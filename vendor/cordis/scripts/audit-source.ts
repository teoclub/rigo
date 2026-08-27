/**
 * Phase 0 source audit (SPEC §5.1.1).
 *
 * Audits the nine vendored Cordis packages in a clone of
 * deepseek-ai/deepseek-harness and emits a machine-generated manifest
 * (`docs/upstream.manifest.md`) plus a JSON report
 * (`docs/upstream-audit.json`) covering:
 *
 *   1. package.json facts: name, version, dependencies, peerDependencies, exports
 *   2. drift between package.json versions and the vendor/README.md manifest
 *   3. Node-specific API usage (node:*, Bun.*) in src/ and bin.js
 *   4. rescope workload (@deepseek-ai / @cordisjs / cosmokit references)
 *   5. license confirmation
 *
 * Usage: bun scripts/audit-source.ts <harness-clone-path> <pinned-commit>
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const VENDOR_DIRS = [
  'cosmokit',
  'schemastery',
  'cordis',
  'loader',
  'include',
  'group',
  'timer',
  'hmr',
  'logger-console',
] as const

/** PRD §6.1 mapping: vendor dir -> TEO Club package name. */
const NAME_MAP: Record<string, string> = {
  cosmokit: '@teoclub/kit',
  schemastery: '@teoclub/schemastery',
  cordis: '@teoclub/cordis',
  loader: '@teoclub/cordis-plugin-loader',
  include: '@teoclub/cordis-plugin-include',
  group: '@teoclub/cordis-plugin-group',
  timer: '@teoclub/cordis-plugin-timer',
  hmr: '@teoclub/cordis-plugin-hmr',
  'logger-console': '@teoclub/cordis-plugin-logger-console',
}

interface AuditResult {
  dir: string
  name: string
  teoclubName: string
  version: string
  manifestVersion: string | null
  drift: boolean
  license: string
  licenseHolder: string | null
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  optionalPeerDependencies: string[]
  exports: string
  hasBin: boolean
  tsFiles: number
  srcLines: number
  nodeApis: string[]
  bunApis: string[]
  oldScopeRefs: number
  oldScopeFiles: string[]
}

async function* walk(dir: string): AsyncIterable<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8')
}

/** Parse the version column of the vendor README manifest table. */
function parseManifest(readme: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of readme.split('\n')) {
    const m = line.match(/^\|\s*`([a-z-]+)\/?`\s*\|[^|]+\|[^|]+\|\s*([^|]+?)\s*\|/)
    if (m) map.set(m[1], m[2])
  }
  return map
}

