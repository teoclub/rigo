/**
 * Upstream re-sync tool (SPEC §2.4). P0 ran the audit once; this script is
 * the documented procedure for pulling a newer deepseek-harness vendor
 * snapshot into this monorepo.
 *
 * Flow (mirrors Phase 0 + Phase 1):
 *   1. clone / update a deepseek-harness checkout at the new commit
 *   2. run scripts/audit-source.ts <clone> <new-commit>
 *   3. human review: diff the vendored trees, update docs/upstream.md
 *      (manifest + patch list) - every TEO Club patch must be re-applied
 *      or explicitly dropped with a log entry
 *   4. run scripts/rescope.ts <clone> <new-commit> to re-copy + rescope
 *   5. rebuild, run all gates and both runtime test suites
 *
 * This script performs the mechanical steps 2-5 and refuses to run without
 * an explicit --apply (default is a dry run that prints the plan).
 *
 * Usage: bun scripts/sync-upstream.ts <harness-clone-path> <new-commit> [--apply]
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

function run(cmd: string, args: string[]) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: 'inherit' })
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

  const steps: Array<[string, string[]]> = [
    ['bun', ['scripts/audit-source.ts', clonePath, commit]],
    ['bun', ['scripts/rescope.ts', clonePath, commit]],
    ['bunx', ['tsc', '-b']],
    ['bunx', ['tsdown']],
    ['bun', ['scripts/verify-packages.ts']],
    ['bun', ['scripts/verify-old-scopes.ts']],
    ['bunx', ['vitest', 'run']],
    ['bun', ['test', 'tests/conformance', 'tests/integration', 'tests/package', 'tests/bun']],
  ]

  if (!apply) {
    console.log('dry run - would execute:')
    for (const [cmd, argv] of steps) console.log(`  ${cmd} ${argv.join(' ')}`)
    console.log('\nre-run with --apply to sync. Review docs/upstream.md manually afterwards:')
    console.log('  - re-apply or drop every TEO Club patch (patches 1-6 + Phase 3 patches 7-10)')
    console.log('  - update the manifest table and the pinned commit')
    process.exit(0)
  }

  for (const [cmd, argv] of steps) run(cmd, argv)
  console.log('\nsync complete - now update docs/upstream.md (patch list + manifest) and CHANGELOG.md')
}

main()
