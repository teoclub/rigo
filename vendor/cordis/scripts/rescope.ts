/**
 * Phase 1 rescope (SPEC §5.1.2): copy the nine vendored Cordis packages from
 * a deepseek-harness clone into the TEO Club monorepo layout and rewrite
 * every `@deepseek-ai/*` reference to `@teoclub/*` (with the
 * cosmokit -> kit rename), plus regenerate package manifests per SPEC §3.1.
 *
 * Channel A (AST, accurate): import/export declarations (incl. type-only),
 * `require()` / `import()` string literals, and `declare module` names in
 * every .ts file, rewritten via the TypeScript parser.
 *
 * Channel B (text, catch-all): quoted complete package-name tokens in
 * .js/.md/.json files, tsconfig project-reference paths, and fresh
 * package.json generation.
 *
 * Usage: bun scripts/rescope.ts <harness-clone-path> <pinned-commit>
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

interface PkgSpec {
  /** vendor directory name inside the harness clone */
  vendorDir: string
  /** destination path relative to repo root */
  destDir: string
  oldName: string
  newName: string
  /** TEO Club release version (SPEC D5 / §3.1) */
  version: string
  description: string
}

export const PACKAGES: PkgSpec[] = [
  { vendorDir: 'cosmokit', destDir: 'packages/kit', oldName: '@deepseek-ai/cosmokit', newName: '@teoclub/kit', version: '1.8.2', description: 'A collection of common utilities' },
  { vendorDir: 'schemastery', destDir: 'packages/schemastery', oldName: '@deepseek-ai/schemastery', newName: '@teoclub/schemastery', version: '3.18.1', description: 'Type driven schema validator' },
  { vendorDir: 'cordis', destDir: 'packages/cordis', oldName: '@deepseek-ai/cordis', newName: '@teoclub/cordis', version: '5.0.0', description: 'Meta-Framework for Modern JavaScript Applications' },
  { vendorDir: 'loader', destDir: 'packages/plugins/loader', oldName: '@deepseek-ai/cordis-plugin-loader', newName: '@teoclub/cordis-plugin-loader', version: '1.0.2', description: 'Plugin loader for cordis' },
  { vendorDir: 'include', destDir: 'packages/plugins/include', oldName: '@deepseek-ai/cordis-plugin-include', newName: '@teoclub/cordis-plugin-include', version: '1.0.6', description: 'Include files in cordis configurations' },
  { vendorDir: 'group', destDir: 'packages/plugins/group', oldName: '@deepseek-ai/cordis-plugin-group', newName: '@teoclub/cordis-plugin-group', version: '1.0.1', description: 'Nested plugin group for cordis' },
  { vendorDir: 'timer', destDir: 'packages/plugins/timer', oldName: '@deepseek-ai/cordis-plugin-timer', newName: '@teoclub/cordis-plugin-timer', version: '1.1.3', description: 'Timer service for cordis' },
  { vendorDir: 'hmr', destDir: 'packages/plugins/hmr', oldName: '@deepseek-ai/cordis-plugin-hmr', newName: '@teoclub/cordis-plugin-hmr', version: '1.0.16', description: 'Hot Module Replacement Plugin for Cordis' },
  { vendorDir: 'logger-console', destDir: 'packages/plugins/logger-console', oldName: '@deepseek-ai/cordis-plugin-logger-console', newName: '@teoclub/cordis-plugin-logger-console', version: '1.0.1', description: 'Console logger exporter for cordis' },
]

const RENAME_MAP = new Map(PACKAGES.map((p) => [p.oldName, p]))
/** Upstream cordiverse names that also appear in vendored READMEs/docs. */
const UPSTREAM_NAME_MAP = new Map(PACKAGES.filter((p) => p.oldName.includes('plugin')).map((p) => [`@cordisjs/plugin-${p.vendorDir}`, p]))
const UPSTREAM_VERSION: Record<string, string> = {
  '@teoclub/kit': '1.8.2',
  '@teoclub/schemastery': '3.18.1',
  '@teoclub/cordis': '4.0.1',
  '@teoclub/cordis-plugin-loader': '1.0.2',
  '@teoclub/cordis-plugin-include': '1.0.6',
  '@teoclub/cordis-plugin-group': '1.0.1',
  '@teoclub/cordis-plugin-timer': '1.1.3',
  '@teoclub/cordis-plugin-hmr': '1.0.16',
  '@teoclub/cordis-plugin-logger-console': '1.0.1',
}

