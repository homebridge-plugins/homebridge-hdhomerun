'use strict';

/** Local calendar day, "2026-10-25". */
function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysBack(now, n) {
  const out = [];
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    out.push(dayKey(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/**
 * Sums the stored days into periods for the dashboard:
 *   today, last7, last30, all — each with tuner seconds per device, top channels, clients,
 *   sessions, seconds with every tuner busy, and the most tuners busy at once;
 * plus a series of the last 30 days and the hour-of-day profile of the last 30 days.
 */
function summarize(stats, now = Date.now()) {
  const days = stats?.days || {};
  const allKeys = Object.keys(days).sort();
  const periods = {
    today: [dayKey(now)],
    yesterday: [daysBack(now, 2)[1]],
    last7: daysBack(now, 7),
    last30: daysBack(now, 30),
    all: allKeys,
  };
  const out = { generated: now, since: allKeys[0] || null, periods: {}, daily: [], hours: new Array(24).fill(0) };

  for (const [name, keys] of Object.entries(periods)) {
    const p = { seconds: 0, onlineSeconds: 0, sessions: 0, allBusy: 0, peak: 0, devices: {}, channels: {}, clients: {}, days: 0 };
    for (const k of keys) {
      const d = days[k];
      if (!d) continue;
      p.days++;
      p.sessions += d.sessions || 0;
      for (const [id, dev] of Object.entries(d.devices || {})) {
        if (dev.virtual) {
          // online streams through Channels DVR: counted on their own, not as tuner time
          const pd = (p.devices[id] ||= { name: dev.name, virtual: true, tuners: {}, seconds: 0, allBusy: 0, peak: 0 });
          pd.name = dev.name || pd.name;
          pd.peak = Math.max(pd.peak, dev.peak || 0);
          for (const v of Object.values(dev.tuners || {})) { pd.seconds += v; p.onlineSeconds += v; }
          continue;
        }
        const pd = (p.devices[id] ||= { name: dev.name, tuners: {}, seconds: 0, allBusy: 0, peak: 0 });
        pd.name = dev.name || pd.name;
        pd.allBusy += dev.allBusy || 0;
        pd.peak = Math.max(pd.peak, dev.peak || 0);
        p.allBusy += dev.allBusy || 0;
        p.peak = Math.max(p.peak, dev.peak || 0);
        for (const [i, s] of Object.entries(dev.tuners || {})) {
          pd.tuners[i] = (pd.tuners[i] || 0) + s;
          pd.seconds += s;
          p.seconds += s;
        }
      }
      for (const [ck, c] of Object.entries(d.channels || {})) {
        const pc = (p.channels[ck] ||= { key: ck, number: c.number, name: c.name, seconds: 0 });
        pc.name = c.name || pc.name;
        pc.seconds += c.seconds;
      }
      for (const [ip, c] of Object.entries(d.clients || {})) {
        const pc = (p.clients[ip] ||= { ip, name: c.name, seconds: 0 });
        pc.name = c.name || pc.name;
        pc.seconds += c.seconds;
      }
    }
    p.channels = Object.values(p.channels).sort((a, b) => b.seconds - a.seconds).slice(0, 15);
    p.clients = Object.values(p.clients).sort((a, b) => b.seconds - a.seconds).slice(0, 10);
    out.periods[name] = p;
  }

  for (const k of periods.last30.slice().reverse()) {
    const d = days[k];
    let s = 0;
    let o = 0;
    for (const dev of Object.values(d?.devices || {})) for (const v of Object.values(dev.tuners || {})) { if (dev.virtual) o += v; else s += v; }
    out.daily.push({ day: k, seconds: s, onlineSeconds: o, sessions: d?.sessions || 0 });
    (d?.hours || []).forEach((v, h) => { out.hours[h] += v || 0; });
  }
  return out;
}

/**
 * Reception per channel: averages over the last 7 and 30 days, the lowest quality seen,
 * and a 14-day trend of average quality, per device, worst channels first.
 */
function receptionSummary(reception, now = Date.now()) {
  const last7 = new Set(daysBack(now, 7));
  const last30 = new Set(daysBack(now, 30));
  const trendDays = daysBack(now, 14).reverse();
  const out = {};
  for (const [id, chans] of Object.entries(reception || {})) {
    const rows = [];
    for (const [number, ch] of Object.entries(chans)) {
      const sum = (set) => {
        const a = [0, 0, 0, 0, 100];
        for (const [k, d] of Object.entries(ch.days || {})) {
          if (!set.has(k)) continue;
          a[0] += d[0]; a[1] += d[1]; a[2] += d[2]; a[3] += d[3]; a[4] = Math.min(a[4], d[4]);
        }
        return a[0] ? { samples: a[0], signalStrength: Math.round(a[1] / a[0]), signalQuality: Math.round(a[2] / a[0]), symbolQuality: Math.round(a[3] / a[0]), lowest: a[4] } : null;
      };
      const d30 = sum(last30);
      if (!d30) continue;
      rows.push({
        number,
        name: ch.name,
        frequency: ch.frequency,
        last: ch.last,
        d7: sum(last7),
        d30,
        trend: trendDays.map((k) => { const d = ch.days?.[k]; return d && d[0] ? Math.round(d[2] / d[0]) : null; }),
      });
    }
    rows.sort((a, b) => (a.d30.signalQuality - b.d30.signalQuality) || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
    out[id] = rows;
  }
  return out;
}

module.exports = { dayKey, summarize, receptionSummary };
