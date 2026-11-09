import fs from 'node:fs';
import path from 'node:path';
import { summarize, receptionSummary } from './stats.js';
import { readJson } from './recorder.js';
import { Guide } from './guide.js';
import { analyze } from './channels.js';
import { energySummary } from './energy.js';

const SESSIONS_SHOWN = 200;

/**
 * Everything the dashboard shows, in one object. The plugin builds it from memory;
 * the Config UI tab builds it from the files when it cannot reach the plugin.
 */
function build({ devices, online, dvrStreams, combined, connection, energy, open, stats, closed, history, lineups, reception, guide, dvr, version, now = Date.now() }) {
  devices = devices || [];
  return {
    generated: now,
    version,
    devices,
    online: online || null,
    dvrStreams: dvrStreams || [],
    combined: combined || null,
    connection: connection || null,
    energy: energy || null,
    open: open || [],
    stats: summarize(stats, now),
    sessions: (closed || []).slice(0, SESSIONS_SHOWN),
    history: history || {},
    lineups: lineups || {},
    reception: receptionSummary(reception, now),
    guide: Guide.nowNext(guide, now),
    recordings: analyze(dvr, devices, now),
  };
}

function fromFiles(dir, version) {
  const state = readJson(path.join(dir, 'state.json'), { devices: [], open: [] });
  const sessions = readJson(path.join(dir, 'sessions.json'), { closed: [] });
  const lineups = {};
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = /^lineup-(.+)\.json$/.exec(f);
      if (m) lineups[m[1]] = readJson(path.join(dir, f), []);
    }
  } catch { /* no folder yet */ }
  const snap = build({
    devices: state.devices,
    online: state.online,
    open: state.open,
    stats: readJson(path.join(dir, 'stats.json'), { days: {} }),
    closed: sessions.closed,
    history: readJson(path.join(dir, 'history.json'), {}),
    lineups,
    reception: readJson(path.join(dir, 'reception.json'), {}),
    guide: readJson(path.join(dir, 'guide.json'), {}),
    dvr: readJson(path.join(dir, 'channels.json'), null),
    energy: energySummary(readJson(path.join(dir, 'energy.json'), null), { pricePerKwh: undefined }),
    version,
  });
  snap.stateAge = state.generated ? Date.now() - state.generated : null;
  snap.fromFiles = true;
  return snap;
}

export { build, fromFiles };
