import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@teoclub/cordis'
import Loader from '@teoclub/cordis-plugin-loader'
import Include from '@teoclub/cordis-plugin-include'
import { S } from '../conformance/utils.ts'

/**
 * Nine-package integration flow (SPEC §9.2): cold start from cordis.yml ->
 * plugin tree loading -> runtime entry CRUD -> failed-update containment ->
 * atomic write-back -> full disposal cleanup.
 */

const isNode = typeof (process.versions as any).bun === 'undefined'
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

  // Runtime-diff (Node only): the assertion below triggers a plugin that
  // throws during a config-driven restart, which the reverted `Fiber.update()`
  // can no longer report to its caller. Node routes that through
  // `unhandledRejection`, which the test captures; Bun attributes it to the
  // running test and fails it outright, and offers no hook to consume it.
  const _it = isNode ? it : it.skip
  _it('failed update reports the failure without rolling the entry back', async () => {
    await boot()
    const include = ctx.loader.resolve(Object.keys(ctx.loader.store)[0]).subtree as any
    const entry = include.store['p1']
    expect(entry.options.config).toEqual({ marker: 'first' })

    // The plugin throws on marker === 'bad'. The reverted, non-transactional
    // update path assigns the new config and restarts eagerly, so the previous
    // plugin is NOT restored and `update()` resolves normally (reverted PR
    // #932). Because `Fiber.update()` no longer returns the restart promise,
    // the failure surfaces as an unhandled rejection rather than to the
    // caller - captured here so the contract is pinned rather than incidental.
    const rejections: Error[] = []
    const capture = (reason: unknown) => { rejections.push(reason as Error) }
    process.on('unhandledRejection', capture)
    try {
      await include.update('p1', { config: { marker: 'bad' } })
      await new Promise((resolve) => setTimeout(resolve, 100))
    } finally {
      process.off('unhandledRejection', capture)
    }

    expect(entry.options.config).toEqual({ marker: 'bad' })
    expect(entry.fiber?.state).toBe(S.FAILED)
    expect(rejections.map((error) => error.message)).toContain('refusing bad config')
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