const root = resolve(import.meta.dir, '..')

/** Map a module specifier through the rename table (with /subpath support). */
function mapSpecifier(spec: string): string | null {
  for (const [oldName, pkg] of RENAME_MAP) {
    if (spec === oldName) return pkg.newName
    if (spec.startsWith(oldName + '/')) return pkg.newName + spec.slice(oldName.length)
  }
  return null
}

async function* walk(dir: string): AsyncIterable<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

/** Channel A: AST-based specifier rewrite for a single .ts file. */
function rescopeTypeScript(text: string, fileName: string): { text: string; edits: number } {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true)
  const edits: { start: number; end: number; replacement: string }[] = []

  function visit(node: ts.Node) {
    // import ... from 'x' / export ... from 'x'
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      recordIfMapped(node.moduleSpecifier)
    }
    // declare module 'x'
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      recordIfMapped(node.name)
    }
    // require('x') / import('x') / import.meta.resolve('x')
    if (
      ts.isCallExpression(node)
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0])
    ) {
      const callee = node.expression.getText(sourceFile)
      if (callee === 'require' || callee === 'import' || callee.endsWith('.resolve')) {
        recordIfMapped(node.arguments[0])
      }
    }
    // type-only import specifiers are covered by ImportDeclaration handling
    node.forEachChild(visit)
  }

  function recordIfMapped(literal: ts.StringLiteralLike) {
    const mapped = mapSpecifier(literal.text)
    if (mapped !== null) {
      edits.push({ start: literal.getStart(sourceFile), end: literal.getEnd(), replacement: `'${mapped}'` })
    }
  }

  visit(sourceFile)
  if (!edits.length) return { text, edits: 0 }
  edits.sort((a, b) => b.start - a.start)
  let out = text
  for (const e of edits) out = out.slice(0, e.start) + e.replacement + out.slice(e.end)
  return { text: out, edits: edits.length }
}

