/**
 * Zero-residue gate for old scopes (SPEC §5.1.2, AC-002).
 *
 * Runs against the **contents of packed tarballs** (not just src) for every
 * package. A hit on `@deepseek-ai/`, `@cordisjs/`, or `cosmokit` outside the
 * exemption list fails the gate.
 *
 * Usage: bun scripts/verify-old-scopes.ts [pack-dir]
 *   pack-dir defaults to tmp/pack - populate with `npm pack` output first
 *   (see tests/package). When pack-dir is absent the gate runs on the
 *   workspace sources instead (pre-pack fast lane).
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

const PATTERNS = [
  /@deepseek-ai\//,
  /@cordisjs\//,
  /(?<![a-zA-Z@/.-])cosmokit/,
]

/** Locations where old-scope names are intentional (SPEC §5.1.2 exemption list). */
const EXEMPT_FILES = [
  'docs/upstream.md',
  'docs/upstream.manifest.md',
  'docs/upstream-audit.json',
  'docs/migration.md',
  'CHANGELOG.md',
]

/**
 * Allowed old-scope occurrences inside shipped files: provenance metadata
 * (SPEC §3.1 teoclub.source.upstreamPackage) and factual references to
 * packages we do not distribute (e.g. @cordisjs/unyaml in an explanatory
 * comment).
 */
const EXEMPT_LINE_PATTERNS = [
  /"upstreamPackage":\s*"@deepseek-ai\//,
  /"path":\s*"vendor\/cosmokit"/,
  /@cordisjs\/unyaml/,
  /This package continues \[cosmokit\]/,
]

async function* walk(dir: string): AsyncIterable<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

async function main() {
  const packDir = process.argv[2] ? resolve(process.argv[2]) : null
  const scanRoot = packDir ?? join(root, 'packages')
  const scope = packDir ? relative(root, packDir) : 'packages/'

  let violations = 0
  let filesScanned = 0
  for await (const file of walk(scanRoot)) {
    const rel = relative(root, file)
    if (EXEMPT_FILES.some((f) => rel === f || rel.startsWith(f + '/'))) continue
    if (file.endsWith('.map')) continue
    if (!/\.(ts|js|mjs|cjs|json|md|d\.ts)$/.test(file) && !file.endsWith('.d.ts')) continue
    const text = await readFile(file, 'utf8')
    filesScanned++
    for (const [i, line] of text.split('\n').entries()) {
      if (EXEMPT_LINE_PATTERNS.some((p) => p.test(line))) continue
      for (const pattern of PATTERNS) {
        if (pattern.test(line)) {
          console.error(`✗ ${rel}:${i + 1}: ${line.trim().slice(0, 120)}`)
          violations++
          break
        }
      }
    }
  }
  const target = packDir ? `packed tarballs (${scope})` : 'workspace sources (packages/)'
  console.log(`scanned ${filesScanned} files in ${target}: ${violations} violation(s)`)
  process.exit(violations ? 1 : 0)
}

main()
