import { settle, delay } from './accessory.js';

/**
 * The single "TV In Use" switch: on while anything is being watched or recorded, from an
 * HDHomeRun tuner or a Channels DVR online channel. The platform works out whether it
 * should be on; this applies the channel-surfing delays and keeps HomeKit up to date.
 * Like the other switches it only reports: tapping it is undone straight away.
 *
 * With no accessory (null) it only keeps the state, for the Matter version of the switch
 * (matter.js), which shows estimated watts on its tile.
 */
class CombinedAccessory {
  constructor(platform, accessory, opts) {
    this.hap = platform.api.hap;
    this.accessory = accessory;
    this.opts = opts || {};
    this.onDelayMs = delay(this.opts.onDelaySeconds, 30);
    this.offDelayMs = delay(this.opts.offDelaySeconds, 120);
    this.ind = { shown: false, raw: false, changedAt: 0, primed: false };
    this.reasons = [];
    if (accessory) this.build();
  }

  get asSwitch() {
    return this.opts.sensorType !== 'occupancy';
  }

  build() {
    const { Service, Characteristic } = this.hap;
    const a = this.accessory;
    const Type = this.asSwitch ? Service.Switch : Service.OccupancySensor;
    const label = this.opts.name || 'TV In Use';
    let svc = a.getServiceById(Type, 'combined');
    if (!svc) {
      svc = a.addService(Type, label, 'combined');
      if (Characteristic.ConfiguredName) {
        try { svc.addOptionalCharacteristic?.(Characteristic.ConfiguredName); svc.setCharacteristic(Characteristic.ConfiguredName, label); } catch { /* older HAP */ }
      }
    }
    this.svc = svc;
    if (this.asSwitch) {
      const ch = svc.getCharacteristic(Characteristic.On);
      ch.onGet(() => this.ind.shown);
      ch.onSet(() => setTimeout(() => svc.updateCharacteristic(Characteristic.On, this.ind.shown), 300));
    } else {
      svc.getCharacteristic(Characteristic.OccupancyDetected).onGet(() => this.occupancy());
    }
    // remove the other kind, if the setting was changed
    for (const s of a.services.slice()) {
      if (s.subtype === 'combined' && s !== svc) a.removeService(s);
    }
    const info = a.getService(Service.AccessoryInformation);
    info.updateCharacteristic(Characteristic.Manufacturer, 'Homebridge HDHomeRun');
    info.updateCharacteristic(Characteristic.Model, 'TV in use');
    info.updateCharacteristic(Characteristic.SerialNumber, 'tv-in-use');
  }

  occupancy() {
    const { OccupancyDetected } = this.hap.Characteristic;
    return this.ind.shown ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  /** reasons: what is in use right now, e.g. ["Lounge HDHomeRun Tuner 1", "Online: ch 104"]. */
  update(reasons, now = Date.now()) {
    const { Characteristic } = this.hap;
    this.reasons = reasons;
    settle(this.ind, reasons.length > 0, now, this.onDelayMs, this.offDelayMs);
    if (!this.svc) return;
    if (this.asSwitch) this.svc.updateCharacteristic(Characteristic.On, this.ind.shown);
    else this.svc.updateCharacteristic(Characteristic.OccupancyDetected, this.occupancy());
  }

  state() {
    return { name: this.opts.name || 'TV In Use', on: this.ind.shown, active: this.ind.raw, reasons: this.reasons };
  }
}

export { CombinedAccessory };
