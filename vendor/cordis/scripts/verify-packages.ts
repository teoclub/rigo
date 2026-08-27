/**
 * Package structure gate (SPEC §9.4 AC-001).
 *
 * Verifies for each of the nine packages:
 *   - existence, name, version per the PRD §6.1 mapping and SPEC D5
 *   - exports map shape (SPEC §4.2), engines field (D6), teoclub.source
 *     provenance metadata (FR-DIST-004 / SPEC §3.1)
 *   - README + LICENSE presence
 *   - built runtime artifacts (lib/index.js &c.) and declaration artifacts
 *     (lib/types/*.d.ts) after a build
 *
 * Usage: bun scripts/verify-packages.ts [--no-build-artifacts]
 */
import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

interface Expectation {
  dir: string
  name: string
  version: string
  /** runtime artifacts that must exist post-build */
  runtime: string[]
  types: string[]
  bin?: boolean
  dualFormat?: boolean
  browserEntry?: boolean
}

const EXPECTATIONS: Expectation[] = [
  { dir: 'packages/kit', name: '@teoclub/kit', version: '1.8.2', runtime: ['lib/index.js'], types: ['lib/types/index.d.ts'] },
  { dir: 'packages/schemastery', name: '@teoclub/schemastery', version: '3.18.1', runtime: ['lib/index.mjs', 'lib/index.cjs'], types: ['lib/types/index.d.ts'], dualFormat: true },
  { dir: 'packages/cordis', name: '@teoclub/cordis', version: '5.0.0', runtime: ['lib/index.js'], types: ['lib/types/index.d.ts'], bin: true },
  { dir: 'packages/plugins/loader', name: '@teoclub/cordis-plugin-loader', version: '1.0.2', runtime: ['lib/index.js'], types: ['lib/types/index.d.ts'] },
  { dir: 'packages/plugins/include', name: '@teoclub/cordis-plugin-include', version: '1.0.6', runtime: ['lib/index.js'], types: ['lib/types/index.d.ts'] },
  { dir: 'packages/plugins/group', name: '@teoclub/cordis-plugin-group', version: '1.0.1', runtime: ['lib/index.js'], types: ['lib/types/index.d.ts'] },
  { dir: 'packages/plugins/timer', name: '@teoclub/cordis-plugin-timer', version: '1.1.3', runtime: ['lib/index.js'], types: ['lib/types/index.d.ts'] },
  { dir: 'packages/plugins/hmr', name: '@teoclub/cordis-plugin-hmr', version: '1.0.16', runtime: ['lib/index.js'], types: ['lib/types/index.d.ts'] },
  { dir: 'packages/plugins/logger-console', name: '@teoclub/cordis-plugin-logger-console', version: '1.0.1', runtime: ['lib/index.js', 'lib/browser.js'], types: ['lib/types/shared.d.ts'], browserEntry: true },
]

const PINNED_COMMIT = /^[0-9a-f]{40}$/

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const checkBuildArtifacts = !process.argv.includes('--no-build-artifacts')
  let failures = 0
  const fail = (msg: string) => {
    console.error(`✗ ${msg}`)
    failures++
  }

  if (EXPECTATIONS.length !== 9) fail(`expected 9 package expectations, got ${EXPECTATIONS.length}`)

  for (const exp of EXPECTATIONS) {
    const dir = join(root, exp.dir)
    if (!(await exists(dir))) {
      fail(`${exp.dir}: package directory missing`)
      continue
    }
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))

    if (pkg.name !== exp.name) fail(`${exp.dir}: name is ${pkg.name}, expected ${exp.name}`)
    if (pkg.version !== exp.version) fail(`${exp.dir}: version is ${pkg.version}, expected ${exp.version}`)
    if (pkg.type !== 'module') fail(`${exp.dir}: type must be "module"`)
    if (pkg.license !== 'MIT') fail(`${exp.dir}: license must be MIT`)
    if (pkg.engines?.node !== '^22.19.0 || >=24.0.0') fail(`${exp.dir}: engines.node must be "^22.19.0 || >=24.0.0"`)

    // provenance metadata (SPEC §3.1)
    const source = pkg.teoclub?.source
    if (!source) {
      fail(`${exp.dir}: teoclub.source provenance metadata missing`)
    } else {
      if (source.repository !== 'deepseek-ai/deepseek-harness') fail(`${exp.dir}: teoclub.source.repository wrong`)
      if (!PINNED_COMMIT.test(source.commit ?? '')) fail(`${exp.dir}: teoclub.source.commit must be a 40-hex commit`)
      if (!source.upstreamPackage?.startsWith('@deepseek-ai/')) fail(`${exp.dir}: teoclub.source.upstreamPackage wrong`)
      if (typeof source.upstreamVersion !== 'string') fail(`${exp.dir}: teoclub.source.upstreamVersion missing`)
    }

    // exports map (SPEC §4.2)
    const exports = pkg.exports?.['.'] ?? {}
    if (exp.dualFormat) {
      if (exports.import !== './lib/index.mjs') fail(`${exp.dir}: exports.import must be ./lib/index.mjs`)
      if (exports.require !== './lib/index.cjs') fail(`${exp.dir}: exports.require must be ./lib/index.cjs`)
    } else if (exp.browserEntry) {
      if (exports.node !== './lib/index.js') fail(`${exp.dir}: exports.node must be ./lib/index.js`)
      if (exports.default !== './lib/browser.js') fail(`${exp.dir}: exports.default must be ./lib/browser.js`)
    } else {
      if (exports.import !== './lib/index.js') fail(`${exp.dir}: exports.import must be ./lib/index.js`)
    }
    if (pkg.exports?.['./src/*'] !== './src/*') fail(`${exp.dir}: ./src/* export missing (D7)`)
    if (pkg.exports?.['./package.json'] !== './package.json') fail(`${exp.dir}: ./package.json export missing`)

    if (exp.bin && pkg.bin?.cordis !== 'bin.js') fail(`${exp.dir}: bin.cordis must be bin.js`)
    if (exp.dir === 'packages/kit' && pkg.sideEffects !== false) fail(`${exp.dir}: kit must declare sideEffects:false (FR-KIT-003)`)

    // docs + license files
    for (const f of ['README.md', 'LICENSE']) {
      if (!(await exists(join(dir, f)))) fail(`${exp.dir}: ${f} missing`)
    }

    // build artifacts
    if (checkBuildArtifacts) {
      for (const f of [...exp.runtime, ...exp.types]) {
        if (!(await exists(join(dir, f)))) fail(`${exp.dir}: build artifact ${f} missing (run bun run build)`)
      }
    }
  }

  console.log(`verify-packages: ${failures} failure(s) across ${EXPECTATIONS.length} packages${checkBuildArtifacts ? ' (incl. build artifacts)' : ' (manifests only)'}`)
  process.exit(failures ? 1 : 0)
}

main()
