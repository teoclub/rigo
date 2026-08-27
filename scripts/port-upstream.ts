/**
 * Phase 0/1 port (SPEC §2.3, §10 Phase 0-1; Issues 001/003).
 *
 * Extracts every KEEP/ADAPT package from a local deepseek-harness clone at
 * the pinned commit (BASELINE), rewrites `@deepseek-ai/*` specifiers to the
 * `@teoclub/*` names, and emits:
 *
 *   - packages/harness/<name>/src/**       (rewritten source)
 *   - packages/harness/<name>/package.json (regenerated manifest)
 *   - packages/harness/<name>/tsconfig.json
 *   - packages/harness/<name>/tsdown.config.ts
 *   - packages/harness/<name>/LICENSE      (upstream DeepSeek MIT)
 *   - tests/upstream/<name>/**             (rewritten upstream tests)
 *   - tsconfig.paths.json                  (generated source-resolution map)
 *   - docs/harness-upstream-audit.json     (machine-readable port record)
 *
 * Re-running the script is safe for KEEP packages (they must stay
 * rewrite-identical; audit-source.ts verifies this). ADAPT packages carry
 * local modifications listed in the audit record and are only ported with
 * --force-adapt.
 *
 * Usage: bun scripts/port-upstream.ts <harness-clone-path> [--force-adapt]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { BASELINE, LOCAL_PACKAGES, PACKAGES, rewriteProse, rewriteTextTokens, rewriteTypeScript, type PackageSpec } from './lib/baseline.ts'

const clone = resolve(process.argv[2] ?? '')
const forceAdapt = process.argv.includes('--force-adapt')
if (!clone) {
  console.error('usage: bun scripts/port-upstream.ts <harness-clone-path> [--force-adapt]')
  process.exit(1)
}

const root = resolve(import.meta.dir, '..')

function gitShow(path: string): string {
  return execFileSync('git', ['-C', clone, 'show', `${BASELINE.commit}:${path}`], { encoding: 'utf8' })
}

function gitList(path: string): string[] {
  const out = execFileSync('git', ['-C', clone, 'ls-tree', '-r', '--name-only', BASELINE.commit, '--', path], { encoding: 'utf8' })
  return out.trim().split('\n').filter(Boolean)
}

/** Rewrite one file's bytes through the appropriate channel. */
function rewriteFile(path: string, text: string): { text: string; edits: number } {
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts') || path.endsWith('.tsx')) {
    return rewriteTypeScript(text, path)
  }
  return rewriteTextTokens(text)
}

/**
 * Local inter-package deps of a package, computed from its rewritten SOURCE imports (tests excluded: project references must stay acyclic).
 * Returns harness deps plus the vendored cordis-family packages imported (those become project references into the sibling checkout).
 */

/** Derive the source face for one exported path (lib -> src). */
function srcFaceFor(exportPath: string): string {
  const withoutLib = exportPath.replace(/^\.\/lib\//, './src/')
  return withoutLib
    .replace(/\.d\.ts$/, '.ts')
    .replace(/\.js$/, '.ts')
    .replace(/^(\.\/src\/types\/)(.*)/, './src/$2')
    .replace(/\.ts\.ts$/, '.ts')
}

/**
 * Add the "development" condition (source) to every exports entry and ensure
 * `./src/*` is exported, so workspace-internal resolution reaches SOURCE in
 * dev runtimes while production consumers keep the built lib.
 */
function addDevelopmentConditions(exports: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === 'string') {
      out[key] = value
      continue
    }
    const entry = value as Record<string, string>
    const defaultPath = entry['default'] ?? ''
    const typesPath = entry['types']
    const srcPath = defaultPath.startsWith('./lib/') ? srcFaceFor(defaultPath) : undefined
    out[key] = {
      ...(srcPath === undefined || srcPath === defaultPath ? {} : { development: srcPath }),
      ...(typesPath === undefined ? {} : { types: typesPath }),
      default: defaultPath,
    }
  }
  if (out['./src/*'] === undefined) out['./src/*'] = './src/*'
  return out
}

function computeDeps(spec: PackageSpec, files: string[], localTexts: string[] = []): { harness: Set<string>; cordis: Set<string> } {
  const harness = new Set<string>()
  const cordis = new Set<string>()
  const texts = [
    ...files.filter((f) => f.startsWith(`${spec.upstreamPath}/src/`)).map((f) => gitShow(f)),
    ...localTexts,
  ]
  for (const text of texts) {
    for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      // Local-only ADAPT modules import the LOCAL package names directly.
      const mapped = [...PACKAGES].find(
        (p) => m[1] === p.upstreamPackage || m[1].startsWith(p.upstreamPackage + '/')
          || m[1] === p.localPackage || m[1].startsWith(p.localPackage + '/'),
      )
      if (mapped && mapped.localPackage !== spec.localPackage) harness.add(mapped.localPackage)
      const cordisPkg = CORDIS_PACKAGES.find((c) => m[1] === c.upstreamName || m[1] === c.name)
      if (cordisPkg) cordis.add(cordisPkg.name)
    }
  }
  return { harness, cordis }
}

/**
 * Vendored cordis-family packages, resolved through the vendor/ symlink
 * (workspace members of this repo).
 */
