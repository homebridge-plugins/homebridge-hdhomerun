import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { dayKey } from './stats.js';

const MIN_SESSION_SECONDS = 3;
const KEEP_SESSIONS = 1000;
const HISTORY_HOURS = 24;

/**
 * Turns the stream of device snapshots into what the dashboard shows:
 *
 *  stats.json     usage per local day: seconds per tuner, channel, client and hour of day
 *  sessions.json  one entry per tuner session (a channel watched by a client, start to end)
 *  history.json   signal per tuner per minute, last 24 hours
 *  state.json     the latest snapshot of every device, for the Config UI tab
 *  lineup-<id>.json  each device's channel list
 *
 * All under <Homebridge storage>/hdhomerun-monitor/.
 */
class Recorder extends EventEmitter {
  constructor({ dir, log, keepDays = 400 }) {
    super();
    this.dir = dir;
    this.log = log;
    this.keepDays = keepDays;
    fs.mkdirSync(dir, { recursive: true });
    this.stats = readJson(this.file('stats.json'), { version: 1, days: {} });
    this.stats.days ||= {};
    const s = readJson(this.file('sessions.json'), { open: [], closed: [] });
    this.closed = Array.isArray(s.closed) ? s.closed : [];
    this.open = new Map();
    this.dirty = { stats: false, sessions: false, history: false, reception: false };
    // sessions left open by a restart are closed at the time they were last seen
    for (const o of s.open || []) this.finish(o, o.lastSeen || o.start, false);
    this.history = readJson(this.file('history.json'), {});
    this.reception = readJson(this.file('reception.json'), {});
    this.minute = new Map(); // key → { t, ss, snq, seq, n }
    this.devices = new Map(); // deviceKey → snapshot
    this.lastAt = new Map();
    this.stateWrittenAt = 0;
    this.stateSig = '';
    this.saveTimer = setInterval(() => this.save(), 5 * 60 * 1000);
    this.saveTimer.unref?.();
  }

  file(name) {
    return path.join(this.dir, name);
  }

  /** Called with every device snapshot from a DeviceMonitor. */
  update(snap, pollMs) {
    const now = snap.lastPoll || Date.now();
    const id = snap.deviceId || snap.key;
    this.devices.set(snap.key, snap);

    const prev = this.lastAt.get(snap.key);
    this.lastAt.set(snap.key, now);
    const dt = prev ? Math.min(now - prev, pollMs * 3) / 1000 : 0;

    const busy = snap.online ? snap.tuners.filter((t) => t.inUse) : [];
    if (dt > 0 && snap.online) this.accumulate(id, snap, busy, dt, now);
    this.trackSessions(id, snap, now);
    this.trackSignal(id, busy, now);
    this.trackReception(id, busy, now);
    this.writeState(now);
  }

  accumulate(id, snap, busy, dt, now) {
    const day = (this.stats.days[dayKey(now)] ||= { devices: {}, channels: {}, clients: {}, hours: new Array(24).fill(0), sessions: 0 });
    day.hours ||= new Array(24).fill(0);
    const dev = (day.devices[id] ||= { name: snap.name, tuners: {}, allBusy: 0, peak: 0, online: 0 });
    dev.name = snap.name;
    dev.online += dt;
    dev.peak = Math.max(dev.peak, busy.length);
    if (!snap.virtual && busy.length && busy.length >= snap.tuners.length) dev.allBusy += dt;
    if (busy.length && !snap.virtual) day.hours[new Date(now).getHours()] += dt;
    if (snap.virtual) dev.virtual = true;
    for (const t of busy) {
      dev.tuners[t.index] = (dev.tuners[t.index] || 0) + dt;
      const ck = channelKey(id, t);
      const ch = (day.channels[ck] ||= { number: t.channelNumber, name: t.channelName, seconds: 0 });
      if (t.channelName) ch.name = t.channelName;
      ch.seconds += dt;
      if (t.client) {
        const cl = (day.clients[t.client] ||= { name: t.clientName, seconds: 0 });
        if (t.clientName) cl.name = t.clientName;
        cl.seconds += dt;
      }
    }
    this.dirty.stats = true;
  }

