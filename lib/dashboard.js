import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PUBLIC = fileURLToPath(new URL('./homebridge-ui/public/', import.meta.url))
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
}
// files the standalone page may load; index.html is the Config UI tab and is not served
const FILES = new Set(['app.js', 'style.css', 'icon.svg'])

/**
 * The web dashboard at http://<homebridge>:8588/
 *   GET  /               the dashboard
 *   GET  /api/snapshot   everything it shows, as JSON
 *   GET  /api/state      just the live device state
 *   GET  /api/events     server-sent events: live device state on every poll
 *   POST /api/reset-stats  empties statistics and sessions
 */
class Dashboard {
  constructor({ port, host, log, getSnapshot, getLive, onReset }) {
    this.port = port
    this.host = host
    this.log = log
    this.getSnapshot = getSnapshot
    this.getLive = getLive
    this.onReset = onReset
    this.clients = new Set()
  }

  start() {
    this.server = http.createServer((req, res) =>
      this.handle(req, res).catch((e) => {
        this.log.debug(`dashboard: ${e.stack || e}`)
        if (!res.headersSent) {
          send(res, 500, { error: e.message })
        }
      }),
    )
    this.server.on('error', (e) => {
      this.log.error(`dashboard could not listen on port ${this.port}: ${e.message}`)
    })
    this.server.listen(this.port, this.host, () => {
      this.log.info(`dashboard at http://${this.host === '0.0.0.0'
        ? '<this machine>'
        : this.host}:${this.port}/`)
    })
    this.keepAlive = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n')
    }, 25000)
    this.keepAlive.unref?.()
  }

  stop() {
    clearInterval(this.keepAlive)
    for (const c of this.clients) c.end()
    this.server?.close()
  }

  /** Pushes live state to open dashboards. */
  broadcast() {
    if (!this.clients.size) {
      return
    }
    const data = `event: live\ndata: ${JSON.stringify(this.getLive())}\n\n`
    for (const c of this.clients) c.write(data)
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const p = url.pathname

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return file(res, 'dashboard.html')
    }
    if (req.method === 'GET' && FILES.has(p.slice(1))) {
      return file(res, p.slice(1))
    }
    if (req.method === 'GET' && p === '/api/snapshot') {
      return send(res, 200, this.getSnapshot())
    }
    if (req.method === 'GET' && p === '/api/state') {
      return send(res, 200, this.getLive())
    }
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      })
      res.write(`event: live\ndata: ${JSON.stringify(this.getLive())}\n\n`)
      this.clients.add(res)
      req.on('close', () => this.clients.delete(res))
      return
    }
    if (req.method === 'POST' && p === '/api/reset-stats') {
      // a plain cross-site form cannot send this header, so a page elsewhere cannot reset
      if (req.headers['x-hdhr-dashboard'] !== '1') {
        return send(res, 403, { error: 'missing header' })
      }
      this.onReset()
      return send(res, 200, { ok: true })
    }
    send(res, 404, { error: 'not found' })
  }
}

function file(res, name) {
  const full = path.join(PUBLIC, name)
  fs.readFile(full, (err, buf) => {
    if (err) {
      return send(res, 404, { error: 'not found' })
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(name)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(buf)
  })
}

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export { Dashboard }
