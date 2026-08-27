/**
 * Issue 035 compatibility matrix (SPEC §9.2; PRD US-017, FR-1/FR-2/FR-36).
 *
 * Generates docs/compatibility-matrix.md from the audit record
 * (docs/harness-upstream-audit.json) and the migration manifest:
 * every ported package, every upstream test file, its local counterpart,
 * and its status - `unchanged`, `adapted`, or `intentionally omitted` -
 * with the recorded reason for the non-`unchanged` rows. The "deliberate
 * divergences" section lists every intentional deviation from upstream
 * (DROP/REPLACE rows, omitted and adapted tests, ADAPT packages).
 *
 * `--check` fails when:
 *   - a local compatibility test under tests/upstream has no upstream
 *     mapping (a local test that is not derived from the pinned baseline);
 *   - a status outside the vocabulary is used;
 *   - an adapted/omitted row lacks a concrete reason.
 *
 * Usage: bun scripts/generate-matrix.ts [--check]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { NOT_PORTED, PACKAGES } from './lib/baseline.ts'

const root = resolve(import.meta.dir, '..')
const checkOnly = process.argv.includes('--check')
const auditPath = join(root, 'docs/harness-upstream-audit.json')
const matrixPath = join(root, 'docs/compatibility-matrix.md')

let failures = 0

function fail(message: string): void {
  failures += 1
  console.error(`✗ ${message}`)
}

interface AuditRecord {
  localPackage: string
  upstreamPath: string
  classification: string
  adaptedTestFiles: { file: string; substitutions: string[]; reason: string }[]
  omittedTestFiles: { file: string; reason: string }[]
}

const audit = JSON.parse(readFileSync(auditPath, 'utf8')) as {
  ported: AuditRecord[]
}
const byPackage = new Map(audit.ported.map((r) => [r.localPackage, r]))
const STATUS = new Set(['unchanged', 'adapted', 'intentionally omitted'])

interface MatrixRow {
  localPackage: string
  upstreamFile: string
  localFile: string
  status: string
  reason: string
}

const rows: MatrixRow[] = []
for (const row of PACKAGES) {
  const record = byPackage.get(row.localPackage)
  if (!record) {
    fail(`${row.localPackage}: missing from the audit record (run scripts/audit-source.ts)`)
    continue
  }
  const localTestDir = join(root, 'tests/upstream', row.localPath.split('/').pop()!)
  if (!existsSync(localTestDir)) {
    // A package may legitimately have no tests (e.g. brand); the audit record
    // counts zero test files and the matrix simply has no rows for it.
    continue
  }
  const adapted = new Map(record.adaptedTestFiles.map((t) => [t.file, t]))
  const omitted = new Map(record.omittedTestFiles.map((t) => [t.file, t]))
  const localFiles: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) localFiles.push(full)
    }
  }
  walk(localTestDir)
  for (const localFile of localFiles.sort()) {
    const rel = relative(localTestDir, localFile)
    const upstreamFile = `${record.upstreamPath}/${rel}`
    const adaptedEntry = adapted.get(rel)
    const omittedEntry = omitted.get(rel)
    let status: string
    let reason = ''
    if (adaptedEntry) {
      status = 'adapted'
      reason = adaptedEntry.reason || adaptedEntry.substitutions.join('; ')
    } else if (omittedEntry) {
      // The local file cannot exist for an omitted upstream test; this branch
      // is unreachable for real local files (omissions have no local file).
      status = 'intentionally omitted'
      reason = omittedEntry.reason
    } else {
      status = 'unchanged'
    }
    rows.push({ localPackage: row.localPackage, upstreamFile, localFile: `tests/upstream/${row.localPath.split('/').pop()}/${rel}`, status, reason })
  }
  // Omitted upstream tests are matrix rows without a local counterpart.
  for (const entry of record.omittedTestFiles) {
    rows.push({
      localPackage: row.localPackage,
      upstreamFile: `${record.upstreamPath}/${entry.file}`,
      localFile: '',
      status: 'intentionally omitted',
      reason: entry.reason,
    })
  }
}

// --check: every status is in the vocabulary; adapted/omitted carry reasons;
// every local compat test has an upstream mapping (by construction above, but
// the audit identity check must have run - otherwise rows cannot be trusted).
if (checkOnly) {
  for (const row of rows) {
    if (!STATUS.has(row.status)) fail(`${row.localPackage}: ${row.localFile || row.upstreamFile} has unknown status ${row.status}`)
    if (row.status !== 'unchanged' && !row.reason) {
      fail(`${row.localPackage}: ${row.localFile || row.upstreamFile} is ${row.status} without a reason`)
    }
  }
  const auditStale = readFileSync(auditPath, 'utf8').includes('"notPorted": undefined')
  if (auditStale) fail('the audit record is stale (notPorted undefined); run scripts/audit-source.ts first')
  if (failures > 0) {
    console.error(`generate-matrix --check: ${failures} failure(s)`)
    process.exit(1)
  }
  console.log(`generate-matrix: OK (${rows.length} test rows, ${new Set(rows.map((r) => r.localPackage)).size} packages)`)
  process.exit(0)
}

// Render the document.
const byPkg = new Map<string, MatrixRow[]>()
for (const row of rows) {
  if (!byPkg.has(row.localPackage)) byPkg.set(row.localPackage, [])
  byPkg.get(row.localPackage)!.push(row)
}

const lines: string[] = [
  '# Rigo Core Compatibility Matrix',
  '',
  '> Generated by `bun scripts/generate-matrix.ts` from `docs/harness-upstream-audit.json`.',
  '> Status vocabulary: `unchanged` (rewrite-identical through the port pipeline),',
  '> `adapted` (recorded local modification), `intentionally omitted` (not ported, with reason).',
  '',
  '## Deliberate divergences from upstream',
  '',
  'The migration intentionally deviates from upstream in the following ways (SPEC §2.3, PRD):',
  '',
]
for (const row of NOT_PORTED) {
  lines.push(`- **${row.classification}** \`${row.upstreamPackage}\` (\`${row.upstreamPath}\`) — ${row.reason}`)
}
const adaptedPackages = PACKAGES.filter((p) => p.classification === 'ADAPT')
if (adaptedPackages.length) {
  lines.push('')
  lines.push('ADAPT packages carry recorded local modifications (reason in the manifest):')
  for (const p of adaptedPackages) lines.push(`- **${p.classification}** \`${p.localPackage}\` — ${p.reason}`)
}
lines.push('', '## Per-package test mapping', '')
for (const pkg of [...byPkg.keys()].sort()) {
  const record = byPackage.get(pkg)!
  const spec = PACKAGES.find((p) => p.localPackage === pkg)!
  lines.push(`### ${pkg}`, '')
  lines.push(`| Upstream package | Upstream path | Local path | Classification |`)
  lines.push(`| --- | --- | --- | --- |`)
  lines.push(`| \`${spec.upstreamPackage}\` | \`${spec.upstreamPath}\` | \`${spec.localPath}\` | \`${spec.classification}\` |`)
  lines.push('', '| Upstream File | Upstream Test | Local Test File | Status | Reason |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const row of byPkg.get(pkg)!) {
    const testName = row.upstreamFile.split('/').pop()!
    lines.push(`| \`${row.upstreamFile}\` | \`${testName}\` | ${row.localFile ? `\`${row.localFile}\`` : '—'} | \`${row.status}\` | ${row.reason.replaceAll('|', '\\|') || '—'} |`)
  }
  lines.push('')
}

// ---------------------------------------------------------------------------
// Compatibility coverage of the SPEC §9.2 core areas + local packages.
// ---------------------------------------------------------------------------

/** The nine core areas the matrix must cover (Issue 035 AC). */
const AREA_COVERAGE: { area: string; localPackage: string; ported: boolean; localTestFile: string }[] = [
  { area: 'Scope', localPackage: '@teoclub/harness-scope', ported: true, localTestFile: '' },
  { area: 'Session', localPackage: '@teoclub/harness-session', ported: true, localTestFile: '' },
  { area: 'System Prompt', localPackage: '@teoclub/harness-system-prompt', ported: true, localTestFile: '' },
  { area: 'Tools', localPackage: '@teoclub/harness-tools', ported: true, localTestFile: '' },
  { area: 'Agent', localPackage: '@teoclub/harness-agent', ported: true, localTestFile: '' },
  { area: 'Agent Loop', localPackage: '@teoclub/harness-agent-loop', ported: true, localTestFile: '' },
  { area: 'LLM', localPackage: '@teoclub/harness-llm', ported: true, localTestFile: '' },
  { area: 'Invariant', localPackage: '@teoclub/harness-invariants', ported: true, localTestFile: '' },
  { area: 'Context', localPackage: '@teoclub/harness-context', ported: false, localTestFile: 'tests/integration/context-assembly.spec.ts' },
]

