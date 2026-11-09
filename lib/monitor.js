import { promises as dns } from 'node:dns'
import { EventEmitter } from 'node:events'

import * as hdhr from './hdhr.js'
import { ReceptionWatch } from './reception.js'

const INFO_EVERY_MS = 5 * 60 * 1000
const LINEUP_EVERY_MS = 30 * 60 * 1000
const MAX_TUNERS = 8

/**
 * Watches one HDHomeRun. Every poll it emits 'update' with the device state:
 *
 * {
 *   key, deviceId, name, host, online, error, lastSeen, lastPoll, source: 'status.json' | 'control',
 *   info: { FriendlyName, ModelNumber, FirmwareName, FirmwareVersion, DeviceID, TunerCount, BaseURL, ... },
 *   tuners: [{ index, inUse, channelNumber, channelName, frequency, modulation,
 *              signalStrength, signalQuality, symbolQuality, client, clientName, bitrate }],
 *   lineupCount, lineupStatus
 * }
 *
 * and 'lineup' with the channel list when it is (re)read.
 */
class DeviceMonitor extends EventEmitter {
  constructor({ key, host, deviceId, name, log, clientNames, pollSeconds, reception }) {
    super()
    this.key = key
    this.host = host
    this.deviceId = deviceId
    this.configuredName = name
    this.log = log
    this.clientNames = clientNames || {}
    this.pollMs = Math.max(2, pollSeconds || 5) * 1000
    this.info = null
    this.infoAt = 0
    this.lineup = []
    this.lineupAt = 0
    this.lineupStatus = null
    this.useControl = false // status.json missing → native protocol
    this.online = false
    this.error = null
    this.lastSeen = null
    this.tuners = []
    this.timer = null
    this.failures = 0
    this.dnsCache = new Map()
    this.reception = new ReceptionWatch(reception)
  }

  get name() {
    return (
      this.configuredName
      || this.info?.FriendlyName
      || (this.deviceId
        ? `HDHomeRun ${this.deviceId}`
        : `HDHomeRun ${this.host}`)
    )
  }

  get baseUrl() {
    return hdhr.baseUrlFor(this.host)
  }

  start() {
    if (this.timer || !this.host) {
      return
    }
    this.stopped = false
    const loop = async () => {
      try {
        await this.poll()
      } catch (e) {
        this.log.warn(`[${this.name}] ${e.message}`)
      }
      // stop() may have run while the poll was waiting on the device
      if (this.stopped) {
        return
      }
      this.timer = setTimeout(loop, this.failures > 3
        ? Math.min(this.pollMs * 6, 60000)
        : this.pollMs)
    }
    this.timer = setTimeout(loop, 0)
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = null
  }

  setHost(host) {
    if (host && host !== this.host) {
      this.log.info(`[${this.name}] now at ${host} (was ${this.host || 'unknown'})`)
      this.host = host
      this.infoAt = 0
      this.lineupAt = 0
      if (!this.timer) {
        this.start()
      }
    }
  }

  async poll() {
    const now = Date.now()
    try {
      if (!this.info || now - this.infoAt > INFO_EVERY_MS) {
        await this.readInfo()
      }
      if (now - this.lineupAt > LINEUP_EVERY_MS) {
        await this.readLineup().catch(e => this.log.debug(`[${this.name}] lineup: ${e.message}`))
      }
      this.tuners = await this.readTuners()
      await this.nameClients(this.tuners)
      if (!this.online) {
        this.log.info(`[${this.name}] ${this.lastSeen ? 'back online' : 'online'}: ${this.describe()}`)
      }
      this.online = true
      this.error = null
      this.failures = 0
      this.lastSeen = now
    } catch (e) {
      this.failures++
      this.error = e.message
      if (this.online || this.failures === 1) {
        this.log.warn(`[${this.name}] unreachable at ${this.host}: ${e.message}`)
      }
      this.online = false
      this.tuners = this.tuners.map(t => ({ index: t.index, inUse: false }))
    }
    const change = this.reception.update(this.tuners, this.online, now)
    if (change === 'started') {
      const d = this.reception.detail || {}
      this.log.warn(
        `[${this.name}] poor reception: Tuner ${(d.tuner ?? 0) + 1} on ${[d.channelNumber, d.channelName].filter(Boolean).join(' ')} at ${d.signalQuality}% signal quality (below ${this.reception.threshold}% for ${this.reception.holdMs / 60000} min)`,
      )
    } else if (change === 'ended') {
      this.log.info(`[${this.name}] reception back to normal`)
    }
    this.emit('update', this.snapshot(now))
  }

