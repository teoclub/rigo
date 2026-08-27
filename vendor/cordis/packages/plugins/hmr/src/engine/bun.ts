import type { Context } from '@teoclub/cordis'
import type { Loader } from '@teoclub/cordis-plugin-loader'

/**
 * Bun engine (SPEC §5.4, D10): configuration refresh + controlled full
 * process restart. Bun has no equivalent of Node's `--expose-internals`
 * ESM loader, so module-graph partial reload is not available; a module
 * change that would reload plugin code triggers a safe full restart:
 *
 *   1. stop accepting new Fiber work (close the HMR watcher)
 *   2. root Fiber unload - every disposer runs and is awaited
 *   3. signal handling / exporter flush via the `exit` event
 *   4. `loader.exit()` - the host (bin layer) exits the process so an outer
 *      supervisor can respawn it. Bare `bun --hot` is NOT used (FR-HMR-004).
 */

export interface SafeRestartOptions {
  /** Changed module URL that forced the restart, for diagnostics. */
  url?: string
  /** Host exit hook; defaults to the loader's `exit()` (no-op unless the host overrides it). */
  exit?: () => void
}

export async function safeRestart(ctx: Context, loader: Loader, options: SafeRestartOptions = {}) {
  const logger = ctx.logger('hmr')
  if (options.url) {
    logger.info('module change at %C requires a full restart', options.url)
  } else {
    logger.info('full restart requested')
  }

  // 1. stop accepting new Fiber work: close the HMR watcher first so no
  // further change events can schedule reloads during teardown
  try {
    await ctx.hmr?._closeWatchers()
  } catch (error) {
    logger.warn(error)
  }

  // 2. root Fiber unload - every disposer runs (in reverse order) and the
  // unload is awaited to completion before exiting
  try {
    await ctx.root.fiber.dispose()
  } catch (error) {
    logger.warn(error)
  }

  // 3. signal handling and exporter flush: give hosts a final asynchronous
  // barrier (log exporters are synchronous; async exporters observe `exit`)
  try {
    await ctx.parallel('exit', 'hmr')
  } catch {
    // listeners are being torn down; their failures must not block exit
  }

  // 4. host hook: the bin layer exits the process; an outer supervisor
  // respawns it (documented restart contract)
  try {
    ;(options.exit ?? loader.exit.bind(loader))()
  } catch (error) {
    logger.warn(error)
  }
}
