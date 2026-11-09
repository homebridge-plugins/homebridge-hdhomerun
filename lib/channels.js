import { promises as dns } from 'node:dns'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseActivity } from './activity.js'

const JOBS_EVERY_MS = 60 * 1000
const RECORDINGS_EVERY_MS = 10 * 60 * 1000
const RECENT_SHOWN = 25
const SOON_MS = 15 * 60 * 1000
const AHEAD_MS = 7 * 86400_000
const CHANNELS_EVERY_MS = 30 * 60 * 1000
const GUIDE_EVERY_MS = 5 * 60 * 1000

/**
 * Recordings from a Channels DVR server (https://getchannels.com), read-only:
 *   GET /api/v1/jobs                                 scheduled recordings
 *   GET /api/v1/episodes?source=recordings&...       recorded episodes
 *   GET /api/v1/movies?source=recordings&...         recorded movies
 *   GET /dvr                                         live activity: every stream being watched
 *                                                    or recorded, from any source (HDHomeRun, M3U, TVE)
 *   GET /api/v1/channels                             channel names, for online channels
 *   GET /devices/ANY/guide/now                       what is on now, for online channels
 * Older servers without /api/v1 are read from /dvr/jobs and /dvr/files.
 */
class ChannelsDvr extends EventEmitter {
  constructor({ url, log, dir, enabled = true, pollSeconds = 5 }) {
    super()
    this.activityMs = Math.max(2, Number(pollSeconds) || 5) * 1000
    this.streams = []
    this.activityOk = false
    this.activityAt = null
    this.channelNames = {}
    this.channelsAt = 0
    this.nowPlaying = {}
    this.guideAt = 0
    this.url = url
      ? String(url).trim().replace(/\/+$/, '')
      : ''
    this.auto = !this.url
    this.log = log
    this.dir = dir
    this.enabled = enabled
    this.status = 'off'
    this.error = null
    this.jobs = []
    this.recordings = []
    this.checkedAt = null
    this.recordingsAt = 0
    this.hostIps = new Set()
    this.legacy = false
    this.timer = null
  }

  async start() {
    if (!this.enabled) {
      return
    }
    if (this.auto) {
      // Channels DVR often runs on the same machine as Homebridge
      const candidate = 'http://127.0.0.1:8089'
      try {
        await getJson(`${candidate}/api/v1/jobs`, 3000)
        this.url = candidate
        this.log.info(`[Channels DVR] found on this machine at ${candidate}`)
      } catch {
        this.log.debug('[Channels DVR] not found on this machine; set its address in the settings to show recordings')
        return
      }
    }
    await this.resolveHost()
    const loop = async () => {
      await this.poll()
      this.timer = setTimeout(loop, JOBS_EVERY_MS)
      this.timer.unref?.()
    }
    loop()
    const activityLoop = async () => {
      await this.pollActivity()
      this.activityTimer = setTimeout(activityLoop, this.activityMs)
      this.activityTimer.unref?.()
    }
    activityLoop()
  }

  stop() {
    clearTimeout(this.timer)
    clearTimeout(this.activityTimer)
  }

  /** Reads what Channels DVR is streaming right now, and emits 'activity'. */
  async pollActivity(now = Date.now()) {
    try {
      const data = await getJson(`${this.url}/dvr`, 4000)
      this.streams = parseActivity(data?.activity)
      if (!this.activityOk) {
        this.log.debug(`[Channels DVR] reading live activity (${this.streams.length} streams)`)
      }
      this.activityOk = true
      this.activityAt = now
    } catch (e) {
      if (this.activityOk) {
        this.log.debug(`[Channels DVR] activity: ${e.message}`)
      }
      this.activityOk = false
      this.streams = []
    }
    if (now - this.channelsAt > CHANNELS_EVERY_MS) {
      await this.readChannels(now)
    }
    if (now - this.guideAt > GUIDE_EVERY_MS || this.guideStale(now)) {
      await this.readGuideNow(now)
    }
    for (const st of this.streams) {
      if (!st.channelName && st.channelNumber) {
        st.channelName = this.channelNames[st.channelNumber]
      }
      const np = this.nowPlaying[st.channelNumber]
      if (np && np.end > now) {
        st.programme = np
      }
    }
    this.emit('activity', this.streams, now)
  }

  guideStale(now) {
    // refresh early when something being watched has no current programme
    return (
      now - this.guideAt > 60_000
      && this.streams.some(s => s.kind === 'online' && s.channelNumber && !(this.nowPlaying[s.channelNumber]?.end > now))
    )
  }

