/**
 * Issue 001 closure generator: walks the workspace dependency graph of the
 * SPEC §1.3 core-port candidates inside a deepseek-harness clone at the
 * pinned commit and prints the transitive workspace closure. The output is
 * frozen in scripts/lib/baseline.ts PACKAGES; this script exists to make that
 * table auditable and re-derivable.
 *
 * Usage: bun scripts/print-closure.ts <harness-clone-path>
 */
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { BASELINE } from './lib/baseline.ts'

const clone = resolve(process.argv[2] ?? '')
if (!clone) {
  console.error('usage: bun scripts/print-closure.ts <harness-clone-path>')
  process.exit(1)
}

/** SPEC §1.3 core migration candidates. */
const ROOTS = [
  'packages/core/scope',
  'packages/core/session',
  'packages/core/system-prompt',
  'packages/core/tools',
  'packages/core/agent',
  'packages/core/agent-default-model',
  'packages/core/agent-loop',
  'packages/llm/llm',
  'packages/boot/app-boot',
]

const listing = execFileSync('git', ['-C', clone, 'ls-tree', '-r', '--name-only', BASELINE.commit, '--', 'packages'], { encoding: 'utf8' })
  .trim().split('\n').filter((f) => f.endsWith('/package.json'))

const byName: Record<string, string> = {}
for (const file of listing) {
  const pkg = JSON.parse(execFileSync('git', ['-C', clone, 'show', `${BASELINE.commit}:${file}`], { encoding: 'utf8' }))
  if (pkg.name?.startsWith('@deepseek-ai/')) byName[pkg.name] = file.replace('/package.json', '')
}

const seen = new Set<string>()
const order: { name: string; dir: string }[] = []

function visit(dir: string) {
  if (seen.has(dir)) return
  seen.add(dir)
  const pkg = JSON.parse(execFileSync('git', ['-C', clone, 'show', `${BASELINE.commit}:${dir}/package.json`], { encoding: 'utf8' }))
  order.push({ name: pkg.name, dir })
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.peerDependencies ?? {}) }
  for (const dep of Object.keys(deps).sort()) {
    if (byName[dep]) visit(byName[dep])
  }
}

for (const root of ROOTS) visit(root)

console.log(`# Workspace closure of [${ROOTS.map((r) => r.split('/').pop()).join(', ')}] at ${BASELINE.tag}`)
for (const { name, dir } of order) {
  console.log(`${name.padEnd(48)} ${dir}`)
}
console.log(`# ${order.length} packages`)