const CORDIS_PACKAGES = [
  { upstreamName: '@deepseek-ai/cosmokit', name: '@teoclub/kit', path: 'vendor/cordis/packages/kit' },
  { upstreamName: '@deepseek-ai/schemastery', name: '@teoclub/schemastery', path: 'vendor/cordis/packages/schemastery' },
  { upstreamName: '@deepseek-ai/cordis', name: '@teoclub/cordis', path: 'vendor/cordis/packages/cordis' },
  { upstreamName: '@deepseek-ai/cordis-plugin-loader', name: '@teoclub/cordis-plugin-loader', path: 'vendor/cordis/packages/plugins/loader' },
  { upstreamName: '@deepseek-ai/cordis-plugin-include', name: '@teoclub/cordis-plugin-include', path: 'vendor/cordis/packages/plugins/include' },
  { upstreamName: '@deepseek-ai/cordis-plugin-group', name: '@teoclub/cordis-plugin-group', path: 'vendor/cordis/packages/plugins/group' },
  { upstreamName: '@deepseek-ai/cordis-plugin-timer', name: '@teoclub/cordis-plugin-timer', path: 'vendor/cordis/packages/plugins/timer' },
  { upstreamName: '@deepseek-ai/cordis-plugin-hmr', name: '@teoclub/cordis-plugin-hmr', path: 'vendor/cordis/packages/plugins/hmr' },
  { upstreamName: '@deepseek-ai/cordis-plugin-logger-console', name: '@teoclub/cordis-plugin-logger-console', path: 'vendor/cordis/packages/plugins/logger-console' },
] as const

/**
 * Upstream test files intentionally not ported: each audits a repo-wide
 * surface (catalog generators, export-style lints) that spans packages
 * outside this repo's 22-package closure, so the test would fail here for
 * structural reasons rather than behavioral ones.
 */
const NOT_PORTED_TESTS: { file: string; reason: string }[] = [
  { file: 'packages/core/tools/tests/gen-tool-catalog.spec.ts', reason: 'harvests the tool schemas of every upstream tool package; most are outside the migration closure' },
  { file: 'packages/core/agent/tests/verify-export-jsdoc.spec.ts', reason: 'audits upstream repo-wide export JSDoc conventions' },
  { file: 'packages/core/session/tests/gen-persistence-catalog.spec.ts', reason: 'snapshots the upstream persistence-package catalog; most entries are outside the migration closure' },
]

/**
 * Per-file test adaptations, applied after the standard specifier rewrite.
 * Each records the upstream file, the textual substitutions, and why - the
 * audit JSON carries them so the Issue 035 compatibility matrix can mark the
 * file `adapted` with its behavioral divergence.
 */
const ADAPTED_TESTS: {
  file: string
  reason: string
  substitutions: { find: RegExp; replace: string | ((...args: string[]) => string); description: string }[]
}[] = [
  {
    file: 'packages/core/agent-loop/tests/config-session-id.spec.ts',
    reason: 'uses the dropped JSONL persistence provider (PRD D-003: SQLite is Rigo\'s only shipped provider); the root-keyed in-memory MemoryPersistence keeps the reload-survival semantics under test',
    substitutions: [
      { find: /import JsonlSessionPersistence from '@deepseek-ai\/dsh-session-persistence-jsonl'/, replace: "import MemoryPersistence from '../../../support/memory-persistence.ts'", description: 'swap provider import' },
      { find: /\bJsonlSessionPersistence\b/g, replace: 'MemoryPersistence', description: 'rename provider identifier' },
    ],
  },
  {
    file: 'packages/core/agent-loop/tests/resume.spec.ts',
    reason: 'uses the dropped JSONL persistence provider (PRD D-003: SQLite is Rigo\'s only shipped provider); the root-keyed in-memory MemoryPersistence keeps the reload-survival semantics under test',
    substitutions: [
      { find: /import JsonlSessionPersistence from '@deepseek-ai\/dsh-session-persistence-jsonl'/, replace: "import MemoryPersistence from '../../../support/memory-persistence.ts'", description: 'swap provider import' },
      { find: /\bJsonlSessionPersistence\b/g, replace: 'MemoryPersistence', description: 'rename provider identifier' },
    ],
  },
  {
    file: 'packages/llm/llm/tests/attribution.spec.ts',
    reason: 'reads the upstream package manifest relative to the test location; after the move to tests/upstream/ it must point into the ported package directory',
    substitutions: [
      { find: /createRequire\(import\.meta\.url\)\('\.\.\/package\.json'\)/, replace: "createRequire(import.meta.url)('../../../../packages/harness/llm/package.json')", description: 'repoint manifest read' },
    ],
  },
  {
    file: 'packages/core/agent-loop/tests/resume.spec.ts',
    reason: 'bun\'s expect().rejects/.resolves evaluate the subject promise EAGERLY (blocking the test), so the vitest pattern of registering a rejection assertion and then triggering the rejection deadlocks under bun; the lazy then-form settles identically in both runtimes and asserts the same rejection message',
    substitutions: [
      {
        find: /const rejection = expect\(promptly\((\w+)\)\)\.rejects\.toThrow\(([^)]*)\)/g,
        replace: (match: string, subject: string, matcher: string) => matcher.trim()
          ? `const rejection = promptly(${subject}).then(() => { throw new Error('expected resume rejection') }, (error: unknown) => expect(error instanceof Error ? error.message : String(error)).toMatch(${matcher.trim()}))`
          : `const rejection = promptly(${subject}).then(() => { throw new Error('expected resume rejection') }, () => undefined)`,
        description: 'lazy rejection assertion (register-then-trigger) instead of bun-eager .rejects',
      },
    ],
  },
  {
    file: 'packages/session/session-persistence/tests/preparations.spec.ts',
    reason: 'bun flags the promise rejection raised synchronously by AbortController.abort() as unhandled when no handler is attached yet, so the abort-then-await shape fails; attaching the lazy rejection handlers before aborting keeps the same semantics in both runtimes',
    substitutions: [
      {
        find: /firstController\.abort\(new Error\('first observer cancelled'\)\)\n    secondController\.abort\(new Error\('second observer cancelled'\)\)\n    await expect\(first\)\.rejects\.toThrow\('first observer cancelled'\)\n    await expect\(second\)\.rejects\.toThrow\('second observer cancelled'\)/,
        replace: [
          "const firstRejection = Promise.resolve(first).then(",
          "  () => { throw new Error('expected \"first\" to reject') },",
          "  (error: unknown) => expect(error instanceof Error ? error.message : String(error)).toMatch('first observer cancelled'),",
          ")",
          "const secondRejection = Promise.resolve(second).then(",
          "  () => { throw new Error('expected \"second\" to reject') },",
          "  (error: unknown) => expect(error instanceof Error ? error.message : String(error)).toMatch('second observer cancelled'),",
          ")",
          "firstController.abort(new Error('first observer cancelled'))",
          "secondController.abort(new Error('second observer cancelled'))",
          "await firstRejection",
          "await secondRejection",
        ].join('\n'),
        description: 'attach lazy rejection handlers before aborting',
      },
    ],
  },
  {
    file: 'packages/session/session-persistence/tests/coordinator-contract.ts',
    reason: 'bun\'s .resolves.not.toThrow() treats any truthy resolved value as a thrown value, so the flush boolean fails it; asserting the documented store contract (flush drains to true) keeps the same meaning in both runtimes',
    substitutions: [
      {
        find: /await expect\(ctx\.sessions\.flush\(session\)\)\.resolves\.not\.toThrow\(\)/,
        replace: 'await expect(Promise.resolve(ctx.sessions.flush(session))).resolves.toBe(true)',
        description: 'assert flush(true) instead of resolves.not.toThrow (bun toThrow quirk)',
      },
    ],
  },
]

