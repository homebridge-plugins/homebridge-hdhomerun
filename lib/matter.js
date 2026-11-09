const MIN_HOMEBRIDGE = '2.3.0';
const VERIFY_POLLS = 12;
const VERIFY_POLL_MS = 500;
const MAX_ATTEMPTS = 8;
const POWER_PUSH_MS = 10_000;
const ENERGY_PUSH_MS = 60_000;

/**
 * Publishes the plugin's accessories over Matter (Homebridge 2.3+, Matter on for the bridge
 * running this plugin; paired with that bridge's Matter code). Three kinds:
 *
 *   outlet     report-only on/off, optionally with watts and cumulative kWh
 *              (the Home app shows watts on outlet tiles, iOS/tvOS 27+)
 *   occupancy  an occupancy sensor (Poor Reception)
 *   contact    a contact sensor, closed = true (Online)
 *
 * What Homebridge's Matter API needs, from its api.ts and from homebridge-shelly-matter:
 *  - register on every start, including accessories restored from the cache (handlers can't
 *    be cached); a restored accessory keeps its cached state, so push the current state after;
 *  - one registration at a time (concurrent ones race), each confirmed by reading state back,
 *    because registration completes asynchronously and is swallowed before the Matter server
 *    is up; retry before registering again;
 *  - removals complete asynchronously too;
 *  - power reports are throttled by matter.js (~10 s); energy events are not, so energy is
 *    pushed once a minute.
 */
class MatterPublisher {
  constructor({ api, log, pluginName, platformName, version }) {
    this.api = api;
    this.matter = api.matter;
    this.log = log;
    this.pluginName = pluginName;
    this.platformName = platformName;
    this.version = version;
    this.entries = new Map(); // key → entry
    this.queue = Promise.resolve();
    this.stopped = false;
    // shorter in tests only
    this.powerPushMs = Number(process.env.HDHR_MATTER_POWER_MS) || POWER_PUSH_MS;
    this.energyPushMs = Number(process.env.HDHR_MATTER_ENERGY_MS) || ENERGY_PUSH_MS;
  }

  /** Whether this Homebridge can publish over Matter: 2.3+ with Matter on for this bridge. */
  static check(api) {
    if (!api.matter || !api.isMatterAvailable?.()) return { ok: false, reason: 'this Homebridge has no Matter support (needs Homebridge 2.3 or later)' };
    if (api.versionGreaterOrEqual && !api.versionGreaterOrEqual(MIN_HOMEBRIDGE)) {
      return { ok: false, reason: `Homebridge ${api.serverVersion} is too old for Matter (needs ${MIN_HOMEBRIDGE} or later)` };
    }
    if (!api.isMatterEnabled?.()) return { ok: false, reason: 'Matter is not turned on for the bridge running this plugin' };
    return { ok: true };
  }

  /** The UUID for a key. "tv" keeps the UUID TV In Use had in 1.6, so its pairing survives. */
  uuidFor(key) {
    return this.api.hap.uuid.generate(key === 'tv' ? 'hdhomerun-monitor:tv-in-use-matter' : `hdhomerun-monitor:matter:${key}`);
  }

  /**
   * Adds an accessory: { key, name, type: 'outlet'|'occupancy'|'contact', energy, manufacturer,
   * model, serial, context }. Registration is queued, one at a time.
   */
  add(spec, state = {}) {
    if (this.entries.has(spec.key)) return this.entries.get(spec.key);
    const entry = {
      spec,
      uuid: this.uuidFor(spec.key),
      state: { on: false, occupied: false, contact: true, reachable: true, watts: 0, mWh: 0, ...state },
      ready: false,
      pushed: {},
    };
    this.entries.set(spec.key, entry);
    this.queue = this.queue
      .then(() => this.registerVerified(entry))
      .catch((e) => this.log.warn(`[Matter] "${spec.name}": ${e.message}`));
    return entry;
  }

  accessory(entry) {
    const { spec, state } = entry;
    const dt = this.matter.deviceTypes;
    const base = {
      UUID: entry.uuid,
      displayName: spec.name,
      serialNumber: spec.serial || spec.key,
      manufacturer: spec.manufacturer || 'Homebridge HDHomeRun',
      model: spec.model || spec.name,
      firmwareRevision: this.version,
      context: { kind: 'hdhomerun-monitor', key: spec.key, ...(spec.context || {}) },
    };
    if (spec.type === 'occupancy') {
      return { ...base, deviceType: dt.MotionSensor, clusters: { occupancySensing: { occupancy: { occupied: !!state.occupied } } } };
    }
    if (spec.type === 'contact') {
      return { ...base, deviceType: dt.ContactSensor, clusters: { booleanState: { stateValue: state.contact !== false } } };
    }
    // report only: whatever the Home app asks, put back what is really happening
    // (Homebridge sets the commanded state after the handler, so wait a moment)
    const putBack = () => {
      setTimeout(() => {
        entry.pushed.on = undefined;
        this.push(entry, Date.now(), false);
      }, 500);
    };
    const clusters = { onOff: { onOff: !!state.on } };
    if (spec.energy) {
      clusters.electricalPowerMeasurement = { activePower: Math.round((state.watts || 0) * 1000) };
      clusters.electricalEnergyMeasurement = { cumulativeEnergyImported: { energy: Math.round(state.mWh || 0) } };
    }
    return { ...base, deviceType: dt.OnOffOutlet, clusters, handlers: { onOff: { on: putBack, off: putBack } } };
  }

