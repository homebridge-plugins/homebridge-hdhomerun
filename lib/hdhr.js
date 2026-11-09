/**
 * Talking to an HDHomeRun.
 *
 *  - HTTP JSON API (port 80): discover.json, status.json, lineup.json, lineup_status.json
 *  - Native control protocol (TCP 65001): get /tunerN/status, /tunerN/vchannel, /tunerN/target
 *    Used when status.json is not offered by older firmware.
 *  - Discovery (UDP 65001): broadcast DISCOVER_REQ, collect DISCOVER_RPY.
 *
 * No dependencies: Node 18+ fetch, net and dgram.
 */

import { Buffer } from 'node:buffer'
import dgram from 'node:dgram'
import net from 'node:net'
import os from 'node:os'

const HDHR_PORT = 65001
const TYPE_DISCOVER_REQ = 0x0002
const TYPE_DISCOVER_RPY = 0x0003
const TYPE_GETSET_REQ = 0x0004
const TYPE_GETSET_RPY = 0x0005
const TAG_DEVICE_TYPE = 0x01
const TAG_DEVICE_ID = 0x02
const TAG_GETSET_NAME = 0x03
const TAG_GETSET_VALUE = 0x04
const TAG_ERROR_MESSAGE = 0x05
const TAG_TUNER_COUNT = 0x10
const TAG_LINEUP_URL = 0x27
const TAG_BASE_URL = 0x2A
const DEVICE_TYPE_TUNER = 0x00000001
const DEVICE_ID_WILDCARD = 0xFFFFFFFF

// ---------- CRC32 (IEEE, reflected) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1
        ? 0xEDB88320 ^ (c >>> 1)
        : c >>> 1
    }
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

// ---------- TLV packets ----------
function encodeTlv(tag, value) {
  const len = value.length
  const head = len < 128
    ? Buffer.from([tag, len])
    : Buffer.from([tag, (len & 0x7F) | 0x80, len >> 7])
  return Buffer.concat([head, value])
}

function buildPacket(type, tlvs) {
  const payload = Buffer.concat(tlvs)
  const header = Buffer.alloc(4)
  header.writeUInt16BE(type, 0)
  header.writeUInt16BE(payload.length, 2)
  const body = Buffer.concat([header, payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32LE(crc32(body), 0)
  return Buffer.concat([body, crc])
}

/** Parses one packet from the start of buf. Returns { type, tags: Map, size } or null if incomplete. */
function parsePacket(buf) {
  if (buf.length < 8) {
    return null
  }
  const type = buf.readUInt16BE(0)
  const len = buf.readUInt16BE(2)
  const size = 4 + len + 4
  if (buf.length < size) {
    return null
  }
  const crc = buf.readUInt32LE(4 + len)
  if (crc !== crc32(buf.subarray(0, 4 + len))) {
    throw new Error('HDHomeRun packet CRC mismatch')
  }
  const tags = new Map()
  let p = 4
  const end = 4 + len
  while (p < end) {
    const tag = buf[p++]
    let l = buf[p++]
    if (l & 0x80) {
      l = (l & 0x7F) | (buf[p++] << 7)
    }
    tags.set(tag, buf.subarray(p, p + l))
    p += l
  }
  return { type, tags, size }
}

function cstr(b) {
  return b
    ? b.toString('utf8').replace(/\0+$/, '')
    : undefined
}

// ---------- control protocol ----------
/**
 * Gets several items over one TCP connection: getItems('192.168.1.30', ['/tuner0/status', ...])
 * Resolves to { '/tuner0/status': 'ch=... lock=...', ... }; items that error are left out.
 */
function getItems(ip, names, { timeoutMs = 2500, port = HDHR_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const out = {}
    const queue = names.slice()
    let current = null
    let buf = Buffer.alloc(0)
    const sock = net.createConnection({ host: ip, port })
    const timer = setTimeout(() => done(new Error(`control protocol timeout (${ip}:${port})`)), timeoutMs)
    let finished = false

    function done(err) {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timer)
      sock.destroy()
      if (err && Object.keys(out).length === 0) {
        reject(err)
      } else {
        resolve(out)
      }
    }
    function next() {
      current = queue.shift()
      if (current === undefined) {
        return done()
      }
      sock.write(buildPacket(TYPE_GETSET_REQ, [
        encodeTlv(TAG_GETSET_NAME, Buffer.from(`${current}\0`)),
      ]))
    }
    sock.on('connect', next)
    sock.on('error', done)
    sock.on('close', () => done(new Error('control connection closed')))
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      let pkt
      try {
        for (pkt = parsePacket(buf); pkt; pkt = parsePacket(buf)) {
          buf = buf.subarray(pkt.size)
          if (pkt.type === TYPE_GETSET_RPY && !pkt.tags.has(TAG_ERROR_MESSAGE)) {
            out[current] = cstr(pkt.tags.get(TAG_GETSET_VALUE))
          }
          next()
        }
      } catch (e) {
        done(e)
      }
    })
  })
}