/**
 * Tests that structurally require Node's internal module loader
 * (--expose-internals): under bun `ModuleLoader.fromInternal()` is undefined,
 * so the loader falls back to runtime bare-import resolution from the module
 * location. Each entry names the exact `it(...)` opener to mark with
 * `it.skipIf(...)`; the reason is recorded for the Issue 035 matrix.
 */
const BUN_SKIPPED_TESTS: { file: string; itOpener: string; reason: string }[] = [
  {
    file: 'packages/boot/app-boot/tests/hmr-config.spec.ts',
    itOpener: "it('observes module changes when its watch base is a filesystem alias', { timeout: 30_000 }, async () => {",
    reason: 'asserts alias-to-cache identity through ctx.loader.internal.loadCache, which requires Node\'s internal module loader (--expose-internals); bun has no ModuleLoader.fromInternal()',
  },
  {
    file: 'packages/boot/app-boot/tests/app-boot.spec.ts',
    itOpener: "it('can resolve bare plugins from the harness when the config project shadows their package name', async () => {",
    reason: 'bare plugin names resolve through ctx.loader.internal.import(baseUrl), which requires Node\'s internal module loader; without it bun resolves bare specifiers from the loader module location and cannot see the config-project node_modules shadow',
  },
]

/**
 * Manifest sections contributed by local-only source modules of ADAPT
 * packages (preserved across re-ports). Keyed by local package name; merged
 * into the regenerated package.json after the upstream-derived sections.
 */
const LOCAL_MANIFEST_ADDITIONS: Record<string, { peerDependencies?: Record<string, string> }> = {
  // Issue 004 minimal core boot (src/core-boot.ts): mounts the per-turn core.
  '@teoclub/harness-app-boot': {
    peerDependencies: {
      '@teoclub/harness-agent': '*',
      '@teoclub/harness-agent-loop': '*',
      '@teoclub/harness-llm': '*',
      '@teoclub/harness-session': '*',
      '@teoclub/harness-system-prompt': '*',
      '@teoclub/harness-tools': '*',
    },
  },
}

/**
 * Test files using vitest APIs Bun's `bun:test` lacks (`vi.waitFor`,
 * `vi.stubEnv`, `vi.unstubAllEnvs`): their `vitest` import gains a sibling
 * polyfill import (tests/support/vitest-bun-polyfill.ts) that patches those
 * members when running under Bun. Vitest ignores the polyfill entirely
 * (its import guard detects vitest's richer `vi`), so the same file serves
 * both runtimes - the dual-runtime requirement in SPEC §9.2.
 */
