import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Node runtime tests (SPEC §9.1, AC-005): the HMR Node engine performs
 * module-graph partial reload. The scenario runs in a child process with
 * `--expose-internals` (required for the module cache) and reports its
 * observations as JSON. These tests only run under vitest (Node).
 */

const isNode = typeof (process.versions as any).bun === 'undefined'
const _d = isNode ? describe : describe.skip

/** Scenario executed inside the --expose-internals child process. */
const scenario = `
import { Context } from '@teoclub/cordis'
import Loader from '@teoclub/cordis-plugin-loader'
import Timer from '@teoclub/cordis-plugin-timer'
import Hmr from '@teoclub/cordis-plugin-hmr'
import { realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// realpath the root: on macOS the temp dir lives behind symlinks (/var ->
// /private/var), and the HMR watcher realpaths its base while module
// resolution keeps the given path - mismatched URLs would classify every
// change as unrelated to the loaded plugins.
const root = await realpath(process.argv[2])
const seen = []
const disposed = []
const exitCalls = []
const hmrEvents = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const pluginSource = (version) => \`
export default {
  name: 'node-hmr-plugin',
  apply(c) {
    globalThis.__seen.push(\${JSON.stringify(version)})
    c.effect(() => () => globalThis.__disposed.push(\${JSON.stringify(version)}))
  },
}
\`
globalThis.__seen = seen
globalThis.__disposed = disposed

await writeFile(join(root, 'plugin.mjs'), pluginSource('v1'))
await writeFile(join(root, 'cordis.yml'), '- id: p1\\n  name: ./plugin.mjs\\n')

const ctx = new Context()
ctx.baseUrl = new URL('file://' + root + '/').href
await ctx.plugin(Timer)
await ctx.plugin(Loader, { baseUrl: ctx.baseUrl })
await ctx.loader.create({
  name: '@teoclub/cordis-plugin-include',
  config: { path: './cordis.yml' },
})
await ctx.plugin(Hmr, { root: ['.'], debounce: 20, ignored: ['**/node_modules', '**/.*'] })
ctx.loader.exit = () => { exitCalls.push('exit') }
ctx.on('hmr/change', (url) => hmrEvents.push('change:' + url))
ctx.on('hmr/reload', (reloads) => hmrEvents.push('reload:' + reloads.size))
await sleep(300)

// module change -> partial reload expected
await writeFile(join(root, 'plugin.mjs'), pluginSource('v2'))
await sleep(500)

console.log('@@RESULT@@' + JSON.stringify({
  seen,
  disposed,
  exitCalls,
  registrySize: ctx.registry.size,
  hmrEvents,
}))
process.exit(0)
`

_d('hmr node engine (subprocess with --expose-internals)', () => {
  it('module change triggers partial reload, not a full restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cordis-node-hmr-'))
    // the scenario file must live inside the repo for workspace resolution,
    // and the tmp root needs the workspace node_modules for entry imports
    const script = resolve('tmp', 'hmr-node-scenario.mjs')
    try {
      await symlink(resolve('node_modules'), join(root, 'node_modules'), 'dir')
      await writeFile(script, scenario)
      const { stdout } = await run(process.execPath, ['--expose-internals', script, root], {
        cwd: process.cwd(),
        env: process.env,
        timeout: 30_000,
      })
      const line = stdout.split('@@RESULT@@')[1]
      expect(line, 'scenario output: ' + stdout).toBeTruthy()
      const result = JSON.parse(line.trim().split('\n')[0])
      expect(result.hmrEvents, 'diagnostics').toBeDefined()

      // initial load + partial reload both applied in-process
      expect(result.seen).toEqual(['v1', 'v2'])
      // the old fiber was disposed by the reload
      expect(result.disposed).toEqual(['v1'])
      // partial reload: the exit hook must NOT fire
      expect(result.exitCalls).toEqual([])
      // exactly one reload round with one plugin reloaded
      expect(result.hmrEvents).toContain('reload:1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