  async registerVerified(entry) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !this.stopped; attempt++) {
      try {
        if (!(await this.isRegistered(entry))) {
          await this.matter.registerPlatformAccessories(this.pluginName, this.platformName, [this.accessory(entry)]);
        }
      } catch (e) {
        this.log.debug(`[Matter] register "${entry.spec.name}": ${e.message}`);
      }
      for (let i = 0; i < VERIFY_POLLS && !this.stopped; i++) {
        if (await this.isRegistered(entry)) {
          entry.ready = true;
          entry.pushed = {};
          this.log.info(`[Matter] "${entry.spec.name}" published${entry.spec.energy ? ' with estimated watts and kWh' : ''}`);
          this.push(entry, Date.now(), true);
          return;
        }
        await sleep(VERIFY_POLL_MS);
      }
      await sleep(Math.min(10_000, 1000 * attempt));
    }
    if (!this.stopped) this.log.warn(`[Matter] could not publish "${entry.spec.name}"; it will be retried at the next restart`);
  }

  async isRegistered(entry) {
    const cluster = { occupancy: 'occupancySensing', contact: 'booleanState' }[entry.spec.type] || 'onOff';
    try {
      return (await this.matter.getAccessoryState(entry.uuid, cluster)) !== undefined;
    } catch {
      return false;
    }
  }

  /** Sets what an accessory should show: { on, occupied, contact, reachable, watts, mWh }. */
  set(key, state, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return;
    Object.assign(entry.state, state);
    if (state.mWh !== undefined) entry.state.mWh = Math.max(entry.pushed.mWh || 0, state.mWh);
    if (entry.ready) this.push(entry, now, false);
  }

  push(entry, now, force) {
    const { spec, state, pushed: p } = entry;
    const send = (cluster, attrs) => Promise.resolve()
      .then(() => this.matter.updateAccessoryState(entry.uuid, cluster, attrs))
      .catch((e) => this.log.debug(`[Matter] "${spec.name}" ${cluster}: ${e.message}`));
    if (state.reachable !== undefined && (force || p.reachable !== state.reachable)) {
      p.reachable = state.reachable;
      send('bridgedDeviceBasicInformation', { reachable: !!state.reachable });
    }
    if (spec.type === 'occupancy') {
      if (force || p.occupied !== !!state.occupied) {
        p.occupied = !!state.occupied;
        send('occupancySensing', { occupancy: { occupied: p.occupied } });
      }
      return;
    }
    if (spec.type === 'contact') {
      if (force || p.contact !== !!state.contact) {
        p.contact = !!state.contact;
        send('booleanState', { stateValue: p.contact });
      }
      return;
    }
    if (force || p.on !== !!state.on) {
      p.on = !!state.on;
      send('onOff', { onOff: p.on });
    }
    if (!spec.energy) return;
    const mW = Math.round((state.watts || 0) * 1000);
    if (force || (mW !== p.mW && now - (p.powerAt || 0) >= this.powerPushMs)) {
      p.mW = mW;
      p.powerAt = now;
      send('electricalPowerMeasurement', { activePower: mW });
    }
    const mWh = Math.round(state.mWh || 0);
    if (force || (mWh !== p.mWh && now - (p.energyAt || 0) >= this.energyPushMs)) {
      p.mWh = mWh;
      p.energyAt = now;
      send('electricalEnergyMeasurement', { cumulativeEnergyImported: { energy: mWh } });
    }
  }

  /** Removes accessories from the Matter bridge (no longer wanted, or the setting changed). */
  remove(accessories) {
    if (!accessories.length) return this.queue;
    this.queue = this.queue.then(() => MatterPublisher.remove(this.api, this.pluginName, this.platformName, accessories, this.log));
    return this.queue;
  }

  static async remove(api, pluginName, platformName, accessories, log) {
    if (!api.matter || !accessories.length) return;
    try {
      await api.matter.unregisterPlatformAccessories(pluginName, platformName, accessories);
      log.info(`[Matter] removed ${accessories.map((a) => `"${a.displayName}"`).join(', ')}`);
      // removal completes asynchronously; wait, so a re-add of the same UUID isn't a duplicate
      for (let i = 0; i < 20; i++) {
        let left = false;
        for (const a of accessories) {
          try { if ((await api.matter.getAccessoryState(a.UUID, 'onOff')) !== undefined) left = true; } catch { /* gone */ }
        }
        if (!left) break;
        await sleep(250);
      }
    } catch (e) {
      log.debug(`[Matter] unregister: ${e.message}`);
    }
  }

  get ready() {
    return [...this.entries.values()].every((e) => e.ready);
  }

  stop() {
    this.stopped = true;
  }
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

export { MatterPublisher, MIN_HOMEBRIDGE };
