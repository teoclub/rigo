/**
 * Issue 001 baseline gate (SPEC §2.3, §10 Phase 0).
 *
 * Validates the pinned DeepSeek Harness baseline:
 *   - the manifest facts (repository URL, official release tag, full commit
 *     SHA) are present and well-formed;
 *   - every migration row records upstream path, local target path,
 *     classification (KEEP/ADAPT/DROP/REPLACE) and a reason;
 *   - every local target exists with a package.json carrying the pinned
 *     commit in its `teoclub.source` provenance block;
 *   - the human-readable manifest (docs/upstream-baseline.md) exists and
 *     contains the no-automatic-master-following policy;
 *   - the pinned tag re-resolves to the pinned SHA, both against the remote
 *     (`git ls-remote`, network permitting) and against an optional local
 *     clone (RIGO_UPSTREAM_CLONE or the default sibling checkout);
 *   - `--refresh <dir>` re-fetches the pinned tag into a fresh directory and
 *     verifies it resolves to the same SHA (Issue 001 AC: a fresh workdir can
 *     re-obtain and verify the identical baseline).
 *
 * Exit code is non-zero when any manifest field is missing or inconsistent
 * (Issue 001 AC: missing tag, full SHA, or source path fails the gate).
 *
 * Usage: bun scripts/verify-baseline.ts [--refresh <fresh-dir>]
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { BASELINE, NOT_PORTED, PACKAGES } from './lib/baseline.ts'

const root = resolve(import.meta.dir, '..')
const refreshDir = process.argv.indexOf('--refresh') >= 0
  ? resolve(process.argv[process.argv.indexOf('--refresh') + 1] ?? '')
  : undefined
if (process.argv.includes('--refresh') && !refreshDir) {
  console.error('usage: bun scripts/verify-baseline.ts [--refresh <fresh-dir>]')
  process.exit(2)
}

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

const COMMIT_RE = /^[0-9a-f]{40}$/
const TAG_RE = /^[^\s~^:]+$/
const CLASSIFICATIONS = new Set(['KEEP', 'ADAPT', 'DROP', 'REPLACE'])

// ---------------------------------------------------------------------------
// 1. Manifest facts (Issue 001 AC 1/6).
// ---------------------------------------------------------------------------
console.log('Baseline manifest facts')
if (typeof BASELINE.repository !== 'string' || !/^https?:\/\//.test(BASELINE.repository)) {
  fail(`BASELINE.repository is missing or not a URL: ${String(BASELINE.repository)}`)
} else {
  ok(`repository: ${BASELINE.repository}`)
}
if (typeof BASELINE.tag !== 'string' || !TAG_RE.test(BASELINE.tag)) {
  fail(`BASELINE.tag is missing or malformed: ${String(BASELINE.tag)}`)
} else {
  ok(`release tag: ${BASELINE.tag}`)
}
if (typeof BASELINE.commit !== 'string' || !COMMIT_RE.test(BASELINE.commit)) {
  fail(`BASELINE.commit is missing or not a full 40-hex SHA: ${String(BASELINE.commit)}`)
} else {
  ok(`commit SHA: ${BASELINE.commit}`)
}
if (typeof BASELINE.upstreamVersion !== 'string' || BASELINE.upstreamVersion.length === 0) {
  fail('BASELINE.upstreamVersion is missing')
} else {
  ok(`upstream version: ${BASELINE.upstreamVersion}`)
}
if (typeof BASELINE.license !== 'string' || BASELINE.license.length === 0) fail('BASELINE.license is missing')
if (typeof BASELINE.licenseHolder !== 'string' || BASELINE.licenseHolder.length === 0) fail('BASELINE.licenseHolder is missing')

// ---------------------------------------------------------------------------
// 2. Migration rows (Issue 001 AC 2/6): every row must carry source path,
//    target path, classification and a reason.
// ---------------------------------------------------------------------------
console.log('Migration table')
if (!Array.isArray(PACKAGES) || PACKAGES.length === 0) {
  fail('PACKAGES is empty or missing')
}
const seenLocal = new Set<string>()
const seenUpstream = new Set<string>()
for (const row of PACKAGES) {
  const label = row.localPackage ?? row.upstreamPackage ?? '<unnamed row>'
  let rowOk = true
  for (const [field, value] of Object.entries({
    upstreamPath: row.upstreamPath,
    localPath: row.localPath,
    upstreamPackage: row.upstreamPackage,
    localPackage: row.localPackage,
    classification: row.classification,
    reason: row.reason,
  })) {
    if (typeof value !== 'string' || value.length === 0) {
      fail(`${label}: missing ${field}`)
      rowOk = false
    }
  }
  if (rowOk && !CLASSIFICATIONS.has(row.classification)) {
    fail(`${label}: classification ${row.classification} is not one of KEEP/ADAPT/DROP/REPLACE`)
    rowOk = false
  }
  if (rowOk) {
    if (seenLocal.has(row.localPackage)) fail(`${label}: duplicate local package ${row.localPackage}`)
    if (seenUpstream.has(row.upstreamPackage)) fail(`${label}: duplicate upstream package ${row.upstreamPackage}`)
    seenLocal.add(row.localPackage)
    seenUpstream.add(row.upstreamPackage)
    ok(`${row.classification} ${row.upstreamPackage} -> ${row.localPackage}`)
  }
}
for (const row of NOT_PORTED ?? []) {
  if (typeof row.upstreamPackage !== 'string' || row.upstreamPackage.length === 0
    || typeof row.upstreamPath !== 'string' || row.upstreamPath.length === 0
    || !CLASSIFICATIONS.has(row.classification)
    || typeof row.reason !== 'string' || row.reason.length === 0) {
    fail(`NOT_PORTED row is incomplete: ${JSON.stringify(row)}`)
  } else {
    ok(`not ported: ${row.classification} ${row.upstreamPackage}`)
  }
}

// ---------------------------------------------------------------------------
// 3. Local targets carry the pinned provenance (Issue 001 AC 5).
// ---------------------------------------------------------------------------
console.log('Local targets')
for (const row of PACKAGES) {
  const pkgPath = join(root, row.localPath)
  const manifestPath = join(pkgPath, 'package.json')
  if (!existsSync(manifestPath)) {
    fail(`${row.localPackage}: target ${row.localPath}/package.json does not exist`)
    continue
  }
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    fail(`${row.localPackage}: package.json is not valid JSON (${String(error)})`)
    continue
  }
  const source = manifest.teoclub?.source as Record<string, unknown> | undefined
  const commit = source?.commit
  if (commit !== BASELINE.commit) {
    fail(`${row.localPackage}: teoclub.source.commit is ${String(commit)}, expected ${BASELINE.commit}`)
  } else {
    ok(`${row.localPackage}: provenance commit matches the baseline`)
  }
}

// ---------------------------------------------------------------------------
// 4. No automatic upstream-master following (Issue 001 AC 4).
// ---------------------------------------------------------------------------
console.log('Upgrade policy')
const baselineDoc = join(root, 'docs/upstream-baseline.md')
if (!existsSync(baselineDoc)) {
  fail('docs/upstream-baseline.md is missing (the manifest document)')
} else {
  const doc = readFileSync(baselineDoc, 'utf8')
  if (!/master/i.test(doc) || !/must not follow upstream `master` automatically/i.test(doc)) {
    fail('docs/upstream-baseline.md must state that upstream `master` is never followed automatically')
  } else {
    ok('docs/upstream-baseline.md forbids automatic upstream-master following')
  }
  if (!doc.includes('dsh-v0.1.1-rc.2') || !doc.includes(BASELINE.commit)) {
    fail('docs/upstream-baseline.md does not record the pinned tag and full commit SHA')
  } else {
    ok('docs/upstream-baseline.md records the pinned tag and commit SHA')
  }
}

// ---------------------------------------------------------------------------
// 5. The pinned tag re-resolves to the pinned SHA (Issue 001 AC 5).
// ---------------------------------------------------------------------------
console.log('Tag re-resolution')
const localClone = process.env.RIGO_UPSTREAM_CLONE
  ? resolve(process.env.RIGO_UPSTREAM_CLONE)
  : '/Users/a08/work/NodeProjects/deepseek-harness'

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8' }).trim() }
  } catch {
    return { ok: false, out: '' }
  }
}

if (existsSync(join(localClone, '.git'))) {
  const head = git(['rev-parse', 'HEAD'], localClone)
  const tagResolve = git(['rev-parse', `${BASELINE.tag}^{commit}`], localClone)
  if (!head.ok || head.out !== BASELINE.commit) {
    fail(`local clone ${localClone} is at ${head.ok ? head.out.slice(0, 12) : 'unknown'}, expected ${BASELINE.commit.slice(0, 12)}`)
  } else if (!tagResolve.ok || tagResolve.out !== BASELINE.commit) {
    fail(`local clone tag ${BASELINE.tag} resolves to ${tagResolve.out.slice(0, 12)}, expected ${BASELINE.commit.slice(0, 12)}`)
  } else {
    ok(`local clone ${localClone} is checked out at the pinned commit and its tag matches`)
  }
} else {
  warn(`no local clone at ${localClone} (set RIGO_UPSTREAM_CLONE); remote re-resolution only`)
}

// Remote re-resolution: the tag as advertised by the repository must equal
// the pinned SHA. Offline runs degrade to a warning; the CI gate has network.
const remote = spawnSync('git', ['ls-remote', BASELINE.repository, `refs/tags/${BASELINE.tag}`], { encoding: 'utf8' })
if (remote.status === 0) {
  const advertised = (remote.stdout ?? '').trim().split(/\s+/)[0] ?? ''
  if (advertised === BASELINE.commit) {
    ok(`remote tag ${BASELINE.tag} advertises the pinned commit`)
  } else {
    fail(`remote tag ${BASELINE.tag} advertises ${advertised.slice(0, 12)}, expected ${BASELINE.commit.slice(0, 12)}`)
  }
} else {
  warn(`git ls-remote failed (offline?); the tag could not be re-resolved remotely: ${(remote.stderr ?? '').trim().slice(0, 200)}`)
}

// Fresh-workdir re-fetch (Issue 001 AC 5): clone the pinned tag into a fresh
// directory and verify the identical SHA.
if (refreshDir) {
  console.log(`Fresh re-fetch into ${refreshDir}`)
  if (existsSync(join(refreshDir, '.git'))) {
    fail(`--refresh target ${refreshDir} already contains a git directory`)
  } else {
    for (const step of [
      ['init', ['init', '-q', refreshDir]],
      ['remote', ['remote', 'add', 'origin', BASELINE.repository]],
      ['fetch', ['fetch', '--depth', '1', 'origin', `refs/tags/${BASELINE.tag}:refs/tags/${BASELINE.tag}`]],
    ] as const) {
      // init runs from the parent directory: its target does not exist yet.
      const cwd = step[0] === 'init' ? dirname(refreshDir) : refreshDir
      const result = git(step[1], cwd)
      if (!result.ok) {
        fail(`fresh re-fetch step "${step[0]}" failed (network required); the tag could not be re-verified in a fresh workdir`)
        break
      }
    }
    const fetched = git(['rev-parse', `${BASELINE.tag}^{commit}`], refreshDir)
    if (fetched.ok && fetched.out === BASELINE.commit) {
      ok(`fresh workdir re-fetched ${BASELINE.tag} and verified ${BASELINE.commit}`)
    } else if (fetched.ok) {
      fail(`fresh workdir fetched ${BASELINE.tag} as ${fetched.out.slice(0, 12)}, expected ${BASELINE.commit.slice(0, 12)}`)
    }
  }
}

console.log('')
if (failures > 0) {
  console.error(`verify-baseline: ${failures} failure(s)${warnings > 0 ? `, ${warnings} warning(s)` : ''}`)
  process.exit(1)
}
console.log(`verify-baseline: OK${warnings > 0 ? ` (${warnings} warning(s))` : ''}`)
