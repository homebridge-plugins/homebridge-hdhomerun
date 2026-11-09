/**
 * One HomeKit accessory per HDHomeRun. What it shows depends on `sensorType`:
 *
 *   "switch" (default)  a switch per tuner that is on while that tuner is streaming
 *   "occupancy"         an occupancy sensor per tuner, occupied while it is streaming
 *
 *   Tuner 1 … Tuner N      that tuner is streaming      (tunerSensors; only those in `tuners`, if set)
 *   <name> In Use          any tuner is streaming                      (anyTunerSensor)
 *   <name> All Busy        every tuner is streaming                    (allBusySensor)
 *   <name> Online          contact sensor, closed while reachable      (onlineSensor)
 *   <name> Poor Reception  occupancy sensor, occupied while signal quality has stayed low
 *                          (poorReceptionSensor; always a sensor, so the Home app can notify)
 *
 * The streaming indicators wait `onDelaySeconds` before turning on and `offDelaySeconds`
 * before turning off, so channel surfing or a short gap does not fire automations twice.
 *
 * The switches only report. Turning one on or off in the Home app is undone straight
 * away, so an automation on "Tuner 1 turns on" only ever fires when the tuner starts.
 */
class TunerAccessory {
  constructor(platform, accessory, opts) {
    this.platform = platform;
    this.accessory = accessory;
    this.opts = opts || {};
    this.api = platform.api;
    this.hap = platform.api.hap;
    this.state = null;
    this.indicators = [];
    this.onDelayMs = delay(this.opts.onDelaySeconds, 30);
    this.offDelayMs = delay(this.opts.offDelaySeconds, 120);
    this.build(Number(accessory.context.tunerCount) || 2);
  }

  get asSwitch() {
    return this.opts.sensorType !== 'occupancy';
  }

