import { settle, delay } from './accessory.js';

/**
 * One HomeKit accessory for Channels DVR's online sources (custom M3U channels, TV Everywhere):
 *
 *   <switchName> In Use    on while any online channel is being watched
 *   <name> <number>        one per channel listed in `channelSwitches`, on while that channel
 *                          is watched through Channels DVR, from any source
 *
 * Used with the "separate switches" HomeKit layout; the default layout has one combined
 * "TV In Use" switch instead (combined-accessory.js).
 * Recordings count only with `includeRecordings`. Same on/off delays and report-only
 * behaviour as the tuner switches; `sensorType: "occupancy"` shows occupancy sensors instead.
 */
class OnlineAccessory {
  constructor(platform, accessory, opts) {
    this.platform = platform;
    this.accessory = accessory;
    this.opts = opts || {};
    this.hap = platform.api.hap;
    this.onDelayMs = delay(this.opts.onDelaySeconds, 30);
    this.offDelayMs = delay(this.opts.offDelaySeconds, 120);
    this.indicators = [];
    this.streams = [];
    this.build();
  }

  get asSwitch() {
    return this.opts.sensorType !== 'occupancy';
  }

  counts(st) {
    return st.activity === 'watching' || (this.opts.includeRecordings && st.activity === 'recording');
  }

  build() {
    const { Service, Characteristic } = this.hap;
    const a = this.accessory;
    const Type = this.asSwitch ? Service.Switch : Service.OccupancySensor;
    const wanted = new Set();
    const names = a.context.channelNames || {};

    const indicator = (subtype, label, test) => {
      wanted.add(`${Type.UUID}/${subtype}`);
      let svc = a.getServiceById(Type, subtype);
      if (!svc) {
        svc = a.addService(Type, label, subtype);
        if (Characteristic.ConfiguredName) {
          try { svc.addOptionalCharacteristic?.(Characteristic.ConfiguredName); svc.setCharacteristic(Characteristic.ConfiguredName, label); } catch { /* older HAP */ }
        }
      }
      const ind = { key: subtype, svc, test, shown: false, raw: false, changedAt: 0, primed: false };
      if (this.asSwitch) {
        const ch = svc.getCharacteristic(Characteristic.On);
        ch.onGet(() => ind.shown);
        ch.onSet(() => setTimeout(() => svc.updateCharacteristic(Characteristic.On, ind.shown), 300));
      } else {
        svc.getCharacteristic(Characteristic.OccupancyDetected).onGet(() => this.occupancy(ind.shown));
      }
      this.indicators.push(ind);
    };

    if (this.opts.onlineSwitch !== false) {
      indicator('online', `${this.opts.switchName || 'Online TV'} In Use`,
        (streams, ctx) => ctx.reachable && streams.some((s) => s.kind === 'online' && this.counts(s)));
    }
    for (const raw of this.opts.channelSwitches || []) {
      const num = String(raw).trim();
      if (!num) continue;
      indicator(`ch-${num}`, names[num] ? `${names[num]} ${num}` : `Channel ${num}`,
        (streams, ctx) => ctx.reachable && streams.some((s) => String(s.channelNumber) === num && this.counts(s)));
    }

    for (const s of a.services.slice()) {
      if (s.subtype && [Service.Switch.UUID, Service.OccupancySensor.UUID].includes(s.UUID) && !wanted.has(`${s.UUID}/${s.subtype}`)) a.removeService(s);
    }
  }

  occupancy(on) {
    const { OccupancyDetected } = this.hap.Characteristic;
    return on ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  setInfo() {
    const { Service, Characteristic } = this.hap;
    const s = this.accessory.getService(Service.AccessoryInformation);
    s.updateCharacteristic(Characteristic.Manufacturer, 'Fancy Bits (Channels DVR)');
    s.updateCharacteristic(Characteristic.Model, 'Online channels');
    s.updateCharacteristic(Characteristic.SerialNumber, 'channels-dvr-online');
  }

  /** streams: parsed Channels DVR activity; reachable: whether Channels DVR answered. */
  update(streams, reachable, now = Date.now()) {
    const { Characteristic } = this.hap;
    this.streams = streams || [];
    const ctx = { reachable: !!reachable };
    for (const ind of this.indicators) {
      settle(ind, Boolean(ind.test(this.streams, ctx)), now, this.onDelayMs, this.offDelayMs);
      if (this.asSwitch) ind.svc.updateCharacteristic(Characteristic.On, ind.shown);
      else {
        ind.svc.updateCharacteristic(Characteristic.OccupancyDetected, this.occupancy(ind.shown));
        ind.svc.updateCharacteristic(Characteristic.StatusActive, !!reachable);
      }
    }
  }

  /** What each switch shows, for the dashboard. */
  states() {
    return this.indicators.map((i) => ({ key: i.key, name: i.svc.displayName, on: i.shown }));
  }
}

export { OnlineAccessory };
