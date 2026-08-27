/**
 * Issue 003 boundary gate (SPEC §2.2, §2.5; PRD FR-4/FR-5).
 *
 * Enforces the mechanically verifiable package boundaries:
 *   - `packages/harness/*` may not import React, HTTP, SQLite,
 *     `@teoclub/work-*`, `@teoclub/code-*`, or `@teoclub/shared-*`
 *     (the core stays domain- and host-agnostic);
 *   - domain packages (`packages/work/*`, `packages/code/*`) may only depend
 *     on Rigo Core (`@teoclub/harness-*`) and Shared Service Definitions
 *     (`@teoclub/shared-*`) — never on another domain's providers
 *     (work <-> code isolation);
 *   - every declared workspace entry from Issue 003 exists.
 *
 * Checks both source imports and declared package.json dependencies.
 * Exit code is non-zero on any violation.
 *
 * Usage: bun scripts/verify-boundaries.ts
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
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

/** Import specifiers collected from a TypeScript source file. */
function collectSpecifiers(text: string): string[] {
  const out = new Set<string>()
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    out.add(match[1]!)
  }
  for (const match of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(match[1]!)
  for (const match of text.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) out.add(match[1]!)
  for (const match of text.matchAll(/\/\/\/\s*<reference\s+path=['"]([^'"]+)['"]/g)) out.add(match[1]!)
  return [...out]
}

const FORBIDDEN_HARNESS = [
  /^react(\/|$)/,
  /^react-dom(\/|$)/,
  /^(node:)?https?(\/|$)/,
  /^node:sqlite$/,
  /^better-sqlite3(\/|$)/,
  /^sql\.js$/,
  /^@libsql\/client(\/|$)/,
  /^@teoclub\/work-/,
  /^@teoclub\/code-/,
  /^@teoclub\/shared-/,
]

const FORBIDDEN_DOMAIN = [
  /^react(\/|$)/,
  /^react-dom(\/|$)/,
  /^(node:)?https?(\/|$)/,
  /^node:sqlite$/,
  /^better-sqlite3(\/|$)/,
  /^sql\.js$/,
  /^@libsql\/client(\/|$)/,
]

// Domain packages may depend on Rigo Core and Shared Service Definitions
// (SPEC §2.5). Rigo Core includes the Layer-0 Cordis runtime family, so the
// @teoclub/cordis* packages count as core here. A domain may additionally
// import the OTHER packages of its own domain — a Provider may depend on its
// domain's Service Definition (work-documents-local -> work-documents) —
// but never on another domain's providers (work <-> code isolation).
const allowedDomain = (name: string, domain: string): boolean =>
  /^@teoclub\/(harness|shared)-/.test(name)
  || /^@teoclub\/cordis(-|$)/.test(name)
  || name === '@teoclub/kit'
  || name === '@teoclub/schemastery'
  || name.startsWith(`@teoclub/${domain}-`)
  || !name.startsWith('@teoclub/')

/** Walk *.ts files under a directory, skipping node_modules and lib. */
function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'lib') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkTs(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function checkImports(
  label: string,
  files: string[],
  forbidden: RegExp[],
  domain: string | undefined,
): void {
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const spec of collectSpecifiers(text)) {
      // Relative and absolute-local specifiers are fine; only bare names are
      // boundary-relevant (except ../src which never escapes its package).
      if (spec.startsWith('.') || spec.startsWith('/')) continue
      if (spec.startsWith('@teoclub/') && domain !== undefined) {
        if (!allowedDomain(spec, domain)) {
          fail(`${label}: ${relative(root, file)} imports ${spec} (domain packages may only use @teoclub/harness-*, @teoclub/shared-*, and same-domain packages)`)
        }
        continue
      }
      for (const pattern of forbidden) {
        if (pattern.test(spec)) {
          fail(`${label}: ${relative(root, file)} imports ${spec} (forbidden by the ${label} boundary)`)
        }
      }
    }
  }
}

function checkManifestDeps(label: string, dir: string, forbidden: RegExp[], domain: string | undefined): void {
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) return
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    fail(`${label}: package.json unreadable`)
    return
  }
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
    const deps = manifest[section]
    if (typeof deps !== 'object' || deps === null) continue
    for (const name of Object.keys(deps as Record<string, unknown>)) {
      if (domain !== undefined && name.startsWith('@teoclub/') && !allowedDomain(name, domain)) {
        fail(`${label}: package.json ${section} names ${name} (domain packages may only use @teoclub/harness-*, @teoclub/shared-*, and same-domain packages)`)
      }
      for (const pattern of forbidden) {
        if (pattern.test(name)) fail(`${label}: package.json ${section} names ${name}`)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Harness core isolation (SPEC §2.2; Issue 003 AC 4).
// ---------------------------------------------------------------------------
console.log('Harness core boundary')
const harnessOk: string[] = []
for (const row of PACKAGES) {
  const files = walkTs(join(root, row.localPath, 'src'))
  checkImports(`harness`, files, FORBIDDEN_HARNESS, undefined)
  checkManifestDeps(`harness`, join(root, row.localPath), FORBIDDEN_HARNESS, undefined)
  harnessOk.push(row.localPackage)
}
ok(`harness core: ${harnessOk.length} packages checked (no React/HTTP/SQLite/work/code/shared imports)`)

// ---------------------------------------------------------------------------
// Domain packages (SPEC §2.5; Issue 003 AC 5): work and code stay isolated.
// ---------------------------------------------------------------------------
console.log('Domain package boundary')
let domainChecked = 0
for (const domain of ['work', 'code']) {
  const domainDir = join(root, `packages/${domain}`)
  if (!existsSync(domainDir)) {
    ok(`packages/${domain}: no packages yet (boundary enforced when they land)`)
    continue
  }
  for (const entry of readdirSync(domainDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    const pkgDir = join(domainDir, entry.name)
    const files = walkTs(join(pkgDir, 'src'))
    checkImports(`packages/${domain}`, files, FORBIDDEN_DOMAIN, domain)
    checkManifestDeps(`packages/${domain}`, pkgDir, FORBIDDEN_DOMAIN, domain)
    domainChecked += 1
  }
}
if (domainChecked === 0) {
  // The checks above ran per package; report the aggregate only when present.
}

// ---------------------------------------------------------------------------
// Workspace entries (Issue 003 AC 1).
// ---------------------------------------------------------------------------
console.log('Workspace entries')
for (const entry of ['packages/harness', 'packages/shared', 'packages/work', 'packages/code', 'packages/api', 'packages/bundle', 'apps', 'examples', 'tests']) {
  if (!existsSync(join(root, entry))) fail(`workspace entry ${entry} is missing`)
  else ok(entry)
}

console.log('')
if (failures > 0) {
  console.error(`verify-boundaries: ${failures} failure(s)`)
  process.exit(1)
}
console.log('verify-boundaries: OK')
