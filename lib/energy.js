import fs from 'node:fs';
import path from 'node:path';
import { dayKey } from './stats.js';

const SAVE_EVERY_MS = 5 * 60 * 1000;
const KEEP_DAYS = 800;

/**
 * Estimated energy. The HDHomeRun has no power meter, so the plugin estimates its draw
 * from what it is doing — watts while idle plus watts per busy tuner — and adds it up
 * into kWh. Kept in energy.json:
 *   { totalMWh, days: { "2026-11-07": Wh }, devices: { <device id>: mWh } }
 * totalMWh only ever grows, as Matter's cumulative energy must.
 */
class EnergyMeter {
  constructor({ dir, log }) {
    this.file = dir ? path.join(dir, 'energy.json') : null;
    this.log = log;
    this.totalMWh = 0;
    this.days = {};
    this.byKey = {};
    this.parts = {};
    this.watts = 0;
    this.lastAt = null;
    this.savedAt = 0;
    if (this.file) {
      try {
        const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.totalMWh = Math.max(0, Number(d.totalMWh) || 0);
        this.days = d.days || {};
        this.byKey = d.devices || {};
      } catch { /* first run */ }
    }
  }

  /**
   * Adds the energy used since the last call at the previous draw, then sets the new draw.
   * parts: optional { <device id>: watts }, to keep a total per device as well.
   */
  tick(watts, now = Date.now(), maxGapMs = 60_000, parts) {
    if (this.lastAt !== null && now > this.lastAt) {
      const dt = Math.min(now - this.lastAt, maxGapMs);
      const mWh = (this.watts * dt) / 3600; // W·ms → mWh
      this.totalMWh += mWh;
      const k = dayKey(now);
      this.days[k] = (this.days[k] || 0) + mWh / 1000;
      for (const [id, w] of Object.entries(this.parts)) this.byKey[id] = (this.byKey[id] || 0) + (w * dt) / 3600;
    }
    if (parts) this.parts = { ...parts };
    this.watts = Math.max(0, Number(watts) || 0);
    this.lastAt = now;
    if (now - this.savedAt > SAVE_EVERY_MS) this.save(now);
  }

  save(now = Date.now()) {
    this.savedAt = now;
    if (!this.file) return;
    try {
      const keys = Object.keys(this.days).sort();
      const cutoff = dayKey(now - KEEP_DAYS * 86400_000);
      for (const k of keys) if (k < cutoff) delete this.days[k];
      fs.writeFileSync(`${this.file}.tmp`, JSON.stringify({ totalMWh: Math.round(this.totalMWh), days: this.days, devices: Object.fromEntries(Object.entries(this.byKey).map(([k, v]) => [k, Math.round(v)])) }));
      fs.renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      this.log?.debug?.(`could not save energy: ${e.message}`);
    }
  }
}

/** Energy per period for the dashboard, in Wh, with the cost if a price is set. */
function energySummary(data, { watts, pricePerKwh } = {}, now = Date.now()) {
  const days = data?.days || {};
  const back = (n) => {
    const out = [];
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    for (let i = 0; i < n; i++) { out.push(dayKey(d)); d.setDate(d.getDate() - 1); }
    return out;
  };
  const sum = (keys) => keys.reduce((s, k) => s + (days[k] || 0), 0);
  const y = back(2)[1];
  const periods = {
    today: sum([dayKey(now)]),
    yesterday: days[y] || 0,
    last7: sum(back(7)),
    last30: sum(back(30)),
    all: Object.values(days).reduce((s, v) => s + v, 0),
  };
  const price = Number(pricePerKwh) > 0 ? Number(pricePerKwh) : null;
  return {
    watts: watts ?? null,
    totalKWh: (Number(data?.totalMWh) || 0) / 1e6,
    periods,
    pricePerKwh: price,
    daily: back(30).reverse().map((k) => ({ day: k, wh: days[k] || 0 })),
  };
}

export { EnergyMeter, energySummary };
