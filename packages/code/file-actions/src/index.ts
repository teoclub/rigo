/**
 * Rigo Workspace File Read/Write Actions (Issue 032; SPEC §2.5, §5.5;
 * PRD FR-5, FR-38, D-002).
 *
 * The minimal Rigo Code domain actions:
 *
 *   - `file.read` (`local-read`): boundary-checked UTF-8 file read inside
 *     the session's workspace root;
 *   - `file.write` (`local-write`): the ATOMIC write (same-directory temp
 *     file, full flush, atomic rename) that requires approval through the
 *     Issue 021 default policy — unapproved/denied/expired requests never
 *     touch the filesystem;
 *   - BOTH reuse the Workspace Boundary + symlink-escape protection
 *     (absolute paths, `..` traversal and escaping realpaths are rejected
 *     with {@link WorkspaceBoundaryError}).
 *
 * This package imports NO `@teoclub/work-*` package (SPEC §2.5 domain
 * isolation) — the boundary helpers are implemented here.
 *
 * @module @teoclub/code-file-actions
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { type Session } from '@teoclub/harness-session'
import type { ActionDefinition } from '@teoclub/shared-actions'

/** The stable read action name. */
export const READ_FILE_ACTION_NAME = 'file.read'
/** The stable write action name. */
export const WRITE_FILE_ACTION_NAME = 'file.write'

/** Boundary violation (SPEC §6.1 `PATH_OUTSIDE_WORKSPACE`). */
export class WorkspaceBoundaryError extends Error {
  readonly code = 'PATH_OUTSIDE_WORKSPACE'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceBoundaryError'
  }
}

/** Reject absolute paths and `..` traversal. */
export function assertWorkspaceRelativePath(relativePath: string): string {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath.split('/').includes('..')
  ) {
    throw new WorkspaceBoundaryError(
      `file path must be workspace-relative and must not escape the workspace, got "${String(relativePath)}"`,
    )
  }
  return relativePath
}

/** The session's workspace root (header cwd), asserted absolute. */
export function workspaceRootOf(session: Session): string {
  const root = session.header.cwd
  if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root)) {
    throw new WorkspaceBoundaryError('the session has no absolute workspace root (header.cwd)')
  }
  return root
}

/**
 * Resolve a relative path inside the root and enforce the boundary:
 * the PARENT's realpath must stay inside the root's realpath (the target
 * itself may not exist) — escaping symlinks are rejected.
 */
export function resolveInsideWorkspace(root: string, relativePath: string): string {
  const rootReal = realpathSync(root)
  const candidate = resolve(root, relativePath)
  const parentReal = realpathSync(dirname(candidate))
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  if (parentReal !== rootReal && !parentReal.startsWith(prefix)) {
    throw new WorkspaceBoundaryError(
      `path "${relativePath}" resolves outside the workspace root "${rootReal}" (escaping symlink)`,
    )
  }
  return candidate
}

/** sha256 hex of UTF-8 content. */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

// ---------------------------------------------------------------------------
// Read action
// ---------------------------------------------------------------------------

export interface FileReadActionConfig {
  /** The session whose header cwd is the workspace root. */
  session: Session
  /** Registry key (default {@link READ_FILE_ACTION_NAME}); multi-session hosts use one name per session. */
  name?: string
}

/** The `file.read` action: boundary-safe UTF-8 read (AC-2/3). */
export function createReadFileAction(config: FileReadActionConfig): ActionDefinition {
  if (config?.session === undefined) {
    throw new TypeError('file read action requires a session')
  }
  return {
    name: config.name ?? READ_FILE_ACTION_NAME,
    description: 'Read a file inside the workspace root; returns its content and size',
    inputSchema: {
      type: 'object',
      properties: { relativePath: { type: 'string' } },
      required: ['relativePath'],
    },
    sideEffect: 'local-read',
    execute(input) {
      const { relativePath } = input as { relativePath: string }
      const root = workspaceRootOf(config.session)
      const target = resolveInsideWorkspace(root, assertWorkspaceRelativePath(relativePath))
      if (!existsSync(target)) {
        throw new Error(`file "${relativePath}" not found`)
      }
      // Strict UTF-8: invalid sequences reject instead of substituting.
      const buffer = readFileSync(target)
      let content: string
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      } catch {
        throw new Error(`file "${relativePath}" is not valid UTF-8`)
      }
      return { relativePath, content, sizeBytes: buffer.length, source: target }
    },
  }
}

// ---------------------------------------------------------------------------
// Write action (atomic, approval-gated)
// ---------------------------------------------------------------------------

export interface FileWriteActionConfig {
  /** The session whose header cwd is the workspace root. */
  session: Session
  /** Registry key (default {@link WRITE_FILE_ACTION_NAME}). */
  name?: string
}

/** The `file.write` action: approved atomic write (AC-2/3). */
export function createWriteFileAction(config: FileWriteActionConfig): ActionDefinition {
  if (config?.session === undefined) {
    throw new TypeError('file write action requires a session')
  }
  return {
    name: config.name ?? WRITE_FILE_ACTION_NAME,
    description: 'Atomically write a file inside the workspace root; the write requires approval',
    inputSchema: {
      type: 'object',
      properties: {
        relativePath: { type: 'string' },
        content: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
      required: ['relativePath', 'content', 'idempotencyKey'],
    },
    sideEffect: 'local-write',
    execute(input) {
      const { relativePath, content } = input as { relativePath: string; content: string }
      const root = workspaceRootOf(config.session)
      const relative = assertWorkspaceRelativePath(relativePath)
      const target = resolveInsideWorkspace(root, relative)

      // Same-directory temp file, full flush, atomic rename: a failure never
      // leaves partial target content.
      const tmp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
      let fd: number | undefined
      try {
        fd = openSync(tmp, 'wx')
        writeSync(fd, content, null, 'utf8')
        fsyncSync(fd)
      } finally {
        if (fd !== undefined) closeSync(fd)
      }
      try {
        renameSync(tmp, target)
      } catch (error) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          // Best-effort cleanup; the target is untouched either way.
        }
        throw error
      }
      const written = readFileSync(target)
      return {
        relativePath: relative,
        contentHash: sha256(content),
        sizeBytes: written.length,
        source: target,
      }
    },
  }
}

export default createReadFileAction
