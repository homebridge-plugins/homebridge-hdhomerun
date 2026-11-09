import { createRequire } from 'node:module';
import path from 'node:path';
import { DeviceMonitor } from './monitor.js';
import { Recorder } from './recorder.js';
import { Dashboard } from './dashboard.js';
import { TunerAccessory } from './accessory.js';
import { Guide } from './guide.js';
import { ChannelsDvr } from './channels.js';
import { OnlineAccessory } from './online-accessory.js';
import { CombinedAccessory } from './combined-accessory.js';
import { MatterPublisher } from './matter.js';
import { settle, delay } from './accessory.js';
import { EnergyMeter, energySummary } from './energy.js';
import { dayKey } from './stats.js';
import * as snapshot from './snapshot.js';
import * as hdhr from './hdhr.js';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const PLUGIN_NAME = '@homebridge-plugins/homebridge-hdhomerun';
const PLATFORM_NAME = 'HDHomeRun';
const DISCOVERY_EVERY_MS = 10 * 60 * 1000;

export default (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, HDHomeRunPlatform);
};

class HDHomeRunPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.cached = new Map(); // uuid → PlatformAccessory
    this.handlers = new Map(); // deviceId → TunerAccessory
    this.monitors = new Map(); // key → DeviceMonitor
    this.pollMs = Math.max(2, Number(this.config.pollSeconds) || 5) * 1000;
    this.clientNames = {};
    for (const c of this.config.clients || []) if (c?.ip && c?.name) this.clientNames[c.ip.trim()] = c.name;
    this.devices = (this.config.devices || []).filter((d) => d && (d.host || d.deviceId));

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  /** Matter accessories restored from the cache: only TV In Use is ours. */
  configureMatterAccessory(accessory) {
    (this.matterCached ||= new Map()).set(accessory.UUID, accessory);
  }

  get energyConfig() {
    return this.config.energy || {};
  }

  /**
   * Estimated draw in watts: each reachable HDHomeRun's idle watts plus watts per busy tuner,
   * and optionally watts per online stream (e.g. a streamer). The HDHomeRun has no meter.
   */
  estimateWatts() {
    return this.estimate().total;
  }

  /** { total, parts: { <device id>: watts } } */
  estimate() {
    const e = this.energyConfig;
    const num = (v, d) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? d : Math.max(0, Number(v)));
    let w = 0;
    const parts = {};
    for (const m of this.monitors.values()) {
      if (!m.online) {
        if (m.deviceId) parts[m.deviceId] = parts[m.deviceId] || 0;
        continue;
      }
      const cfg = this.deviceConfig(m.deviceId, m.host);
      const idle = num(cfg.idleWatts, num(e.idleWatts, 3));
      const tuner = num(cfg.tunerWatts, num(e.tunerWatts, 1));
      const dw = idle + tuner * m.tuners.filter((t) => t.inUse).length;
      if (m.deviceId) parts[m.deviceId] = (parts[m.deviceId] || 0) + dw;
      w += dw;
    }
    const perStream = num(e.onlineStreamWatts, 0);
    if (perStream && this.dvr?.activityOk) w += perStream * (this.dvrStreams || []).filter((x) => x.kind === 'online').length;
    return { total: Math.round(w * 100) / 100, parts };
  }

  /**
   * How the plugin reaches Apple Home:
   *   "homekit"     HomeKit (HAP) only
   *   "matter"      HomeKit, with TV In Use over Matter for its watts (the default)
   *   "matterOnly"  everything over Matter, nothing on HomeKit
   * Matter needs Homebridge 2.3+ with Matter on for the bridge; without it, HomeKit is used.
   */
  get connection() {
    const c = this.config.appleHome;
    if (c === 'homekit' || c === 'matter' || c === 'matterOnly') return c;
    return this.energyConfig.matter === false ? 'homekit' : 'matter';
  }

  get matterOnly() {
    return this.mode === 'matterOnly';
  }

  /** Decides what goes over Matter, before any accessory is made. Sets this.mode. */
  setupMatter() {
    const cached = [...(this.matterCached?.values() || [])];
    const want = this.connection;
    this.mode = 'homekit';
    const dropCached = () => { if (cached.length && this.api.matter) MatterPublisher.remove(this.api, PLUGIN_NAME, PLATFORM_NAME, cached, this.log); };
    if (want === 'homekit') return dropCached();
    const check = MatterPublisher.check(this.api);
    if (!check.ok) {
      if (want === 'matterOnly') {
        this.log.warn(`"Matter only" needs Matter: ${check.reason}. Using HomeKit until Matter is turned on for this plugin's bridge (Homebridge 2.3+).`);
      } else if (this.combinedLayout) {
        this.log.info(`TV In Use stays a plain switch without watts: ${check.reason}. To show estimated watts on its tile, turn on Matter for this plugin's bridge (Homebridge 2.3+, iOS 27+).`);
      }
      return dropCached();
    }
    if (want === 'matter' && !this.combinedLayout) return dropCached(); // nothing to show over Matter
    this.mode = want;
    this.matterPub = new MatterPublisher({ api: this.api, log: this.log, pluginName: PLUGIN_NAME, platformName: PLATFORM_NAME, version });
    this.matterDevices = new Map(); // device id → { tunerCount, subs, inds }
    this.matterOnlineInds = null;

    // keep what is still wanted; remove the rest before anything is added
    const keyOf = (a) => a.context?.key || (a.context?.kind === 'tv-in-use' ? 'tv' : null);
    const keep = (a) => {
      const key = keyOf(a);
      if (key === 'tv') return this.combinedLayout;
      if (!this.matterOnly || !key) return false;
      const { deviceId, tunerCount, host } = a.context || {};
      if (deviceId) {
        if (!this.isWanted(deviceId, host)) return false;
        return this.matterSubs(deviceId, this.deviceConfig(deviceId, host), tunerCount || 2, a.context.name || '').some((x) => x.key === key);
      }
      return !this.combinedLayout && this.onlineMatterKeys().has(key);
    };
    const stale = cached.filter((a) => !keep(a));
    if (stale.length) this.matterPub.remove(stale);
    this.matterCachedDevices = cached.filter((a) => keep(a) && a.context?.deviceId);

    if (this.combinedLayout) {
      this.matterPub.add({ key: 'tv', name: this.combinedConfig.name || 'TV In Use', type: 'outlet', energy: true, model: 'TV In Use (estimated energy)', serial: 'tv-in-use', context: { kind: 'tv-in-use' } },
        { on: false, watts: 0, mWh: this.energy.totalMWh });
    }
    if (this.matterOnly) {
      this.log.info('Apple Home connection: Matter only — pair this bridge\'s Matter code in the Home app; nothing is published on HomeKit');
    }
  }

  /** The Matter accessories for one HDHomeRun (Matter only). */
  matterSubs(deviceId, cfg, tunerCount, name) {
    if (cfg.homekit === false) return [];
    const subs = [];
    const id = deviceId;
    const label = name || cfg.name || `HDHomeRun ${id}`;
    if (!this.combinedLayout) {
      const list = Array.isArray(cfg.tuners) ? cfg.tuners.map(Number).filter((n) => n >= 1) : [];
      if (cfg.tunerSensors !== false) {
        for (let i = 0; i < tunerCount; i++) {
          if (!list.length || list.includes(i + 1)) subs.push({ key: `${id}-tuner${i}`, name: `${label} Tuner ${i + 1}`, type: 'outlet', test: (st) => st.tuners[i]?.inUse });
        }
      }
      if (cfg.anyTunerSensor !== false) subs.push({ key: `${id}-any`, name: `${label} In Use`, type: 'outlet', energy: true, test: (st) => st.tuners.some((t) => t.inUse) });
      if (cfg.allBusySensor) subs.push({ key: `${id}-all`, name: `${label} All Busy`, type: 'outlet', test: (st) => st.tuners.length > 0 && st.tuners.every((t) => t.inUse) });
    }
    if (cfg.poorReceptionSensor !== false) subs.push({ key: `${id}-poor`, name: `${label} Poor Reception`, type: 'occupancy' });
    if (cfg.onlineSensor) subs.push({ key: `${id}-online`, name: `${label} Online`, type: 'contact' });
    return subs;
  }

  /** Online TV and channel outlets (Matter only, separate switches). */
  onlineMatterKeys() {
    const cd = this.config.channelsDvr || {};
    const keys = new Set();
    if (cd.enabled === false || cd.homekit === false) return keys;
    if (cd.onlineSwitch !== false) keys.add('online-tv');
    for (const n of cd.channelSwitches || []) if (String(n).trim()) keys.add(`ch-${String(n).trim()}`);
    return keys;
  }

  /** Adds a device's Matter accessories once it is known (Matter only). */
  ensureMatterDevice(m) {
    if (!this.matterOnly || !m.deviceId) return null;
    const id = m.deviceId;
    const cachedCtx = this.matterCachedDevices?.find((a) => a.context.deviceId === id)?.context;
    const tunerCount = Number(m.info?.TunerCount) || m.tuners.length || cachedCtx?.tunerCount || 2;
    let rec = this.matterDevices.get(id);
    if (rec && rec.tunerCount >= tunerCount) return rec;
    const cfg = this.deviceConfig(id, m.host);
    const name = cfg.name || cachedCtx?.name || m.name;
    const subs = this.matterSubs(id, cfg, tunerCount, name);
    rec = rec || { inds: new Map() };
    rec.tunerCount = tunerCount;
    rec.subs = subs;
    for (const sub of subs) {
      if (!rec.inds.has(sub.key)) rec.inds.set(sub.key, { shown: false, raw: false, changedAt: 0, primed: false });
      this.matterPub.add({
        key: sub.key,
        name: sub.name,
        type: sub.type,
        energy: sub.energy,
        manufacturer: 'SiliconDust',
        model: m.info?.ModelNumber ? `HDHomeRun ${m.info.ModelNumber}` : 'HDHomeRun',
        serial: `${id}-${sub.key.slice(id.length + 1)}`,
        context: { deviceId: id, host: m.host, tunerCount, name },
      }, { mWh: this.energy.byKey[id] || 0, contact: !!m.online, reachable: true });
    }
    this.matterDevices.set(id, rec);
    return rec;
  }

  /** Pushes a device's state to its Matter accessories (Matter only). */
  updateMatterDevice(m, snap, now = Date.now()) {
    const rec = this.ensureMatterDevice(m);
    if (!rec) return;
    const cfg = this.deviceConfig(m.deviceId, m.host);
    const onMs = delay(cfg.onDelaySeconds, 30);
    const offMs = delay(cfg.offDelaySeconds, 120);
    const watts = this.estimate().parts[m.deviceId] || 0;
    for (const sub of rec.subs) {
      if (sub.type === 'occupancy') {
        this.matterPub.set(sub.key, { occupied: !!snap.reception?.active, reachable: !!snap.online }, now);
      } else if (sub.type === 'contact') {
        this.matterPub.set(sub.key, { contact: !!snap.online }, now);
      } else {
        const ind = rec.inds.get(sub.key);
        settle(ind, Boolean(snap.online && sub.test(snap)), now, onMs, offMs);
        this.matterPub.set(sub.key, {
          on: ind.shown,
          reachable: !!snap.online,
          ...(sub.energy ? { watts, mWh: this.energy.byKey[m.deviceId] || 0 } : {}),
        }, now);
      }
    }
  }

  /** Online TV and channel outlets, from Channels DVR's activity (Matter only, separate switches). */
  updateMatterOnline(streams, now) {
    if (!this.matterOnly || this.combinedLayout || !this.dvr.activityOk) return;
    const cd = this.config.channelsDvr || {};
    const counts = (x) => x.activity === 'watching' || (cd.includeRecordings && x.activity === 'recording');
    if (!this.matterOnlineInds) {
      this.matterOnlineInds = new Map();
      for (const key of this.onlineMatterKeys()) {
        const num = key.startsWith('ch-') ? key.slice(3) : null;
        const name = num ? (this.dvr.channelNames[num] ? `${this.dvr.channelNames[num]} ${num}` : `Channel ${num}`) : `${cd.switchName || 'Online TV'} In Use`;
        const test = num ? (list) => list.some((x) => String(x.channelNumber) === num && counts(x)) : (list) => list.some((x) => x.kind === 'online' && counts(x));
        this.matterOnlineInds.set(key, { test, ind: { shown: false, raw: false, changedAt: 0, primed: false } });
        this.matterPub.add({ key, name, type: 'outlet', manufacturer: 'Channels DVR', model: 'Online channels', serial: key, context: { kind: 'channels-online' } });
      }
    }
    const onMs = delay(cd.onDelaySeconds, 30);
    const offMs = delay(cd.offDelaySeconds, 120);
    for (const [key, { test, ind }] of this.matterOnlineInds) {
      settle(ind, Boolean(test(streams)), now, onMs, offMs);
      this.matterPub.set(key, { on: ind.shown }, now);
    }
  }

  start() {
    const dir = path.join(this.api.user.storagePath(), 'hdhomerun-monitor');
    this.recorder = new Recorder({
      dir,
      log: this.log,
      keepDays: Number(this.config.keepDays) || 400,
    });
    if (this.config.logSessions !== false) {
      this.recorder.on('session-start', (s) => this.log.info(`[${s.device}] Tuner ${s.tuner + 1}: ${channelLabel(s)} → ${clientLabel(s)}`));
      this.recorder.on('session-end', (s) => this.log.info(`[${s.device}] Tuner ${s.tuner + 1}: stopped ${channelLabel(s)} after ${duration(s.seconds)}`));
    }

    this.energy = new EnergyMeter({ dir, log: this.log });
    this.setupMatter();
    this.useMatterTv = this.mode !== 'homekit' && this.combinedLayout;
    this.guide = new Guide({ dir, log: this.log, enabled: this.config.guide !== false });
    const cd = this.config.channelsDvr || {};
    this.dvr = new ChannelsDvr({ url: cd.url, enabled: cd.enabled !== false, log: this.log, dir, pollSeconds: this.pollMs / 1000 });
    this.onlineSlots = []; // session id per slot, for the virtual "Online TV" device
    this.onlineSeen = new Map(); // session id → { client, logged }
    this.dvr.on('activity', (streams, now) => this.onDvrActivity(streams, now));
    this.dvr.start();

    for (const d of this.devices) {
      if (d.host) this.addMonitor({ host: d.host.trim(), deviceId: d.deviceId, cfg: d });
    }
    // devices seen before keep their accessory, and are watched at their last address
    for (const acc of this.cached.values()) {
      const { deviceId, host } = acc.context || {};
      if (!deviceId || this.findMonitor(deviceId)) continue;
      const byHost = host && [...this.monitors.values()].find((m) => !m.deviceId && m.host && hdhr.hostOnly(m.host) === hdhr.hostOnly(host));
      if (byHost) {
        // a configured address we have seen before: show its accessory (offline) until it answers
        byHost.deviceId = deviceId;
        this.ensureAccessory(byHost);
        continue;
      }
      const cfg = this.deviceConfig(deviceId, host);
      if (this.isWanted(deviceId, host)) {
        this.addMonitor({ host, deviceId, cfg });
      }
    }
    // devices seen over Matter only before are watched at their last address too
    for (const a of this.matterCachedDevices || []) {
      const { deviceId, host } = a.context;
      if (this.findMonitor(deviceId) || !host || !this.isWanted(deviceId, host)) continue;
      const cfg = this.deviceConfig(deviceId, host);
      // a configured address seen before: the same device, shown (unreachable) until it answers
      const byHost = [...this.monitors.values()].find((m) => !m.deviceId && m.host && hdhr.hostOnly(m.host) === hdhr.hostOnly(host));
      if (byHost) {
        byHost.deviceId = deviceId;
        this.ensureMatterDevice(byHost);
        continue;
      }
      this.addMonitor({ host, deviceId, cfg });
    }
    this.removeUnwanted();
    if (this.combinedLayout) this.ensureCombinedAccessory();

    if (this.config.discovery !== false) {
      // after the first polls, so configured devices have identified themselves
      this.discoveryKick = setTimeout(() => this.discover(), 8000);
      this.discoveryTimer = setInterval(() => this.discover(), DISCOVERY_EVERY_MS);
    }

    const dash = this.config.dashboard || {};
    if (dash.enabled !== false) {
      this.dashboard = new Dashboard({
        port: Number(dash.port) || 8588,
        host: dash.host || '0.0.0.0',
        log: this.log,
        getSnapshot: () => this.snapshot(),
        getLive: () => this.live(),
        onReset: () => {
          this.log.info('statistics reset from the dashboard');
          this.recorder.reset();
        },
      });
      this.dashboard.start();
    }
  }

  stop() {
    clearTimeout(this.discoveryKick);
    clearInterval(this.discoveryTimer);
    for (const m of this.monitors.values()) m.stop();
    this.dvr?.stop();
    this.matterPub?.stop();
    this.energy?.tick(this.energy.watts);
    this.energy?.save();
    this.dashboard?.stop();
    this.recorder?.close();
  }

  deviceConfig(deviceId, host) {
    const id = deviceId && String(deviceId).toUpperCase();
    return this.devices.find((d) => (id && d.deviceId && d.deviceId.toUpperCase() === id) || (host && d.host && hdhr.hostOnly(d.host) === hdhr.hostOnly(host))) || {};
  }

  isWanted(deviceId, host) {
    if (this.config.discovery !== false) return true;
    return Object.keys(this.deviceConfig(deviceId, host)).length > 0;
  }

  /**
   * HomeKit layout: "combined" (default) is one "TV In Use" switch for everything;
   * "separate" is the switches per tuner, In Use, All Busy and Online TV.
   */
  get combinedLayout() {
    return this.config.homekitLayout !== 'separate';
  }

  get combinedConfig() {
    return this.config.combined || {};
  }

  get onlineConfig() {
    const cd = this.config.channelsDvr || {};
    return { ...cd, homekit: !this.combinedLayout && !this.matterOnly && cd.enabled !== false && cd.homekit !== false };
  }

  /** What a device's accessory shows, or null for no accessory. */
  deviceOptions(cfg) {
    if (cfg.homekit === false) return null;
    if (!this.combinedLayout) return cfg;
    // the combined switch replaces the streaming switches; the sensors stay
    const opts = { ...cfg, tunerSensors: false, anyTunerSensor: false, allBusySensor: false };
    return opts.poorReceptionSensor === false && !opts.onlineSensor ? null : opts;
  }

  removeUnwanted() {
    const stale = [...this.cached.values()].filter((a) => {
      if (this.matterOnly) return true; // nothing on HomeKit
      if (a.context?.kind === 'channels-online') return !this.onlineConfig.homekit;
      // the HAP TV In Use goes when the Matter one (with watts) replaces it
      if (a.context?.kind === 'combined') return !this.combinedLayout || this.useMatterTv;
      return !this.isWanted(a.context?.deviceId, a.context?.host)
        || !this.deviceOptions(this.deviceConfig(a.context?.deviceId, a.context?.host));
    });
    if (stale.length) {
      this.log.info(`removing ${stale.map((a) => a.displayName).join(', ')} (no longer configured)`);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const a of stale) this.cached.delete(a.UUID);
    }
  }

  findMonitor(deviceId) {
    const id = String(deviceId).toUpperCase();
    for (const m of this.monitors.values()) if (m.deviceId && m.deviceId.toUpperCase() === id) return m;
    return null;
  }

  addMonitor({ host, deviceId, cfg }) {
    const key = deviceId ? String(deviceId).toUpperCase() : `host:${host}`;
    if (this.monitors.has(key)) return this.monitors.get(key);
    const m = new DeviceMonitor({
      key,
      host,
      deviceId: deviceId && String(deviceId).toUpperCase(),
      name: cfg?.name,
      log: this.log,
      clientNames: this.clientNames,
      pollSeconds: this.pollMs / 1000,
      reception: { threshold: cfg?.poorReceptionThreshold, minutes: cfg?.poorReceptionMinutes },
    });
    this.monitors.set(key, m);
    m.on('identified', () => {
      // the same HDHomeRun watched at an old address too (it moved): keep the one that answered
      for (const [k, other] of this.monitors) {
        if (other !== m && other.deviceId === m.deviceId) {
          other.stop();
          this.monitors.delete(k);
          this.log.info(`[${m.name}] found at ${m.host}; no longer checking ${other.host}`);
        }
      }
      this.ensureAccessory(m);
    });
    m.on('lineup', (l) => this.recorder.saveLineup(m.deviceId, l));
    m.on('update', (snap) => {
      this.attributeDvrViewers(m.deviceId, snap.tuners);
      this.recorder.update(snap, this.pollMs);
      this.updateCombined(snap.lastPoll || Date.now());
      this.updateMatterDevice(m, snap, snap.lastPoll || Date.now());
      this.guide.maybeRefresh(m.deviceId, m.info?.DeviceAuth);
      if (m.deviceId) {
        const h = this.handlers.get(m.deviceId) || this.ensureAccessory(m);
        h?.setInfo(snap.info);
        h?.update(snap);
      }
      this.dashboard?.broadcast();
    });
    if (deviceId) this.ensureAccessory(m);
    if (host) m.start();
    return m;
  }

  ensureAccessory(m) {
    if (!m.deviceId) return null;
    if (this.matterOnly) {
      this.ensureMatterDevice(m);
      return null;
    }
    if (this.handlers.has(m.deviceId)) return this.handlers.get(m.deviceId);
    const cfg = this.deviceConfig(m.deviceId, m.host);
    const opts = this.deviceOptions(cfg);
    if (!opts) return null;
    const uuid = this.api.hap.uuid.generate(`hdhomerun:${m.deviceId}`);
    let acc = this.cached.get(uuid);
    const name = cfg.name || m.name;
    if (!acc) {
      acc = new this.api.platformAccessory(name, uuid);
      acc.context = { deviceId: m.deviceId, host: m.host, name, tunerCount: Number(m.info?.TunerCount) || 2 };
      this.log.info(`adding ${name} to HomeKit`);
      const handler = new TunerAccessory(this, acc, opts);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.cached.set(uuid, acc);
      this.handlers.set(m.deviceId, handler);
      return handler;
    }
    acc.context.host = m.host || acc.context.host;
    acc.context.name = name;
    acc.context.deviceId = m.deviceId;
    const handler = new TunerAccessory(this, acc, opts);
    this.api.updatePlatformAccessories([acc]);
    this.handlers.set(m.deviceId, handler);
    return handler;
  }

  async discover() {
    let found = [];
    try {
      found = await hdhr.discover();
    } catch (e) {
      this.log.debug(`discovery failed: ${e.message}`);
    }
    for (const f of found) {
      const existing = this.findMonitor(f.deviceId) || this.monitors.get(`host:${f.ip}`);
      if (existing) {
        if (existing.deviceId === f.deviceId && hdhr.hostOnly(existing.host || '') !== f.ip && !this.deviceConfig(f.deviceId).host) {
          existing.setHost(f.ip);
          const h = this.handlers.get(f.deviceId);
          if (h) h.accessory.context.host = f.ip;
        }
        continue;
      }
      // a configured device given by ID only
      const cfg = this.deviceConfig(f.deviceId);
      this.log.info(`found HDHomeRun ${f.deviceId} at ${f.ip} (${f.tunerCount || '?'} tuners)`);
      this.addMonitor({ host: f.ip, deviceId: f.deviceId, cfg });
    }
    // configured by ID but not found: keep trying at the next discovery
    for (const d of this.devices) {
      if (d.deviceId && !d.host && !this.findMonitor(d.deviceId)) {
        this.log.warn(`HDHomeRun ${d.deviceId} not found on the network yet`);
      }
    }
  }

  /**
   * Channels DVR's live activity: classify each stream, drive the online switches, and
   * record online streams as a virtual device so they get sessions and statistics.
   */
  onDvrActivity(streams, now = Date.now()) {
    const lineups = [...this.monitors.values()].map((m) => new Set((m.lineup || []).map((c) => String(c.GuideNumber))));
    const lastSource = streams.find((x) => x.kind === 'online')?.sourceName || this.lastOnlineSource || 'Online';
    for (const st of streams) {
      if (st.kind === 'online') this.lastOnlineSource = st.sourceName;
      // recordings don't name their source: a channel the HDHomeRun doesn't have is online
      if (st.kind === 'unknown' && st.channelNumber) {
        if (lineups.some((l) => l.has(String(st.channelNumber)))) st.kind = 'tuner';
        else Object.assign(st, { kind: 'online', sourceName: lastSource });
      }
      if (st.ip && this.clientNames[st.ip]) st.device = this.clientNames[st.ip];
    }
    this.dvrStreams = streams;

    const oc = this.onlineConfig;
    if (oc.homekit && this.dvr.activityOk) this.ensureOnlineAccessory();
    this.onlineHandler?.update(streams, this.dvr.activityOk, now);
    this.updateMatterOnline(streams, now);
    this.updateCombined(now);

    const online = streams.filter((x) => x.kind === 'online');
    this.recorder.update(this.onlineSnapshot(online, now), this.pollMs);
    if (this.config.logSessions !== false) this.logOnline(online);
    this.dashboard?.broadcast();
  }

  logOnline(online) {
    const ids = new Set(online.map((x) => x.id));
    for (const x of online) {
      const key = `${x.id}|${x.channelNumber}`;
      if (!this.onlineSeen.has(key)) {
        this.onlineSeen.set(key, true);
        const what = x.activity === 'recording' ? `recording ${x.title || ''}`.trim() : `→ ${x.device || x.ip || 'unknown client'}`;
        this.log.info(`[Channels DVR] ${x.sourceName}: ch ${x.channelNumber}${x.channelName ? ` ${x.channelName}` : ''} ${what}`);
      }
    }
    for (const key of [...this.onlineSeen.keys()]) if (!ids.has(key.split('|')[0])) this.onlineSeen.delete(key);
  }

  /**
   * Everything in use right now, for the combined "TV In Use" switch: HDHomeRun tuners
   * (watched directly or through Channels DVR), online channels, and recordings.
   */
  inUseReasons(now = Date.now()) {
    const rec = this.combinedConfig.includeRecordings !== false;
    const reasons = [];
    const recordingChannels = new Set();
    for (const m of this.monitors.values()) {
      if (!m.online) continue;
      for (const t of m.tuners) {
        if (!t.inUse || (!rec && t.dvrRecording)) continue;
        if (t.dvrRecording) recordingChannels.add(String(t.channelNumber));
        reasons.push(`${m.name} Tuner ${t.index + 1}${t.channelNumber ? ` · ch ${t.channelNumber}` : ''}${t.dvrRecording ? ' (recording)' : ''}`);
      }
    }
    if (this.dvr?.activityOk) {
      for (const st of this.dvrStreams || []) {
        if (st.kind !== 'online' || (st.activity === 'recording' && !rec)) continue;
        if (st.activity === 'recording') recordingChannels.add(String(st.channelNumber));
        reasons.push(`${st.sourceName || 'Online'} · ch ${st.channelNumber}${st.activity === 'recording' ? ' (recording)' : ''}`);
      }
    }
    if (rec && this.dvr?.status === 'ok') {
      // a recording Channels DVR is making that the checks above didn't see
      for (const j of this.dvr.jobs || []) {
        if (j.skipped || j.failed || j.start > now || j.end <= now) continue;
        if (j.channel && recordingChannels.has(String(j.channel))) continue;
        if (!j.channel && recordingChannels.size) continue;
        reasons.push(`Recording ${j.title}`);
      }
    }
    return reasons;
  }

  updateCombined(now = Date.now()) {
    const { total: watts, parts } = this.estimate();
    this.energy?.tick(watts, now, this.pollMs * 3, parts);
    if (!this.combinedHandler) return;
    const before = this.combinedHandler.ind.shown;
    this.combinedHandler.update(this.inUseReasons(now), now);
    const after = this.combinedHandler.ind.shown;
    this.matterPub?.set('tv', { on: after, watts, mWh: this.energy.totalMWh }, now);
    if (before !== after && this.config.logSessions !== false) {
      const name = this.combinedConfig.name || 'TV In Use';
      this.log.info(after ? `${name}: on (${this.combinedHandler.reasons.join(', ')})` : `${name}: off`);
    }
  }

  ensureCombinedAccessory() {
    if (this.combinedHandler) return this.combinedHandler;
    if (this.useMatterTv) {
      // the Matter outlet shows it; keep the state here without a HAP accessory
      this.combinedHandler = new CombinedAccessory(this, null, this.combinedConfig);
      return this.combinedHandler;
    }
    const uuid = this.api.hap.uuid.generate('hdhomerun-monitor:tv-in-use');
    let acc = this.cached.get(uuid);
    const fresh = !acc;
    if (fresh) {
      acc = new this.api.platformAccessory('TV', uuid);
      this.log.info(`adding "${this.combinedConfig.name || 'TV In Use'}" to HomeKit`);
    }
    acc.context = { ...(acc.context || {}), kind: 'combined' };
    this.combinedHandler = new CombinedAccessory(this, acc, this.combinedConfig);
    if (fresh) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.cached.set(uuid, acc);
    } else {
      this.api.updatePlatformAccessories([acc]);
    }
    return this.combinedHandler;
  }

  /**
   * A tuner streaming to Channels DVR shows the Channels DVR server as its client.
   * Channels DVR knows who is really watching, so use that device instead.
   */
  attributeDvrViewers(deviceId, tuners) {
    const streams = (this.dvrStreams || []).filter((x) => x.kind === 'tuner' && x.deviceId === deviceId);
    if (!streams.length) return;
    const hosts = this.dvr?.hostIps || new Set();
    const used = new Set();
    for (const t of tuners) {
      if (!t.inUse || (t.client && hosts.size && !hosts.has(t.client))) continue;
      const st = streams.find((x) => !used.has(x.id) && String(x.channelNumber) === String(t.channelNumber));
      if (!st) continue;
      used.add(st.id);
      t.via = 'Channels DVR';
      if (st.activity === 'recording') {
        t.clientName = 'Channels DVR recording';
        t.dvrRecording = true;
      } else if (st.ip || st.device) {
        t.client = st.ip || t.client;
        t.clientName = this.clientNames[st.ip] || st.device || t.clientName;
      }
    }
  }

  /** Online streams as a device with one slot per stream, for the recorder. */
  onlineSnapshot(online, now) {
    const ids = new Set(online.map((x) => x.id));
    this.onlineSlots = this.onlineSlots.map((id) => (ids.has(id) ? id : null));
    for (const x of online) {
      if (this.onlineSlots.includes(x.id)) continue;
      const free = this.onlineSlots.indexOf(null);
      if (free >= 0) this.onlineSlots[free] = x.id;
      else this.onlineSlots.push(x.id);
    }
    const byId = new Map(online.map((x) => [x.id, x]));
    const name = this.onlineConfig.switchName || 'Online TV';
    return {
      key: 'channels-online',
      deviceId: 'ONLINE',
      name,
      virtual: true,
      online: !!this.dvr.activityOk,
      lastPoll: now,
      lastSeen: this.dvr.activityAt,
      tuners: this.onlineSlots.map((id, index) => {
        const x = id && byId.get(id);
        if (!x) return { index, inUse: false };
        return {
          index,
          inUse: true,
          channelNumber: x.channelNumber,
          channelName: x.channelName,
          client: x.ip,
          clientName: x.device,
          source: x.sourceName,
          activity: x.activity,
          title: x.title,
          programme: x.programme,
        };
      }),
      switches: this.onlineHandler?.states() || [],
    };
  }

  ensureOnlineAccessory() {
    if (this.onlineHandler) return this.onlineHandler;
    const uuid = this.api.hap.uuid.generate('hdhomerun-monitor:channels-dvr-online');
    let acc = this.cached.get(uuid);
    const name = 'Channels DVR';
    const fresh = !acc;
    if (fresh) {
      acc = new this.api.platformAccessory(name, uuid);
      this.log.info('adding Channels DVR online channels to HomeKit');
    }
    acc.context = { ...(acc.context || {}), kind: 'channels-online', channelNames: this.dvr.channelNames };
    this.onlineHandler = new OnlineAccessory(this, acc, this.onlineConfig);
    this.onlineHandler.setInfo();
    if (fresh) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      this.cached.set(uuid, acc);
    } else {
      this.api.updatePlatformAccessories([acc]);
    }
    return this.onlineHandler;
  }

  live() {
    const now = Date.now();
    return {
      generated: now,
      devices: [...this.monitors.values()].map((m) => m.snapshot(m.lastSeen || now)),
      open: this.recorder.openSessions(),
      online: this.dvr?.url ? this.onlineSnapshot((this.dvrStreams || []).filter((x) => x.kind === 'online'), now) : null,
      dvrStreams: this.dvrStreams || [],
      combined: this.combinedHandler ? { ...this.combinedHandler.state(), matter: this.matterPub?.entries.get('tv') ? (this.matterPub.entries.get('tv').ready ? 'ready' : 'starting') : null } : null,
      connection: this.mode,
      energy: { watts: this.energy?.watts ?? null, todayWh: this.energy?.days[dayKey(now)] || 0 },
    };
  }

  snapshot() {
    const lineups = {};
    for (const m of this.monitors.values()) if (m.deviceId) lineups[m.deviceId] = m.lineup;
    const live = this.live();
    return snapshot.build({
      devices: live.devices,
      online: live.online,
      dvrStreams: live.dvrStreams,
      combined: live.combined,
      connection: live.connection,
      open: live.open,
      stats: this.recorder.stats,
      closed: this.recorder.closed,
      history: this.recorder.history,
      lineups,
      reception: this.recorder.reception,
      guide: this.guide.devices,
      dvr: this.dvr.state(),
      energy: energySummary(this.energy, { watts: this.energy.watts, pricePerKwh: this.energyConfig.pricePerKwh }),
      version,
    });
  }
}

function channelLabel(s) {
  return [s.channelNumber, s.channelName].filter(Boolean).join(' ') || 'a channel';
}

function clientLabel(s) {
  if (!s.client) return 'unknown client';
  return s.clientName ? `${s.clientName} (${s.client})` : s.client;
}

function duration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : sec < 60 ? `${sec} s` : `${m} min`;
}

export { HDHomeRunPlatform };
