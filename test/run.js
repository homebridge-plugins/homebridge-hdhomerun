'use strict';

/* End-to-end test: the plugin in a stand-in Homebridge against a mock HDHomeRun. */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hdhr = require('../src/hdhr');
const { DeviceMonitor } = require('../src/monitor');
const { createMock } = require('./mock-hdhomerun');
const { createApi, createMatter, createLog, Service, Characteristic } = require('./fake-homebridge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HTTP = 18080;
const DASH = 18588;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log(`  ✓ ${msg}`); };
const getJson = async (u) => (await fetch(u)).json();
const mockSet = (tuners) => fetch(`http://127.0.0.1:${HTTP}/mock`, { method: 'POST', body: JSON.stringify({ tuners }) });

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(200);
  }
  return false;
}

(async () => {
  console.log('protocol');
  ok(hdhr.crc32(Buffer.from('123456789')) === 0xcbf43926, 'CRC32 check value');
  const pkt = hdhr.buildPacket(4, [hdhr.encodeTlv(3, Buffer.from('/tuner0/status\0'))]);
  ok(hdhr.parsePacket(pkt).tags.get(3).toString() === '/tuner0/status\0', 'packet round trip');
  const long = hdhr.encodeTlv(4, Buffer.alloc(300, 65));
  ok(hdhr.parsePacket(hdhr.buildPacket(5, [long])).tags.get(4).length === 300, 'two-byte TLV length');
  ok(hdhr.parseTunerStatus('ch=auto:533000000 lock=t8bw ss=93 snq=100 seq=100 bps=19394080 pps=0').snq === '100', 'tuner status line');

  const mock = createMock({ port: HTTP });
  await mock.start();

  const found = await hdhr.discover({ targets: ['127.0.0.1'], timeoutMs: 600 });
  ok(found.length === 1 && found[0].deviceId === '1050ABCD' && found[0].tunerCount === 2, `UDP discovery finds the device (${JSON.stringify(found[0])})`);

  await mockSet([{ ch: '3', client: '192.168.1.42' }, null]);
  const items = await hdhr.getItems('127.0.0.1', ['/tuner0/status', '/tuner0/vchannel', '/tuner1/target', '/tuner9/status']);
  ok(items['/tuner0/vchannel'] === '3' && items['/tuner1/target'] === 'none' && !('/tuner9/status' in items), 'control protocol get, errors left out');

  console.log('plugin');
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-'));
  const api = createApi(storage);
  require('../src/index')(api);
  const log = createLog();
  const config = {
    platform: 'HDHomeRunMonitor',
    devices: [{ host: `127.0.0.1:${HTTP}`, name: 'Lounge HDHomeRun', sensorType: 'occupancy', allBusySensor: true, onlineSensor: true, onDelaySeconds: 0, offDelaySeconds: 0 }],
    discovery: false, homekitLayout: 'separate',
    pollSeconds: 2,
    dashboard: { port: DASH, host: '127.0.0.1' },
    clients: [{ ip: '192.168.1.20', name: 'Lounge Apple TV' }],
  };
  await mockSet([{ ch: '1', client: '192.168.1.20', snq: 95 }, null]);
  const platform = new api.Platform(log, config, api);
  api.emit('didFinishLaunching');

  ok(await waitFor(() => api.registered.length === 1), 'accessory registered');
  const acc = api.registered[0];
  const svc = (sub) => acc.getServiceById(sub === 'online' ? Service.ContactSensor : Service.OccupancySensor, sub);
  const occ = (sub) => svc(sub)?.value(Characteristic.OccupancyDetected);

  ok(await waitFor(() => occ('tuner0') === 1), 'Tuner 1 occupied while streaming');
  ok(occ('tuner1') === 0, 'Tuner 2 not occupied');
  ok(occ('any') === 1 && occ('all') === 0, 'In Use on, All Busy off');
  ok(svc('online').value(Characteristic.ContactSensorState) === 0, 'Online contact closed');
  const info = acc.getService(Service.AccessoryInformation);
  ok(info.value(Characteristic.SerialNumber) === '1050ABCD' && info.value(Characteristic.FirmwareRevision) === '2025.8.15', 'accessory information');
  ok(acc.displayName === 'Lounge HDHomeRun', 'configured name used');
  ok(await waitFor(() => occ('tuner0') === 1 && svc('tuner0').getCharacteristic(Characteristic.OccupancyDetected).handleGet().then((v) => v === 1)), 'onGet answers from state');

  let snap = await getJson(`http://127.0.0.1:${DASH}/api/snapshot`);
  const t0 = snap.devices[0].tuners[0];
  ok(t0.channelName === 'TVNZ 1' && t0.clientName === 'Lounge Apple TV' && t0.signalQuality > 80, `dashboard API shows the tuner (${t0.channelNumber} ${t0.channelName} → ${t0.clientName})`);
  ok(snap.lineups['1050ABCD'].length === 15, 'lineup in snapshot');
  ok(snap.open.length === 1, 'one open session');

  // SSE
  const ctrl = new AbortController();
  const es = await fetch(`http://127.0.0.1:${DASH}/api/events`, { signal: ctrl.signal });
  const reader = es.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  ok(first.startsWith('event: live') && first.includes('TVNZ 1'), 'server-sent events stream live state');
  ctrl.abort();

  const page = await (await fetch(`http://127.0.0.1:${DASH}/`)).text();
  ok(page.includes('HDRDashboard') || page.includes('HDHRDashboard'), 'dashboard page served');
  ok((await fetch(`http://127.0.0.1:${DASH}/../package.json`)).status === 404, 'no path traversal');
  ok((await fetch(`http://127.0.0.1:${DASH}/api/reset-stats`, { method: 'POST' })).status === 403, 'reset needs the header');

  console.log('sessions');
  await sleep(4500);
  await mockSet([{ ch: '2', client: '192.168.1.20' }, { ch: '8', client: '192.168.1.57' }]);
  ok(await waitFor(() => occ('all') === 1 && occ('tuner1') === 1), 'All Busy when both tuners stream');
  ok(log.lines.some((l) => l.includes('stopped 1 TVNZ 1')), 'channel change ends the session in the log');
  await sleep(3000);
  await mockSet([null, null]);
  ok(await waitFor(() => occ('any') === 0 && occ('all') === 0), 'sensors clear when idle');
  snap = await getJson(`http://127.0.0.1:${DASH}/api/snapshot`);
  ok(snap.sessions.length === 3 && snap.open.length === 0, `three finished sessions (${snap.sessions.map((s) => `${s.channelName} ${s.seconds}s`).join(', ')})`);
  const today = snap.stats.periods.today;
  ok(today.seconds > 8 && today.peak === 2 && today.allBusy > 0 && today.channels[0].name, `statistics: ${today.seconds.toFixed(0)} tuner-s, peak ${today.peak}, top ${today.channels[0].name}`);
  ok(snap.stats.daily.length === 30 && snap.stats.hours.some((h) => h > 0), 'daily and hourly series');

  console.log('offline');
  mock.stop();
  ok(await waitFor(() => svc('tuner0').value(Characteristic.StatusFault) === 1, 10000), 'StatusFault when unreachable');
  ok(svc('online').value(Characteristic.ContactSensorState) === 1, 'Online contact open');
  ok(log.lines.some((l) => l.includes('unreachable')), 'logged unreachable');

  api.emit('shutdown');
  const dir = path.join(storage, 'hdhomerun-monitor');
  for (const f of ['stats.json', 'sessions.json', 'state.json', 'lineup-1050ABCD.json']) ok(fs.existsSync(path.join(dir, f)), `${f} written`);

  console.log('restart from cache');
  const api2 = createApi(storage);
  require('../src/index')(api2);
  const p2 = new api2.Platform(createLog(), { ...config, dashboard: { enabled: false } }, api2);
  p2.configureAccessory(acc);
  api2.emit('didFinishLaunching');
  await sleep(300);
  ok(api2.registered.length === 0 && p2.handlers.size === 1, 'cached accessory reused, not re-registered');
  const snapFiles = require('../src/snapshot').fromFiles(dir, 'x');
  ok(snapFiles.sessions.length === 3 && snapFiles.stats.periods.today.sessions === 3, 'snapshot from files (Config UI fallback)');
  api2.emit('shutdown');

  console.log('control protocol fallback');
  const mock2 = createMock({ port: HTTP + 1, statusJson: false });
  await mock2.start();
  await fetch(`http://127.0.0.1:${HTTP + 1}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [null, { ch: '15', client: '192.168.1.42' }] }) });
  const m = new DeviceMonitor({ key: 'x', host: `127.0.0.1:${HTTP + 1}`, log: createLog(), pollSeconds: 2 });
  const upd = await new Promise((r) => { m.once('update', r); m.start(); });
  m.stop();
  mock2.stop();
  ok(upd.online && upd.source === 'control', 'falls back to the control protocol');
  ok(!upd.tuners[0].inUse && upd.tuners[1].inUse && upd.tuners[1].channelName === 'Sky Open' && upd.tuners[1].client === '192.168.1.42', `tuner 2: ${upd.tuners[1].channelNumber} ${upd.tuners[1].channelName} → ${upd.tuners[1].client}, ss ${upd.tuners[1].signalStrength}`);

  console.log('switches');
  const mock3 = createMock({ port: HTTP + 2 });
  await mock3.start();
  await fetch(`http://127.0.0.1:${HTTP + 2}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [{ ch: '1', client: '192.168.1.20' }, null] }) });
  const storage3 = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-'));
  const api3 = createApi(storage3);
  require('../src/index')(api3);
  const cfg3 = { devices: [{ host: `127.0.0.1:${HTTP + 2}`, name: 'Den HDHomeRun', onDelaySeconds: 0, offDelaySeconds: 0 }], discovery: false, homekitLayout: 'separate', pollSeconds: 2, dashboard: { enabled: false } };
  new api3.Platform(createLog(), cfg3, api3);
  api3.emit('didFinishLaunching');
  ok(await waitFor(() => api3.registered.length === 1), 'accessory registered (switch mode is the default)');
  const acc3 = api3.registered[0];
  const sw = (sub) => acc3.getServiceById(Service.Switch, sub);
  ok(sw('tuner0') && sw('tuner1') && sw('any') && !acc3.getServiceById(Service.OccupancySensor, 'tuner0'), 'switches for Tuner 1, Tuner 2 and In Use, no occupancy sensors');
  ok(await waitFor(() => sw('tuner0').value(Characteristic.On) === true && sw('any').value(Characteristic.On) === true), 'Tuner 1 switch on while streaming');
  ok(sw('tuner1').value(Characteristic.On) === false, 'Tuner 2 switch off while idle');
  ok(await sw('tuner0').getCharacteristic(Characteristic.On).handleGet() === true, 'switch onGet answers from state');
  await sw('tuner0').getCharacteristic(Characteristic.On).handleSet(false);
  ok(sw('tuner0').value(Characteristic.On) === false, 'tap in the Home app turns it off for a moment');
  ok(await waitFor(() => sw('tuner0').value(Characteristic.On) === true, 2000), 'and it goes back on, because the tuner is still streaming');
  await fetch(`http://127.0.0.1:${HTTP + 2}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [null, { ch: '2', client: '192.168.1.42' }] }) });
  ok(await waitFor(() => sw('tuner0').value(Characteristic.On) === false && sw('tuner1').value(Characteristic.On) === true), 'switches follow the tuners');
  await fetch(`http://127.0.0.1:${HTTP + 2}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [null, null] }) });
  ok(await waitFor(() => sw('any').value(Characteristic.On) === false), 'In Use switch off when idle');
  api3.emit('shutdown');
  // changing back to occupancy sensors replaces the switches on the cached accessory
  const api4 = createApi(storage3);
  require('../src/index')(api4);
  const p4 = new api4.Platform(createLog(), { ...cfg3, devices: [{ ...cfg3.devices[0], sensorType: 'occupancy' }] }, api4);
  p4.configureAccessory(acc3);
  api4.emit('didFinishLaunching');
  await sleep(300);
  ok(!acc3.services.some((s) => s.UUID === Service.Switch.UUID) && acc3.getServiceById(Service.OccupancySensor, 'tuner0'), 'switching to occupancy sensors removes the switches');
  api4.emit('shutdown');
  // only the tuners picked in `tuners`
  const api5 = createApi(fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-')));
  require('../src/index')(api5);
  new api5.Platform(createLog(), { ...cfg3, devices: [{ ...cfg3.devices[0], tuners: [2] }] }, api5);
  api5.emit('didFinishLaunching');
  ok(await waitFor(() => api5.registered.length === 1), 'accessory registered with tuners: [2]');
  const acc5 = api5.registered[0];
  ok(!acc5.getServiceById(Service.Switch, 'tuner0') && acc5.getServiceById(Service.Switch, 'tuner1') && acc5.getServiceById(Service.Switch, 'any'), 'only Tuner 2 has a switch (plus In Use)');
  await fetch(`http://127.0.0.1:${HTTP + 2}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [null, { ch: '3', client: '192.168.1.42' }] }) });
  ok(await waitFor(() => acc5.getServiceById(Service.Switch, 'tuner1').value(Characteristic.On) === true), 'Tuner 2 switch turns on while streaming');
  api5.emit('shutdown');
  mock3.stop();

  console.log('on and off delays');
  {
    const { TunerAccessory } = require('../src/accessory');
    const fakeApi = createApi(os.tmpdir());
    const pa = new fakeApi.platformAccessory('Test', 'u1');
    pa.context = { name: 'Test', tunerCount: 2 };
    const ta = new TunerAccessory({ api: fakeApi }, pa, { onDelaySeconds: 30, offDelaySeconds: 120 });
    const st = (a, b) => ({ online: true, info: { TunerCount: 2 }, tuners: [{ index: 0, inUse: a }, { index: 1, inUse: b }] });
    const on = (sub) => pa.getServiceById(Service.Switch, sub).value(Characteristic.On);
    let t = 1_000_000;
    ta.update(st(false, false), t);
    ta.update(st(true, false), (t += 5000));
    ok(on('tuner0') === false, 'not on straight away');
    ta.update(st(true, false), (t += 20000));
    ok(on('tuner0') === false, 'still off after 25 s');
    ta.update(st(true, false), (t += 10000));
    ok(on('tuner0') === true && on('any') === true, 'on after 30 s of streaming');
    ta.update(st(false, false), (t += 5000));
    ta.update(st(true, false), (t += 10000));
    ta.update(st(false, false), (t += 60000));
    ok(on('tuner0') === true, 'a short gap (channel change) keeps it on');
    ta.update(st(false, false), (t += 61000));
    ok(on('tuner0') === true, 'still on 61 s into the idle spell');
    ta.update(st(false, false), (t += 60000));
    ok(on('tuner0') === false && on('any') === false, 'off after 2 min idle');
    ta.update(st(true, false), (t += 5000));
    ta.update(st(false, false), (t += 10000));
    ta.update(st(false, false), (t += 60000));
    ok(on('tuner0') === false, 'a 10 s blip never turns it on');
    const pb = new fakeApi.platformAccessory('Test2', 'u2');
    pb.context = { name: 'Test2', tunerCount: 2 };
    const tb = new TunerAccessory({ api: fakeApi }, pb, {});
    tb.update(st(true, false), 5);
    ok(pb.getServiceById(Service.Switch, 'tuner0').value(Characteristic.On) === true, 'first reading after a restart is taken as it is');
  }

  console.log('poor reception');
  {
    const { ReceptionWatch } = require('../src/reception');
    const w = new ReceptionWatch({ threshold: 60, minutes: 3 });
    const tun = (q) => [{ index: 0, inUse: true, signalQuality: q, channelNumber: '3', channelName: 'ThreeNow' }, { index: 1, inUse: false }];
    let t = 0;
    ok(w.update(tun(55), true, t) === null, 'low but not for long yet');
    ok(w.update(tun(58), true, (t += 120000)) === null && !w.active, 'still under 3 min');
    ok(w.update(tun(40), true, (t += 61000)) === 'started' && w.state().detail.signalQuality === 40, 'alert after 3 min below 60%');
    ok(w.update(tun(90), true, (t += 30000)) === null && w.active, 'stays on for a moment after it recovers');
    ok(w.update(tun(90), true, (t += 61000)) === 'ended', 'clears after a minute of good signal');
    w.update(tun(50), true, (t += 1000));
    ok(w.update(tun(70), true, (t += 200000)) === null && !w.active, 'a dip that recovers never alerts');
    const idle = [{ index: 0, inUse: false }, { index: 1, inUse: false }];
    w.update(idle, true, (t += 1000));
    ok(!w.active, 'idle tuners do not alert');
  }

  console.log('guide, Channels DVR, reception per channel');
  const { createServices } = require('./mock-services');
  const services = createServices({ port: 18200 });
  await services.start();
  process.env.HDHR_GUIDE_URL = `${services.url}/api/guide.php`;
  const mock4 = createMock({ port: HTTP + 3 });
  await mock4.start();
  await fetch(`http://127.0.0.1:${HTTP + 3}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [{ ch: '1', client: '192.168.1.20', snq: 45 }, { ch: '3', client: '192.168.1.42', snq: 92 }] }) });
  const storage6 = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-'));
  const api6 = createApi(storage6);
  require('../src/index')(api6);
  const log6 = createLog();
  new api6.Platform(log6, {
    devices: [{ host: `127.0.0.1:${HTTP + 3}`, name: 'Lounge HDHomeRun', poorReceptionThreshold: 60, poorReceptionMinutes: 0.05 }],
    discovery: false, homekitLayout: 'separate', pollSeconds: 2, dashboard: { port: DASH + 1, host: '127.0.0.1' }, channelsDvr: { url: services.url },
  }, api6);
  api6.emit('didFinishLaunching');
  ok(await waitFor(() => api6.registered.some((x) => x.context?.deviceId)), 'accessory registered');
  const acc6 = api6.registered.find((x) => x.context?.deviceId);
  const poor = () => acc6.getServiceById(Service.OccupancySensor, 'poor-reception')?.value(Characteristic.OccupancyDetected);
  ok(await waitFor(() => poor() === 1, 10000), 'Poor Reception sensor occupied when quality stays low');
  ok(log6.lines.some((l) => l.includes('poor reception: Tuner 1 on 1 TVNZ 1 at')), 'poor reception logged with tuner and channel');
  let s6;
  ok(await waitFor(async () => { s6 = await getJson(`http://127.0.0.1:${DASH + 1}/api/snapshot`); return s6.guide['1050ABCD']?.channels?.['1']?.now; }, 10000), 'guide fetched');
  ok(s6.guide['1050ABCD'].channels['1'].now.title === 'Te Karere' && s6.guide['1050ABCD'].channels['1'].next.title === 'TVNZ News at Six', `now and next: ${s6.guide['1050ABCD'].channels['1'].now.title} → ${s6.guide['1050ABCD'].channels['1'].next.title}`);
  ok(!JSON.stringify(s6.devices).includes('"DeviceAuth":"abc"'), 'DeviceAuth kept out of the dashboard API');
  const rec = s6.recordings;
  ok(rec.status === 'ok' && rec.recordingNow.length === 1 && rec.recordingNow[0].title === 'Fair Go', 'Channels DVR: recording now');
  ok(rec.upcoming.length === 4 && rec.recent.length === 3 && rec.recent[0].title === 'Shortland Street', 'upcoming and recent recordings (episodes and movies, newest first)');
  ok(rec.warnings.filter((w) => w.level === 'bad').length === 3 && /3 recordings at once/.test(rec.warnings[0].text), `clash warned: ${rec.warnings[0].title} — ${rec.warnings[0].text}`);
  ok(await waitFor(async () => { s6 = await getJson(`http://127.0.0.1:${DASH + 1}/api/snapshot`); return (s6.reception['1050ABCD'] || []).length === 2; }), 'reception per channel recorded');
  const r1 = s6.reception['1050ABCD'][0];
  ok(r1.number === '1' && r1.d30.signalQuality < 60 && r1.frequency && r1.trend.length === 14, `worst channel first: ${r1.number} ${r1.name} at ${r1.d30.signalQuality}%`);
  api6.emit('shutdown');
  const files = require('../src/snapshot').fromFiles(path.join(storage6, 'hdhomerun-monitor'), 'x');
  ok(files.guide['1050ABCD'] && files.recordings.status === 'ok' && files.reception['1050ABCD'], 'guide, recordings and reception also from the files');
  mock4.stop();
  services.stop();

  console.log('Channels DVR online channels');
  {
    const { parseActivity } = require('../src/activity');
    const parsed = parseActivity({
      '6-stream-M3U-Online-192.168.1.20': 'Watching ch104 Sky News from Lounge Apple TV (192.168.1.20): buf=0% drop=0%',
      '6-stream-1050ABCD-192.168.1.42': 'Watching ch1 TVNZ 1 from Bedroom TV (192.168.1.42)',
      '7-stream-TVE-hulu_live-10.0.0.2': 'Watching ch7 from 10.0.0.2',
      'x': "Streaming 'A movie' to Lounge",
    });
    ok(parsed.length === 3, 'activity parsed (VOD playback ignored)');
    ok(parsed[0].kind === 'online' && parsed[0].sourceName === 'Online' && parsed[0].channelNumber === '104' && parsed[0].device === 'Lounge Apple TV' && parsed[0].ip === '192.168.1.20', 'M3U stream: source, channel, device and IP');
    ok(parsed[1].kind === 'tuner' && parsed[1].deviceId === '1050ABCD', 'HDHomeRun stream recognised by its device ID');
    ok(parsed[2].kind === 'online' && parsed[2].sourceName === 'TVE Hulu' && parsed[2].ip === '10.0.0.2', 'TV Everywhere stream');

    const services2 = createServices({ port: 18201 });
    await services2.start();
    const mock5 = createMock({ port: HTTP + 4 });
    await mock5.start();
    const storage7 = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-'));
    const api7 = createApi(storage7);
    require('../src/index')(api7);
    const log7 = createLog();
    const p7 = new api7.Platform(log7, {
      devices: [{ host: `127.0.0.1:${HTTP + 4}`, name: 'Lounge HDHomeRun', onDelaySeconds: 0, offDelaySeconds: 0 }],
      discovery: false, homekitLayout: 'separate', pollSeconds: 2, guide: false, dashboard: { port: DASH + 2, host: '127.0.0.1' },
      channelsDvr: { url: services2.url, onDelaySeconds: 0, offDelaySeconds: 0, channelSwitches: ['104', '120'] },
      clients: [{ ip: '192.168.1.57', name: 'Kitchen iPad' }],
    }, api7);
    api7.emit('didFinishLaunching');
    const findOnline = () => api7.registered.find((a) => a.context?.kind === 'channels-online');
    ok(await waitFor(() => findOnline()), 'Channels DVR accessory registered');
    const accO = findOnline();
    const swO = (sub) => accO.getServiceById(Service.Switch, sub);
    ok(swO('online') && swO('ch-104') && swO('ch-120'), 'switches: Online TV In Use, and one per listed channel');
    ok(swO('ch-104').displayName === 'Sky News Online 104', `channel switch named from Channels DVR (${swO('ch-104').displayName})`);
    ok(swO('online').value(Characteristic.On) === false, 'off while nothing online is watched');

    services2.setActivity({ '6-stream-M3U-Online-192.168.1.57': 'Watching ch104 from Kitchen (192.168.1.57): buf=0%' });
    ok(await waitFor(() => swO('online').value(Characteristic.On) === true && swO('ch-104').value(Characteristic.On) === true), 'watching an online channel turns Online TV In Use and its channel switch on');
    ok(swO('ch-120').value(Characteristic.On) === false, 'other channel switches stay off');
    let s7;
    ok(await waitFor(async () => { s7 = await getJson(`http://127.0.0.1:${DASH + 2}/api/snapshot`); return s7.online?.tuners?.some((t) => t.inUse); }), 'dashboard shows the online stream');
    const ot = s7.online.tuners.find((t) => t.inUse);
    ok(ot.channelNumber === '104' && ot.channelName === 'Sky News Online' && ot.clientName === 'Kitchen iPad' && ot.source === 'Online' && ot.programme?.title === 'World News Live',
      `online stream: ch ${ot.channelNumber} ${ot.channelName}, "${ot.programme?.title}" → ${ot.clientName} via ${ot.source}`);
    ok(log7.lines.some((l) => l.includes('[Channels DVR] Online: ch 104 Sky News Online → Kitchen iPad')), 'logged');
    await sleep(3500);

    await fetch(`http://127.0.0.1:${HTTP + 4}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [{ ch: '1', client: '127.0.0.1' }, null] }) });
    services2.setActivity({ '6-stream-1050ABCD-192.168.1.20': 'Watching ch1 TVNZ 1 from Lounge Apple TV (192.168.1.20)' });
    ok(await waitFor(() => swO('online').value(Characteristic.On) === false), 'an HDHomeRun channel through Channels DVR does not turn the online switch on');
    let s7b;
    ok(await waitFor(async () => { s7b = await getJson(`http://127.0.0.1:${DASH + 2}/api/snapshot`); return s7b.devices[0]?.tuners[0]?.via; }),
      'HDHomeRun tuner used by Channels DVR is marked');
    ok(s7b.devices[0].tuners[0].clientName === 'Lounge Apple TV' && s7b.devices[0].tuners[0].client === '192.168.1.20', 'and shows the real viewer, not the Channels DVR server');
    await fetch(`http://127.0.0.1:${HTTP + 4}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [null, null] }) });

    services2.setActivity({ '9-job-1': 'Recording ch120 for Big Movie until 11:00pm: buf=0%' });
    await sleep(4500);
    ok(swO('online').value(Characteristic.On) === false && swO('ch-120').value(Characteristic.On) === false, 'recordings do not count unless "include recordings" is on');
    s7 = await getJson(`http://127.0.0.1:${DASH + 2}/api/snapshot`);
    const rt = s7.online.tuners.find((t) => t.inUse);
    ok(rt && rt.activity === 'recording' && rt.source === 'Online', 'a recording of a channel the HDHomeRun lacks is shown as online');

    services2.setActivity({});
    await sleep(2500);
    s7 = await getJson(`http://127.0.0.1:${DASH + 2}/api/snapshot`);
    const onlineSessions = s7.sessions.filter((x) => x.deviceId === 'ONLINE');
    ok(onlineSessions.length >= 2 && onlineSessions.some((x) => x.channelNumber === '104' && x.source === 'Online' && x.clientName === 'Kitchen iPad'), `online sessions recorded (${onlineSessions.length})`);
    ok(s7.stats.periods.today.onlineSeconds > 0 && s7.stats.periods.today.channels.some((c) => c.key === 'ONLINE|104'), 'online time counted separately from tuner time');
    ok(!s7.devices.some((d) => d.virtual), 'the online device is kept out of the HDHomeRun list');
    api7.emit('shutdown');

    {
      const { OnlineAccessory } = require('../src/online-accessory');
      const fa = createApi(os.tmpdir());
      const pa = new fa.platformAccessory('Channels DVR', 'o1');
      pa.context = { kind: 'channels-online' };
      const oa = new OnlineAccessory({ api: fa }, pa, { includeRecordings: true, onDelaySeconds: 0, offDelaySeconds: 0 });
      oa.update([], true, 1);
      oa.update([{ kind: 'online', activity: 'recording', channelNumber: '120' }], true, 2);
      ok(pa.getServiceById(Service.Switch, 'online').value(Characteristic.On) === true, '"include recordings" turns the online switch on for a recording');
    }
    // turning the online switches off removes the accessory
    const api8 = createApi(storage7);
    require('../src/index')(api8);
    const p8 = new api8.Platform(createLog(), { devices: [], discovery: false, homekitLayout: 'separate', dashboard: { enabled: false }, channelsDvr: { url: services2.url, homekit: false } }, api8);
    api8.registered.push(accO);
    p8.configureAccessory(accO);
    api8.emit('didFinishLaunching');
    await sleep(300);
    ok(!api8.registered.includes(accO), 'removed from HomeKit when turned off');
    api8.emit('shutdown');
    mock5.stop();
    services2.stop();
  }

  console.log('combined "TV In Use" switch (default layout)');
  {
    const services3 = createServices({ port: 18202 });
    await services3.start();
    services3.setJobs([]);
    const mock6 = createMock({ port: HTTP + 5 });
    await mock6.start();
    const storage9 = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-'));
    const api9 = createApi(storage9);
    require('../src/index')(api9);
    const log9 = createLog();
    const cfg9 = {
      devices: [{ host: `127.0.0.1:${HTTP + 5}`, name: 'Lounge HDHomeRun' }],
      discovery: false, pollSeconds: 2, guide: false, dashboard: { port: DASH + 3, host: '127.0.0.1' },
      channelsDvr: { url: services3.url }, combined: { onDelaySeconds: 0, offDelaySeconds: 0 },
    };
    api9.platformInstance = new api9.Platform(log9, cfg9, api9);
    api9.emit('didFinishLaunching');
    const tv = () => api9.registered.find((a) => a.context?.kind === 'combined');
    ok(tv(), 'TV accessory added straight away');
    const sw = () => tv().getServiceById(Service.Switch, 'combined');
    ok(sw() && sw().displayName === 'TV In Use', 'one "TV In Use" switch');
    ok(await waitFor(() => api9.registered.some((a) => a.context?.deviceId)), 'HDHomeRun accessory still added, for the Poor Reception sensor');
    const hd = api9.registered.find((a) => a.context?.deviceId);
    ok(!hd.services.some((x) => x.UUID === Service.Switch.UUID) && hd.getServiceById(Service.OccupancySensor, 'poor-reception'), 'no tuner switches, only the Poor Reception sensor');
    await sleep(2500);
    ok(!api9.registered.some((a) => a.context?.kind === 'channels-online'), 'no separate Online TV accessory');
    ok(sw().value(Characteristic.On) === false, 'off while nothing is in use');

    await fetch(`http://127.0.0.1:${HTTP + 5}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [{ ch: '2', client: '192.168.1.20' }, null] }) });
    ok(await waitFor(() => sw().value(Characteristic.On) === true), 'on while an HDHomeRun tuner streams');
    await fetch(`http://127.0.0.1:${HTTP + 5}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [null, null] }) });
    ok(await waitFor(() => sw().value(Characteristic.On) === false), 'off when it stops');

    services3.setActivity({ '6-stream-M3U-Online-192.168.1.42': 'Watching ch104 from Bedroom TV (192.168.1.42)' });
    ok(await waitFor(() => sw().value(Characteristic.On) === true), 'on while an online channel is watched');
    let s9;
    ok(await waitFor(async () => { s9 = await getJson(`http://127.0.0.1:${DASH + 3}/api/state`); return s9.combined?.on; }) && s9.combined.reasons[0] === 'Online · ch 104', `dashboard says why: ${s9.combined.reasons.join(', ')}`);
    services3.setActivity({});
    ok(await waitFor(() => sw().value(Characteristic.On) === false), 'off when it stops');

    services3.setActivity({ '9-job-1': 'Recording ch120 for Big Movie until 11:00pm: buf=0%' });
    ok(await waitFor(() => sw().value(Characteristic.On) === true), 'on while recording an online channel');
    services3.setActivity({});
    ok(await waitFor(() => sw().value(Characteristic.On) === false), 'off when the recording ends');

    const t = Math.floor(Date.now() / 1000);
    services3.setJobs([{ id: 'r', name: 'The Chase', start_time: t - 60, end_time: t + 1800, duration: 1860, channels: ['2'], skipped: false, failed: false, item: { title: 'The Chase' } }]);
    await services3.setActivity({});
    await p9poll();
    ok(sw().value(Characteristic.On) === true, 'on while Channels DVR has a recording running');
    ok(log9.lines.some((l) => l.includes('TV In Use: on')), 'switching on and off is logged');
    api9.emit('shutdown');

    // switching to separate switches removes the TV accessory and brings back the tuner switches
    const tvAcc = tv();
    const api10 = createApi(storage9);
    require('../src/index')(api10);
    const p10 = new api10.Platform(createLog(), { ...cfg9, homekitLayout: 'separate', dashboard: { enabled: false } }, api10);
    api10.registered.push(tvAcc, hd);
    p10.configureAccessory(tvAcc);
    p10.configureAccessory(hd);
    api10.emit('didFinishLaunching');
    ok(!api10.registered.includes(tvAcc), 'separate layout removes the TV accessory');
    ok(await waitFor(() => hd.getServiceById(Service.Switch, 'tuner0')), 'and the tuner switches come back');
    api10.emit('shutdown');
    mock6.stop();
    services3.stop();

    async function p9poll() {
      // the jobs list is read once a minute; read it now
      const plat = p9();
      await plat.dvr.poll();
      plat.updateCombined(Date.now());
    }
    function p9() { return api9.platformInstance; }
  }

  console.log('TV In Use over Matter, with estimated watts and kWh');
  {
    process.env.HDHR_MATTER_POWER_MS = '200';
    process.env.HDHR_MATTER_ENERGY_MS = '500';
    const { EnergyMeter } = require('../src/energy');
    const em = new EnergyMeter({});
    em.tick(4, 0);
    em.tick(4, 3600_000, 3600_000);
    ok(Math.round(em.totalMWh) === 4000, 'energy meter: 4 W for an hour is 4 Wh (4000 mWh)');

    const mock7 = createMock({ port: HTTP + 6 });
    await mock7.start();
    const storage11 = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-'));
    const matter = createMatter({ enabled: true });
    const api11 = createApi(storage11, { matter });
    require('../src/index')(api11);
    const log11 = createLog();
    const cfg11 = {
      devices: [{ host: `127.0.0.1:${HTTP + 6}`, name: 'Lounge HDHomeRun' }],
      discovery: false, pollSeconds: 2, guide: false, dashboard: { port: DASH + 4, host: '127.0.0.1' },
      channelsDvr: { enabled: false }, combined: { onDelaySeconds: 0, offDelaySeconds: 0 },
      energy: { idleWatts: 3, tunerWatts: 1, pricePerKwh: 0.3 },
    };
    new api11.Platform(log11, cfg11, api11);
    api11.emit('didFinishLaunching');
    let entry;
    ok(await waitFor(() => (entry = [...matter.store.values()][0])), 'TV In Use registered on the Matter bridge');
    const a = entry.accessory;
    ok(a.deviceType === 'OnOffPlugInUnitDevice' && a.displayName === 'TV In Use', 'as an outlet, so the Home app shows its watts');
    ok(a.clusters.electricalPowerMeasurement && a.clusters.electricalEnergyMeasurement?.cumulativeEnergyImported, 'with power and cumulative energy clusters');
    ok(!api11.registered.some((x) => x.context?.kind === 'combined'), 'no separate HAP TV In Use');
    ok(api11.registered.some((x) => x.context?.deviceId), 'HDHomeRun accessory (Poor Reception) still on HAP');
    const st = () => entry.state;
    ok(await waitFor(() => st().electricalPowerMeasurement?.activePower === 3000), 'idle: 3 W (3000 mW) on the tile');
    ok(st().onOff.onOff === false, 'off while nothing is watched');

    await fetch(`http://127.0.0.1:${HTTP + 6}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [{ ch: '1', client: '192.168.1.20' }, { ch: '2', client: '192.168.1.42' }] }) });
    ok(await waitFor(() => st().onOff.onOff === true && st().electricalPowerMeasurement.activePower === 5000), 'two tuners streaming: on, 5 W');
    await matter.command(a.UUID, 'onOff', 'off');
    ok(st().onOff.onOff === false, 'a tap in the Home app turns it off for a moment');
    ok(await waitFor(() => st().onOff.onOff === true, 3000), 'and it goes back on, because the TV is still in use');
    ok(await waitFor(() => (st().electricalEnergyMeasurement?.cumulativeEnergyImported?.energy || 0) > 0, 5000), `energy adds up (${st().electricalEnergyMeasurement.cumulativeEnergyImported.energy} mWh)`);
    let snap11;
    ok(await waitFor(async () => { snap11 = await getJson(`http://127.0.0.1:${DASH + 4}/api/snapshot`); return snap11.energy?.watts === 5; }), 'dashboard: estimated watts');
    ok(snap11.energy.periods.today > 0 && snap11.energy.pricePerKwh === 0.3 && snap11.combined.matter === 'ready', 'dashboard: energy today, price, Matter ready');
    ok(log11.lines.some((l) => l.includes('[Matter] "TV In Use" published')), 'logged');
    await fetch(`http://127.0.0.1:${HTTP + 6}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [null, null] }) });
    ok(await waitFor(() => st().onOff.onOff === false && st().electricalPowerMeasurement.activePower === 3000), 'stops: off, back to 3 W');
    const before = st().electricalEnergyMeasurement.cumulativeEnergyImported.energy;
    api11.emit('shutdown');

    // restart: registered again (handlers can't be cached), energy carries on from where it was
    const cachedMatter = matter.restart();
    const api12 = createApi(storage11, { matter });
    require('../src/index')(api12);
    const p12 = new api12.Platform(createLog(), { ...cfg11, dashboard: { enabled: false } }, api12);
    for (const c of cachedMatter) p12.configureMatterAccessory(c);
    const calls = matter.registerCalls;
    api12.emit('didFinishLaunching');
    ok(await waitFor(() => matter.registerCalls > calls && matter.store.size === 1), 'registered again after a restart');
    const e2 = [...matter.store.values()][0];
    ok(typeof e2.handlers.onOff?.off === 'function', 'with its handlers back');
    ok(await waitFor(() => (e2.state.electricalEnergyMeasurement?.cumulativeEnergyImported?.energy || 0) >= before), 'energy total never goes backwards');
    api12.emit('shutdown');

    // Matter turned off for the bridge: back to the plain HAP switch, and the Matter one removed
    const cached2 = matter.restart();
    matter.enabled = false;
    const api13 = createApi(storage11, { matter });
    require('../src/index')(api13);
    const log13 = createLog();
    const p13 = new api13.Platform(log13, { ...cfg11, dashboard: { enabled: false } }, api13);
    for (const c of cached2) p13.configureMatterAccessory(c);
    api13.emit('didFinishLaunching');
    await sleep(300);
    ok(api13.registered.some((x) => x.context?.kind === 'combined'), 'without Matter, TV In Use is a HAP switch');
    ok(matter.unregistered >= 1, 'and the Matter one is removed');
    ok(log13.lines.some((l) => l.includes('turn on Matter for this plugin')), 'the log says how to get watts');
    api13.emit('shutdown');

    // no Matter API at all (Homebridge 1.x)
    const api14 = createApi(fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-')));
    require('../src/index')(api14);
    new api14.Platform(createLog(), { ...cfg11, dashboard: { enabled: false } }, api14);
    api14.emit('didFinishLaunching');
    ok(api14.registered.some((x) => x.context?.kind === 'combined'), 'Homebridge 1.x: plain HAP switch');
    api14.emit('shutdown');
    mock7.stop();
  }

  console.log('Matter only');
  {
    const { createServices: cs } = require('./mock-services');
    const services4 = cs({ port: 18203 });
    await services4.start();
    services4.setJobs([]);
    const mock8 = createMock({ port: HTTP + 7 });
    await mock8.start();
    const storage15 = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-'));
    const matter = createMatter({ enabled: true });
    const byName = (n) => [...matter.store.values()].find((e) => e.accessory.displayName === n);
    const names = () => [...matter.store.values()].map((e) => e.accessory.displayName).sort();

    // seed a HomeKit (1.6-style) run first, so there is a cached HAP accessory to remove
    const api15 = createApi(storage15, { matter });
    require('../src/index')(api15);
    const cfg15 = {
      appleHome: 'matter',
      devices: [{ host: `127.0.0.1:${HTTP + 7}`, name: 'Lounge HDHomeRun', onlineSensor: true, poorReceptionThreshold: 60, poorReceptionMinutes: 0.03 }],
      discovery: false, pollSeconds: 2, guide: false, dashboard: { enabled: false },
      channelsDvr: { url: services4.url }, combined: { onDelaySeconds: 0, offDelaySeconds: 0 },
    };
    new api15.Platform(createLog(), cfg15, api15);
    api15.emit('didFinishLaunching');
    ok(await waitFor(() => api15.registered.some((x) => x.context?.deviceId)), 'HomeKit + Matter: HDHomeRun on HomeKit');
    const hapCached = [...api15.registered];
    api15.emit('shutdown');

    // now Matter only
    const cachedM = matter.restart();
    const api16 = createApi(storage15, { matter });
    require('../src/index')(api16);
    const log16 = createLog();
    const p16 = new api16.Platform(log16, { ...cfg15, appleHome: 'matterOnly' }, api16);
    for (const a of hapCached) { api16.registered.push(a); p16.configureAccessory(a); }
    for (const a of cachedM) p16.configureMatterAccessory(a);
    api16.emit('didFinishLaunching');
    ok(api16.registered.length === 0, 'Matter only: HomeKit accessories removed, nothing on HomeKit');
    ok(await waitFor(() => names().length === 3), `on Matter: ${names().join(', ')}`);
    const tv = byName('TV In Use');
    const poor = byName('Lounge HDHomeRun Poor Reception');
    const online = byName('Lounge HDHomeRun Online');
    ok(tv && tv.accessory.deviceType === 'OnOffPlugInUnitDevice' && tv.accessory.clusters.electricalPowerMeasurement, 'TV In Use: outlet with watts (same accessory as before)');
    ok(poor && poor.accessory.deviceType === 'OccupancySensorDevice', 'Poor Reception: occupancy sensor');
    ok(online && online.accessory.deviceType === 'ContactSensorDevice', 'Online: contact sensor');
    ok(await waitFor(() => online.state.booleanState?.stateValue === true), 'Online: closed while the HDHomeRun answers');

    await fetch(`http://127.0.0.1:${HTTP + 7}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [{ ch: '1', client: '192.168.1.20', snq: 40 }, null] }) });
    ok(await waitFor(() => tv.state.onOff?.onOff === true && tv.state.electricalPowerMeasurement?.activePower === 4000), 'TV In Use on, 4 W');
    ok(await waitFor(() => poor.state.occupancySensing?.occupancy?.occupied === true, 10000), 'Poor Reception occupied when quality stays low');
    ok(log16.lines.some((l) => l.includes('Matter only')), 'logged: Matter only, pair the Matter code');

    mock8.stop();
    ok(await waitFor(() => online.state.booleanState?.stateValue === false, 12000), 'Online opens when the HDHomeRun stops answering');
    ok(poor.state.bridgedDeviceBasicInformation?.reachable === false, 'Poor Reception shown unreachable');
    api16.emit('shutdown');

    // restart in Matter only: kept and registered again, not removed
    const cached3 = matter.restart();
    const removedBefore = matter.unregistered || 0;
    const api17 = createApi(storage15, { matter });
    require('../src/index')(api17);
    const p17 = new api17.Platform(createLog(), { ...cfg15, appleHome: 'matterOnly' }, api17);
    for (const a of cached3) p17.configureMatterAccessory(a);
    api17.emit('didFinishLaunching');
    ok(await waitFor(() => names().length === 3), 'restart: all three registered again');
    ok((matter.unregistered || 0) === removedBefore, 'nothing removed on a normal restart');
    api17.emit('shutdown');

    // separate switches over Matter
    const cached4 = matter.restart();
    const mock9 = createMock({ port: HTTP + 8 });
    await mock9.start();
    const api18 = createApi(storage15, { matter });
    require('../src/index')(api18);
    const cfg18 = {
      ...cfg15, appleHome: 'matterOnly', homekitLayout: 'separate',
      devices: [{ host: `127.0.0.1:${HTTP + 8}`, name: 'Lounge HDHomeRun', allBusySensor: true, onDelaySeconds: 0, offDelaySeconds: 0 }],
      channelsDvr: { url: services4.url, channelSwitches: ['104'], onDelaySeconds: 0, offDelaySeconds: 0 },
    };
    const p18 = new api18.Platform(createLog(), cfg18, api18);
    for (const a of cached4) p18.configureMatterAccessory(a);
    api18.emit('didFinishLaunching');
    ok(await waitFor(() => !byName('TV In Use') && byName('Lounge HDHomeRun Tuner 2') && byName('Sky News Online 104')), `separate switches: ${names().join(', ')}`);
    ok(byName('Lounge HDHomeRun In Use').accessory.clusters.electricalPowerMeasurement && !byName('Lounge HDHomeRun Tuner 1').accessory.clusters.electricalPowerMeasurement, 'watts on In Use only, so the home total isn\'t counted twice');
    await fetch(`http://127.0.0.1:${HTTP + 8}/mock`, { method: 'POST', body: JSON.stringify({ tuners: [{ ch: '2', client: '192.168.1.20' }, null] }) });
    const okT1 = await waitFor(() => byName('Lounge HDHomeRun Tuner 1').state.onOff?.onOff === true && byName('Lounge HDHomeRun In Use').state.electricalPowerMeasurement?.activePower === 4000);
    ok(okT1 && p18.monitors.size === 1, 'Tuner 1 on; In Use shows 4 W; the HDHomeRun is watched once, at its new address');
    ok(byName('Lounge HDHomeRun Tuner 2').state.onOff.onOff === false && byName('Lounge HDHomeRun All Busy').state.onOff.onOff === false, 'Tuner 2 and All Busy off');
    services4.setActivity({ '6-stream-M3U-Online-192.168.1.42': 'Watching ch104 from Bedroom TV (192.168.1.42)' });
    ok(await waitFor(() => byName('Online TV In Use')?.state.onOff?.onOff === true && byName('Sky News Online 104').state.onOff.onOff === true), 'Online TV In Use and the channel outlet on');
    await matter.command(byName('Lounge HDHomeRun Tuner 1').uuid || byName('Lounge HDHomeRun Tuner 1').accessory.UUID, 'onOff', 'off');
    ok(await waitFor(() => byName('Lounge HDHomeRun Tuner 1').state.onOff.onOff === true, 3000), 'report only: a tap is put back');
    api18.emit('shutdown');
    mock9.stop();

    // back to HomeKit: Matter accessories removed, HomeKit ones back
    const mock10 = createMock({ port: HTTP + 7 });
    await mock10.start();
    const cached5 = matter.restart();
    const api19 = createApi(storage15, { matter });
    require('../src/index')(api19);
    const p19 = new api19.Platform(createLog(), { ...cfg15, appleHome: 'homekit' }, api19);
    for (const a of cached5) p19.configureMatterAccessory(a);
    api19.emit('didFinishLaunching');
    await sleep(400);
    ok(matter.store.size === 0 && (matter.unregistered || 0) >= removedBefore + cached5.length, 'HomeKit: everything removed from Matter');
    ok(await waitFor(() => api19.registered.some((x) => x.context?.kind === 'combined') && api19.registered.some((x) => x.context?.deviceId)), 'and TV In Use and the HDHomeRun are back on HomeKit');
    api19.emit('shutdown');
    mock10.stop();

    // Matter only without Matter: falls back to HomeKit
    matter.enabled = false;
    const api20 = createApi(fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-test-')), { matter });
    require('../src/index')(api20);
    const log20 = createLog();
    new api20.Platform(log20, { ...cfg15, appleHome: 'matterOnly' }, api20);
    api20.emit('didFinishLaunching');
    await sleep(200);
    ok(api20.registered.some((x) => x.context?.kind === 'combined') && log20.lines.some((l) => l.includes('"Matter only" needs Matter')), 'Matter only without Matter: HomeKit, and the log says why');
    api20.emit('shutdown');
    services4.stop();
  }

  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
