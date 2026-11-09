import { describe, expect, it } from 'vitest'

import { parseActivity, parseValue } from './activity.js'

/**
 * Channels DVR describes each live stream in a line of text. These are the
 * shapes it sends, and what the plugin reads from each.
 */

describe('a channels dvr activity line', () => {
  it('reads the channel, its name, the device and its address while watching', () => {
    expect(parseValue('Watching ch104 Sky News from Lounge Apple TV (192.168.1.20): buf=0% drop=0%')).toEqual({
      activity: 'watching',
      channelNumber: '104',
      channelName: 'Sky News',
      device: 'Lounge Apple TV',
      ip: '192.168.1.20',
    })
  })

  it('takes a bare address as the address, not the device name', () => {
    expect(parseValue('Watching ch7 from 10.0.0.2: buf=1%')).toEqual({
      activity: 'watching',
      channelNumber: '7',
      channelName: undefined,
      device: undefined,
      ip: '10.0.0.2',
    })
  })

  it('reads a sub-channel number', () => {
    expect(parseValue('Watching channel 5.1 KQED HD from Kitchen iPad')).toMatchObject({
      channelNumber: '5.1',
      channelName: 'KQED HD',
      device: 'Kitchen iPad',
    })
  })

  it('leaves out an address that is not one', () => {
    expect(parseValue('Watching ch12 Prime from Den (bad ip): x')).toMatchObject({ device: 'Den', ip: undefined })
  })

  it('reads the title of a recording', () => {
    expect(parseValue('Recording ch5 for The Chase until 7:00pm: buf=0%')).toEqual({
      activity: 'recording',
      channelNumber: '5',
      title: 'The Chase',
    })
  })

  it('has no title for a recording without an end time', () => {
    expect(parseValue('Recording ch5 for The Chase')).toEqual({
      activity: 'recording',
      channelNumber: '5',
      title: undefined,
    })
  })

  it('ignores anything that is not watching or recording', () => {
    expect(parseValue('Streaming \'A movie\' to Lounge')).toBeNull()
    expect(parseValue('')).toBeNull()
  })

  it('finishes quickly on a long line with no end', () => {
    // the old patterns took 15 seconds over this one
    const line = `Watching ch1 ${' '.repeat(5000)}x`
    const started = Date.now()
    parseValue(line)
    expect(Date.now() - started).toBeLessThan(200)
  })
})

describe('the channels dvr activity list', () => {
  it('tells online channels from hdhomerun tuners by the session name', () => {
    const parsed = parseActivity({
      '6-stream-M3U-Online-192.168.1.20': 'Watching ch104 Sky News from Lounge Apple TV (192.168.1.20): buf=0%',
      '6-stream-1050ABCD-192.168.1.42': 'Watching ch1 TVNZ 1 from Bedroom TV (192.168.1.42)',
      'x': 'Streaming \'A movie\' to Lounge',
    })
    expect(parsed.map(p => p.kind)).toEqual(['online', 'tuner'])
    expect(parsed[0].sourceName).toBe('Online')
    expect(parsed[1].deviceId).toBe('1050ABCD')
  })
})
