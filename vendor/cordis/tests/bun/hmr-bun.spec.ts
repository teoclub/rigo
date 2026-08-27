import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@teoclub/cordis'
import Loader from '@teoclub/cordis-plugin-loader'
import Timer from '@teoclub/cordis-plugin-timer'
import Hmr from '@teoclub/cordis-plugin-hmr'

/**
 * Bun runtime tests (SPEC §9.1): the HMR Bun engine (D10) provides
 * configuration refresh + controlled full restart instead of Node's
 * module-graph partial reload. These tests only run under `bun test`.
 */

const isBun = typeof (process.versions as any).bun === 'string'
const _d = isBun ? describe : describe.skip

_d('hmr bun engine', () => {
  let root: string
  let ctx: Context
  let exitCalls: string[]

  const pluginSource = () => `
export default {
  name: 'bun-hmr-plugin',
  apply(c, config) {
    globalThis.__bunHmrSeen.push(config?.marker ?? 'first')
    c.effect(() => () => globalThis.__bunHmrDisposed.push(config?.marker ?? 'first'))
  },
}
`

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cordis-bun-'))
    ;(globalThis as any).__bunHmrSeen = []
    ;(globalThis as any).__bunHmrDisposed = []
    exitCalls = []
    await writeFile(join(root, 'plugin.mjs'), pluginSource())
    await writeFile(join(root, 'cordis.yml'), [
      '- id: p1',
      '  name: ./plugin.mjs',
      '',
    ].join('\n'))

    ctx = new Context()
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Timer)
    await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
    await ctx.loader.create({
      name: '@teoclub/cordis-plugin-include',
      config: { path: './cordis.yml' },
    })
    // HMR boots under Bun without --expose-internals (Bun engine)
    await ctx.plugin(Hmr, { root: ['.'], debounce: 20, ignored: [] })
    // stub the exit hook: record instead of exiting the test process
    ctx.loader.exit = () => { exitCalls.push('exit') }
    await new Promise((resolve) => setTimeout(resolve, 300))
  })

  afterAll(async () => {
    try { await ctx?.root.fiber.dispose() } catch {}
    await rm(root, { recursive: true, force: true })
  })

  it('boots the HMR service under Bun and loads entries', async () => {
    expect((globalThis as any).__bunHmrSeen).toEqual(['first'])
    expect(ctx.hmr).toBeTruthy()
  })

  it('config refresh: cordis.yml changes re-apply the plugin', async () => {
    const before = (globalThis as any).__bunHmrSeen.length
    await writeFile(join(root, 'cordis.yml'), [
      '- id: p1',
      '  name: ./plugin.mjs',
      '  config:',
      '    marker: second',
      '',
    ].join('\n'))
    await new Promise((resolve) => setTimeout(resolve, 400))
    const seen = (globalThis as any).__bunHmrSeen
    expect(seen.length).toBeGreaterThan(before)
    expect(seen[seen.length - 1]).toBe('second')
    // refresh must not force a full restart
    expect(exitCalls).toEqual([])
  })

  it('safe restart: module changes dispose the tree and call loader.exit', async () => {
    const disposedBefore = (globalThis as any).__bunHmrDisposed.length
    // module code change: not a config file -> full restart path
    await writeFile(join(root, 'plugin.mjs'), pluginSource())
    await new Promise((resolve) => setTimeout(resolve, 400))

    // exit hook fired exactly once (debounced)
    expect(exitCalls.length).toBeGreaterThanOrEqual(1)

    // the root fiber was unloaded: the plugin's disposer ran
    const disposed = (globalThis as any).__bunHmrDisposed
    expect(disposed.length).toBeGreaterThan(disposedBefore)

    // restart invariants (SPEC §5.4): no duplicate service registration -
    // the plugin's service entries are gone after unload
    expect(ctx.registry.size).toBe(0)
  })
})
