/**
 * TEO Club patch ledger gate (SPEC §2.4).
 *
 * Re-derives the rescope transform of every upstream `.ts` file at the pinned
 * commit and classifies each vendored destination:
 *
 *   identical     - byte-identical to upstream; nothing to record
 *   registered    - diverges, and the path is in `merge-teo.ts`' TEO_PATCHES
 *   unregistered  - diverges with no ledger entry  ->  failure
 *
 * The `406cc95` fiber / registry / kit patches shipped without a ledger entry
 * and nothing caught it; this is the check that would have. It also fails when
 * a `PROTECTED` path has gone missing (what the old `rm(destDir)` did), and
 * warns when a registered patch no longer diverges because upstream adopted it.
 *
 * Usage: bun scripts/verify-teo-patches.ts <harness-clone-path>
 *        RIGO_UPSTREAM_CLONE=<path> bun scripts/verify-teo-patches.ts
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TEO_PATCHES } from './merge-teo.ts'
import { PACKAGES, PROTECTED, rescopeTypeScript } from './rescope.ts'

const root = resolve(import.meta.dir, '..')
const MAX_BUFFER = 64 * 1024 * 1024

/** The commit recorded in the package manifests is the pin of record. */
function pinnedCommit(): string {
  for (const spec of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(root, spec.destDir, 'package.json'), 'utf8'))
    const commit = manifest.teoclub?.source?.commit
    if (typeof commit === 'string' && commit.length) return commit
  }
  throw new Error('no teoclub.source.commit found in any vendored package manifest')
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', cwd ? ['-C', cwd, ...args] : args, { encoding: 'utf8', maxBuffer: MAX_BUFFER })
}

function main() {
  const clonePath = process.argv[2] ?? process.env.RIGO_UPSTREAM_CLONE
  if (!clonePath) {
    console.error('usage: bun scripts/verify-teo-patches.ts <harness-clone-path>')
    console.error('   or: RIGO_UPSTREAM_CLONE=<path> bun scripts/verify-teo-patches.ts')
    process.exit(1)
  }

  const commit = pinnedCommit()
  const registered = new Set(TEO_PATCHES.map((p) => `${p.dir}/${p.rel}`))
  const failures: string[] = []
  const stale: string[] = []
  const inspected = new Set<string>()
  let identical = 0

  for (const spec of PACKAGES) {
    const prefix = `vendor/${spec.vendorDir}/`
    const listed = git(['ls-tree', '-r', '--name-only', commit, '--', `${prefix}src`], clonePath)
      .split('\n')
      .filter((line) => line.endsWith('.ts'))

    for (const upstreamPath of listed) {
      const rel = upstreamPath.slice(prefix.length)
      const destRel = `${spec.destDir}/${rel}`
      const destPath = join(root, destRel)
      inspected.add(destRel)

      if (!existsSync(destPath)) {
        failures.push(`${destRel}: missing, but upstream has it at ${commit}`)
        continue
      }

      const source = git(['show', `${commit}:${upstreamPath}`], clonePath)
      if (rescopeTypeScript(source, rel).text === readFileSync(destPath, 'utf8')) {
        identical += 1
        if (registered.has(destRel)) stale.push(destRel)
        continue
      }
      if (!registered.has(destRel)) {
        failures.push(`${destRel}: diverges from upstream with no TEO_PATCHES entry`)
      }
    }
  }

  for (const [dir, paths] of Object.entries(PROTECTED)) {
    for (const path of paths) {
      if (!existsSync(join(root, dir, path))) {
        failures.push(`${dir}/${path}: PROTECTED path is missing (a sync deleted it)`)
      }
    }
  }

  const uncovered = TEO_PATCHES.filter((p) => !inspected.has(`${p.dir}/${p.rel}`))
  console.log(`pinned commit: ${commit}`)
  console.log(`inspected ${inspected.size} upstream source files: ${identical} identical, ${inspected.size - identical} diverging`)
  console.log(`ledger: ${TEO_PATCHES.length} entries, ${uncovered.length} outside the upstream \`src/\` tree`)

  if (stale.length) {
    console.log('\nregistered patches that no longer diverge (upstream may have adopted them):')
    for (const path of stale) console.log(`  ${path}`)
  }

  if (failures.length) {
    console.error(`\n${failures.length} ledger failure(s):`)
    for (const line of failures) console.error(`  ${line}`)
    console.error('\nRecord the divergence in merge-teo.ts TEO_PATCHES and in docs/upstream.md.')
    process.exit(1)
  }
  console.log('\nthe patch ledger matches the tree')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