async function main() {
  const [clonePath, pinnedCommit] = process.argv.slice(2)
  if (!clonePath || !pinnedCommit) {
    console.error('usage: bun scripts/audit-source.ts <harness-clone-path> <pinned-commit>')
    process.exit(1)
  }
  const vendorRoot = join(clonePath, 'vendor')
  if (!(await exists(vendorRoot))) {
    console.error(`error: ${vendorRoot} not found - is this a deepseek-harness clone?`)
    process.exit(1)
  }

  const readme = await readText(join(vendorRoot, 'README.md'))
  const manifest = parseManifest(readme)
  const results: AuditResult[] = []

  for (const dir of VENDOR_DIRS) {
    const pkgRoot = join(vendorRoot, dir)
    const pkg: any = JSON.parse(await readText(join(pkgRoot, 'package.json')))

    // license
    let licenseHolder: string | null = null
    const licensePath = join(pkgRoot, 'LICENSE')
    if (await exists(licensePath)) {
      const text = await readText(licensePath)
      const m = text.match(/Copyright \(c\) [^(]+(\([^)]+\))/)
      licenseHolder = m?.[1] ?? text.split('\n')[1]?.trim() ?? null
    }

    // source scan
    const srcRoot = join(pkgRoot, 'src')
    const nodeApis = new Set<string>()
    const bunApis = new Set<string>()
    const oldScopeFiles = new Set<string>()
    let oldScopeRefs = 0
    let tsFiles = 0
    let srcLines = 0

    const scanTargets: string[] = []
    if (await exists(srcRoot)) scanTargets.push(srcRoot)
    const binPath = join(pkgRoot, 'bin.js')
    const hasBin = await exists(binPath)
    if (hasBin) scanTargets.push(binPath)

    for (const target of scanTargets) {
      const files = target.endsWith('.js') ? [target] : [...(await Array.fromAsync(walk(target)))]
      for (const file of files) {
        const text = await readText(file)
        const rel = relative(pkgRoot, file)
        if (file.endsWith('.ts') || file.endsWith('.js')) {
          tsFiles++
          srcLines += text.split('\n').length
        }
        for (const m of text.matchAll(/['"]node:([a-z:/-]+)['"]/g)) nodeApis.add(`node:${m[1]}`)
        for (const m of text.matchAll(/\bBun\s*\.\s*[a-zA-Z]+/g)) bunApis.add(m[0].replace(/\s+/g, ''))
        const scopeMatches = text.match(/@deepseek-ai|@cordisjs|(?<![a-zA-Z/.])cosmokit/g)
        if (scopeMatches) {
          oldScopeRefs += scopeMatches.length
          oldScopeFiles.add(rel)
        }
      }
    }

    const manifestVersion = manifest.get(dir) ?? null
    results.push({
      dir,
      name: pkg.name,
      teoclubName: NAME_MAP[dir],
      version: pkg.version,
      manifestVersion,
      drift: manifestVersion !== null && manifestVersion !== pkg.version,
      license: pkg.license ?? 'MISSING',
      licenseHolder,
      dependencies: pkg.dependencies ?? {},
      peerDependencies: pkg.peerDependencies ?? {},
      optionalPeerDependencies: Object.entries(pkg.peerDependenciesMeta ?? {})
        .filter(([, meta]: any) => meta?.optional).map(([name]) => name),
      exports: JSON.stringify(pkg.exports),
      hasBin,
      tsFiles,
      srcLines,
      nodeApis: [...nodeApis].sort(),
      bunApis: [...bunApis].sort(),
      oldScopeRefs,
      oldScopeFiles: [...oldScopeFiles].sort(),
    })
  }

  // machine-readable companion
  await writeFile(
    join(import.meta.dir, '../docs/upstream-audit.json'),
    JSON.stringify({ pinnedCommit, auditedAt: new Date().toISOString(), results }, null, 2) + '\n',
  )

  // markdown manifest (human-audited conclusions are appended separately in docs/upstream.md)
  const lines: string[] = []
  lines.push('# Upstream Source Tracking')
  lines.push('')
  lines.push('> Machine-generated by `scripts/audit-source.ts`. Human audit conclusions live')
  lines.push('> in [`upstream.md`](upstream.md).')
  lines.push('')
  lines.push(`- **Source repository**: deepseek-ai/deepseek-harness (public clone)`)
  lines.push(`- **Pinned commit**: \`${pinnedCommit}\``)
  lines.push(`- **Audit date**: ${new Date().toISOString().slice(0, 10)}`)
  lines.push('')
  lines.push('## Manifest')
  lines.push('')
  lines.push('| Directory | Upstream package | TEO Club package | Version | Manifest version | Drift | License |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const r of results) {
    lines.push(`| \`${r.dir}/\` | \`${r.name}\` | \`${r.teoclubName}\` | ${r.version} | ${r.manifestVersion ?? '—'} | ${r.drift ? '⚠️ yes' : 'no'} | ${r.license} |`)
  }
  lines.push('')
  lines.push('## Node-Specific API Usage (src/ + bin.js)')
  lines.push('')
  lines.push('| Package | node: APIs | Bun APIs |')
  lines.push('|---|---|---|')
  for (const r of results) {
    lines.push(`| \`${r.teoclubName}\` | ${r.nodeApis.map((s) => `\`${s}\``).join(', ') || '—'} | ${r.bunApis.map((s) => `\`${s}\``).join(', ') || '—'} |`)
  }
  lines.push('')
  lines.push('## Rescope Workload (old-scope references in source)')
  lines.push('')
  lines.push('| Package | Refs | Files |')
  lines.push('|---|---|---|')
  for (const r of results) {
    lines.push(`| \`${r.teoclubName}\` | ${r.oldScopeRefs} | ${r.oldScopeFiles.map((f) => `\`${f}\``).join(', ') || '—'} |`)
  }
  lines.push('')
  lines.push('<!-- AUDIT-GENERATED-END -->')
  await writeFile(join(import.meta.dir, '../docs/upstream.manifest.md'), lines.join('\n') + '\n')
  console.log(`audited ${results.length} packages -> docs/upstream.manifest.md, docs/upstream-audit.json`)
  const drifted = results.filter((r) => r.drift)
  if (drifted.length) {
    console.log(`version drift vs vendor README manifest: ${drifted.map((r) => `${r.dir} (${r.manifestVersion} -> ${r.version})`).join(', ')}`)
  }
}

main()