  trackSessions(id, snap, now) {
    for (const t of snap.tuners) {
      const k = `${id}#${t.index}`;
      const open = this.open.get(k);
      const live = snap.online && t.inUse;
      const same = open && live && open.channelNumber === t.channelNumber && open.client === t.client;
      if (open && !same) {
        // seen ending now; if the device dropped off the network, it ended when last seen
        this.finish(open, snap.online ? now : (open.lastSeen || now), true);
        this.open.delete(k);
      }
      if (live) {
        let s = this.open.get(k);
        if (!s) {
          s = {
            id: `${now.toString(36)}-${id}-${t.index}`,
            deviceId: id,
            device: snap.name,
            tuner: t.index,
            channelNumber: t.channelNumber,
            channelName: t.channelName,
            client: t.client,
            clientName: t.clientName,
            source: t.source,
            activity: t.activity,
            start: now,
            lastSeen: now,
            signal: { n: 0, ss: 0, snq: 0, seq: 0, minSnq: null },
          };
          this.open.set(k, s);
          this.emit('session-start', s);
        }
        s.lastSeen = now;
        if (t.channelName) s.channelName = t.channelName;
        if (t.clientName) s.clientName = t.clientName;
        if (t.signalQuality !== undefined) {
          s.signal.n++;
          s.signal.ss += t.signalStrength || 0;
          s.signal.snq += t.signalQuality || 0;
          s.signal.seq += t.symbolQuality || 0;
          s.signal.minSnq = s.signal.minSnq === null ? t.signalQuality : Math.min(s.signal.minSnq, t.signalQuality);
        }
        this.dirty.sessions = true;
      }
    }
  }

  finish(s, end, announce) {
    const seconds = Math.max(0, Math.round((end - s.start) / 1000));
    if (seconds < MIN_SESSION_SECONDS) return;
    const n = s.signal?.n || 0;
    const done = {
      id: s.id,
      deviceId: s.deviceId,
      device: s.device,
      tuner: s.tuner,
      channelNumber: s.channelNumber,
      channelName: s.channelName,
      client: s.client,
      clientName: s.clientName,
      source: s.source,
      activity: s.activity,
      start: s.start,
      end,
      seconds,
      signalStrength: n ? Math.round(s.signal.ss / n) : undefined,
      signalQuality: n ? Math.round(s.signal.snq / n) : undefined,
      symbolQuality: n ? Math.round(s.signal.seq / n) : undefined,
      minSignalQuality: s.signal?.minSnq ?? undefined,
    };
    this.closed.unshift(done);
    if (this.closed.length > KEEP_SESSIONS) this.closed.length = KEEP_SESSIONS;
    const day = (this.stats.days[dayKey(s.start)] ||= { devices: {}, channels: {}, clients: {}, hours: new Array(24).fill(0), sessions: 0 });
    day.sessions = (day.sessions || 0) + 1;
    this.dirty.sessions = this.dirty.stats = true;
    if (announce) this.emit('session-end', done);
  }

  trackSignal(id, busy, now) {
    const minute = Math.floor(now / 60000) * 60000;
    for (const t of busy) {
      if (t.signalQuality === undefined && t.signalStrength === undefined) continue;
      const k = `${id}#${t.index}`;
      let m = this.minute.get(k);
      if (m && m.t !== minute) {
        this.pushHistory(id, t.index, m);
        m = null;
      }
      if (!m) this.minute.set(k, (m = { t: minute, ss: 0, snq: 0, seq: 0, n: 0 }));
      m.ss += t.signalStrength || 0;
      m.snq += t.signalQuality || 0;
      m.seq += t.symbolQuality || 0;
      m.n++;
    }
    // flush minutes of tuners that went idle
    for (const [k, m] of this.minute) {
      if (m.t !== minute) {
        const [dev, idx] = k.split('#');
        this.pushHistory(dev, Number(idx), m);
        this.minute.delete(k);
      }
    }
  }