const BUN_POLYFILL_TESTS = [
  'packages/boot/app-boot/tests/app-boot.spec.ts',
  'packages/util/home-paths/tests/home-paths.spec.ts',
  'packages/util/launch-environment/tests/launch-environment.spec.ts',
  'packages/session/session-persistence/tests/coordinator-contract.ts',
  'packages/session/session-persistence/tests/persistence.spec.ts',
  'packages/settings/settings/tests/settings.spec.ts',
  'packages/core/agent-loop/tests/cancel.spec.ts',
  'packages/core/agent-loop/tests/config-session-id.spec.ts',
  'packages/core/agent-loop/tests/resume.spec.ts',
  'packages/core/agent-loop/tests/scope-lifecycle.spec.ts',
  'packages/core/tools/tests/code-mode.spec.ts',
]

/**
 * Wrap `expect(<subject>).rejects` / `.resolves` subjects so the assertions
 * work under Bun (whose `.rejects`/`.resolves` require native Promises;
 * vitest awaits any thenable). Balanced-paren scan, skipping strings/comments
 * crudely by requiring the subject to parse; multi-line subjects supported.
 *
 * Two shapes, chosen by the subject:
 *  - a thenable (e.g. a Cordis Fiber from `ctx.plugin(...)`): wrap in
 *    `Promise.resolve(...)`, which adapts the thenable to a native promise.
 *  - an async function expression (`async (...) => ...` / `async function`):
 *    invoke it — `expect(<fn>())` — since `Promise.resolve(fn)` would just
 *    resolve to the function itself without calling it (breaking vitest), and
 *    Bun rejects raw function subjects. An async function always returns a
 *    native promise, so the invoked form is valid in both runtimes.
 */
