import { describe, expect, it } from 'vitest'

import { ChannelsDvr } from './channels.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = {
  info: () => {},
  warn: () => {},
  debug: () => {},
}

/** A Channels DVR client with the network left out. */
function dvr() {
  const d = new ChannelsDvr({ enabled: true, log, dir: '/nonexistent' })
  d.autoRetryMs = 20
  d.resolveHost = async () => {}
  d.polls = 0
  d.poll = async () => {
    d.polls++
  }
  d.pollActivity = async () => {}
  return d
}

describe('channels dvr on this machine', () => {
  it('keeps looking when it starts after homebridge', async () => {
    const d = dvr()
    let looks = 0
    d.findLocal = async () => ++looks >= 3

    await d.start()
    await sleep(150)
    d.stop()

    expect(looks).toBe(3)
    expect(d.polls).toBeGreaterThan(0)
  })

  it('stops looking once stopped', async () => {
    const d = dvr()
    let looks = 0
    d.findLocal = async () => {
      looks++
      return false
    }

    await d.start()
    d.stop()
    await sleep(100)

    expect(looks).toBe(1)
  })

  it('stops for good when stopped during a poll', async () => {
    const d = dvr()
    d.url = 'http://127.0.0.1:8089'
    d.auto = false
    d.activityMs = 10
    let reads = 0
    d.pollActivity = async () => {
      reads++
      await sleep(60)
    }

    await d.start()
    await sleep(20)
    d.stop()
    await sleep(150)

    expect(reads).toBe(1)
  })
})