  async readChannels(now) {
    this.channelsAt = now
    try {
      const list = await getJson(`${this.url}/api/v1/channels`, 8000)
      const names = {}
      for (const c of Array.isArray(list)
        ? list
        : []) {
        const num = c.number ?? c.Number ?? c.GuideNumber
        const name = c.name ?? c.Name ?? c.GuideName
        if (num !== undefined && name) {
          names[String(num)] = String(name)
        }
      }
      if (Object.keys(names).length) {
        this.channelNames = names
      }
    } catch (e) {
      this.log.debug(`[Channels DVR] channels: ${e.message}`)
    }
  }

  async readGuideNow(now) {
    this.guideAt = now
    try {
      const list = await getJson(`${this.url}/devices/ANY/guide/now`, 8000)
      const np = {}
      for (const item of Array.isArray(list)
        ? list
        : []) {
        for (const a of item.Airings || []) {
          const ch = String(a.Channel ?? item.Channel?.Number ?? '')
          const start = Number(a.Time) * 1000
          const end = start + Number(a.Duration || 0) * 1000
          if (ch && start <= now && end > now) {
            np[ch] = {
              title: a.Title || '',
              episodeTitle: a.EpisodeTitle || undefined,
              start,
              end,
            }
          }
        }
      }
      this.nowPlaying = np
    } catch (e) {
      this.log.debug(`[Channels DVR] guide: ${e.message}`)
    }
  }

  async resolveHost() {
    try {
      const host = new URL(this.url).hostname
      this.hostIps = new Set([host])
      if (host === '127.0.0.1' || host === 'localhost') {
        for (const list of Object.values(os.networkInterfaces())) {
          for (const a of list || []) {
            if (a.family === 'IPv4') {
              this.hostIps.add(a.address)
            }
          }
        }
      } else if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        for (const a of await dns.lookup(host, { all: true })) this.hostIps.add(a.address)
      }
    } catch {
      /* keep what we have */
    }
  }

  async poll(now = Date.now()) {
    const first = this.status !== 'ok'
    try {
      this.jobs = await this.readJobs()
      if (now - this.recordingsAt > RECORDINGS_EVERY_MS || first) {
        this.recordings = await this.readRecordings().catch((e) => {
          this.log.debug(`[Channels DVR] recordings: ${e.message}`)
          return this.recordings
        })
        this.recordingsAt = now
      }
      if (this.status !== 'ok') {
        this.log.info(
          `[Channels DVR] connected at ${this.url}: ${this.jobs.filter(j => j.end > now).length} upcoming recordings`,
        )
      }
      this.status = 'ok'
      this.error = null
    } catch (e) {
      if (this.status !== 'error') {
        this.log.warn(`[Channels DVR] not reachable at ${this.url}: ${e.message}`)
      }
      this.status = 'error'
      this.error = e.message
    }
    this.checkedAt = now
    this.save()
  }

  async readJobs() {
    if (!this.legacy) {
      try {
        const list = await getJson(`${this.url}/api/v1/jobs`)
        return (Array.isArray(list)
          ? list
          : []).map(j => ({
          id: String(j.id),
          title: j.item?.title || j.name || 'Recording',
          episodeTitle: j.item?.episode_title || undefined,
          start: Number(j.start_time) * 1000,
          end: Number(j.end_time || Number(j.start_time) + Number(j.duration || 0)) * 1000,
          channel: j.channel || (j.channels || [])[0],
          channels: j.channels || [],
          skipped: !!j.skipped,
          failed: !!j.failed,
          error: j.error || undefined,
        }))
      } catch (e) {
        if (e.status !== 404) {
          throw e
        }
        this.legacy = true
      }
    }
    const list = await getJson(`${this.url}/dvr/jobs`)
    return (Array.isArray(list)
      ? list
      : []).map(j => ({
      id: String(j.ID),
      title: j.Airing?.Title || j.Name || 'Recording',
      episodeTitle: j.Airing?.EpisodeTitle || undefined,
      start: Number(j.Time) * 1000,
      end: (Number(j.Time) + Number(j.Duration || 0)) * 1000,
      channel: j.Airing?.Channel || (j.Channels || [])[0],
      channels: j.Channels || [],
      skipped: !!j.Skipped,
      failed: !!j.Failed,
      error: j.Error || undefined,
    }))
  }

  async readRecordings() {
    if (this.legacy) {
      const list = await getJson(`${this.url}/dvr/files`, 15000)
      return (Array.isArray(list)
        ? list
        : [])
        .map(f => ({
          id: String(f.ID),
          title: f.Airing?.Title || f.Title || 'Recording',
          episodeTitle: f.Airing?.EpisodeTitle || undefined,
          channel: f.Airing?.Channel,
          recordedAt: Number(f.CreatedAt) || undefined,
          duration: Number(f.Duration) || undefined,
          completed: f.Completed !== false,
        }))
        .sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0))
        .slice(0, RECENT_SHOWN)
    }
    const q = `source=recordings&sort=date_added&order=desc&limit=${RECENT_SHOWN}`
    const [episodes, movies] = await Promise.all([
      getJson(`${this.url}/api/v1/episodes?${q}`, 15000),
      getJson(`${this.url}/api/v1/movies?${q}`, 15000).catch(() => []),
    ])
    return [
      ...(episodes || []),
      ...(movies || []),
    ]
      .map(r => ({
        id: String(r.id),
        title: r.title || 'Recording',
        episodeTitle: r.episode_title || undefined,
        channel: r.channel,
        recordedAt: ms(r.created_at),
        duration: Number(r.duration) || undefined,
        completed: r.completed !== false,
        image: r.image_url || undefined,
      }))
      .sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0))
      .slice(0, RECENT_SHOWN)
  }

  state() {
    return {
      url: this.url || null,
      status: this.status,
      error: this.error,
      checkedAt: this.checkedAt,
      hostIps: [...this.hostIps],
      jobs: this.jobs,
      recordings: this.recordings,
      streams: this.streams,
      activityOk: this.activityOk,
    }
  }

  save() {
    if (!this.dir) {
      return
    }
    try {
      const f = path.join(this.dir, 'channels.json')
      fs.writeFileSync(`${f}.tmp`, JSON.stringify(this.state()))
      fs.renameSync(`${f}.tmp`, f)
    } catch {
      /* not important */
    }
  }
}