  describe() {
    const i = this.info || {}
    return [
      i.ModelNumber && `${i.FriendlyName || 'HDHomeRun'} (${i.ModelNumber})`,
      i.DeviceID && `ID ${i.DeviceID}`,
      `at ${this.host}`,
      i.FirmwareVersion && `firmware ${i.FirmwareVersion}`,
      i.TunerCount && `${i.TunerCount} tuners`,
      this.useControl ? 'tuner status via control protocol' : null,
    ]
      .filter(Boolean)
      .join(', ')
  }

  async readInfo() {
    const info = await hdhr.getJson(`${this.baseUrl}/discover.json`)
    this.info = info
    this.infoAt = Date.now()
    if (info.DeviceID) {
      if (this.deviceId && this.deviceId.toUpperCase() !== String(info.DeviceID).toUpperCase()) {
        this.log.warn(`[${this.name}] expected device ${this.deviceId} at ${this.host} but found ${info.DeviceID}`)
      }
      const first = !this.deviceId
      this.deviceId = String(info.DeviceID).toUpperCase()
      if (first) {
        this.emit('identified', this.deviceId)
      }
    }
  }

  async readLineup() {
    const url = this.info?.LineupURL || `${this.baseUrl}/lineup.json`
    const list = await hdhr.getJson(url, 8000)
    this.lineup = Array.isArray(list)
      ? list
      : []
    this.lineupAt = Date.now()
    this.lineupStatus = await hdhr.getJson(`${this.baseUrl}/lineup_status.json`).catch(() => null)
    this.emit('lineup', this.lineup)
  }

  tunerCount() {
    const n = Number(this.info?.TunerCount) || this.tuners.length || 2
    return Math.min(MAX_TUNERS, Math.max(1, n))
  }

  channelName(number) {
    if (number === undefined || number === null || number === '') {
      return undefined
    }
    const c = this.lineup.find(l => String(l.GuideNumber) === String(number))
    return c?.GuideName
  }

  async readTuners() {
    if (!this.useControl) {
      try {
        const list = await hdhr.getJson(`${this.baseUrl}/status.json`)
        if (!Array.isArray(list)) {
          throw Object.assign(new Error('status.json is not a list'), { status: 404 })
        }
        return this.fromStatusJson(list)
      } catch (e) {
        if (e.status !== 404 && !/not a list|JSON/i.test(e.message)) {
          throw e
        }
        this.useControl = true
        this.log.info(`[${this.name}] status.json not available; using the control protocol for tuner status`)
      }
    }
    return this.fromControlProtocol()
  }

  fromStatusJson(list) {
    const n = this.tunerCount()
    const tuners = []
    for (let i = 0; i < n; i++) tuners.push({ index: i, inUse: false })
    for (const r of list) {
      const m = /^tuner(\d+)$/.exec(r.Resource || '')
      if (!m) {
        continue
      }
      const i = Number(m[1])
      const number = r.VctNumber ?? r.ChannelNumber ?? r.GuideNumber
      const inUse = Boolean(number || r.Frequency || r.TargetIP || r.Name)
      tuners[i] = {
        index: i,
        inUse,
        channelNumber: number !== undefined
          ? String(number)
          : undefined,
        channelName: r.VctName ?? r.ChannelName ?? r.GuideName ?? this.channelName(number),
        frequency: r.Frequency,
        modulation: r.Modulation,
        signalStrength: num(r.SignalStrengthPercent),
        signalQuality: num(r.SignalQualityPercent),
        symbolQuality: num(r.SymbolQualityPercent),
        client: r.TargetIP || r.Name || undefined,
        bitrate: num(r.NetworkRate),
      }
    }
    return tuners
  }

