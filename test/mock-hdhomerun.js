/**
 * A pretend HDHomeRun DUO for testing without one:
 *   HTTP  discover.json, lineup.json, lineup_status.json, status.json (or 404 with --no-status-json)
 *   TCP   control protocol on 65001: /tunerN/status, /tunerN/vchannel, /tunerN/target
 *   UDP   discovery on 65001
 * POST /mock  {"tuners":[{"ch":"1","client":"192.168.1.20"}, null]}  sets what each tuner is doing.
 *
 *   node test/mock-hdhomerun.js [--port 8080] [--no-status-json] [--auto]
 */

import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import * as hdhr from '../lib/hdhr.js';

const { consts: C } = hdhr;

function createMock({ port = 8080, statusJson = true, auto = false, controlPort = 65001, deviceId = '1050ABCD' } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const lineup = [
    ['1', 'TVNZ 1', 1], ['2', 'TVNZ 2', 1], ['3', 'ThreeNow', 1], ['5', 'Whakaata Māori', 1], ['6', 'TVNZ DUKE', 1],
    ['8', 'eden', 0], ['9', 'Bravo', 0], ['10', 'Rush', 0], ['11', 'Te Reo', 0], ['12', 'Parliament TV', 0],
    ['13', 'ThreePlus1', 0], ['14', 'HGTV', 0], ['15', 'Sky Open', 1], ['20', 'Al Jazeera', 0], ['22', 'Shine TV', 0],
  ].map(([n, name, hd], i) => ({
    GuideNumber: n, GuideName: name, HD: hd || undefined, Favorite: n === '1' ? 1 : undefined,
    VideoCodec: hd ? 'H264' : 'MPEG2', AudioCodec: hd ? 'HEAAC' : 'MPEG',
    URL: `${base}/auto/v${n}`, _freq: 530000000 + (i % 6) * 8000000,
  }));
  const tuners = [null, null];

  function tunerState(i) {
    const t = tuners[i];
    if (!t) return null;
    const ch = lineup.find((c) => c.GuideNumber === t.ch) || lineup[0];
    const jitter = (n) => Math.max(0, Math.min(100, n + Math.round((Math.random() - 0.5) * 6)));
    return { ch, client: t.client, ss: jitter(t.ss ?? 88), snq: jitter(t.snq ?? 93), seq: t.seq ?? 100, bps: 9_800_000 + Math.round(Math.random() * 2e6) };
  }

  const server = http.createServer((req, res) => {
    const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const url = req.url.split('?')[0];
    if (req.method === 'POST' && url === '/mock') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const o = JSON.parse(body || '{}');
        if (o.tuners) o.tuners.forEach((t, i) => (tuners[i] = t));
        json({ ok: true });
      });
      return;
    }
    if (url === '/discover.json') {
      return json({
        FriendlyName: 'HDHomeRun DUO', ModelNumber: 'HDHR5-2DT', FirmwareName: 'hdhomerun5_dvbt',
        FirmwareVersion: '20250815', DeviceID: deviceId, DeviceAuth: 'abc', BaseURL: base, LineupURL: `${base}/lineup.json`, TunerCount: 2,
      });
    }
    if (url === '/lineup.json') return json(lineup.map(({ _freq, ...c }) => c));
    if (url === '/lineup_status.json') return json({ ScanInProgress: 0, ScanPossible: 1, Source: 'Antenna', SourceList: ['Antenna'] });
    if (url === '/status.json') {
      if (!statusJson) return json({ error: 'not found' }, 404);
      return json(tuners.map((_, i) => {
        const s = tunerState(i);
        if (!s) return { Resource: `tuner${i}` };
        return {
          Resource: `tuner${i}`, VctNumber: s.ch.GuideNumber, VctName: s.ch.GuideName, Frequency: s.ch._freq,
          SignalStrengthPercent: s.ss, SignalQualityPercent: s.snq, SymbolQualityPercent: s.seq, TargetIP: s.client, NetworkRate: s.bps,
        };
      }));
    }
    json({ error: 'not found' }, 404);
  });

  // control protocol
  const control = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pkt;
      while ((pkt = hdhr.parsePacket(buf))) {
        buf = buf.subarray(pkt.size);
        const name = pkt.tags.get(C.TAG_GETSET_NAME).toString().replace(/\0+$/, '');
        const m = /^\/tuner(\d+)\/(status|vchannel|target)$/.exec(name);
        let value;
        if (m && Number(m[1]) < tuners.length) {
          const s = tunerState(Number(m[1]));
          if (m[2] === 'status') value = s ? `ch=auto:${s.ch._freq} lock=t8bw ss=${s.ss} snq=${s.snq} seq=${s.seq} bps=${s.bps} pps=0` : 'ch=none lock=none ss=0 snq=0 seq=0 bps=0 pps=0';
          if (m[2] === 'vchannel') value = s ? s.ch.GuideNumber : 'none';
          if (m[2] === 'target') value = s ? `rtp://${s.client}:5000` : 'none';
        }
        const tlvs = [hdhr.encodeTlv(C.TAG_GETSET_NAME, Buffer.from(name + '\0'))];
        tlvs.push(value !== undefined ? hdhr.encodeTlv(C.TAG_GETSET_VALUE, Buffer.from(value + '\0')) : hdhr.encodeTlv(C.TAG_ERROR_MESSAGE, Buffer.from('ERROR: unknown getset variable\0')));
        sock.write(hdhr.buildPacket(C.TYPE_GETSET_RPY, tlvs));
      }
    });
  });

  // discovery
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    try {
      const pkt = hdhr.parsePacket(msg);
      if (!pkt || pkt.type !== C.TYPE_DISCOVER_REQ) return;
      const type = Buffer.alloc(4); type.writeUInt32BE(C.DEVICE_TYPE_TUNER);
      const id = Buffer.alloc(4); id.writeUInt32BE(parseInt(deviceId, 16));
      udp.send(hdhr.buildPacket(C.TYPE_DISCOVER_RPY, [
        hdhr.encodeTlv(C.TAG_DEVICE_TYPE, type), hdhr.encodeTlv(C.TAG_DEVICE_ID, id),
        hdhr.encodeTlv(C.TAG_TUNER_COUNT, Buffer.from([2])), hdhr.encodeTlv(C.TAG_BASE_URL, Buffer.from(base)),
      ]), rinfo.port, rinfo.address);
    } catch { /* junk */ }
  });

  let autoTimer;
  if (auto) {
    const clients = ['192.168.1.20', '192.168.1.42', '192.168.1.57'];
    autoTimer = setInterval(() => {
      for (let i = 0; i < tuners.length; i++) {
        if (Math.random() < 0.25) {
          tuners[i] = Math.random() < 0.35 ? null : {
            ch: lineup[Math.floor(Math.random() * lineup.length)].GuideNumber,
            client: clients[Math.floor(Math.random() * clients.length)],
            snq: 70 + Math.round(Math.random() * 30),
          };
        }
      }
    }, 5000);
  }

  return {
    tuners,
    lineup,
    async start() {
      await new Promise((r) => server.listen(port, '127.0.0.1', r));
      await new Promise((r) => control.listen(controlPort, '127.0.0.1', r));
      await new Promise((r) => udp.bind(controlPort, r));
    },
    stop() {
      clearInterval(autoTimer);
      server.close(); control.close(); udp.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]) || 8080;
  const mock = createMock({ port, statusJson: !args.includes('--no-status-json'), auto: args.includes('--auto') });
  mock.start().then(() => console.log(`mock HDHomeRun at http://127.0.0.1:${port}/ (control and discovery on 65001)`));
}

export { createMock };
