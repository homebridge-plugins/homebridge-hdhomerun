import fs from 'node:fs';
import path from 'node:path';

const GUIDE_URL = 'https://api.hdhomerun.com/api/guide.php';
const REFRESH_MS = 30 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const KEEP_PER_CHANNEL = 8;

/**
 * Programme guide from SiliconDust, for "now" and "next" on the dashboard.
 * It is asked with the device's DeviceAuth, the same way the HDHomeRun app does,
 * and only has data where SiliconDust offers a guide for the device's area.
 */
class Guide {
  constructor({ dir, log, enabled = true, url }) {
    this.dir = dir;
    this.url = url || process.env.HDHR_GUIDE_URL || GUIDE_URL;
    this.log = log;
    this.enabled = enabled;
    this.devices = {}; // deviceId → { fetchedAt, status, error, channels: { number: [[start, end, title, episodeTitle]] } }
    this.next = {}; // deviceId → time of next fetch
    this.busy = new Set();
    this.warned = new Set();
    try {
      this.devices = JSON.parse(fs.readFileSync(this.file(), 'utf8')) || {};
    } catch { /* first run */ }
  }

  file() {
    return path.join(this.dir, 'guide.json');
  }

  /** Called on every poll; fetches when the guide is due. */
  maybeRefresh(deviceId, deviceAuth, now = Date.now()) {
    if (!this.enabled || !deviceId || !deviceAuth || this.busy.has(deviceId)) return;
    if (now < (this.next[deviceId] || 0)) return;
    const g = this.devices[deviceId];
    if (g && g.status === 'ok' && now - g.fetchedAt < REFRESH_MS && !this.runningOut(g, now)) {
      this.next[deviceId] = g.fetchedAt + REFRESH_MS;
      return;
    }
    this.busy.add(deviceId);
    this.fetch(deviceId, deviceAuth, now)
      .finally(() => this.busy.delete(deviceId));
  }

  runningOut(g, now) {
    // refresh early if most channels have nothing after the next hour
    const lists = Object.values(g.channels || {});
    if (!lists.length) return false;
    const short = lists.filter((l) => !l.length || l[l.length - 1][1] * 1000 < now + 3600_000).length;
    return short > lists.length / 2;
  }

  async fetch(deviceId, deviceAuth, now) {
    try {
      const res = await fetch(`${this.url}?DeviceAuth=${encodeURIComponent(deviceAuth)}`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('unexpected answer');
      const channels = {};
      for (const ch of data) {
        const list = (ch.Guide || [])
          .filter((p) => p.EndTime * 1000 > now)
          .sort((a, b) => a.StartTime - b.StartTime)
          .slice(0, KEEP_PER_CHANNEL)
          .map((p) => [p.StartTime, p.EndTime, p.Title || '', p.EpisodeTitle || '']);
        if (ch.GuideNumber !== undefined) channels[String(ch.GuideNumber)] = list;
      }
      const count = Object.values(channels).filter((l) => l.length).length;
      this.devices[deviceId] = { fetchedAt: now, status: count ? 'ok' : 'empty', channels };
      this.next[deviceId] = now + (count ? REFRESH_MS : 6 * 3600_000);
      if (!count && !this.warned.has(deviceId)) {
        this.warned.add(deviceId);
        this.log.info(`[guide] SiliconDust has no programme guide for HDHomeRun ${deviceId}; now and next will not show`);
      } else if (count) {
        this.log.debug(`[guide] ${count} channels for ${deviceId}`);
      }
      this.save();
    } catch (e) {
      const prev = this.devices[deviceId];
      this.devices[deviceId] = { ...(prev || { channels: {} }), status: prev?.status === 'ok' ? 'ok' : 'error', error: e.message, triedAt: now };
      this.next[deviceId] = now + RETRY_MS;
      if (!this.warned.has(`${deviceId}:err`)) {
        this.warned.add(`${deviceId}:err`);
        this.log.debug(`[guide] could not fetch the guide for ${deviceId}: ${e.message}`);
      }
    }
  }

  save() {
    try {
      const tmp = `${this.file()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.devices));
      fs.renameSync(tmp, this.file());
    } catch (e) {
      this.log.debug(`[guide] could not save: ${e.message}`);
    }
  }

  /** { deviceId: { status, channels: { number: { now, next } } } } for the dashboard. */
  static nowNext(devices, now = Date.now()) {
    const out = {};
    const t = now / 1000;
    for (const [id, g] of Object.entries(devices || {})) {
      const channels = {};
      for (const [num, list] of Object.entries(g.channels || {})) {
        const i = list.findIndex((p) => p[1] > t);
        if (i < 0) continue;
        const cur = list[i][0] <= t ? list[i] : null;
        const nxt = cur ? list[i + 1] : list[i];
        const fmt = (p) => (p ? { start: p[0] * 1000, end: p[1] * 1000, title: p[2], episodeTitle: p[3] || undefined } : null);
        channels[num] = { now: fmt(cur), next: fmt(nxt) };
      }
      out[id] = { status: g.status, fetchedAt: g.fetchedAt, channels };
    }
    return out;
  }
}

export { Guide, GUIDE_URL };
