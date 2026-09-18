/**
 * Upstream re-sync tool (SPEC §2.4). P0 ran the audit once; this script is
 * the documented procedure for pulling a newer deepseek-harness vendor
 * snapshot into this monorepo.
 *
 * Flow (mirrors Phase 0 + Phase 1):
 *   1. clone / update a deepseek-harness checkout at the new commit
 *   2. run scripts/audit-source.ts <clone> <new-commit>
 *   3. run scripts/rescope.ts <clone> <new-commit> to write the new upstream
 *      trees (it never deletes - see the note in that script)
 *   4. run scripts/merge-teo.ts <clone> <old-commit> <new-commit> to replay
 *      every Rigo divergence over that write, three-way merging each one
 *   5. resolve whatever merge-teo reports as conflicting (by hand), and
 *      reconcile the ledger if it names an unregistered divergence
 *   6. rebuild, run all gates and both runtime test suites
 *
 * Steps 2-6 are mechanical; `merge-teo.ts`' TEO_PATCHES table is the
 * authoritative patch ledger and `verify-teo-patches.ts` gates it, so a sync
 * cannot silently drop a local patch.
 *
 * This script refuses to run without an explicit --apply (default is a dry run
 * that prints the plan).
 *
 * Usage: bun scripts/sync-upstream.ts <harness-clone-path> <new-commit> [--apply]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PACKAGES } from './rescope.ts'

const root = resolve(import.meta.dir, '..')

function run(cmd: string, args: string[]) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'inherit' })
}

/**
 * The commit currently recorded in the vendored manifests. Read before any
 * step runs: `rescope.ts` overwrites those manifests with the new commit, and
 * the merge needs the old one as its three-way base.
 */
function previousCommit(): string {
  for (const spec of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(root, spec.destDir, 'package.json'), 'utf8'))
    const commit = manifest.teoclub?.source?.commit
    if (typeof commit === 'string' && commit.length) return commit
  }
  throw new Error('no teoclub.source.commit found in any vendored package manifest')
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const positional = args.filter((a) => !a.startsWith('--'))
  const [clonePath, commit] = positional
  if (!clonePath || !commit) {
    console.error('usage: bun scripts/sync-upstream.ts <harness-clone-path> <new-commit> [--apply]')
    process.exit(1)
  }

  const previous = previousCommit()
  const steps: Array<[string, string[]]> = [
    ['bun', ['scripts/audit-source.ts', clonePath, commit]],
    ['bun', ['scripts/rescope.ts', clonePath, commit]],
    ['bun', ['scripts/merge-teo.ts', clonePath, previous, commit, '--apply']],
    ['bun', ['scripts/verify-teo-patches.ts', clonePath]],
    ['bunx', ['tsc', '-b']],
    ['bunx', ['tsdown']],
    ['bun', ['scripts/verify-packages.ts']],
    ['bun', ['scripts/verify-old-scopes.ts']],
    ['bunx', ['vitest', 'run']],
    ['bun', ['test', 'tests/conformance', 'tests/integration', 'tests/package', 'tests/bun']],
  ]

  if (!apply) {
    console.log(`dry run - would sync from ${previous} to ${commit}:`)
    for (const [cmd, argv] of steps) console.log(`  ${cmd} ${argv.join(' ')}`)
    console.log('\nre-run with --apply to sync. Afterwards, by hand:')
    console.log('  - resolve the conflicts merge-teo reports (expect packages/plugins/hmr/src/index.ts)')
    console.log('  - re-run the sync if the hand merge changed a file the gates already read')
    console.log('  - update docs/upstream.md (patch ledger + manifest) and CHANGELOG.md')
    process.exit(0)
  }

  for (const [cmd, argv] of steps) run(cmd, argv)
  console.log('\nsync complete - now update docs/upstream.md (patch ledger + manifest) and CHANGELOG.md')
}

main()