/** Channel B: quoted complete package-name token rewrite for text files. */
function rescopeTextTokens(text: string): { text: string; edits: number } {
  let edits = 0
  let out = text
  for (const oldName of RENAME_MAP.keys()) {
    const pkg = RENAME_MAP.get(oldName)!
    const pattern = new RegExp(`(['"\`])${escapeRegExp(oldName)}((?:/[^\`'"]*)?)\\1`, 'g')
    out = out.replace(pattern, (_m, quote: string, subpath: string) => {
      edits++
      return `${quote}${pkg.newName}${subpath}${quote}`
    })
  }
  return { text: out, edits }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Convert a vendored dependency range to the TEO Club range. */
function convertRange(name: string, range: string): string {
  const pkg = RENAME_MAP.get(name)
  if (!pkg) return range
  if (range.startsWith('workspace:')) {
    const suffix = range.slice('workspace:'.length)
    if (suffix === '*' || suffix === '^' || suffix === '') return `^${pkg.version}`
    return suffix
  }
  return range
}

/** Generate the TEO Club package.json for one package (SPEC §3.1). */
async function generateManifest(spec: PkgSpec, vendorPkg: any): Promise<Record<string, any>> {
  const manifest: Record<string, any> = {
    name: spec.newName,
    description: spec.description,
    version: spec.version,
    type: 'module',
    main: spec.vendorDir === 'schemastery' ? 'lib/index.cjs' : 'lib/index.js',
    types: 'lib/types/index.d.ts',
    publishConfig: { access: 'public' },
    repository: {
      type: 'git',
      url: 'git+https://github.com/teoclub/cordis.git',
      directory: spec.destDir,
    },
    engines: { node: '^22.19.0 || >=24.0.0' },
    license: 'MIT',
    author: vendorPkg.author,
    teoclub: {
      source: {
        repository: 'deepseek-ai/deepseek-harness',
        path: `vendor/${spec.vendorDir}`,
        upstreamPackage: spec.oldName,
        upstreamVersion: UPSTREAM_VERSION[spec.newName],
        commit: process.env.CORDIS_UPSTREAM_COMMIT!,
      },
    },
  }

  if (spec.vendorDir === 'schemastery') {
    manifest.module = 'lib/index.mjs'
    manifest.exports = {
      '.': {
        types: './lib/types/index.d.ts',
        import: './lib/index.mjs',
        require: './lib/index.cjs',
      },
      './src/*': './src/*',
      './package.json': './package.json',
    }
    manifest.files = ['lib/index.mjs', 'lib/index.cjs', 'lib/types/**/*.d.ts', 'lib/types/**/*.d.ts.map', 'src', 'LICENSE', 'README.md']
  } else if (spec.vendorDir === 'logger-console') {
    manifest.types = 'lib/types/shared.d.ts'
    manifest.exports = {
      '.': {
        types: './lib/types/shared.d.ts',
        node: './lib/index.js',
        default: './lib/browser.js',
      },
      './src/*': './src/*',
      './package.json': './package.json',
    }
    manifest.files = ['lib/index.js', 'lib/browser.js', 'lib/types/**/*.d.ts', 'lib/types/**/*.d.ts.map', 'src', 'LICENSE', 'README.md']
  } else {
    manifest.exports = {
      '.': {
        types: './lib/types/index.d.ts',
        import: './lib/index.js',
      },
      './src/*': './src/*',
      './package.json': './package.json',
    }
    manifest.files = ['lib/index.js', 'lib/types/**/*.d.ts', 'lib/types/**/*.d.ts.map', 'src', 'LICENSE', 'README.md']
  }

  if (spec.vendorDir === 'cordis') {
    manifest.bin = { cordis: 'bin.js' }
    manifest.files.splice(1, 0, 'bin.js')
    manifest.sideEffects = false
  }
  if (spec.vendorDir === 'cosmokit') {
    manifest.sideEffects = false
  }

  // dependencies (rescoped + range conversion; third-party untouched)
  if (vendorPkg.dependencies) {
    manifest.dependencies = Object.fromEntries(
      Object.entries(vendorPkg.dependencies).map(([name, range]) => {
        const mapped = mapSpecifier(name as string)!
        return [mapped ?? name, mapped ? convertRange(name as string, range as string) : range]
      }),
    )
  }
  // peerDependencies
  if (vendorPkg.peerDependencies) {
    manifest.peerDependencies = Object.fromEntries(
      Object.entries(vendorPkg.peerDependencies).map(([name, range]) => {
        const mapped = mapSpecifier(name as string)!
        return [mapped ?? name, mapped ? convertRange(name as string, range as string) : range]
      }),
    )
    if (vendorPkg.peerDependenciesMeta) {
      manifest.peerDependenciesMeta = Object.fromEntries(
        Object.entries(vendorPkg.peerDependenciesMeta).map(([name, meta]) => {
          const mapped = mapSpecifier(name as string)
          return [mapped ?? name, meta]
        }),
      )
    }
  }
  // devDependencies (third-party only in the vendored tree)
  if (vendorPkg.devDependencies) {
    manifest.devDependencies = vendorPkg.devDependencies
  }
  // harness service metadata field on hmr
  const serviceMeta = vendorPkg['@deepseek-ai/cordis']
  if (serviceMeta) {
    manifest['@teoclub/cordis'] = serviceMeta
  }
  return manifest
}

/** Rewrite a vendored tsconfig.json: extends path + project references. */
async function rewriteTsConfig(text: string, oldDir: string, newDir: string, vendorRoot: string): Promise<string> {
  const config = JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''))
  const oldRootDir = resolve(vendorRoot, oldDir)
  const newRootDir = resolve(root, newDir)
  // extends: ../../tsconfig.base.json -> same depth from packages/<x>, one deeper from packages/plugins/<x>
  const extendsDepth = newDir.split('/').length
  config.extends = '../'.repeat(extendsDepth) + 'tsconfig.base.json'
  if (config.references) {
    config.references = config.references.map((ref: { path: string }) => {
      const oldTarget = resolve(oldRootDir, ref.path) // e.g. vendor/cosmokit
      const targetDir = relative(vendorRoot, oldTarget) // e.g. cosmokit
      const spec = PACKAGES.find((p) => p.vendorDir === targetDir)
      if (!spec) throw new Error(`unknown tsconfig reference target: ${oldTarget}`)
      return { path: relative(newRootDir, resolve(root, spec.destDir)) }
    })
  }
  return JSON.stringify(config, null, 2) + '\n'
}

