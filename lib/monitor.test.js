import { describe, expect, it } from 'vitest'

import { DeviceMonitor } from './monitor.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function monitor() {
  const warnings = []
  const m = new DeviceMonitor({
    key: 'x',
    host: '127.0.0.1:1',
    log: {
      info: () => {},
      warn: msg => warnings.push(msg),
      debug: () => {},
    },
    pollSeconds: 2,
  })
  m.pollMs = 20
  return { m, warnings }
}

describe('watching an hdhomerun', () => {
  it('stops for good when stopped during a poll', async () => {
    const { m } = monitor()
    let polls = 0
    m.poll = async () => {
      polls++
      await sleep(60)
    }
    m.start()
    await sleep(20)
    m.stop()
    await sleep(200)
    expect(polls).toBe(1)
    expect(m.timer).toBeNull()
  })

  it('keeps polling after a poll fails', async () => {
    const { m, warnings } = monitor()
    let polls = 0
    m.poll = async () => {
      polls++
      throw new Error('could not save state.json')
    }
    m.start()
    await sleep(120)
    m.stop()
    expect(polls).toBeGreaterThan(1)
    expect(warnings[0]).toContain('could not save state.json')
  })
})
