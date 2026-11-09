'use strict';

/** Just enough of the Homebridge API and HAP to run the plugin in tests. */

const crypto = require('crypto');
const { EventEmitter } = require('events');

class Characteristic {
  constructor(name) {
    this.displayName = name;
    this.value = null;
    this.getHandler = null;
  }
  onGet(fn) { this.getHandler = fn; return this; }
  onSet(fn) { this.setHandler = fn; return this; }
  async handleGet() { return this.getHandler ? this.getHandler() : this.value; }
  async handleSet(v) { this.value = v; if (this.setHandler) await this.setHandler(v); }
}
const charNames = ['Name', 'On', 'ConfiguredName', 'OccupancyDetected', 'StatusActive', 'StatusFault', 'ContactSensorState',
  'Manufacturer', 'Model', 'SerialNumber', 'FirmwareRevision'];
const C = {};
for (const n of charNames) C[n] = { UUID: `char-${n}`, displayName: n };
C.OccupancyDetected.OCCUPANCY_DETECTED = 1;
C.OccupancyDetected.OCCUPANCY_NOT_DETECTED = 0;
C.StatusFault.NO_FAULT = 0;
C.StatusFault.GENERAL_FAULT = 1;
C.ContactSensorState.CONTACT_DETECTED = 0;
C.ContactSensorState.CONTACT_NOT_DETECTED = 1;

class Service {
  constructor(displayName, UUID, subtype) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.subtype = subtype;
    this.chars = new Map();
    this.getCharacteristic(C.Name).value = displayName;
  }
  getCharacteristic(type) {
    if (!this.chars.has(type.UUID)) this.chars.set(type.UUID, new Characteristic(type.displayName));
    return this.chars.get(type.UUID);
  }
  setCharacteristic(type, v) { this.getCharacteristic(type).value = v; return this; }
  updateCharacteristic(type, v) { this.getCharacteristic(type).value = v; return this; }
  addOptionalCharacteristic() {}
  value(type) { return this.chars.get(type.UUID)?.value; }
}
const serviceType = (name) => {
  const T = class extends Service { constructor(dn, st) { super(dn, T.UUID, st); } };
  T.UUID = `svc-${name}`;
  return T;
};
const S = {
  AccessoryInformation: serviceType('AccessoryInformation'),
  OccupancySensor: serviceType('OccupancySensor'),
  ContactSensor: serviceType('ContactSensor'),
  Switch: serviceType('Switch'),
};

class PlatformAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.context = {};
    this.services = [new S.AccessoryInformation(displayName)];
  }
  getService(type) { return this.services.find((s) => s.UUID === type.UUID && !s.subtype); }
  getServiceById(type, subtype) { return this.services.find((s) => s.UUID === type.UUID && s.subtype === subtype); }
  addService(type, name, subtype) { const s = new type(name, subtype); this.services.push(s); return s; }
  removeService(s) { this.services = this.services.filter((x) => x !== s); }
}

/** Homebridge 2's Matter API, as far as the plugin uses it. */
function createMatter({ enabled = true } = {}) {
  const store = new Map(); // uuid → { accessory, state, handlers }
  const cache = new Map(); // uuid → cached state, as after a restart
  const matter = {
    enabled,
    deviceTypes: { OnOffOutlet: 'OnOffPlugInUnitDevice', MotionSensor: 'OccupancySensorDevice', ContactSensor: 'ContactSensorDevice' },
    registerCalls: 0,
    async registerPlatformAccessories(plugin, platform, list) {
      matter.registerCalls++;
      for (const a of list) {
        if (store.has(a.UUID)) throw new Error(`duplicate UUID ${a.UUID}`);
        // completes asynchronously, like a child bridge
        setTimeout(() => {
          const state = cache.get(a.UUID) || JSON.parse(JSON.stringify(a.clusters || {}));
          store.set(a.UUID, { accessory: a, state, handlers: a.handlers || {} });
        }, 200);
      }
    },
    async unregisterPlatformAccessories(plugin, platform, list) {
      for (const a of list) { store.delete(a.UUID); cache.delete(a.UUID); }
      matter.unregistered = (matter.unregistered || 0) + list.length;
    },
    async getAccessoryState(uuid, cluster) {
      return store.get(uuid)?.state[cluster];
    },
    async updateAccessoryState(uuid, cluster, attrs) {
      const e = store.get(uuid);
      if (!e) throw new Error('not registered');
      e.state[cluster] = { ...(e.state[cluster] || {}), ...attrs };
      e.updates = (e.updates || 0) + 1;
    },
    /** A Home app command: the handler runs, then Homebridge sets the commanded state. */
    async command(uuid, cluster, cmd) {
      const e = store.get(uuid);
      await e.handlers[cluster]?.[cmd]?.();
      if (cluster === 'onOff') e.state.onOff = { onOff: cmd === 'on' };
    },
    /** What a restart leaves: cached state, no handlers, nothing registered. */
    restart() {
      for (const [uuid, e] of store) cache.set(uuid, e.state);
      const cached = [...store.values()].map((e) => ({ ...e.accessory, handlers: undefined }));
      store.clear();
      return cached;
    },
    store,
  };
  return matter;
}

function createApi(storage, { matter } = {}) {
  const api = new EventEmitter();
  api.hap = {
    Service: S,
    Characteristic: C,
    uuid: { generate: (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 32) },
  };
  api.platformAccessory = PlatformAccessory;
  api.user = { storagePath: () => storage };
  api.registered = [];
  api.registerPlatform = (plugin, name, cls) => { api.Platform = cls; };
  api.registerPlatformAccessories = (p, n, list) => api.registered.push(...list);
  api.updatePlatformAccessories = () => {};
  api.unregisterPlatformAccessories = (p, n, list) => { api.registered = api.registered.filter((a) => !list.includes(a)); };
  if (matter) {
    api.matter = matter;
    api.serverVersion = '2.5.0';
    api.isMatterAvailable = () => true;
    api.isMatterEnabled = () => matter.enabled;
    api.versionGreaterOrEqual = () => true;
  }
  return api;
}

function createLog(lines = []) {
  const f = (lvl) => (...a) => { const l = `[${lvl}] ${a.join(' ')}`; lines.push(l); if (process.env.VERBOSE) console.log(l); };
  const log = f('info');
  Object.assign(log, { info: f('info'), warn: f('warn'), error: f('error'), debug: f('debug'), success: f('info') });
  log.lines = lines;
  return log;
}

module.exports = { createApi, createMatter, createLog, PlatformAccessory, Service: S, Characteristic: C };
