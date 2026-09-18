/**
 * Exact-path config watching, now owned by app boot.
 *
 * Upstream's transactional HMR revert (PR #932) deleted `Hmr.registerConfig()`
 * and moved the responsibility into app boot, so these cases cover the
 * replacement directly rather than through the HMR service. Ported from
 * deepseek-harness `packages/boot/app-boot/tests/watch-config.spec.ts`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@teoclub/cordis'
import Hmr from '@teoclub/cordis-plugin-hmr'
import Loader from '@teoclub/cordis-plugin-loader'
import Timer from '@teoclub/cordis-plugin-timer'
import { watchConfig } from '@teoclub/harness-app-boot/src/watch-config.ts'
import { FSWatcher, type ChokidarOptions } from 'chokidar'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'

/**
 * Runtime-diff (Node only): the deterministic cases below need module mocking,
 * and Bun's vitest shim supplies neither `importOriginal` nor `vi.importActual`
 * to a `vi.mock` factory, so the factory cannot reach the real module there.
 * The three cases that drive a real watcher still run on both runtimes.
 */
const isNode = typeof (process.versions as { bun?: string }).bun === 'undefined'

/** Cases that drive the mocked watcher factory or the mocked `stat`. */
const _it = isNode ? it : it.skip

/**
 * Watcher-factory override, shared with the `chokidar` mock below.
 *
 * `vi.hoisted` is unavailable under Bun, so the holder lives on `globalThis`:
 * the hoisted mock factory may run before this module's `const` initializers,
 * and both sides must agree on one object regardless of order.
 */
const configWatch = ((globalThis as Record<string, unknown>).__rigoConfigWatch ??= {
  create: undefined as ((options?: ChokidarOptions) => FSWatcher) | undefined,
}) as { create: ((options?: ChokidarOptions) => FSWatcher) | undefined }

if (isNode) {
  vi.mock('node:fs/promises', async (importOriginal) => {
    const native = await importOriginal<typeof import('node:fs/promises')>()
    return { ...native, stat: vi.fn(native.stat) }
  })
  vi.mock('chokidar', async (importOriginal) => {
    const native = await importOriginal<typeof import('chokidar')>()
    const holder = ((globalThis as Record<string, unknown>).__rigoConfigWatch ??= { create: undefined }) as typeof configWatch
    return {
      ...native,
      watch: (paths: string | string[], options?: ChokidarOptions) =>
        holder.create === undefined ? native.watch(paths, options) : holder.create(options),
    }
  })
}

/** Every per-test tree root, removed once the booted watcher has been disposed. */
const hmrRoots: string[] = []

async function bootHmr(dir: string, root: string[] = [], usePolling?: boolean): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, {
    root,
    ignored: [],
    debounce: 0,
    ...usePolling === undefined ? {} : { usePolling },
  })
  return ctx
}

