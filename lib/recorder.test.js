import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { Recorder, RESET_REQUEST } from './recorder.js'

const dirs = []
const log = {
  info: () => {},
  warn: () => {},
  debug: () => {},
}

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdhr-recorder-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.chmodSync(dir, 0o700)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('the recorder', () => {
  it('logs a file it cannot save once, without stopping the polling', () => {
    const dir = folder()
    const warnings = []
    const recorder = new Recorder({
      dir,
      log: {
        ...log,
        warn: msg => warnings.push(msg),
      },
    })
    fs.chmodSync(dir, 0o500)

    expect(() => recorder.writeState(Date.now())).not.toThrow()
    expect(() => recorder.writeState(Date.now() + 60_000)).not.toThrow()
    expect(() => recorder.saveLineup('1050ABCD', [])).not.toThrow()

    expect(warnings.filter(w => w.includes('state.json'))).toHaveLength(1)
    recorder.close()
  })

  it('resets its statistics when the homebridge ui asked while it could not reach the plugin', () => {
    const dir = folder()
    const recorder = new Recorder({ dir, log })
    recorder.stats.days['2026-11-09'] = { seconds: 100 }
    recorder.closed.push({ seconds: 100 })

    fs.writeFileSync(path.join(dir, RESET_REQUEST), '')
    recorder.save()

    expect(recorder.stats.days).toEqual({})
    expect(recorder.closed).toEqual([])
    expect(fs.existsSync(path.join(dir, RESET_REQUEST))).toBe(false)
    recorder.close()
  })
})