function wrapExpectSettledSubjects(text: string): string {
  let out = ''
  let i = 0
  while (true) {
    const hit = text.indexOf('expect(', i)
    if (hit === -1) { out += text.slice(i); return out }
    // Walk to the matching close paren of this expect(.
    let depth = 0
    let j = hit + 'expect('.length - 1
    let inString: string | null = null
    for (; j < text.length; j++) {
      const ch = text[j]!
      if (inString) {
        if (ch === '\\') { j++; continue }
        if (ch === inString) inString = null
        continue
      }
      if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
    }
    if (j >= text.length) { out += text.slice(i); return out }
    const subject = text.slice(hit + 'expect('.length, j)
    const after = text.slice(j + 1)
    const isSettled = /^\s*\.(rejects|resolves)\b/.test(after)
    const alreadyWrapped = /^\s*Promise\.resolve\(/.test(subject)
    const hasAwait = /^\s*await\s/.test(subject)
    const isAsyncFn = /^\s*async\b/.test(subject)
    out += text.slice(i, hit)
    if (isSettled && !alreadyWrapped && !hasAwait) {
      // Invoke async-function subjects; adapt thenables to native promises.
      out += isAsyncFn ? `expect((${subject})())` : `expect(Promise.resolve(${subject}))`
    } else {
      out += text.slice(hit, j + 1)
    }
    i = j + 1
  }
}

/**
 * Map an upstream test's `../src/<sub>.ts` import onto the local package
 * specifier: `../src/index.ts` -> the package root, public subpaths
 * (`invariant`, `client`) -> `@scope/name/<sub>`, anything else ->
 * `@scope/name/src/<sub>.ts` (resolved to source by tsconfig.paths.json,
 * the same module identity the package exports build from).
 */
function relativeToPackage(localPackage: string, srcPath: string): string {
  const sub = srcPath.replace('../src/', '').replace(/\.ts$/, '')
  if (sub === 'index') return localPackage
  if (sub === 'invariant') return `${localPackage}/invariant`
  if (sub === 'client/index') return `${localPackage}/client`
  return `${localPackage}/src/${sub}.ts`
}

interface PortRecord {
  localPackage: string
  upstreamPath: string
  classification: PackageSpec['classification']
  srcFiles: number
  testFiles: number
  omittedTestFiles: { file: string; reason: string }[]
  adaptedTestFiles: { file: string; substitutions: string[]; reason: string }[]
  specifierEdits: number
  deps: string[]
  adapted: boolean
}

/**
 * Rewrite one ported SOURCE file (specifier rename only). Shared with
 * scripts/audit-source.ts, which re-derives KEEP files to verify they stay
 * rewrite-identical to the pinned upstream.
 */
export function portSourceFile(upstreamFile: string, text: string): { text: string; edits: number } {
  return rewriteFile(upstreamFile, text)
}

export interface PortedTestFile {
  text: string
  edits: number
  omitted: boolean
  appliedSubstitutions: string[]
  reason: string
}

/**
 * Rewrite one ported TEST file through the full pipeline (specifier rename,
 * relative-import mapping, recorded adaptations, bun polyfill injection,
 * node-internals skip marking, and the expect-subject wrap). Shared with
 * scripts/audit-source.ts for the KEEP rewrite-identity check.
 */
export function portTestFile(
  spec: PackageSpec,
  upstreamFile: string,
  rel: string,
  text: string,
): PortedTestFile {
  const omission = NOT_PORTED_TESTS.find((t) => t.file === `${spec.upstreamPath}/${rel}`)
  if (omission) return { text, edits: 0, omitted: true, appliedSubstitutions: [], reason: '' }
  const rewritten = rewriteFile(upstreamFile, text)
  // Upstream tests import the sibling source relatively ('../src/x.ts');
  // after the move to tests/upstream/<name>/ they must name the package,
  // which the source-resolution paths map back onto the same source file.
  rewritten.text = rewritten.text.replace(
    /(\bfrom\s+['"])(\.\.\/src\/(?:index\.ts|[^\s'"]+))(['"])/g,
    (_all, pre: string, specPath: string, post: string) => `${pre}${relativeToPackage(spec.localPackage, specPath)}${post}`,
  )
  // Recorded per-file adaptations (provider swaps, repointed paths).
  const adaptations = ADAPTED_TESTS.filter((t) => t.file === `${spec.upstreamPath}/${rel}`)
  const appliedSubstitutions: string[] = []
  for (const adaptation of adaptations) for (const sub of adaptation.substitutions) {
    if (sub.find.test(rewritten.text)) {
      rewritten.text = rewritten.text.replace(sub.find, typeof sub.replace === 'function' ? sub.replace as (...a: string[]) => string : sub.replace)
      appliedSubstitutions.push(sub.description)
    }
  }
  // Bun polyfill for vitest APIs bun:test lacks (vi.waitFor/stubEnv).
  // Path from tests/upstream/<name>/<rel> back to repo root is
  // two levels plus the depth of rel itself.
  if (BUN_POLYFILL_TESTS.includes(`${spec.upstreamPath}/${rel}`)) {
    const prefix = '../'.repeat(2 + rel.split('/').length - 1)
    rewritten.text = `import '${prefix}support/vitest-bun-polyfill.ts'\n${rewritten.text}`
  }
  // Tests that structurally need Node's internal module loader: mark the
  // exact it() with skipIf under bun (the helper evaluates to false in
  // vitest, so the same file still runs there).
  const bunSkip = BUN_SKIPPED_TESTS.find((t) => t.file === `${spec.upstreamPath}/${rel}`)
  if (bunSkip) {
    if (!rewritten.text.includes(bunSkip.itOpener)) {
      throw new Error(`BUN_SKIPPED_TESTS opener not found in ${bunSkip.file}: ${bunSkip.itOpener}`)
    }
    const marked = bunSkip.itOpener.replace(/^it\(/, 'it.skipIf(RIGO_REQUIRES_NODE_INTERNALS)(')
    rewritten.text = rewritten.text.replace(bunSkip.itOpener, marked)
    rewritten.text = `const RIGO_REQUIRES_NODE_INTERNALS = typeof Bun !== 'undefined'\n${rewritten.text}`
  }
  // Bun's expect().rejects/.resolves only accept native Promises, while
  // vitest awaits any thenable - and ctx.plugin(...) returns a Cordis
  // Fiber (a function-shaped thenable). Wrapping the subject in
  // Promise.resolve() is behavior-neutral under vitest and makes the
  // same assertion run under Bun (dual-runtime requirement, SPEC §9.2).
  // Subjects may span lines and nest parentheses, so match balanced
  // parens from `expect(` up to the closing paren before .rejects/.
  // .resolves.
  rewritten.text = wrapExpectSettledSubjects(rewritten.text)
  return {
    text: rewritten.text,
    edits: rewritten.edits,
    omitted: false,
    appliedSubstitutions,
    reason: adaptations.map((a) => a.reason).join(' '),
  }
}

async function main() {
  // Verify the clone actually sits at the pinned commit.
  const head = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const tagCommit = execFileSync('git', ['-C', clone, 'rev-parse', `${BASELINE.tag}^{commit}`], { encoding: 'utf8' }).trim()
  if (tagCommit !== BASELINE.commit) {
    throw new Error(`clone tag ${BASELINE.tag} resolves to ${tagCommit}, expected ${BASELINE.commit}`)
  }
  console.log(`clone checked out at ${head.slice(0, 12)} (pinned baseline ${BASELINE.commit.slice(0, 12)})`)

  const upstreamLicense = gitShow('LICENSE')
  const records: PortRecord[] = []
  const paths: Record<string, string[]> = {}

  for (const spec of PACKAGES) {
    const dest = join(root, spec.localPath)
    const srcFiles = gitList(`${spec.upstreamPath}/src`)
    const testFiles = gitList(`${spec.upstreamPath}/tests`).filter((f) => /\.(spec|test)\.ts$/.test(f) || f.includes('/tests/'))

    // ADAPT packages carry recorded local modifications (hand edits plus
    // local-only modules like the Issue 004 minimal core boot); every local
    // source file is preserved across re-ports so those edits and additions
    // survive, and the preserved contents feed the dependency computation.
    const preservedLocal: { rel: string; content: string }[] = []
    if (spec.classification === 'ADAPT') {
      const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name)
          if (entry.isDirectory()) walk(full)
          else if (entry.name.endsWith('.ts')) {
            preservedLocal.push({ rel: relative(dest, full), content: readFileSync(full, 'utf8') })
          }
        }
      }
      if (existsSync(join(dest, 'src'))) walk(join(dest, 'src'))
    }
    const { harness: deps, cordis: cordisDeps } = computeDeps(spec, gitList(spec.upstreamPath), preservedLocal.map((f) => f.content))
    let specifierEdits = 0

    console.log(`porting ${spec.upstreamPackage} -> ${spec.localPackage} (${srcFiles.length} src, ${testFiles.length} test files, deps: ${[...deps].map((d) => d.replace('@teoclub/harness-', '')).join(', ') || 'none'})`)

    // Fresh destination, but keep build outputs and install state: rm -rf of
    // the package directory would drop lib/ (breaking any subprocess running
    // from a tsx launcher, which resolves the built entry) and the nested
    // node_modules bun links (breaking the next tsc -b until reinstall).
    for (const stale of ['src', 'tsconfig.tsbuildinfo']) {
      await rm(join(dest, stale), { recursive: true, force: true })
    }
    await mkdir(join(dest, 'src'), { recursive: true })

    // Source files.
    for (const upstreamFile of srcFiles) {
      const rel = relative(spec.upstreamPath, upstreamFile)
      const text = gitShow(upstreamFile)
      const rewritten = portSourceFile(upstreamFile, text)
      specifierEdits += rewritten.edits
      await mkdir(dirname(join(dest, rel)), { recursive: true })
      await writeFile(join(dest, rel), rewritten.text)
    }
    for (const file of preservedLocal) {
      await mkdir(dirname(join(dest, file.rel)), { recursive: true })
      await writeFile(join(dest, file.rel), file.content)
      console.log(`  preserved local source ${file.rel} (ADAPT)`)
    }

    // Tests -> tests/upstream/<name>/.
    const testDest = join(root, 'tests/upstream', spec.localPath.split('/').pop()!)
    await rm(testDest, { recursive: true, force: true })
    let omittedTests = 0
    const appliedAdaptations: { file: string; substitutions: string[]; reason: string }[] = []
    for (const upstreamFile of testFiles) {
      const rel = relative(spec.upstreamPath, upstreamFile)
      const ported = portTestFile(spec, upstreamFile, rel, gitShow(upstreamFile))
      if (ported.omitted) {
        omittedTests++
        continue
      }
      if (ported.appliedSubstitutions.length) {
        appliedAdaptations.push({ file: rel, substitutions: ported.appliedSubstitutions, reason: ported.reason })
      }
      specifierEdits += ported.edits
      await mkdir(dirname(join(testDest, rel)), { recursive: true })
      await writeFile(join(testDest, rel), ported.text)
    }
    if (omittedTests) console.log(`  omitted ${omittedTests} test file(s) (see docs/harness-upstream-audit.json)`)
    if (appliedAdaptations.length) console.log(`  adapted ${appliedAdaptations.length} test file(s) (see docs/harness-upstream-audit.json)`)

    // LICENSE (upstream DeepSeek MIT, preserved verbatim per FR-3).
    await writeFile(join(dest, 'LICENSE'), upstreamLicense)

    // package.json regenerated from the upstream manifest.
    const upstreamPkg = JSON.parse(gitShow(`${spec.upstreamPath}/package.json`))
    const pkg = {
      name: spec.localPackage,
      description: rewriteProse(upstreamPkg.description ?? spec.localPackage).text,
      version: '0.1.0',
      type: 'module',
      main: 'lib/index.js',
      types: 'lib/types/index.d.ts',
      publishConfig: { access: 'public' },
      repository: {
        type: 'git',
        url: 'git+https://github.com/teoclub/rigo.git',
        directory: spec.localPath,
      },
      engines: { node: '^22.19.0 || >=24.0.0' },
      license: 'MIT',
      teoclub: {
        source: {
          repository: 'deepseek-ai/deepseek-harness',
          path: spec.upstreamPath,
          upstreamPackage: spec.upstreamPackage,
          upstreamVersion: BASELINE.upstreamVersion,
          commit: BASELINE.commit,
          classification: spec.classification,
        },
      },
      // Exports gain a "development" condition pointing at SOURCE: package-
      // internal bare imports resolve through workspace node_modules links,
      // and a mixed src/lib graph splits module-private symbols (Cordis scope
      // keys, error classes). Vite (dev/vitest) resolves the development
      // condition; published consumers (production) get the built lib.
      ...(Object.keys(upstreamPkg.exports ?? {}).length > 0 ? { exports: addDevelopmentConditions(upstreamPkg.exports) } : {}),
      ...(upstreamPkg.dependencies ? { dependencies: rewriteDepNames(upstreamPkg.dependencies) } : {}),
      ...(upstreamPkg.peerDependencies ? { peerDependencies: rewriteDepNames(upstreamPkg.peerDependencies) } : {}),
      // Local-only source modules (ADAPT packages) may import additional
      // workspace packages; their declarations are merged in after the
      // upstream-derived sections so a re-port stays complete.
      ...(LOCAL_MANIFEST_ADDITIONS[spec.localPackage] as Record<string, unknown> | undefined),
      // Upstream declares these as devDependencies; runtime deps live above.
      ...(upstreamPkg.devDependencies?.['@types/js-yaml'] ? { devDependencies: { '@types/js-yaml': upstreamPkg.devDependencies['@types/js-yaml'] } } : {}),
      files: upstreamPkg.files ?? ['lib/index.js', 'lib/invariant.js', 'lib/types/**/*.d.ts'],
    }
    await writeFile(join(dest, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

    // tsconfig.json: project references computed from actual imports. Vendored
    // cordis-family deps are referenced too, so `paths` can map them to source
    // (bun/vitest runtime) while tsc still checks against their declaration
    // outputs - same boundary pattern as upstream's vendor/ references.
    const depth = spec.localPath.split('/').length
    const extendsPath = '../'.repeat(depth) + 'tsconfig.base.json'
    const references = [
      ...[...deps].sort().map((dep) => ({
        path: relative(spec.localPath, PACKAGES.find((p) => p.localPackage === dep)!.localPath),
      })),
      ...[...cordisDeps].sort().map((name) => ({
        path: relative(spec.localPath, CORDIS_PACKAGES.find((c) => c.name === name)!.path),
      })),
    ]
    await writeFile(join(dest, 'tsconfig.json'), JSON.stringify({
      extends: extendsPath,
      compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
      include: ['src'],
      ...(references.length ? { references } : {}),
    }, null, 2) + '\n')

    // tsdown.config.ts: root + invariant companion (+ client entry for
    // typert-registry). The client bundle uses the object-entry form so the
    // output lands at lib/client.js, matching the upstream manifest's
    // `exports["./client"]` target (the array form would name it lib/index.js
    // and collide with the main entry).
    const entries = ['lib/types/index.js']
    if (srcFiles.includes(`${spec.upstreamPath}/src/invariant.ts`)) entries.push('lib/types/invariant.js')
    const clientEntry = srcFiles.includes(`${spec.upstreamPath}/src/client/index.ts`)
    const tsdownBlocks = clientEntry
      ? [...entries, { client: 'src/client/index.ts' }]
      : entries
    await writeFile(join(dest, 'tsdown.config.ts'), `import { defineConfig } from 'tsdown'

/** Ported build shape: each source entry becomes an independent ESM bundle. */
export default defineConfig([${
  tsdownBlocks
    .map((entry) => `
  {
    entry: ${typeof entry === 'string' ? `['${entry}']` : JSON.stringify(entry)},
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },`).join('')
}])
`)

    records.push({
      localPackage: spec.localPackage,
      upstreamPath: spec.upstreamPath,
      classification: spec.classification,
      srcFiles: srcFiles.length,
      testFiles: testFiles.length,
      omittedTestFiles: NOT_PORTED_TESTS
        .filter((t) => t.file.startsWith(`${spec.upstreamPath}/`))
        .map((t) => ({ file: relative(spec.upstreamPath, t.file), reason: t.reason })),
      adaptedTestFiles: appliedAdaptations,
      specifierEdits,
      deps: [...deps].sort(),
      adapted: spec.classification === 'ADAPT',
    })

    // Source-resolution paths for this package.
    const name = spec.localPackage
    paths[name] = [`./${spec.localPath}/src`]
    for (const sub of ['invariant', 'types', 'brand', 'message', 'surface', 'presentation', 'client']) {
      const file = `${spec.localPath}/src/${sub}.ts`
      if (srcFiles.includes(`${spec.upstreamPath}/src/${sub}.ts`)) paths[`${name}/${sub}`] = [`./${file}`]
    }
    if (srcFiles.includes(`${spec.upstreamPath}/src/client/index.ts`)) paths[`${name}/client`] = [`./${spec.localPath}/src/client/index.ts`]
    paths[`${name}/src/*`] = [`./${spec.localPath}/src/*`]
  }

  // Local-only Rigo packages map to their source (no upstream derivation).
  // Top-level source faces (definition.ts, node.ts, ...) get subpath entries
  // mirroring the package exports, so consumers resolve to source directly.
  for (const local of LOCAL_PACKAGES) {
    paths[local.localPackage] = [`./${local.localPath}/src`]
    paths[`${local.localPackage}/src/*`] = [`./${local.localPath}/src/*`]
    const localSrc = join(root, local.localPath, 'src')
    if (existsSync(localSrc)) {
      for (const file of readdirSync(localSrc)) {
        if (file.endsWith('.ts') && file !== 'index.ts') {
          const base = file.replace(/\.ts$/, '')
          paths[`${local.localPackage}/${base}`] = [`./${local.localPath}/src/${file}`]
        }
      }
    }
  }

  // Vendored cordis family maps to SOURCE here - the same mapping upstream
  // uses, but routed through the IN-REPO vendor/cordis checkout (the only
  // authoritative copy; the old out-of-repo ../cordis path is retired):
  // Vite's tsconfig path resolution only applies targets that sit
  // inside the project root, and an out-of-root target silently falls back to
  // the built node_modules copy (which drops `const enum FiberState` and
  // breaks source-identity sharing in tests). Entries name the exact
  // index.ts: through the symlink, Vite fails to resolve the bare directory
  // form (it works for in-repo paths) and would again fall back to lib/.
  // Two consumers, both intended:
  //  - vitest/bun runtime: loads cordis source, where `const enum FiberState`
  //    is transpiled to a real runtime enum (bundled cordis drops it).
  //  - tsc: each harness package references these as project references, so
  //    tsc checks against their built declarations instead of pulling their
  //    sources into the importing project (no rootDir leakage).
  for (const c of CORDIS_PACKAGES) {
    paths[c.name] = [`./${c.path}/src/index.ts`]
  }

  // tsconfig.paths.json + tsconfig.base.json (generated source-resolution
  // facade). The base file carries the paths INLINE (not via extends):
  // Vite's native tsconfig-paths resolution reads each importer's nearest
  // tsconfig and follows only the direct extends chain, so every package
  // project (tsconfig.json -> ../../../tsconfig.base.json) must see the paths
  // at one hop for the whole graph to resolve to SOURCE — a mixed src/lib
  // graph splits module-private symbols (Cordis scope keys) and breaks
  // scope-dependent behavior.
  const sortedPaths: Record<string, string[]> = {}
  for (const key of Object.keys(paths).sort()) sortedPaths[key] = paths[key]
  await writeFile(join(root, 'tsconfig.paths.json'), JSON.stringify({
    $comment: 'Generated by scripts/port-upstream.ts - do not edit by hand.',
    compilerOptions: { paths: sortedPaths },
  }, null, 2) + '\n')
  console.log(`wrote tsconfig.paths.json (${Object.keys(sortedPaths).length} entries)`)

  const baseOptions: Record<string, unknown> = {
    target: 'es2024',
    module: 'esnext',
    moduleResolution: 'bundler',
    declaration: true,
    sourceMap: true,
    declarationMap: true,
    composite: true,
    incremental: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowImportingTsExtensions: true,
    rewriteRelativeImportExtensions: true,
    verbatimModuleSyntax: false,
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    types: ['node'],
    paths: sortedPaths,
  }
  await writeFile(join(root, 'tsconfig.base.json'), JSON.stringify({
    $comment: 'Generated by scripts/port-upstream.ts - do not edit by hand. Paths are INLINE (not via extends) so every package project reaches them through one extends hop.',
    compilerOptions: baseOptions,
  }, null, 2) + '\n')
  console.log('wrote tsconfig.base.json (inline source-resolution facade)')

  // Workspace apps (not packages): first-class members of the typecheck
  // graph, referenced by path like the package projects.
  const appProjects = ['apps/work-web'] as const

  // Root tsconfig.json references every ported package plus the vendored
  // cordis family (the sibling checkout's own composite projects). Extending
  // the generated paths facade keeps bun's native tsconfig-path resolution
  // (applied per nearest tsconfig) source-consistent for files outside any
  // package project - notably tests/upstream specs, which otherwise resolve
  // workspace imports through node_modules to built lib output while code
  // inside packages/harness/*/lib resolves the same specifiers to src,
  // instantiating each module twice with process-local state split between
  // the copies. For tsc -b the extends is inert: the solution file compiles
  // nothing itself and references are unaffected by inherited compilerOptions.
  const rootTsconfig = {
    $comment: 'Generated by scripts/port-upstream.ts - do not edit by hand.',
    extends: './tsconfig.paths.json',
    files: [],
    references: [
      ...PACKAGES.map((p) => ({ path: p.localPath })),
      ...LOCAL_PACKAGES.map((p) => ({ path: p.localPath })),
      ...CORDIS_PACKAGES.map((c) => ({ path: c.path })),
      ...appProjects.map((path) => ({ path })),
    ],
  }
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(rootTsconfig, null, 2) + '\n')

  // Audit record.
  const audit = {
    generatedAt: new Date().toISOString(),
    baseline: BASELINE,
    ported: records,
    notPorted: undefined, // filled by audit-source.ts from baseline.ts NOT_PORTED
  }
  await mkdir(join(root, 'docs'), { recursive: true })
  await writeFile(join(root, 'docs/harness-upstream-audit.json'), JSON.stringify(audit, null, 2) + '\n')
  console.log(`wrote docs/harness-upstream-audit.json (${records.length} packages, ${records.reduce((n, r) => n + r.specifierEdits, 0)} specifier edits)`)
}