/** "ch=auto:533000000 lock=t8bw ss=93 snq=100 seq=100 bps=19394080 pps=0" → object */
function parseTunerStatus(line) {
  const o = {}
  for (const part of String(line || '')
    .trim()
    .split(/\s+/)) {
    const i = part.indexOf('=')
    if (i > 0) {
      o[part.slice(0, i)] = part.slice(i + 1)
    }
  }
  return o
}

// ---------- discovery ----------
function broadcastAddresses() {
  const out = new Set(['255.255.255.255'])
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || !a.netmask) {
        continue
      }
      const ip = a.address.split('.').map(Number)
      const mask = a.netmask.split('.').map(Number)
      out.add(ip.map((o, i) => (o | (~mask[i] & 255)) & 255).join('.'))
    }
  }
  return [...out]
}

/**
 * Finds HDHomeRun tuners on the LAN. Resolves to
 * [{ deviceId, ip, baseUrl, lineupUrl, tunerCount }]
 */
function discover({ timeoutMs = 1500, targets, port = HDHR_PORT } = {}) {
  return new Promise((resolve) => {
    const found = new Map()
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const finish = () => {
      try {
        sock.close()
      } catch {
        /* closed */
      }
      resolve([
        ...found.values(),
      ])
    }
    sock.on('error', finish)
    sock.on('message', (msg, rinfo) => {
      try {
        const pkt = parsePacket(msg)
        if (!pkt || pkt.type !== TYPE_DISCOVER_RPY) {
          return
        }
        const type = pkt.tags.get(TAG_DEVICE_TYPE)?.readUInt32BE(0)
        if (type !== undefined && type !== DEVICE_TYPE_TUNER) {
          return
        }
        const idBuf = pkt.tags.get(TAG_DEVICE_ID)
        const deviceId = idBuf
          ? idBuf.readUInt32BE(0).toString(16).toUpperCase().padStart(8, '0')
          : undefined
        if (!deviceId) {
          return
        }
        found.set(deviceId, {
          deviceId,
          ip: rinfo.address,
          baseUrl: cstr(pkt.tags.get(TAG_BASE_URL)),
          lineupUrl: cstr(pkt.tags.get(TAG_LINEUP_URL)),
          tunerCount: pkt.tags.get(TAG_TUNER_COUNT)?.[0],
        })
      } catch {
        /* ignore junk */
      }
    })
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true)
      } catch {
        /* ignore */
      }
      const typeBuf = Buffer.alloc(4)
      typeBuf.writeUInt32BE(DEVICE_TYPE_TUNER)
      const idBuf = Buffer.alloc(4)
      idBuf.writeUInt32BE(DEVICE_ID_WILDCARD)
      const pkt = buildPacket(TYPE_DISCOVER_REQ, [
        encodeTlv(TAG_DEVICE_TYPE, typeBuf),
        encodeTlv(TAG_DEVICE_ID, idBuf),
      ])
      for (const addr of targets || broadcastAddresses()) sock.send(pkt, port, addr, () => {})
      setTimeout(finish, timeoutMs)
    })
  })
}

// ---------- HTTP ----------
function baseUrlFor(host) {
  if (/^https?:\/\//i.test(host)) {
    return host.replace(/\/+$/, '')
  }
  return `http://${host}`
}

function hostOnly(host) {
  try {
    return new URL(baseUrlFor(host)).hostname
  } catch {
    return host
  }
}

async function getJson(url, timeoutMs = 4000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${url}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

// exported for the mock device used in tests
const consts = {
  TYPE_DISCOVER_REQ,
  TYPE_DISCOVER_RPY,
  TYPE_GETSET_REQ,
  TYPE_GETSET_RPY,
  TAG_DEVICE_TYPE,
  TAG_DEVICE_ID,
  TAG_GETSET_NAME,
  TAG_GETSET_VALUE,
  TAG_ERROR_MESSAGE,
  TAG_TUNER_COUNT,
  TAG_LINEUP_URL,
  TAG_BASE_URL,
  DEVICE_TYPE_TUNER,
}

export {
  baseUrlFor,
  buildPacket,
  consts,
  crc32,
  discover,
  encodeTlv,
  getItems,
  getJson,
  HDHR_PORT,
  hostOnly,
  parsePacket,
  parseTunerStatus,
}