  async fromControlProtocol() {
    const ip = hdhr.hostOnly(this.host)
    const n = this.tunerCount()
    const names = []
    for (let i = 0; i < n; i++) names.push(`/tuner${i}/status`, `/tuner${i}/vchannel`, `/tuner${i}/target`)
    const items = await hdhr.getItems(ip, names)
    if (!Object.keys(items).length) {
      throw new Error('no answer on the control protocol')
    }
    const tuners = []
    for (let i = 0; i < n; i++) {
      const s = hdhr.parseTunerStatus(items[`/tuner${i}/status`])
      const vch = items[`/tuner${i}/vchannel`]
      const target = items[`/tuner${i}/target`]
      const tuned = s.ch && s.ch !== 'none'
      const number = vch && vch !== 'none'
        ? vch
        : undefined
      let client
      if (target && target !== 'none') {
        const m = /\/\/([^:/]+)/.exec(target)
        client = m ? m[1] : target
      }
      const freq = /:(\d+)$/.exec(s.ch || '')
      tuners.push({
        index: i,
        inUse: Boolean(tuned),
        channelNumber: number,
        channelName: this.channelName(number),
        frequency: freq
          ? Number(freq[1])
          : undefined,
        modulation: s.lock && s.lock !== 'none'
          ? s.lock
          : undefined,
        signalStrength: tuned
          ? num(s.ss)
          : undefined,
        signalQuality: tuned
          ? num(s.snq)
          : undefined,
        symbolQuality: tuned
          ? num(s.seq)
          : undefined,
        client,
        bitrate: tuned
          ? num(s.bps)
          : undefined,
      })
    }
    return tuners
  }

  async nameClients(tuners) {
    for (const t of tuners) {
      if (!t.client) {
        continue
      }
      if (this.clientNames[t.client]) {
        t.clientName = this.clientNames[t.client]
        continue
      }
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(t.client)) {
        continue
      }
      let entry = this.dnsCache.get(t.client)
      if (!entry || Date.now() - entry.at > 3600_000) {
        entry = {
          at: Date.now(),
          name: undefined,
        }
        this.dnsCache.set(t.client, entry)
        try {
          const names = await Promise.race([
            dns.reverse(t.client),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 800)),
          ])
          entry.name = names[0]?.replace(/\.(local|lan|home|localdomain)\.?$/i, '')
        } catch {
          /* no reverse name */
        }
      }
      if (entry.name) {
        t.clientName = entry.name
      }
    }
  }

  snapshot(now = Date.now()) {
    return {
      key: this.key,
      deviceId: this.deviceId,
      name: this.name,
      host: this.host,
      baseUrl: this.host ? this.baseUrl : undefined,
      online: this.online,
      error: this.error,
      lastSeen: this.lastSeen,
      lastPoll: now,
      source: this.useControl ? 'control' : 'status.json',
      // DeviceAuth is the device's key for SiliconDust's services, so it stays out of the dashboard
      info: this.info
        ? { ...this.info, DeviceAuth: undefined }
        : null,
      tuners: this.tuners,
      lineupCount: this.lineup.length,
      lineupStatus: this.lineupStatus,
      reception: this.reception.state(),
    }
  }
}

function num(v) {
  if (v === undefined || v === null || v === '') {
    return undefined
  }
  const n = Number(v)
  return Number.isFinite(n)
    ? n
    : undefined
}

export { DeviceMonitor }
