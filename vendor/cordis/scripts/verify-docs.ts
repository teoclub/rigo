/**
 * Documentation gate (SPEC §9.4 AC-008).
 *
 * Lints every markdown file for phrasing that must not appear in this
 * distribution's docs:
 *   - claims of being an official cordiverse product (PRD §17: docs must
 *     not describe the TEO Club version as an official cordiverse release)
 *   - sandbox/security-boundary marketing for a plugin system that has
 *     none (SPEC §7: READMEs must state there is no sandbox, not advertise
 *     one)
 *
 * Usage: bun scripts/verify-docs.ts
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

/** Forbidden patterns; each hit needs rephrasing. */
const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /官方\s*cordiverse|cordiverse\s*官方|official\s+cordiverse|cordiverse\s+official/i, why: 'must not claim to be an official cordiverse release' },
  { pattern: /(沙箱|sandbox)\s*(保护|隔离|安全|protection|isolation|secure)/i, why: 'must not advertise sandbox protection - plugins are trusted code with no sandbox' },
  { pattern: /secure(ly)?\s+(loads|runs|executes)\s+plugins/i, why: 'plugin loading is not sandboxed; do not imply secure execution' },
]

/** The not-affiliated declaration is required, not forbidden. */
const REQUIRED_STATEMENT = /not affiliated with (the )?cordiverse/i

/** Requirement documents that legitimately discuss the forbidden phrasing. */
const EXEMPT_FILES = ['tasks/prd_cordis_v1.0.md', 'tasks/spec_cordis_v1.0.md']

async function* walk(dir: string): AsyncIterable<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      yield* walk(full)
    } else if (entry.name.endsWith('.md')) {
      yield full
    }
  }
}

async function main() {
  let violations = 0
  const files: string[] = []
  for await (const file of walk(root)) files.push(file)

  for (const file of files) {
    const rel = relative(root, file)
    if (EXEMPT_FILES.includes(rel)) continue
    const text = await readFile(file, 'utf8')
    for (const [i, line] of text.split('\n').entries()) {
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(line)) {
          console.error(`✗ ${rel}:${i + 1}: ${why}: ${line.trim().slice(0, 100)}`)
          violations++
        }
      }
    }
  }

  // the root README must carry the not-affiliated statement (PRD §17)
  const readme = await readFile(join(root, 'README.md'), 'utf8')
  if (!REQUIRED_STATEMENT.test(readme)) {
    console.error('✗ README.md: missing the not-affiliated-with-cordiverse declaration')
    violations++
  }

  console.log(`verify-docs: scanned ${files.length} markdown files, ${violations} violation(s)`)
  process.exit(violations ? 1 : 0)
}

main()
