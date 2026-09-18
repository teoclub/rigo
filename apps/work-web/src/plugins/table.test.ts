/**
 * The composition resolver: host order wins, repeats collapse, and an id this
 * bundle cannot render is surfaced rather than fatal.
 */

import { describe, expect, it } from 'vitest'
import type { ClientPlugin } from '../slots/index.ts'

// The table is a module constant; these cases exercise the resolver against
// the same plugin set so they stay honest if the table grows.
import { ALL_CLIENT_PLUGIN_IDS, CLIENT_PLUGINS, selectClientPlugins } from './table.ts'

describe('selectClientPlugins', () => {
  it('resolves the ids this bundle knows, in host order', () => {
    const ids = ALL_CLIENT_PLUGIN_IDS
    const reversed = [...ids].reverse()
    const { enabled, unknown } = selectClientPlugins(reversed)
    expect(enabled.map(plugin => plugin.id)).toEqual(reversed)
    expect(unknown).toEqual([])
  })

  it('reports a host id this build cannot render without failing the rest', () => {
    const { enabled, unknown } = selectClientPlugins(['work.from-the-future', ...ALL_CLIENT_PLUGIN_IDS])
    expect(unknown).toEqual(['work.from-the-future'])
    expect(enabled.map(plugin => plugin.id)).toEqual([...ALL_CLIENT_PLUGIN_IDS])
  })

  it('collapses a repeated id to its first position', () => {
    const ids = ALL_CLIENT_PLUGIN_IDS
    if (ids.length === 0) return
    const first = ids[0]!
    const { enabled } = selectClientPlugins([first, first, ...ids.slice(1)])
    expect(enabled.map(plugin => plugin.id)).toEqual([...ids])
  })

  it('composes nothing for an empty host list — absence IS the host decision', () => {
    const { enabled, unknown } = selectClientPlugins([])
    expect(enabled).toEqual([])
    expect(unknown).toEqual([])
  })

  it('every table plugin has a well-formed, unique id', () => {
    const seen = new Set<string>()
    for (const plugin of CLIENT_PLUGINS as readonly ClientPlugin[]) {
      expect(plugin.id).toMatch(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/)
      expect(seen.has(plugin.id)).toBe(false)
      seen.add(plugin.id)
      expect(plugin.label.length).toBeGreaterThan(0)
    }
  })
})
