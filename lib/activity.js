/**
 * Parses Channels DVR's live activity, from GET /dvr → { activity: { <session id>: <text> } }.
 *
 * Session ids name the source the stream comes from:
 *   6-stream-1050ABCD-192.168.1.20        an HDHomeRun tuner (its device ID)
 *   6-stream-M3U-Online-192.168.1.20      a custom M3U source called "Online"
 *   6-stream-TVE-hulu_live-192.168.1.20   TV Everywhere
 * and the text says what it is doing:
 *   Watching ch104 Sky News from Lounge Apple TV (192.168.1.20): buf=0% drop=0%
 *   Recording ch5 for The Chase until 7:00pm: buf=0%
 */

const IP = /^\d{1,3}(?:\.\d{1,3}){3}$/

function parseSessionId(id) {
  const parts = String(id || '').split('-')
  const i = parts.findIndex(p => p === 'stream' || p.endsWith('stream'))
  if (i < 0 || i + 1 >= parts.length) {
    return { kind: 'unknown' }
  }
  const rest = parts.slice(i + 1)
  const ip = IP.test(rest[rest.length - 1])
    ? rest.pop()
    : undefined
  const type = rest.shift()
  if (/^[0-9A-F]{8}$/i.test(type)) {
    return {
      kind: 'tuner',
      deviceId: type.toUpperCase(),
      ip,
    }
  }
  if (/^M3U/i.test(type)) {
    return {
      kind: 'online',
      type: 'M3U',
      sourceName: rest.join('-') || 'M3U',
      ip,
    }
  }
  if (/^TVE/i.test(type)) {
    const p = rest.join('-').split('_')[0]
    return {
      kind: 'online',
      type: 'TVE',
      sourceName: p
        ? `TVE ${p[0].toUpperCase()}${p.slice(1)}`
        : 'TV Everywhere',
      ip,
    }
  }
  return {
    kind: 'online',
    type: type || 'Other',
    sourceName: [type, ...rest].join('-'),
    ip,
  }
}

function parseValue(text) {
  const v = String(text || '')
  const ch = /\bch(?:annel)?\s*(\d+(?:\.\d+)?)/i.exec(v)
  if (/^\s*Watching\b/i.test(v) && ch) {
    // "Watching ch104 Sky News from Lounge Apple TV (192.168.1.20): buf=0%"
    const fromAt = v.search(/\sfrom\s/i)
    const afterCh = v.slice(ch.index + ch[0].length, fromAt < 0
      ? undefined
      : fromAt).trim()
    const name = afterCh && !/[()]/.test(afterCh)
      ? afterCh
      : undefined
    const who = fromAt < 0
      ? ''
      : v.slice(fromAt).replace(/^\s*from\s*/i, '').split(':')[0]
    const open = who.indexOf('(')
    const close = who.indexOf(')', open)
    let device = (open < 0
      ? who
      : who.slice(0, open)).trim() || undefined
    let ip = open >= 0 && close > open
      ? who.slice(open + 1, close).trim()
      : undefined
    if (device && IP.test(device)) {
      ip = ip || device
      device = undefined
    }
    return {
      activity: 'watching',
      channelNumber: ch[1],
      channelName: name,
      device,
      ip: ip && IP.test(ip)
        ? ip
        : undefined,
    }
  }
  if (/^\s*Recording\b/i.test(v)) {
    // "Recording ch5 for The Chase until 7:00pm: buf=0%"
    const forAt = v.search(/\sfor\s/i)
    const rest = forAt < 0
      ? ''
      : v.slice(forAt)
    const untilAt = rest.search(/\suntil\s/i)
    const title = untilAt > 0
      ? rest.slice(0, untilAt).replace(/^\s*for\s*/i, '').trim()
      : ''
    return { activity: 'recording', channelNumber: ch?.[1], title: title || undefined }
  }
  return null
}

/** All live streams, watched or recorded, with where they come from. */
function parseActivity(activity) {
  const out = []
  for (const [id, text] of Object.entries(activity || {})) {
    const value = parseValue(text)
    if (!value) {
      continue
    }
    const src = parseSessionId(id)
    out.push({
      id,
      ...src,
      ...value,
      ip: value.ip || src.ip,
    })
  }
  return out
}

export { parseActivity, parseSessionId, parseValue }
