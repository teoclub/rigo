/**
 * Materialize `vendor/<dir>` trees from one commit of a deepseek-harness clone.
 *
 * A clone's working tree sits at whatever the user last checked out, which is
 * not necessarily the commit being synced. Reading it silently mixes revisions
 * into the vendored packages: the `dsh-v0.1.6-alpha.2` sync pulled
 * `loader/src/config/entry.ts` and `cordis/src/logger.ts` from the clone's HEAD
 * while every other file came from the tag, leaving a tree that matched no
 * upstream revision. Every script that consumes upstream sources goes through
 * here so the pinned commit is the only source of truth.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const MAX_BUFFER = 64 * 1024 * 1024

export interface UpstreamTree {
  /** Directory holding `vendor/<dir>/...` exactly as committed. */
  root: string
  /** Remove the materialized tree. */
  dispose(): void
}

/**
 * Copy the named paths out of `vendor/` at `commit` into a temp directory.
 * @param clonePath - a deepseek-harness clone containing `commit`.
 * @param commit - the pinned revision; must exist locally.
 * @param vendorPaths - paths under `vendor/`, files or directories.
 * @returns the staging root (use `join(root, 'vendor', path)`) and its disposer.
 * @throws when the commit or any path is missing, or git fails.
 */
export function materializeVendor(clonePath: string, commit: string, vendorPaths: string[]): UpstreamTree {
  const root = mkdtempSync(join(tmpdir(), 'cordis-upstream-'))
  try {
    const paths = vendorPaths.map((path) => `vendor/${path}`)
    const listing = execFileSync('git', ['-C', clonePath, 'ls-tree', '-r', commit, '--', ...paths], {
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    })
    let files = 0
    for (const line of listing.split('\n')) {
      if (!line) continue
      const [meta, path] = line.split('\t')
      if (!path) continue
      const [mode, type, object] = meta.split(/\s+/)
      if (type !== 'blob') continue
      const blob = execFileSync('git', ['-C', clonePath, 'cat-file', 'blob', object!], { maxBuffer: MAX_BUFFER })
      const target = join(root, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, blob, { mode: Number.parseInt(mode!, 8) })
      files += 1
    }
    if (!files) throw new Error(`no vendor sources found at ${commit} for: ${vendorDirs.join(', ')}`)
    return { root, dispose: () => rmSync(root, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(root, { recursive: true, force: true })
    throw error
  }
}
