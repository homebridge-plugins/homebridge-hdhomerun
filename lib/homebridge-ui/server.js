/**
 * Server side of the plugin's tab in Homebridge Config UI X.
 * It runs in its own process, so it asks the running plugin for its data over the
 * dashboard API, and reads the plugin's files if the plugin cannot be reached
 * (dashboard turned off, or the bridge stopped).
 */

import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils'

import * as hdhr from '../hdhr.js'
import { readJson, RESET_REQUEST, writeJson } from '../recorder.js'
import * as snapshot from '../snapshot.js'

const require = createRequire(import.meta.url)
const { version } = require('../../package.json')

class UiServer extends HomebridgePluginUiServer {
  constructor() {
    super()
    this.dir = path.join(this.homebridgeStoragePath || process.env.UIX_STORAGE_PATH || '', 'hdhomerun-monitor')

    this.onRequest('/snapshot', p => this.snapshot(p || {}))
    this.onRequest('/discover', () => this.discover())
    this.onRequest('/probe', p => this.probe(p || {}))
    this.onRequest('/reset-stats', p => this.resetStats(p || {}))

    this.ready()
  }

  pluginUrl(p) {
    const port = Number(p.port) || 8588
    return `http://127.0.0.1:${port}`
  }

  async snapshot(p) {
    if (p.dashboardEnabled !== false) {
      try {
        const res = await fetch(`${this.pluginUrl(p)}/api/snapshot`, {
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          const snap = await res.json()
          if (snap && Array.isArray(snap.devices)) {
            return { ...snap, via: 'plugin' }
          }
        }
      } catch {
        /* fall back to the files */
      }
    }
    return {
      ...snapshot.fromFiles(this.dir, version),
      via: 'files',
    }
  }

  async discover() {
    const found = await hdhr.discover({ timeoutMs: 2000 })
    return Promise.all(
      found.map(async (f) => {
        try {
          const info = await hdhr.getJson(`${f.baseUrl || `http://${f.ip}`}/discover.json`, 3000)
          return {
            ...f,
            name: info.FriendlyName,
            model: info.ModelNumber,
            firmware: info.FirmwareVersion,
            tunerCount: info.TunerCount ?? f.tunerCount,
          }
        } catch {
          return f
        }
      }),
    )
  }

  async probe(p) {
    if (!p.host) {
      throw new RequestError('No address given', { status: 400 })
    }
    try {
      const info = await hdhr.getJson(`${hdhr.baseUrlFor(String(p.host).trim())}/discover.json`, 4000)
      return { ok: true, info }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  }

  async resetStats(p) {
    if (p.dashboardEnabled !== false) {
      try {
        const res = await fetch(`${this.pluginUrl(p)}/api/reset-stats`, {
          method: 'POST',
          headers: { 'x-hdhr-dashboard': '1' },
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          return { ok: true, via: 'plugin' }
        }
      } catch {
        /* plugin not reachable */
      }
    }
    // the plugin could not be reached, so change the files directly
    if (fs.existsSync(this.dir)) {
      // if the plugin is running after all, it resets its own copy at its next save
      fs.writeFileSync(path.join(this.dir, RESET_REQUEST), '')
      writeJson(path.join(this.dir, 'stats.json'), { version: 1, days: {} })
      const s = readJson(path.join(this.dir, 'sessions.json'), { open: [], closed: [] })
      writeJson(path.join(this.dir, 'sessions.json'), { open: s.open || [], closed: [] })
    }
    return { ok: true, via: 'files' }
  }
}

;(() => new UiServer())()
