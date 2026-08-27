/**
 * Package smoke test (SPEC §9.3, AC-007): pack all nine packages, verify
 * the tarballs (structure + zero old-scope residue), install them into a
 * fresh empty project, and run a minimal plugin lifecycle smoke under both
 * Node and Bun.
 *
 * Usage: bun scripts/package-smoke.ts [--keep]
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

const PACKAGES = [
  'packages/kit',
  'packages/schemastery',
  'packages/cordis',
  'packages/plugins/loader',
  'packages/plugins/include',
  'packages/plugins/group',
  'packages/plugins/timer',
  'packages/plugins/hmr',
  'packages/plugins/logger-console',
]

const SMOKE = `
import { Context } from '@teoclub/cordis'
import Timer from '@teoclub/cordis-plugin-timer'

const ctx = new Context()
await ctx.plugin(Timer)
let disposed = false
const fiber = ctx.plugin({
  name: 'smoke',
  inject: ['timer'],
  apply(c) {
    // timer.interval() returns a disposal function (the timer clears with
    // the effect that owns it)
    const stop = c.timer.setInterval(() => {}, 1000)
    c.effect(() => () => { stop(); disposed = true })
  },
})
await fiber.await()
await fiber.dispose()
if (!disposed) throw new Error('disposer did not run')
console.log('SMOKE-OK')
`

function run(cmd: string, args: string[], opts: { cwd?: string; env?: any } = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts })
}

async function main() {
  const keep = process.argv.includes('--keep')
  const workDir = await mkdtemp(join(tmpdir(), 'cordis-pack-'))
  const packDir = join(workDir, 'pack')
  const unpackDir = join(workDir, 'unpack')
  const projectDir = join(workDir, 'project')
  await mkdir(packDir)
  await mkdir(unpackDir)
  await mkdir(projectDir)

  try {
    // 1. pack all nine packages
    for (const pkg of PACKAGES) {
      run('npm', ['pack', '--pack-destination', packDir], { cwd: join(root, pkg) })
    }
    // 2. unpack and run both gates on the unpacked trees
    const files = await readdir(packDir)
    if (files.length !== 9) throw new Error(`expected 9 tarballs, got ${files.length}`)

    // 2. unpack and run both gates on the unpacked trees
    for (const file of files) {
      const name = file.replace(/\.tgz$/, '')
      await mkdir(join(unpackDir, name))
      run('tar', ['xzf', join(packDir, file), '-C', join(unpackDir, name)])
    }
    run('bun', [join(root, 'scripts/verify-old-scopes.ts'), unpackDir])
    run('bun', [join(root, 'scripts/verify-packages.ts')], { env: { ...process.env } })

    // 3. empty project: install from the local tarballs
    const deps: Record<string, string> = {}
    for (const file of files) {
      const dir = file.replace(/\.tgz$/, '')
      const manifest = JSON.parse(await readFile(join(unpackDir, dir, 'package', 'package.json'), 'utf8'))
      deps[manifest.name] = `file:${join(packDir, file)}`
    }
    // include the runtime deps needed by the smoke
    await writeFile(join(projectDir, 'package.json'), JSON.stringify({
      name: 'cordis-pack-smoke',
      private: true,
      type: 'module',
      dependencies: {
        '@teoclub/cordis': deps['@teoclub/cordis'],
        '@teoclub/kit': deps['@teoclub/kit'],
        '@teoclub/cordis-plugin-timer': deps['@teoclub/cordis-plugin-timer'],
      },
      // bun treats file: dependency versions as 0.0.0, which does not
      // satisfy the packages' own semver ranges - force every @teoclub/*
      // name to the local tarball
      overrides: deps,
    }, null, 2))
    await writeFile(join(projectDir, 'smoke.mjs'), SMOKE)

    // Node install + run (explicit binary: this script may itself run under Bun)
    run('npm', ['install', '--silent', '--no-audit', '--no-fund'], { cwd: projectDir })
    const nodeOut = run('node', [join(projectDir, 'smoke.mjs')]).trim()
    if (!nodeOut.includes('SMOKE-OK')) throw new Error(`node smoke failed: ${nodeOut}`)

    // Bun install + run
    await rm(join(projectDir, 'node_modules'), { recursive: true, force: true })
    await rm(join(projectDir, 'package-lock.json'), { force: true })
    run('bun', ['install', '--silent'], { cwd: projectDir })
    const bunOut = run('bun', [join(projectDir, 'smoke.mjs')]).trim()
    if (!bunOut.includes('SMOKE-OK')) throw new Error(`bun smoke failed: ${bunOut}`)

    console.log('package-smoke: 9 tarballs packed, gates green, install + lifecycle smoke passed on Node and Bun')
  } finally {
    if (!keep) await rm(workDir, { recursive: true, force: true })
  }
}

main()
