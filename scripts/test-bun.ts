/**
 * The BUN half of the dual-runtime suite (SPEC §9.2), as one command both CI
 * and `scripts/verify-compat.ts` invoke.
 *
 * `bun test <dir>` cannot express an exclusion, and a few ported files are
 * genuinely unloadable under bun:test rather than merely failing — see
 * {@link BUN_UNSUPPORTED_TESTS} in `scripts/lib/baseline.ts`, which is the
 * single place those files and their reasons are recorded. This script walks
 * the two suite roots, drops the declared exclusions, and runs the rest.
 *
 * Usage: bun scripts/test-bun.ts
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { BUN_UNSUPPORTED_TESTS } from './lib/baseline.ts'

const root = resolve(import.meta.dirname, '..')
const SUITE_ROOTS = ['tests/upstream', 'tests/integration']

/** Every test file under one root, as repo-relative POSIX paths. */
function collect(dir: string): string[] {
  const found: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (/\.(spec|test)\.ts$/.test(entry.name)) found.push(next)
    }
  }
  walk(dir)
  return found
}

/** The generated workspace source-resolution map, used to resolve `@teoclub/*`. */
const paths = (JSON.parse(readFileSync(join(root, 'tsconfig.paths.json'), 'utf8')) as {
  compilerOptions: { paths: Record<string, string[]> }
}).compilerOptions.paths

/** A source path as the file it names, whether a file or a directory entry. */
function resolveSource(path: string): string | undefined {
  // A bare hit may be a DIRECTORY (the paths map targets `.../src`), and the
  // walk can only follow files, so the file candidates are tried first.
  return [`${path}/index.ts`, `${path}.ts`, path].find((candidate) => existsSync(join(root, candidate)))
}

/** Resolve one import specifier from a file to a source path, or undefined. */
function resolveSpecifier(specifier: string, from: string): string | undefined {
  if (specifier.startsWith('.')) {
    return resolveSource(join(dirname(from), specifier))
  }
  if (!specifier.startsWith('@teoclub/')) return undefined
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = targets[0]!.replace(/^\.\//, '')
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1)
      if (!specifier.startsWith(prefix)) continue
      return resolveSource(`${target.slice(0, -1)}${specifier.slice(prefix.length)}`)
    }
    if (pattern === specifier) return resolveSource(target)
  }
  return undefined
}

/** Every file reachable from an entry through relative and `@teoclub/*` imports. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()!
    if (seen.has(file) || !file.endsWith('.ts')) continue
    seen.add(file)
    const text = readFileSync(join(root, file), 'utf8')
    for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const resolved = resolveSpecifier(match[1]!, file)
      if (resolved !== undefined && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return seen
}

/**
 * Rigo's SQLite storage is built on Node's `node:sqlite`, which bun does not
 * implement, so any integration suite that reaches it fails to RESOLVE rather
 * than to assert. PRD D-003 makes SQLite Rigo's only shipped provider, so
 * these suites are Node-only by construction: there is nothing to fix on the
 * bun side. Reaching it is a property of the import graph, not of the suite's
 * own text — `@teoclub/api-sdk` pulls the provider in for every suite that
 * builds a runtime facade — so the graph is walked.
 */
function needsNodeSqlite(file: string): boolean {
  for (const reached of reachableFrom(file)) {
    // Either the builtin itself, or a specifier naming its package: the
    // storage package is imported by SUBPATH (`.../node`, `.../definition`),
    // which the workspace paths map has no pattern for, so the walk stops
    // there — the intermediate hop is enough to know where the suite lands.
    if (/node:sqlite|shared-storage-sqlite/.test(readFileSync(join(root, reached), 'utf8'))) return true
  }
  return false
}

const excluded = new Set(BUN_UNSUPPORTED_TESTS.map((entry) => entry.file))
const nodeOnly: string[] = []
const files = SUITE_ROOTS
  .filter((dir) => existsSync(join(root, dir)))
  .flatMap(collect)
  .filter((file) => {
    if (excluded.has(file)) return false
    if (!file.startsWith('tests/integration/')) return true
    if (!needsNodeSqlite(file)) return true
    nodeOnly.push(file)
    return false
  })
  .sort()

for (const file of excluded) {
  if (!existsSync(join(root, file))) {
    console.error(`✗ BUN_UNSUPPORTED_TESTS names ${file}, which does not exist`)
    process.exit(1)
  }
}

console.log(`bun test: ${files.length} files (${excluded.size} unloadable under bun:test, ${nodeOnly.length} integration suites need Node's node:sqlite)`)
try {
  execFileSync('bun', ['test', ...files], { cwd: root, stdio: 'inherit' })
} catch {
  // The child already reported its own failures; exit non-zero without a
  // second stack trace on top of the test output.
  process.exit(1)
}