  build(tunerCount) {
    const { Service, Characteristic } = this.hap;
    const a = this.accessory;
    const name = a.context.name;
    a.context.tunerCount = tunerCount;
    const Type = this.asSwitch ? Service.Switch : Service.OccupancySensor;
    const previous = new Map(this.indicators.map((i) => [i.key, i]));

    const wanted = new Set();
    const service = (type, subtype, label) => {
      wanted.add(`${type.UUID}/${subtype}`);
      let s = a.getServiceById(type, subtype);
      if (!s) {
        s = a.addService(type, label, subtype);
        if (Characteristic.ConfiguredName) {
          try { s.addOptionalCharacteristic?.(Characteristic.ConfiguredName); s.setCharacteristic(Characteristic.ConfiguredName, label); } catch { /* older HAP */ }
        }
      }
      return s;
    };
    const indicator = (subtype, label, test) => {
      const svc = service(Type, subtype, label);
      const ind = previous.get(subtype) || { key: subtype, shown: false, raw: false, changedAt: 0, primed: false };
      Object.assign(ind, { svc, test });
      if (this.asSwitch) {
        const ch = svc.getCharacteristic(Characteristic.On);
        ch.onGet(() => ind.shown);
        // report only: put the switch back to what the tuner is doing
        ch.onSet(() => {
          setTimeout(() => svc.updateCharacteristic(Characteristic.On, ind.shown), 300);
        });
      } else {
        svc.getCharacteristic(Characteristic.OccupancyDetected).onGet(() => this.occupancy(ind.shown));
      }
      this.indicators.push(ind);
    };

    this.indicators = [];
    if (this.opts.tunerSensors !== false) {
      for (let i = 0; i < tunerCount; i++) {
        if (this.shows(i)) indicator(`tuner${i}`, `Tuner ${i + 1}`, (st) => st.tuners[i]?.inUse);
      }
    }
    if (this.opts.anyTunerSensor !== false) indicator('any', `${name} In Use`, (st) => st.tuners.some((t) => t.inUse));
    if (this.opts.allBusySensor) indicator('all', `${name} All Busy`, allBusy);

    this.onlineService = null;
    if (this.opts.onlineSensor) {
      this.onlineService = service(Service.ContactSensor, 'online', `${name} Online`);
      this.onlineService.getCharacteristic(Characteristic.ContactSensorState).onGet(() =>
        this.state?.online ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    }

    this.poorService = null;
    if (this.opts.poorReceptionSensor !== false) {
      // a different subtype from the tuner sensors, so it survives switching sensorType
      this.poorService = service(Service.OccupancySensor, 'poor-reception', `${name} Poor Reception`);
      this.poorService.getCharacteristic(Characteristic.OccupancyDetected).onGet(() => this.occupancy(!!this.state?.reception?.active));
    }

    // remove what was turned off, what changed type, or tuners the device no longer has
    const ours = [Service.Switch.UUID, Service.OccupancySensor.UUID, Service.ContactSensor.UUID];
    for (const s of a.services.slice()) {
      if (s.subtype && ours.includes(s.UUID) && !wanted.has(`${s.UUID}/${s.subtype}`)) a.removeService(s);
    }
  }

  /** `tuners: [1, 3]` shows only Tuner 1 and Tuner 3; empty or left out shows them all. */
  shows(index) {
    const list = Array.isArray(this.opts.tuners) ? this.opts.tuners.map(Number).filter((n) => n >= 1) : [];
    return !list.length || list.includes(index + 1);
  }

  occupancy(on) {
    const { OccupancyDetected } = this.hap.Characteristic;
    return on ? OccupancyDetected.OCCUPANCY_DETECTED : OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  /**
   * Applies the on and off delays. The first reading after a start is taken as it is,
   * so a restart while a tuner streams does not turn its switch off and on again.
   */
  settle(ind, raw, now) {
    settle(ind, raw, now, this.onDelayMs, this.offDelayMs);
  }

  setInfo(info) {
    if (!info) return;
    const { Service, Characteristic } = this.hap;
    const s = this.accessory.getService(Service.AccessoryInformation);
    s.updateCharacteristic(Characteristic.Manufacturer, 'SiliconDust');
    if (info.ModelNumber) s.updateCharacteristic(Characteristic.Model, `${info.FriendlyName || 'HDHomeRun'} ${info.ModelNumber}`.trim());
    if (info.DeviceID) s.updateCharacteristic(Characteristic.SerialNumber, String(info.DeviceID));
    const fw = firmwareRevision(info.FirmwareVersion);
    if (fw) s.updateCharacteristic(Characteristic.FirmwareRevision, fw);
  }

  update(state, now = Date.now()) {
    const { Characteristic } = this.hap;
    const tunerCount = Number(state.info?.TunerCount) || state.tuners.length;
    if (tunerCount && tunerCount !== this.accessory.context.tunerCount) {
      this.build(tunerCount);
      this.platform.api.updatePlatformAccessories([this.accessory]);
    }
    this.state = state;
    const fault = state.online ? Characteristic.StatusFault.NO_FAULT : Characteristic.StatusFault.GENERAL_FAULT;
    for (const ind of this.indicators) {
      this.settle(ind, Boolean(state.online && ind.test(state)), now);
      if (this.asSwitch) {
        ind.svc.updateCharacteristic(Characteristic.On, ind.shown);
      } else {
        ind.svc.updateCharacteristic(Characteristic.OccupancyDetected, this.occupancy(ind.shown));
        ind.svc.updateCharacteristic(Characteristic.StatusActive, !!state.online);
        ind.svc.updateCharacteristic(Characteristic.StatusFault, fault);
      }
    }
    if (this.onlineService) {
      this.onlineService.updateCharacteristic(Characteristic.ContactSensorState,
        state.online ? Characteristic.ContactSensorState.CONTACT_DETECTED : Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    }
    if (this.poorService) {
      this.poorService.updateCharacteristic(Characteristic.OccupancyDetected, this.occupancy(!!state.reception?.active));
      this.poorService.updateCharacteristic(Characteristic.StatusActive, !!state.online);
    }
  }
}

/**
 * Applies on and off delays to an indicator { raw, shown, changedAt, primed }.
 * The first reading after a start is taken as it is, so a restart while something
 * streams does not turn its switch off and on again.
 */
function settle(ind, raw, now, onDelayMs, offDelayMs) {
  if (!ind.primed) {
    Object.assign(ind, { primed: true, raw, shown: raw, changedAt: now });
    return;
  }
  if (raw !== ind.raw) {
    ind.raw = raw;
    ind.changedAt = now;
  }
  const held = now - ind.changedAt;
  if (raw && !ind.shown && held >= onDelayMs) ind.shown = true;
  if (!raw && ind.shown && held >= offDelayMs) ind.shown = false;
}

function delay(v, fallback) {
  const n = v === undefined || v === null || v === '' ? fallback : Number(v);
  return Math.max(0, Number.isFinite(n) ? n : fallback) * 1000;
}

function allBusy(st) {
  return st.tuners.length > 0 && st.tuners.every((t) => t.inUse);
}

/** HDHomeRun firmware "20250815" → "2025.8.15", which HomeKit accepts as a revision. */
function firmwareRevision(v) {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(String(v || ''));
  if (m) return `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}`;
  return /^\d+(\.\d+){0,2}$/.test(String(v || '')) ? String(v) : undefined;
}

export { TunerAccessory, firmwareRevision, settle, delay };