async function eventually(test: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('HMR exact config paths', () => {
  afterEach(() => {
    for (const root of hmrRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('collapses filesystem aliases before registering an exact watch', async () => {
    const target = mkdtempSync(join(tmpdir(), 'rigo-hmr-canonical-'))
    const alias = `${target}-alias`
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const ctx = await bootHmr(alias)
    try {
      await watchConfig(ctx, join(alias, 'plugins.yml'), {}, () => {})
      await expect(watchConfig(ctx, join(await realpath(target), 'plugins.yml'), {}, () => {}))
        .rejects.toThrow('config path already registered')
    } finally {
      await ctx.fiber.dispose()
      unlinkSync(alias)
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('observes add, change, and unlink outside its module roots', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rigo-hmr-config-'))
    hmrRoots.push(dir)
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    const observed: string[] = []
    try {
      await watchConfig(ctx, filename, {}, () => {
        try {
          observed.push(readFileSync(filename, 'utf8'))
        } catch (error) {
          if ((error as { code?: string }).code !== 'ENOENT') throw error
          observed.push('missing')
        }
      })

      writeFileSync(filename, 'one', { flag: 'wx' })
      await eventually(() => observed.includes('one'), 'HMR did not observe config creation')
      writeFileSync(filename, 'two')
      await eventually(() => observed.includes('two'), 'HMR did not observe config change')
      unlinkSync(filename)
      await eventually(() => observed.includes('missing'), 'HMR did not observe config removal')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('observes creation when the config parent did not exist at registration', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'rigo-hmr-config-'))
    hmrRoots.push(root)
    const dir = join(root, 'later')
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(root)
    const observed: string[] = []
    try {
      await watchConfig(ctx, filename, {}, () => {
        observed.push(readFileSync(filename, 'utf8'))
      })
      mkdirSync(dir)
      writeFileSync(filename, 'created')
      await eventually(() => observed.includes('created'), 'HMR did not observe config creation under a new parent')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  _it('serializes refreshes and waits for them during disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rigo-hmr-config-'))
    hmrRoots.push(dir)
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    onTestFinished(() => ctx.fiber.dispose())
    const watcher = new FSWatcher()
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    configWatch.create = () => { queueMicrotask(() => { watcher.emit('ready') }); return watcher }
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    onTestFinished(() => { release.resolve() })
    let calls = 0
    let active = 0
    let maxActive = 0
    const dispose = await watchConfig(ctx, filename, {}, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      if (++calls === 1) {
        started.resolve()
        await release.promise
      }
      active -= 1
    })
    watcher.emit('change', join(dir, 'unrelated.yml'))
    expect(calls).toBe(0)
    watcher.emit('add', filename)
    await started.promise
    watcher.emit('change', filename)
    watcher.emit('unlink', filename)
    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve()
    await disposal
    expect(maxActive).toBe(1)
    expect(calls).toBe(2)
  })

  it('rejects a patch path whose parent is a regular file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rigo-patch-parent-'))
    hmrRoots.push(dir)
    const parent = join(dir, 'file')
    writeFileSync(parent, '')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await expect(watchConfig(ctx, join(parent, 'plugins.yml'), {}, () => {}))
      .rejects.toThrow('config watch parent is not a directory')
  })

  _it('stops searching when the filesystem root cannot be read', async () => {
    const failure = Object.assign(new Error('filesystem root unavailable'), { code: 'ENOENT' })
    const read = vi.mocked(fsPromises.stat).mockClear().mockRejectedValueOnce(failure)
    onTestFinished(() => { read.mockRestore() })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await expect(watchConfig(ctx, join(parse(tmpdir()).root, 'plugins.yml'), {}, () => {})).rejects.toBe(failure)
    expect(read).toHaveBeenCalledOnce()
  })

  const releasesRegistrationAfterWatcherFailure = async (phase: 'creation' | 'ready') => {
    const dir = mkdtempSync(join(tmpdir(), 'rigo-patch-watch-failure-'))
    hmrRoots.push(dir)
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    const filename = join(dir, 'plugins.yml')
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    const failure = new Error('watcher unavailable')
    const failed = new FSWatcher()
    const closed = vi.spyOn(failed, 'close')
    configWatch.create = () => {
      if (phase === 'creation') throw failure
      queueMicrotask(() => { failed.emit('error', failure) })
      return failed
    }
    await expect(watchConfig(ctx, filename, {}, () => {})).rejects.toBe(failure)
    if (phase === 'ready') expect(closed).toHaveBeenCalledOnce()
    const watcher = new FSWatcher()
    configWatch.create = () => { queueMicrotask(() => { watcher.emit('ready') }); return watcher }
    await watchConfig(ctx, filename, {}, () => {})
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    watcher.emit('error', failure)
    expect(warn).toHaveBeenCalledWith(failure)  }
  _it('releases registration after watcher creation fails', () => releasesRegistrationAfterWatcherFailure('creation'))
  _it('releases registration after watcher ready fails', () => releasesRegistrationAfterWatcherFailure('ready'))

  _it('closes a ready watcher when its context has already been disposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rigo-patch-disposed-'))
    hmrRoots.push(dir)
    const root = new Context()
    const fiber = root.plugin(() => {})
    await fiber
    const ctx = fiber.ctx
    await fiber.dispose()
    const watcher = new FSWatcher()
    const close = vi.spyOn(watcher, 'close')
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    configWatch.create = () => { queueMicrotask(() => { watcher.emit('ready') }); return watcher }
    await expect(watchConfig(ctx, join(dir, 'plugins.yml'), {}, () => {}))
      .rejects.toThrow('cannot create effect on inactive context')
    expect(close).toHaveBeenCalledOnce()
  })

  _it('logs a normalized refresh failure and continues processing later events', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rigo-patch-failure-'))
    hmrRoots.push(dir)
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    onTestFinished(() => ctx.fiber.dispose())
    const watcher = new FSWatcher()
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    configWatch.create = () => { queueMicrotask(() => { watcher.emit('ready') }); return watcher }
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    let calls = 0
    const recovered = Promise.withResolvers<void>()
    await watchConfig(ctx, filename, {}, () => {
      if (++calls === 1) throw 42
      recovered.resolve()
    })
    watcher.emit('change', filename)
    await expect.poll(() => warn.mock.calls.length).toBe(2)
    expect(warn.mock.calls[0]).toEqual(['config reload at %C failed', filename])
    expect(warn.mock.calls[1]?.[0]).toMatchObject({ message: '42' })
    watcher.emit('change', filename)
    await recovered.promise
    expect(calls).toBe(2)
  })
})