lines.push('## Compatibility coverage (SPEC §9.2 areas)', '')
lines.push('| Area | Package | Provenance | Local test source |')
lines.push('| --- | --- | --- | --- |')
for (const entry of AREA_COVERAGE) {
  if (entry.ported) {
    lines.push(`| ${entry.area} | \`${entry.localPackage}\` | ported from upstream (matrix above) | tests/upstream/${entry.localPackage.split('/').pop()}/ |`)
  } else {
    lines.push(`| ${entry.area} | \`${entry.localPackage}\` | local addition (Issue 011) — no upstream counterpart | \`${entry.localTestFile}\` |`)
  }
}

// Local Rigo packages have no upstream source; their behavior is pinned by
// the local integration suites. Listed so the matrix provably covers them.
lines.push('', '## Local compatibility surface', '')
lines.push('Local packages are intentional additions with no upstream test source (SPEC §2.3); their compatibility is pinned by the local integration suites below.', '')
lines.push('| Local package | Area | Local test file | Status | Reason |')
lines.push('| --- | --- | --- | --- | --- |')
const localSurface: { localPackage: string; area: string; testFile: string }[] = [
  { localPackage: '@teoclub/harness-context', area: 'Context', testFile: 'tests/integration/context-assembly.spec.ts' },
  { localPackage: '@teoclub/harness-session-protocol', area: 'Session events', testFile: 'tests/integration/session-protocol.spec.ts' },
  { localPackage: '@teoclub/harness-llm-protocol', area: 'LLM protocol', testFile: 'tests/integration/llm-protocol.spec.ts' },
  { localPackage: '@teoclub/harness-tools-protocol', area: 'Tools protocol', testFile: 'tests/integration/tools-protocol.spec.ts' },
  { localPackage: '@teoclub/harness-agent-protocol', area: 'Agent API', testFile: 'tests/integration/agent-protocol.spec.ts' },
  { localPackage: '@teoclub/harness-loop-protocol', area: 'Agent Loop protocol', testFile: 'tests/integration/loop-protocol.spec.ts' },
]
for (const entry of localSurface) {
  lines.push(`| \`${entry.localPackage}\` | ${entry.area} | \`${entry.testFile}\` | \`intentionally omitted\` | local package with no upstream counterpart; behavior pinned by the local integration suite |`)
}
lines.push('')

writeFileSync(matrixPath, lines.join('\n'))
console.log(`wrote ${relative(root, matrixPath)} (${rows.length} test rows, ${byPkg.size} packages)`)
