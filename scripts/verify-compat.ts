/**
 * Issue 036 compatibility gate (SPEC §9.2, §9.5; PRD US-017, FR-36).
 *
 * The CI merge-blocking gate for the migrated Core compatibility suites:
 *
 *   1. the Issue 035 source matrix is consistent (`generate-matrix --check`:
 *      every local compat test has an upstream mapping, statuses use the
 *      vocabulary, adapted/omitted rows carry reasons);
 *   2. every matrix row's LOCAL file actually exists on disk (a mapping that
 *      points at nothing is a merge-blocking inconsistency);
 *   3. the migrated upstream suites (`tests/upstream/**`) pass in BOTH
 *      runtimes — Node (vitest) and Bun — any failure blocks the merge.
 *
 * Coverage: the upstream suites exercise the SPEC §9.2 areas (Scope
 * isolation, Cordis unload + fiber refresh, Session event order/history/
 * invariants, System Prompt + Tool lifecycle, Agent lifecycle + turn/step
 * state machine + abort, LLM stream assembly + unknown tools + provider
 * failures) and the local integration suites cover the Rigo surfaces
 * (Context contributors, Action schema/idempotency/cancel/unload).
 *
 * Usage: bun scripts/verify-compat.ts
 */

import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
let failures = 0

function fail(message: string): void {
  failures += 1
  console.error(`✗ ${message}`)
}

function run(label: string, command: string, args: string[]): void {
  console.log(`$ ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) {
    fail(`${label} exited with status ${String(result.status)}`)
  } else {
    console.log(`✓ ${label}`)
  }
}

// 1. The matrix check (mapping + vocabulary + reasons).
run('compat matrix (--check)', process.execPath, ['scripts/generate-matrix.ts', '--check'])

// 2. Every mapped local file exists.
const matrix = readFileSync(join(root, 'docs/compatibility-matrix.md'), 'utf8')
const localFiles = [...matrix.matchAll(/`(tests\/upstream\/[^`]+\.ts)`/g)].map((match) => match[1]!)
for (const file of new Set(localFiles)) {
  if (!existsSync(join(root, file))) {
    fail(`matrix maps ${file} but the local file is missing`)
  }
}
if (localFiles.length > 0) console.log(`✓ ${new Set(localFiles).size} mapped local compat files exist`)

// 3. The migrated upstream suites pass in Node (vitest) and Bun.
run('upstream suites (Node/vitest)', 'bunx', ['vitest', 'run', 'tests/upstream'])
run('upstream suites (Bun)', 'bun', ['test', 'tests/upstream'])

if (failures > 0) {
  console.error(`verify-compat: ${failures} failure(s) — the merge is blocked`)
  process.exit(1)
}
console.log('verify-compat: OK — compatibility gates green')