  pushHistory(id, index, m) {
    const list = ((this.history[id] ||= {})[index] ||= []);
    list.push([m.t, Math.round(m.ss / m.n), Math.round(m.snq / m.n), Math.round(m.seq / m.n)]);
    const cutoff = Date.now() - HISTORY_HOURS * 3600_000;
    while (list.length && list[0][0] < cutoff) list.shift();
    this.dirty.history = true;
  }

  writeState(now) {
    const all = [...this.devices.values()];
    const devices = all.filter((d) => !d.virtual);
    const online = all.find((d) => d.virtual) || null;
    const sig = JSON.stringify(all.map((d) => [d.online, d.tuners.map((t) => [t.inUse, t.channelNumber, t.client])]));
    if (sig === this.stateSig && now - this.stateWrittenAt < 30000) return;
    this.stateSig = sig;
    this.stateWrittenAt = now;
    writeJson(this.file('state.json'), { generated: now, devices, online, open: this.openSessions() });
  }

  saveLineup(deviceId, lineup) {
    if (deviceId) writeJson(this.file(`lineup-${deviceId}.json`), lineup);
  }

  openSessions() {
    return [...this.open.values()].map((s) => {
      const n = s.signal.n;
      return {
        ...s,
        signal: undefined,
        seconds: Math.round((s.lastSeen - s.start) / 1000),
        signalQuality: n ? Math.round(s.signal.snq / n) : undefined,
      };
    });
  }

  /** Empties statistics and sessions (what the dashboard's Reset button does). */
  /**
   * Signal per channel per day, for the Reception tab:
   * reception[deviceId][channel] = { name, frequency, last, days: { day: [samples, ss, snq, seq, lowest snq] } }
   */
  trackReception(id, busy, now) {
    const day = dayKey(now);
    for (const t of busy) {
      if (t.signalQuality === undefined && t.signalStrength === undefined) continue;
      const key = String(t.channelNumber ?? (t.frequency ? `${Math.round(t.frequency / 1e5) / 10} MHz` : 'unknown'));
      const ch = ((this.reception[id] ||= {})[key] ||= { days: {} });
      if (t.channelName) ch.name = t.channelName;
      if (t.frequency) ch.frequency = t.frequency;
      ch.last = now;
      const d = (ch.days[day] ||= [0, 0, 0, 0, 100]);
      d[0]++;
      d[1] += t.signalStrength || 0;
      d[2] += t.signalQuality || 0;
      d[3] += t.symbolQuality || 0;
      if (t.signalQuality !== undefined) d[4] = Math.min(d[4], t.signalQuality);
      this.dirty.reception = true;
    }
  }

  reset() {
    this.stats = { version: 1, days: {} };
    this.closed = [];
    this.dirty.stats = this.dirty.sessions = true;
    this.save();
  }

  prune() {
    const keys = Object.keys(this.stats.days).sort();
    const cutoff = dayKey(Date.now() - this.keepDays * 86400_000);
    for (const k of keys) if (k < cutoff) delete this.stats.days[k];
  }

  save() {
    try {
      if (this.dirty.stats) {
        this.prune();
        writeJson(this.file('stats.json'), this.stats);
        this.dirty.stats = false;
      }
      if (this.dirty.sessions) {
        writeJson(this.file('sessions.json'), { open: [...this.open.values()], closed: this.closed });
        this.dirty.sessions = false;
      }
      if (this.dirty.reception) {
        const cutoff = dayKey(Date.now() - 60 * 86400_000);
        for (const chans of Object.values(this.reception)) {
          for (const ch of Object.values(chans)) for (const k of Object.keys(ch.days)) if (k < cutoff) delete ch.days[k];
        }
        writeJson(this.file('reception.json'), this.reception);
        this.dirty.reception = false;
      }
      if (this.dirty.history) {
        writeJson(this.file('history.json'), this.history);
        this.dirty.history = false;
      }
    } catch (e) {
      this.log.warn(`could not save statistics: ${e.message}`);
    }
  }

  close() {
    clearInterval(this.saveTimer);
    this.save();
  }
}

function channelKey(id, t) {
  return `${id}|${t.channelNumber ?? t.frequency ?? 'unknown'}`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export { Recorder, readJson, writeJson };
