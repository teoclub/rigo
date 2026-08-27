/**
 * Issue 002 packaging gate (SPEC §9.2; PRD FR-3): confirms the license and
 * source provenance enter the release artifacts of every ported package.
 *
 * For each package in the migration manifest:
 *   - package.json declares `license: "MIT"` and a complete `teoclub.source`
 *     provenance block (repository, upstream path, upstream package,
 *     upstream version, pinned commit, classification);
 *   - the LICENSE file ships at the package root (npm includes it in every
 *     published tarball regardless of `files`);
 *   - every `files` entry the manifest promises exists after a build
 *     (lib/index.js and companions) — a publish would not silently drop
 *     the compiled entry points;
 *   - no dependency escapes the workspace boundary into an unregistered
 *     package name.
 *
 * Exit code is non-zero on any gap.
 *
 * Usage: bun scripts/verify-packages.ts
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PACKAGES } from './lib/baseline.ts'

const root = resolve(import.meta.dir, '..')
let failures = 0

function fail(message: string): void {
  failures += 1
  console.error(`✗ ${message}`)
}

function ok(message: string): void {
  console.log(`✓ ${message}`)
}

/** Every workspace member name, from the root workspaces + vendor entries. */
const registered = new Set(PACKAGES.map((p) => p.localPackage))
{
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { workspaces?: string[] }
  const readName = (manifestPath: string): void => {
    if (!existsSync(manifestPath)) return
    try {
      const name = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }).name
      if (name) registered.add(name)
    } catch {
      // unreadable manifests are reported per-package below
    }
  }
  for (const pattern of rootManifest.workspaces ?? []) {
    const literal = pattern.split('*')[0]!.replace(/\/$/, '')
    if (!literal || !existsSync(join(root, literal))) continue
    // A literal entry names the package directory itself (vendor/cordis/*);
    // a glob entry names a directory of packages.
    readName(join(root, literal, 'package.json'))
    for (const entry of readdirSync(join(root, literal), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      readName(join(root, literal, entry.name, 'package.json'))
    }
  }
}

for (const row of PACKAGES) {
  const pkgPath = join(root, row.localPath)
  const manifestPath = join(pkgPath, 'package.json')
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`${row.localPackage}: package.json unreadable (${String(error)})`)
    continue
  }

  // License declaration and file.
  if (manifest.license !== 'MIT') fail(`${row.localPackage}: package.json license is ${String(manifest.license)}, expected "MIT"`)
  if (!existsSync(join(pkgPath, 'LICENSE'))) fail(`${row.localPackage}: LICENSE file missing from the release root`)

  // Provenance block.
  const source = manifest.teoclub?.source as Record<string, unknown> | undefined
  const expectedSource: Record<string, string> = {
    repository: 'deepseek-ai/deepseek-harness',
    path: row.upstreamPath,
    upstreamPackage: row.upstreamPackage,
    classification: row.classification,
  }
  for (const [field, value] of Object.entries(expectedSource)) {
    if (source?.[field] !== value) fail(`${row.localPackage}: teoclub.source.${field} is ${String(source?.[field])}, expected ${value}`)
  }
  if (source?.commit !== row.localPackage && typeof source?.commit !== 'string') {
    // commit checked in detail by verify-baseline; presence is what matters here
  }
  if (typeof source?.commit !== 'string' || source.commit.length !== 40) {
    fail(`${row.localPackage}: teoclub.source.commit is not a full SHA (${String(source?.commit)})`)
  }
  if (typeof source?.upstreamVersion !== 'string' || source.upstreamVersion.length === 0) {
    fail(`${row.localPackage}: teoclub.source.upstreamVersion is missing`)
  }

  // Every declared files entry exists after the build.
  const files = Array.isArray(manifest.files) ? manifest.files as string[] : []
  if (files.length === 0) fail(`${row.localPackage}: no files list (nothing shippable declared)`)
  for (const entry of files) {
    if (typeof entry !== 'string') continue
    // Glob entries end in wildcards; check the longest literal prefix exists.
    const literal = entry.split('*')[0]!
    const target = join(pkgPath, literal)
    if (literal && !existsSync(target)) {
      fail(`${row.localPackage}: declared files entry "${entry}" does not exist after the build (run bun run build?)`)
    }
  }

  // No dependency may reference an unregistered @teoclub package.
  for (const deps of [manifest.dependencies, manifest.peerDependencies]) {
    if (typeof deps !== 'object' || deps === null) continue
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (name.startsWith('@teoclub/') && !registered.has(name)) {
        fail(`${row.localPackage}: depends on unregistered workspace package ${name}`)
      }
    }
  }

  ok(`${row.localPackage}: license + provenance + artifacts verified`)
}

console.log('')
if (failures > 0) {
  console.error(`verify-packages: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-packages: OK')
