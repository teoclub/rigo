/**
 * Exact-path watching for live profile patch files outside Cordis module roots.
 *
 * Ported from deepseek-harness `packages/boot/app-boot/src/watch-config.ts`:
 * the transactional HMR revert (PR #932) deleted `Hmr.registerConfig()` along
 * with its only consumer, moving the responsibility here so the watcher is
 * owned by the app rather than the framework. The watch root is the deepest
 * existing ancestor, canonicalized, so a path under missing parents still
 * reports its requested spelling.
 */
import { dirname, relative, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { watch, type ChokidarOptions } from 'chokidar'
import type { Context } from '@teoclub/cordis'

const registrations = new WeakMap<Context, Set<string>>()

/**
 * Canonicalize the deepest existing ancestor of a config path.
 * @param filename - absolute config path, possibly under missing parents.
 * @returns the canonical directory to watch, the filename expressed under it,
 * and the depth needed to reach the file from that directory.
 * @throws when an existing ancestor is not a directory, or the walk exhausts the filesystem.
 */
async function findWatchRoot(filename: string): Promise<{ filename: string; root: string; depth: number }> {
  let root = dirname(filename)
  let depth = 0
  while (true) {
    try {
      if (!(await stat(root)).isDirectory()) throw new Error(`config watch parent is not a directory: ${root}`)
      const canonicalRoot = await realpath(root)
      return { filename: resolve(canonicalRoot, relative(root, filename)), root: canonicalRoot, depth }
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') throw error
      const parent = dirname(root)
      if (parent === root) throw error
      root = parent
      depth += 1
    }
  }
}

/**
 * Watch one patch path, including missing parents, and serialize refresh callbacks.
 *
 * Refreshes coalesce: a change arriving while a refresh runs marks the state
 * dirty and the running loop picks it up again, so overlapping filesystem
 * events can never interleave two applies over the same tree. A failing
 * refresh is logged and never escapes the watcher.
 *
 * @param ctx - context that owns watcher disposal and receives refresh failures.
 * @param filename - absolute path of the file to watch.
 * @param options - deployment watcher options inherited from the HMR configuration.
 * @param refresh - callback run on add, change, and unlink.
 * @returns an asynchronous disposer that closes the watcher and drains the current refresh.
 * @throws when path resolution, watcher startup, or effect registration fails.
 */
export async function watchConfig(
  ctx: Context, filename: string, options: ChokidarOptions, refresh: () => Promise<void> | void,
): Promise<() => Promise<void>> {
  const target = await findWatchRoot(filename)
  const paths = registrations.get(ctx) ?? new Set<string>()
  registrations.set(ctx, paths)
  if (paths.has(target.filename)) throw new Error(`config path already registered: ${filename}`)
  const { cwd: _cwd, ignored: _ignored, ...watchOptions } = options
  const watcher = watch(target.root, {
    ...watchOptions, depth: target.depth, ignoreInitial: false,
  })
  paths.add(target.filename)
  const state = { dirty: false }
  let running: Promise<void> | undefined
  const onChange = (path: string) => {
    const observed = resolve(path)
    if (observed !== filename && observed !== target.filename) return
    state.dirty = true
    if (running) return
    running = (async () => {
      while (state.dirty) {
        state.dirty = false
        try {
          await refresh()
        } catch (reason) {
          const error = reason instanceof Error ? reason : new Error(String(reason), { cause: reason })
          ctx.logger.warn('config reload at %C failed', filename)
          ctx.logger.warn(error)
        }
      }
    })().finally(() => { running = undefined })
  }
  watcher.on('add', onChange)
  watcher.on('change', onChange)
  watcher.on('unlink', onChange)
  const ready = Promise.withResolvers<void>()
  let pending = true
  watcher.once('ready', () => { pending = false; ready.resolve() })
  watcher.on('error', (error) => {
    if (pending) { pending = false; ready.reject(error) } else { ctx.logger.warn(error) }
  })
  const dispose = async () => {
    await watcher.close()
    paths.delete(target.filename)
    await running
  }
  try {
    await ready.promise
    return ctx.effect(() => dispose, 'app-boot.watchConfig()')
  } catch (error) {
    await dispose()
    throw error
  }
}
