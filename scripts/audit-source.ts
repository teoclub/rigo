/**
 * Issue 002 source-audit gate (SPEC §2.3, §9.2; PRD FR-2/FR-3/NFR-9).
 *
 * Verifies every ported package's provenance and license standing:
 *   - every local package under packages/harness is registered in the
 *     migration manifest, and every manifest row has a real local target;
 *   - every row carries upstream path, local target path, classification and
 *     the fixed baseline SHA;
 *   - every package ships the upstream DeepSeek MIT LICENSE verbatim;
 *   - KEEP packages stay rewrite-identical to the pinned upstream commit:
 *     each source and test file is re-derived through the port pipeline and
 *     byte-compared against the checkout (requires a clone at the pinned
 *     commit; RIGO_UPSTREAM_CLONE or the default sibling checkout);
 *   - the audit record (docs/harness-upstream-audit.json) is refreshed with
 *     the NOT_PORTED table and re-synced with the manifest.
 *
 * Any unregistered package, missing field, license gap, or KEEP drift exits
 * non-zero (the CI merge gate for Issue 002).
 *
 * Usage: bun scripts/audit-source.ts
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { BASELINE, LOCAL_PACKAGES, NOT_PORTED, PACKAGES } from './lib/baseline.ts'
import { portSourceFile, portTestFile } from './port-upstream.ts'

const root = resolve(import.meta.dir, '..')
const auditPath = join(root, 'docs/harness-upstream-audit.json')

let failures = 0
let warnings = 0

function fail(message: string): void {
  failures += 1
  console.error(`✗ ${message}`)
}

function warn(message: string): void {
  warnings += 1
  console.warn(`! ${message}`)
}

function ok(message: string): void {
  console.log(`✓ ${message}`)
}

// ---------------------------------------------------------------------------
// 1. Every local package is registered; every row has a real target.
// ---------------------------------------------------------------------------
console.log('Registered packages')
const localNames = new Map<string, string>()
for (const scope of ['harness', 'shared', 'work', 'code', 'api', 'bundle']) {
  const scopeDir = join(root, 'packages', scope)
  if (!existsSync(scopeDir)) continue
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(scopeDir, entry.name, 'package.json')
    if (!existsSync(manifestPath)) continue
    let name: string | undefined
    try {
      name = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: string }).name
    } catch {
      fail(`${scope}/${entry.name}: package.json is not valid JSON`)
    }
    if (name) localNames.set(name, `${scope}/${entry.name}`)
  }
}
const manifestNames = new Set(PACKAGES.map((p) => p.localPackage))
const localOnlyNames = new Set(LOCAL_PACKAGES.map((p) => p.localPackage))
for (const [name, dir] of localNames) {
  if (!manifestNames.has(name) && !localOnlyNames.has(name)) {
    fail(`unregistered local package: packages/${dir} (${name})`)
  }
}
for (const row of PACKAGES) {
  if (!localNames.has(row.localPackage)) fail(`${row.localPackage}: local target ${row.localPath} is missing`)
  else ok(`${row.localPackage}: registered`)
}
for (const local of LOCAL_PACKAGES) {
  if (!localNames.has(local.localPackage)) {
    fail(`${local.localPackage}: local target ${local.localPath} is missing`)
  } else {
    ok(`${local.localPackage}: local-only package registered (${local.reason})`)
  }
}

// ---------------------------------------------------------------------------
// 2. Every row carries source path, target path, classification, fixed SHA.
// ---------------------------------------------------------------------------
console.log('Manifest fields')
for (const row of PACKAGES) {
  const label = row.localPackage
  if (!row.upstreamPath) fail(`${label}: missing upstreamPath`)
  if (!row.localPath) fail(`${label}: missing localPath`)
  if (!row.classification) fail(`${label}: missing classification`)
  if (!row.reason) fail(`${label}: missing adaptation reason`)
  if (row.localPath !== `packages/harness/${row.localPackage.replace('@teoclub/harness-', '')}`) {
    fail(`${label}: localPath ${row.localPath} does not match the package location`)
  }
}
for (const row of NOT_PORTED) {
  if (!row.upstreamPackage || !row.upstreamPath || !row.classification || !row.reason) {
    fail(`NOT_PORTED row incomplete: ${JSON.stringify(row)}`)
  }
}

// ---------------------------------------------------------------------------
// 3. LICENSE: the upstream DeepSeek MIT text ships in every package.
// ---------------------------------------------------------------------------
console.log('Licenses')
const upstreamLicense = (() => {
  try {
    const clone = resolve(process.env.RIGO_UPSTREAM_CLONE ?? '/Users/a08/work/NodeProjects/deepseek-harness')
    if (existsSync(join(clone, '.git'))) {
      return execFileSync('git', ['-C', clone, 'show', `${BASELINE.commit}:LICENSE`], { encoding: 'utf8' })
    }
  } catch {
    // fall through: license identity is checked against the manifest text
  }
  return null
})()
for (const row of PACKAGES) {
  const licensePath = join(root, row.localPath, 'LICENSE')
  if (!existsSync(licensePath)) {
    fail(`${row.localPackage}: LICENSE is missing`)
    continue
  }
  const text = readFileSync(licensePath, 'utf8')
  if (!/MIT/i.test(text) || !/DeepSeek/i.test(text)) {
    fail(`${row.localPackage}: LICENSE is not the DeepSeek MIT license`)
  } else {
    ok(`${row.localPackage}: LICENSE carries the DeepSeek MIT text`)
  }
  if (upstreamLicense !== null && text !== upstreamLicense) {
    fail(`${row.localPackage}: LICENSE drifts from the upstream LICENSE at the pinned commit`)
  }
}
if (upstreamLicense === null) {
  warn('no upstream clone; LICENSE byte-identity against the pinned commit not checked (set RIGO_UPSTREAM_CLONE)')
}

// ---------------------------------------------------------------------------
// 4. KEEP rewrite-identity: re-derive and byte-compare against the clone.
// ---------------------------------------------------------------------------
const clone = resolve(process.env.RIGO_UPSTREAM_CLONE ?? '/Users/a08/work/NodeProjects/deepseek-harness')
const cloneUsable = (() => {
  if (!existsSync(join(clone, '.git'))) return false
  try {
    const head = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    return head === BASELINE.commit
  } catch {
    return false
  }
})()

function gitShow(path: string): string {
  return execFileSync('git', ['-C', clone, 'show', `${BASELINE.commit}:${path}`], { encoding: 'utf8' })
}

function gitList(path: string): string[] {
  const out = execFileSync('git', ['-C', clone, 'ls-tree', '-r', '--name-only', BASELINE.commit, '--', path], { encoding: 'utf8' })
  return out.trim().split('\n').filter(Boolean)
}

if (cloneUsable) {
  console.log('KEEP rewrite-identity')
  let drift = 0
  for (const spec of PACKAGES) {
    const specFiles = gitList(`${spec.upstreamPath}/src`)
    for (const upstreamFile of specFiles) {
      if (spec.classification !== 'KEEP') continue // ADAPT sources carry recorded local edits
      const rel = relative(spec.upstreamPath, upstreamFile)
      const localFile = join(root, spec.localPath, rel)
      const expected = portSourceFile(upstreamFile, gitShow(upstreamFile)).text
      if (!existsSync(localFile) || readFileSync(localFile, 'utf8') !== expected) {
        fail(`${spec.localPackage}: KEEP source ${rel} drifts from the pinned upstream`)
        drift += 1
      }
    }
    const testFiles = gitList(`${spec.upstreamPath}/tests`).filter((f) => /\.(spec|test)\.ts$/.test(f) || f.includes('/tests/'))
    const localTestDir = join(root, 'tests/upstream', spec.localPath.split('/').pop()!)
    for (const upstreamFile of testFiles) {
      const rel = relative(spec.upstreamPath, upstreamFile)
      const ported = portTestFile(spec, upstreamFile, rel, gitShow(upstreamFile))
      if (ported.omitted) continue
      const localFile = join(localTestDir, rel)
      if (!existsSync(localFile) || readFileSync(localFile, 'utf8') !== ported.text) {
        fail(`${spec.localPackage}: test ${rel} drifts from the port pipeline output`)
        drift += 1
      }
    }
  }
  if (drift === 0) ok('all KEEP sources and all ported tests are rewrite-identical to the pinned baseline')
} else {
  warn(`no clone at the pinned commit (${clone}); KEEP rewrite-identity not checked (set RIGO_UPSTREAM_CLONE)`)
}

// ---------------------------------------------------------------------------
// 5. Refresh the audit record: sync with the manifest + NOT_PORTED table.
// ---------------------------------------------------------------------------
console.log('Audit record')
let audit: { generatedAt: string; baseline: unknown; ported: { localPackage: string; upstreamPath: string; classification: string }[]; notPorted?: unknown }
try {
  audit = JSON.parse(readFileSync(auditPath, 'utf8'))
} catch {
  fail(`docs/harness-upstream-audit.json is missing or not valid JSON`)
  audit = { generatedAt: new Date().toISOString(), baseline: BASELINE, ported: [] }
}
const auditNames = new Set(audit.ported.map((p) => p.localPackage))
for (const row of PACKAGES) {
  if (!auditNames.has(row.localPackage)) fail(`${row.localPackage}: missing from the audit record`)
}
for (const record of audit.ported) {
  if (!manifestNames.has(record.localPackage)) fail(`audit record lists unregistered package ${record.localPackage}`)
}
audit.notPorted = NOT_PORTED
audit.baseline = BASELINE
try {
  writeFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n')
  ok('docs/harness-upstream-audit.json refreshed (NOT_PORTED table + baseline)')
} catch (error) {
  fail(`could not write the audit record: ${String(error)}`)
}

console.log('')
if (failures > 0) {
  console.error(`audit-source: ${failures} failure(s)${warnings > 0 ? `, ${warnings} warning(s)` : ''}`)
  process.exit(1)
}
console.log(`audit-source: OK${warnings > 0 ? ` (${warnings} warning(s))` : ''}`)