/**
 * What the Recordings tab shows: recording now, upcoming (next 7 days) and recent,
 * with a warning on each recording that needs more tuners than the HDHomeRuns have.
 */
function analyze(dvr, devices, now = Date.now()) {
  if (!dvr || dvr.status === 'off') {
    return { status: 'off' }
  }
  const tuners = (devices || []).reduce((n, d) => n + (Number(d.info?.TunerCount) || d.tuners?.length || 0), 0)
  const jobs = (dvr.jobs || []).filter(j => !j.skipped && j.end > now).sort((a, b) => a.start - b.start)
  const active = t => jobs.filter(j => j.start <= t && j.end > t)
  const hosts = new Set(dvr.hostIps || [])
  const liveOthers = (devices || [])
    .flatMap(d => (d.online
      ? d.tuners
      : []))
    .filter(t => t.inUse && !hosts.has(t.client))
    .length

  const upcoming = []
  const warnings = []
  for (const j of jobs) {
    if (j.start > now + AHEAD_MS) {
      break
    }
    const points = [
      j.start,
      ...jobs.filter(k => k.start > j.start && k.start < j.end).map(k => k.start),
    ]
    const peak = Math.max(...points.map(p => active(Math.max(p, now)).length))
    const item = { ...j, recording: j.start <= now, peak }
    if (tuners) {
      if (peak > tuners) {
        item.warning = {
          level: 'bad',
          text: `${peak} recordings at once, but your HDHomeRun${
            devices.length > 1
              ? 's have'
              : ' has'
          } ${tuners} tuners`,
        }
      } else if (peak === tuners) {
        item.warning = { level: 'warn', text: 'uses every tuner — live TV can\'t tune while it records' }
      }
      if (j.start > now && j.start - now <= SOON_MS) {
        const needed = active(j.start).length + liveOthers
        if (needed > tuners) {
          item.warning = {
            level: 'bad',
            text: `starts in ${Math.max(1, Math.round((j.start - now) / 60000))} min, but ${liveOthers} tuner${
              liveOthers === 1
                ? ' is'
                : 's are'
            } in use for live TV`,
          }
        }
      }
    }
    if (item.warning) {
      warnings.push({
        id: j.id,
        title: j.title,
        start: j.start,
        ...item.warning,
      })
    }
    upcoming.push(item)
  }
  return {
    status: dvr.status,
    url: dvr.url,
    error: dvr.error,
    checkedAt: dvr.checkedAt,
    tuners,
    recordingNow: upcoming.filter(j => j.recording),
    upcoming: upcoming.filter(j => !j.recording).slice(0, 40),
    warnings,
    recent: dvr.recordings || [],
    failed: (dvr.jobs || []).filter(j => j.failed && j.end > now - 7 * 86400_000),
  }
}

function ms(t) {
  const n = Number(t)
  if (!n) {
    return undefined
  }
  return n < 1e12
    ? n * 1000
    : n
}

async function getJson(url, timeoutMs = 5000) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json' },
  })
  if (!res.ok) {
    throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  }
  return res.json()
}

export { analyze, ChannelsDvr }