function rewriteDepNames(deps: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const localPackages = new Set(PACKAGES.map((p) => p.localPackage))
  const renameTable: [string, string][] = [
    ...PACKAGES.map((p) => [p.upstreamPackage, p.localPackage] as const),
    ['@deepseek-ai/cordis', '@teoclub/cordis'],
    ['@deepseek-ai/cordis-plugin-loader', '@teoclub/cordis-plugin-loader'],
    ['@deepseek-ai/cordis-plugin-include', '@teoclub/cordis-plugin-include'],
    ['@deepseek-ai/cordis-plugin-group', '@teoclub/cordis-plugin-group'],
    ['@deepseek-ai/cordis-plugin-hmr', '@teoclub/cordis-plugin-hmr'],
    ['@deepseek-ai/cordis-plugin-timer', '@teoclub/cordis-plugin-timer'],
    ['@deepseek-ai/cordis-plugin-logger-console', '@teoclub/cordis-plugin-logger-console'],
    ['@deepseek-ai/schemastery', '@teoclub/schemastery'],
    ['@deepseek-ai/cosmokit', '@teoclub/kit'],
  ]
  const names = Object.keys(deps).sort((a, b) => b.length - a.length)
  for (const name of names) {
    let mapped = name
    for (const [oldName, newName] of renameTable) {
      if (name === oldName || name.startsWith(oldName + '/')) {
        mapped = newName + name.slice(oldName.length)
        break
      }
    }
    const range = deps[name]
    // Only packages inside THIS workspace may use the workspace protocol;
    // the cordis family resolves from the sibling checkout via the root
    // dependency (file:), so those peers use an open range.
    if (localPackages.has(mapped)) {
      // npm 11 rejects the `workspace:` protocol outright (npm/cli#8845), and
      // bun links any matching range to workspace members, so inter-package
      // ranges are emitted as plain `*` for dual-runtime installability.
      out[mapped] = range.startsWith('workspace:') ? '*' : range
    } else if (range.startsWith('workspace:')) {
      out[mapped] = '*'
    } else {
      out[mapped] = range
    }
  }
  return out
}

if (import.meta.main) {
  void main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