/** Docs mode: replace every textual occurrence of the old full names (both
 * scoped forms). Unrelated names like `@cordisjs/unyaml` are untouched. */
function rescopeDocs(text: string): { text: string; edits: number } {
  let edits = 0
  let out = text
  for (const [oldName, pkg] of [...RENAME_MAP, ...UPSTREAM_NAME_MAP]) {
    const re = new RegExp(escapeRegExp(oldName), 'g')
    out = out.replace(re, () => {
      edits++
      return pkg.newName
    })
  }
  // upstream cosmokit's own README references the bare package name
  out = out.replace(/(['`])cosmokit\1/g, (_m, q: string) => {
    edits++
    return `${q}@teoclub/kit${q}`
  })
  return { text: out, edits }
}

async function main() {
  const [clonePath, pinnedCommit] = process.argv.slice(2)
  if (!clonePath || !pinnedCommit) {
    console.error('usage: bun scripts/rescope.ts <harness-clone-path> <pinned-commit>')
    process.exit(1)
  }
  const vendorRoot = join(clonePath, 'vendor')
  process.env.CORDIS_UPSTREAM_COMMIT = pinnedCommit

  let astEdits = 0
  let textEdits = 0

  for (const spec of PACKAGES) {
    const srcDir = join(vendorRoot, spec.vendorDir)
    const destDir = join(root, spec.destDir)
    await rm(destDir, { recursive: true, force: true })
    await mkdir(destDir, { recursive: true })

    // copy source trees and static assets (behavior-preserving; SPEC §3.4)
    await cp(join(srcDir, 'src'), join(destDir, 'src'), { recursive: true })
    for (const asset of ['README.md', 'LICENSE', 'tsdown.config.ts']) {
      try {
        await stat(join(srcDir, asset))
        await cp(join(srcDir, asset), join(destDir, asset))
      } catch { /* not present */ }
    }
    if (spec.vendorDir === 'cordis') await cp(join(srcDir, 'bin.js'), join(destDir, 'bin.js'))

    // channel A: .ts sources
    for await (const file of walk(join(destDir, 'src'))) {
      if (!file.endsWith('.ts')) continue
      const text = await readFile(file, 'utf8')
      const result = rescopeTypeScript(text, file)
      if (result.edits) {
        await writeFile(file, result.text)
        astEdits += result.edits
      }
    }

    // channel B: bin.js, README.md (docs mode), tsconfig.json, package.json
    for (const rel of ['bin.js', 'README.md']) {
      const file = join(destDir, rel)
      try {
        const text = await readFile(file, 'utf8')
        const result = rel === 'README.md' ? rescopeDocs(text) : rescopeTextTokens(text)
        if (result.edits) {
          await writeFile(file, result.text)
          textEdits += result.edits
        }
      } catch { /* not present */ }
    }
    const tsconfigText = await readFile(join(srcDir, 'tsconfig.json'), 'utf8')
    await writeFile(join(destDir, 'tsconfig.json'), await rewriteTsConfig(tsconfigText, spec.vendorDir, spec.destDir, vendorRoot))

    const vendorPkg = JSON.parse(await readFile(join(srcDir, 'package.json'), 'utf8'))
    const manifest = await generateManifest(spec, vendorPkg)
    await writeFile(join(destDir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  }

  console.log(`rescoped ${PACKAGES.length} packages: ${astEdits} AST edits, ${textEdits} text edits`)
}

main()
