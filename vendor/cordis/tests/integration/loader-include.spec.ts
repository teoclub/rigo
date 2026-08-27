import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@teoclub/cordis'
import Loader from '@teoclub/cordis-plugin-loader'
import Include from '@teoclub/cordis-plugin-include'

/**
 * Nine-package integration flow (SPEC §9.2): cold start from cordis.yml ->
 * plugin tree loading -> runtime entry CRUD -> failed-update rollback ->
 * atomic write-back -> full disposal cleanup.
 */

let root: string
let ctx: Context
const applied: Record<string, any[]> = {}

const pluginSource = `
export default {
  name: 'local-test-plugin',
  apply(c, config) {
    c.provide('local-plugin-seen-' + (config?.marker ?? 'x'), true)
    globalThis.__integrationSeen.push(config)
    if (config && config.marker === 'bad') throw new Error('refusing bad config')
    c.effect(() => () => { globalThis.__integrationDisposed.push(config) })
  },
}
`

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cordis-it-'))
  ;(globalThis as any).__integrationSeen = []
  ;(globalThis as any).__integrationDisposed = []
  await writeFile(join(root, 'plugin.mjs'), pluginSource)
  await writeFile(join(root, 'cordis.yml'), [
    "- id: p1",
    "  name: ./plugin.mjs",
    "  config:",
    "    marker: first",
    "",
  ].join('\n'))
  ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
})

afterEach(async () => {
  // beforeEach creates a fresh tmp root per test: clean up per test, not
  // once at the end (which would leak every root but the last)
  await rm(root, { recursive: true, force: true })
})

async function boot() {
  await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
  await ctx.loader.create({
    name: '@teoclub/cordis-plugin-include',
    config: { path: './cordis.yml' },
  })
  // settle the entry tree
  await ctx.loader.await()
  await new Promise((resolve) => setTimeout(resolve, 50))
}

describe('integration: loader + include', () => {
  it('cold start: cordis.yml entries load and apply', async () => {
    await boot()
    const seen = (globalThis as any).__integrationSeen
    expect(seen).toEqual([{ marker: 'first' }])
    expect(ctx.get('local-plugin-seen-first')).toBe(true)
  })

  it('entry CRUD: create, update config, remove', async () => {
    await boot()

    // create
    const id = await ctx.loader.create({
      name: './plugin.mjs',
      config: { marker: 'created' },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((globalThis as any).__integrationSeen).toHaveLength(2)

    // update config -> plugin re-applies with the new config
    await ctx.loader.update(id, { name: './plugin.mjs', config: { marker: 'updated' } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const seen = (globalThis as any).__integrationSeen
    expect(seen[seen.length - 1]).toEqual({ marker: 'updated' })

    // remove -> disposed and no longer written back
    await ctx.loader.remove(id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const afterRemove = (globalThis as any).__integrationDisposed.length
    expect(afterRemove).toBeGreaterThanOrEqual(2)

    // write-back reflects the surviving tree
    const content = await readFile(join(root, 'cordis.yml'), 'utf8')
    expect(content).toContain('p1')
    expect(content).not.toContain('marker: created')
  })

  it('failed update rolls back to the previous plugin state', async () => {
    await boot()
    const seenBefore = (globalThis as any).__integrationSeen.length
    const id = ctx.loader.store['p1'] ? 'p1' : Object.keys(ctx.loader.store)[0]

    // the plugin throws on marker === 'bad'
    await expect(ctx.loader.update(id, {
      name: './plugin.mjs',
      config: { marker: 'bad' },
    })).rejects.toThrow(/refusing bad config/)
    await new Promise((resolve) => setTimeout(resolve, 50))

    // the previous fiber/config is restored: the plugin still runs 'first'
    const seen = (globalThis as any).__integrationSeen
    expect(seen[seen.length - 1]).toEqual({ marker: 'first' })
    expect(seen.length).toBeGreaterThan(seenBefore)

    // write-back still contains the working config, not the failed one
    const content = await readFile(join(root, 'cordis.yml'), 'utf8')
    expect(content).toContain('marker: first')
    expect(content).not.toContain("marker: 'bad'")
    expect(content).not.toContain('marker: bad')
  })

  it('dispose: root disposal unloads every entry cleanly', async () => {
    await boot()
    await ctx.fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const disposed = (globalThis as any).__integrationDisposed
    expect(disposed).toEqual([{ marker: 'first' }])
    expect(ctx.get('local-plugin-seen-first')).toBeUndefined()
  })

  it('JSON config files are also supported', async () => {
    await rm(join(root, 'cordis.yml'))
    await writeFile(join(root, 'cordis.json'), JSON.stringify([
      { id: 'j1', name: './plugin.mjs', config: { marker: 'json' } },
    ]))
    await boot2('./cordis.json')
    expect((globalThis as any).__integrationSeen).toEqual([{ marker: 'json' }])
  })

  async function boot2(path: string) {
    const ctx2 = new Context()
    ctx2.baseUrl = pathToFileURL(root).href + '/'
    await ctx2.plugin(Loader, { baseUrl: ctx2.baseUrl })
    await ctx2.loader.create({
      name: '@teoclub/cordis-plugin-include',
      config: { path },
    })
    await ctx2.loader.await()
    await new Promise((resolve) => setTimeout(resolve, 50))
    await ctx2.fiber.dispose()
  }
})
