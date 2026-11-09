/**
 * The settings schema is checked by Homebridge's verification, and by the
 * Homebridge UI every time someone saves. These keep it valid for both.
 */
import { readFileSync } from 'node:fs'

import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'

const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))
const schemaFile = read('../config.schema.json')
const pkg = read('../package.json')
const validate = new Ajv({ strict: false, allErrors: true }).compile(schemaFile.schema)

/** Every place a field says "required": true, which json schema rejects. */
function requiredFlags(node, path = '$') {
  if (!node || typeof node !== 'object') {
    return []
  }
  const own = typeof node.required === 'boolean'
    ? [path]
    : []
  return [
    ...own,
    ...Object.entries(node.properties ?? {}).flatMap(([key, sub]) => requiredFlags(sub, `${path}.${key}`)),
    ...requiredFlags(node.items, `${path}[]`),
  ]
}

/** Every field the layout shows, as "devices[].host" and so on. */
function layoutKeys(items) {
  return (items ?? []).flatMap((item) => {
    if (typeof item === 'string') {
      return [item]
    }
    return [
      ...(item.key
        ? [item.key]
        : []),
      ...layoutKeys(item.items),
    ]
  })
}

function schemaHas(key) {
  let node = schemaFile.schema
  for (const part of key.split('.')) {
    const name = part.replace('[]', '')
    node = node?.properties?.[name]
    if (part.endsWith('[]')) {
      node = node?.items
    }
  }
  return Boolean(node)
}

describe('the settings schema', () => {
  it('uses the same platform name as the plugin', async () => {
    const source = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
    expect(schemaFile.pluginAlias).toBe(pkg.alias)
    expect(source).toContain(`const PLATFORM_NAME = '${pkg.alias}'`)
  })

  it('is a dynamic platform with a name field', () => {
    expect(schemaFile.pluginType).toBe('platform')
    expect(schemaFile.schema.properties.name).toBeTruthy()
  })

  it('lists required fields the json schema way, not as "required": true', () => {
    expect(requiredFlags(schemaFile.schema)).toEqual([])
  })

  it('accepts the platform with only its name', () => {
    expect(validate({ name: 'HDHomeRun' }), JSON.stringify(validate.errors)).toBe(true)
  })

  it('accepts a full config', () => {
    const config = {
      name: 'HDHomeRun',
      appleHome: 'matter',
      homekitLayout: 'separate',
      devices: [
        {
          name: 'Lounge',
          host: '192.168.1.30',
          tuners: [1, 2],
          onDelaySeconds: 30,
        },
      ],
      clients: [
        { ip: '192.168.1.20', name: 'Lounge Apple TV' },
      ],
      channelsDvr: {
        url: 'http://192.168.1.5:8089',
        channelSwitches: ['104'],
      },
      dashboard: { port: 8588, host: '127.0.0.1' },
    }
    expect(validate(config), JSON.stringify(validate.errors)).toBe(true)
  })

  it('shows only fields that exist in the layout', () => {
    expect(layoutKeys(schemaFile.layout).filter(key => !schemaHas(key))).toEqual([])
  })
})
