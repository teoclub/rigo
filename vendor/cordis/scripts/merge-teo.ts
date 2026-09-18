/**
 * TEO Club patch replay (SPEC §2.4 sync procedure, step 3).
 *
 * `rescope.ts` writes the new upstream trees over the vendored packages. That
 * write is faithful to upstream but it also overwrites every local divergence,
 * so this script restores them with a per-file three-way merge:
 *
 *   base   = transform(upstream @ old-commit)  - what the previous sync produced
 *   ours   = git show HEAD:<destPath>          - the pre-sync Rigo file
 *   theirs = transform(upstream @ new-commit)  - what rescope just wrote
 *
 * A file upstream did not touch between the two commits merges to `ours`
 * unchanged (its side of the diff is empty), so every entry is safe to list
 * whether or not upstream moved it.
 *
 * `TEO_PATCHES` is the authoritative ledger of local divergences. A file that
 * diverges from upstream but is absent from the table is a ledger bug;
 * `verify-teo-patches.ts` re-derives the set independently and fails on a
 * mismatch, so a new divergence cannot go unrecorded.
 *
 * Usage: bun scripts/merge-teo.ts <harness-clone-path> <old-commit> <new-commit> [--apply]
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PACKAGES, rescopeDocs, rescopeTextTokens, rescopeTypeScript } from './rescope.ts'

const root = resolve(import.meta.dir, '..')
const MAX_BUFFER = 64 * 1024 * 1024

/**
 * `git show <rev>:<path>` resolves `<path>` against the repository root, not
 * the process cwd, so the enclosing Rigo checkout needs its own base - the
 * vendored tree is a subdirectory of it.
 */
const repoRoot = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

interface TeoPatch {
  /** Destination package directory relative to the repo root. */
  dir: string
  /** Path inside the package; identical on both sides of the rescope copy. */
  rel: string
  /** Ledger id, as listed in docs/upstream.md. */
  patch: string
  /** One line on what diverges, for the conflict report. */
  note: string
}

/**
 * Every vendored file where Rigo diverges from upstream. Kept in sync with the
 * patch list in `docs/upstream.md`; `verify-teo-patches.ts` is the gate.
 */
export const TEO_PATCHES: TeoPatch[] = [
  { dir: 'packages/cordis', rel: 'src/events.ts', patch: 'G1/G2', note: 'parallel() reports its true mode; internal/listener carries EventOptions' },
  { dir: 'packages/cordis', rel: 'src/fiber.ts', patch: 'G6', note: 'lifecycle hardening: reentrant disposal gaps, root teardown, update() contract' },
  { dir: 'packages/cordis', rel: 'src/index.ts', patch: 'G5', note: 'ReflectService / Property / Impl re-exported from the root barrel' },
  { dir: 'packages/cordis', rel: 'src/registry.ts', patch: 'G4', note: 'thenable-wrapper receiver safety' },
  { dir: 'packages/cordis', rel: 'bin.js', patch: 'P10', note: 'restart contract: exit code 51 for an outer supervisor' },
  { dir: 'packages/kit', rel: 'src/time.ts', patch: 'TEO', note: 'parseTimeValue split out; parseDate added' },
  { dir: 'packages/kit', rel: 'src/types.ts', patch: 'TEO', note: 'cloneView(): type-preserving ArrayBufferView clone' },
  { dir: 'packages/plugins/loader', rel: 'src/index.ts', patch: 'P8', note: 'Node type references made structural' },
  { dir: 'packages/plugins/loader', rel: 'src/internal.ts', patch: 'P8/upstream', note: 'shape detection adopted from upstream; JSDoc only local delta' },
  { dir: 'packages/plugins/include', rel: 'src/index.ts', patch: 'P8/P13/P14', note: 'structural Node types; writeTask widening; durable debounced writes' },
  { dir: 'packages/plugins/timer', rel: 'src/index.ts', patch: 'P7', note: 'NodeJS.Timeout replaced with ReturnType<typeof setTimeout>' },
  { dir: 'packages/plugins/hmr', rel: 'src/index.ts', patch: 'P8/P10', note: 'Bun engine wiring; structural Node types' },
  { dir: 'packages/kit', rel: 'README.md', patch: 'P4', note: 'TEO Club identity, install command, and not-affiliated statement' },
]

function vendorDirFor(dir: string): string {
  const spec = PACKAGES.find((p) => p.destDir === dir)
  if (!spec) throw new Error(`no vendored package maps to ${dir}`)
  return spec.vendorDir
}

/**
 * Apply the same transform `rescope.ts` applies to a copied file. The channel
 * must match that script's dispatch: READMEs go through the docs rewrite (bare
 * package names included), not the quoted-token pass.
 */
function transform(rel: string, text: string): string {
  if (rel.endsWith('.ts')) return rescopeTypeScript(text, rel).text
  if (rel.endsWith('README.md')) return rescopeDocs(text).text
  return rescopeTextTokens(text).text
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', cwd ? ['-C', cwd, ...args] : args, { encoding: 'utf8', maxBuffer: MAX_BUFFER })
}

function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const [clonePath, oldCommit, newCommit] = argv.filter((a) => !a.startsWith('--'))
  if (!clonePath || !oldCommit || !newCommit) {
    console.error('usage: bun scripts/merge-teo.ts <harness-clone-path> <old-commit> <new-commit> [--apply]')
    process.exit(1)
  }

  const staging = mkdtempSync(join(tmpdir(), 'teo-merge-'))
  const conflicted: string[] = []
  let clean = 0

  try {
    for (const row of TEO_PATCHES) {
      const vendorDir = vendorDirFor(row.dir)
      const destRel = `${row.dir}/${row.rel}`
      const destPath = join(root, destRel)
      const stamp = destRel.replaceAll('/', '_')

      const oursPath = join(staging, `${stamp}.ours`)
      const basePath = join(staging, `${stamp}.base`)
      const theirsPath = join(staging, `${stamp}.theirs`)

      writeFileSync(oursPath, git(['show', `HEAD:${relative(repoRoot, destPath)}`], repoRoot))
      writeFileSync(basePath, transform(row.rel, git(['show', `${oldCommit}:vendor/${vendorDir}/${row.rel}`], clonePath)))
      writeFileSync(theirsPath, transform(row.rel, git(['show', `${newCommit}:vendor/${vendorDir}/${row.rel}`], clonePath)))

      const result = spawnSync('git', [
        'merge-file', '-p',
        '-L', 'rigo/ours', '-L', 'upstream/base', '-L', 'upstream/theirs',
        oursPath, basePath, theirsPath,
      ], { encoding: 'utf8', maxBuffer: MAX_BUFFER })

      const conflicts = result.status ?? -1
      if (conflicts < 0) throw new Error(`git merge-file failed for ${destRel}: ${result.stderr}`)
      if (apply) writeFileSync(destPath, result.stdout)

      if (conflicts > 0) {
        conflicted.push(`  ${destRel}  [${row.patch}] ${conflicts} conflict(s) - ${row.note}`)
      } else {
        clean += 1
        console.log(`${apply ? 'merged ' : 'clean  '} ${destRel}`)
      }
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  console.log(`\n${clean}/${TEO_PATCHES.length} merged cleanly${apply ? '' : ' (dry run - nothing written)'}`)
  if (!conflicted.length) return

  console.log(`\n${conflicted.length} file(s) need a hand merge:`)
  for (const line of conflicted) console.log(line)
  if (apply) {
    console.log('\nConflict markers were written into those files. Resolve them in place,')
    console.log('then re-run `bunx tsc -b` before touching the gates.')
  }
  process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
