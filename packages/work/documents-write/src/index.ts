/**
 * Rigo Atomic Document Write Action (Issue 025; SPEC §3.4, §3.5, §5.5,
 * §6.3; PRD US-011, FR-19, FR-21, FR-26, FR-27, NFR-5, NFR-6).
 *
 * The approved local-document write path (SPEC §5.5):
 *
 *   1. parse the workspace-relative target (absolute paths and `..`
 *      traversal are rejected — the same boundary rules as the read
 *      provider);
 *   2. revalidate the workspace boundary (parent realpath inside the root),
 *      the current version (from the documents projection; 0 = new file)
 *      and the current content hash (the file must match the projection);
 *   3. an expected-version mismatch raises {@link DocumentVersionConflictError}
 *      (`DOCUMENT_VERSION_CONFLICT`) and the target is left untouched;
 *   4. the content is written to a SAME-DIRECTORY temp file, fully flushed
 *      (`fsync`) and atomically renamed over the target — a failure never
 *      leaves partial target content;
 *   5. the target is re-read, hashed, the projection version is bumped
 *      (and its knowledge index version cleared — stale until re-indexed),
 *      and the `document/written` session event is appended;
 *   6. approval gating happens OUTSIDE this action (Issue 021 default:
 *      `local-write` requires approval before execution), so unapproved,
 *      denied or expired requests never reach the filesystem;
 *   7. crash recovery ({@link recoverDocumentWrites}) reads the action
 *      journal (`action_executions`, SPEC §3.4) for orphaned `running`/
 *      `proposed` document.write rows and compares the TARGET hash against
 *      the EXPECTED OUTPUT hash (derived from the journaled request): a
 *      match means the atomic rename happened — the success is replayed
 *      (projection + journal), anything else marks `recovery-required`
 *      WITHOUT re-writing (SPEC §5.5: no re-write without user consent);
 *   8. idempotency comes from the action pipeline: the same idempotency key
 *      replays the persisted outcome, so the file side effect happens once.
 *
 * @module @teoclub/work-documents-write
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
import { KNOWN_SESSION_EVENT_TYPES, type Session } from '@teoclub/harness-session'
import type { ActionDefinition } from '@teoclub/shared-actions'
import type { StorageDriver } from '@teoclub/shared-storage-sqlite-node/definition'
import {
  DocumentId,
  DocumentVersionConflictError,
  projectDocument,
  type DocumentsService,
} from '@teoclub/work-documents'

/** The stable action name. */
export const WRITE_DOCUMENT_ACTION_NAME = 'document.write'

/** The session event type appended on every successful atomic write. */
export const DOCUMENT_WRITTEN_EVENT_TYPE = 'document/written'

{
  const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
  known.add(DOCUMENT_WRITTEN_EVENT_TYPE)
}

/** Data shape of {@link DOCUMENT_WRITTEN_EVENT_TYPE}. */
export interface DocumentWrittenEvent {
  documentId: string
  /** The new monotonic version after the write. */
  version: number
  /** sha256 hex of the written content. */
  contentHash: string
  /** The resolved target path. */
  source: string
}

declare module '@teoclub/harness-session' {
  interface SessionEventMap {
    'document/written': DocumentWrittenEvent
  }
}

/** The write request (SPEC §5.5; AC-1). */
export interface DocumentWriteInput {
  /** Workspace-relative target path. */
  relativePath: string
  /** Expected current version (0 = the file does not exist yet). */
  expectedVersion: number
  /** The new full content. */
  content: string
  /** Idempotency key (AC-1): one file side effect per key. */
  idempotencyKey: string
}

/** The outcome of one atomic write. */
export interface DocumentWriteOutcome {
  relativePath: string
  /** The new monotonic version. */
  version: number
  /** sha256 hex of the written content. */
  contentHash: string
  /** The resolved target path. */
  source: string
}

/** Boundary violation (SPEC §6.1 `PATH_OUTSIDE_WORKSPACE`). */
export class WorkspaceBoundaryError extends Error {
  readonly code = 'PATH_OUTSIDE_WORKSPACE'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceBoundaryError'
  }
}

export interface WriteDocumentActionConfig {
  /** The Documents service owning the projection. */
  documents: DocumentsService
  /** The session whose header cwd is the workspace root and whose log records `document/written` events. */
  session: Session
  /** Registry key (default {@link WRITE_DOCUMENT_ACTION_NAME}); multi-session hosts use one name per session. */
  name?: string
}

/**
 * The `document.write` action definition (Issue 021 shape): `local-write`
 * side effect, so the default policy requires approval BEFORE execution.
 * The workspace root comes from the session header's persisted cwd.
 */
export function createWriteDocumentAction(config: WriteDocumentActionConfig): ActionDefinition {
  if (config?.documents === undefined) {
    throw new TypeError('write document action requires the documents service')
  }
  if (config?.session === undefined) {
    throw new TypeError('write document action requires a session (its header cwd is the workspace root)')
  }
  return {
    name: config.name ?? WRITE_DOCUMENT_ACTION_NAME,
    description: 'Atomically write a Markdown or text document inside the workspace root',
    inputSchema: {
      type: 'object',
      properties: {
        relativePath: { type: 'string' },
        expectedVersion: { type: 'integer' },
        content: { type: 'string' },
        idempotencyKey: { type: 'string' },
      },
      required: ['relativePath', 'expectedVersion', 'content', 'idempotencyKey'],
    },
    sideEffect: 'local-write',
    async execute(input, signal) {
      return writeDocumentAtomically(
        config.documents,
        input as DocumentWriteInput,
        config.session,
        signal,
      )
    },
  }
}

/** sha256 hex of a string (UTF-8). */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/** Reject absolute paths and `..` traversal (workspace boundary, AC-2). */
export function assertWorkspaceRelativePath(relativePath: string): string {
  if (
    typeof relativePath !== 'string'
    || relativePath.length === 0
    || isAbsolute(relativePath)
    || relativePath.split('/').includes('..')
  ) {
    throw new WorkspaceBoundaryError(
      `document path must be workspace-relative and must not escape the workspace, got "${String(relativePath)}"`,
    )
  }
  return relativePath
}

/** The atomic write (SPEC §5.5 steps 1–10). Throws; never leaves partial targets. */
export async function writeDocumentAtomically(
  documents: DocumentsService,
  input: DocumentWriteInput,
  session: Session | undefined,
  signal?: AbortSignal,
): Promise<DocumentWriteOutcome> {
  signal?.throwIfAborted()
  const relativePath = assertWorkspaceRelativePath(input.relativePath)
  const previous = documents.projection(DocumentId(relativePath))

  // The workspace root: the session header's cwd is the per-session root;
  // without a session the caller must pass a root — documents service has
  // no root, so require the session for the boundary check.
  const sessionHeader = session?.header
  const root = sessionHeader?.cwd
  if (typeof root !== 'string' || root.length === 0) {
    throw new WorkspaceBoundaryError('document write requires a session with a persisted workspace root (header.cwd)')
  }
  const rootReal = realpathSync(root)
  const candidate = resolve(root, relativePath)
  // The parent must exist and stay inside the root (target may not exist).
  const parent = dirname(candidate)
  const parentReal = realpathSync(parent)
  const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  if (parentReal !== rootReal && !parentReal.startsWith(prefix)) {
    throw new WorkspaceBoundaryError(
      `document "${relativePath}" resolves outside the workspace root "${rootReal}" (escaping symlink)`,
    )
  }

  // Current version + content hash (SPEC §5.5 steps 3–4; AC-2).
  const fileHash = existsSync(candidate) ? sha256(readFileSync(candidate, 'utf8')) : undefined
  const currentVersion = previous?.version ?? 0
  if (previous !== undefined && fileHash !== undefined && fileHash !== previous.contentHash) {
    throw new DocumentVersionConflictError(
      `file "${relativePath}" drifted from its indexed content — refusing to write`,
    )
  }
  if (previous === undefined && fileHash !== undefined) {
    throw new DocumentVersionConflictError(
      `file "${relativePath}" exists but has no projection; expected version 0 cannot apply`,
    )
  }
  if (currentVersion !== input.expectedVersion) {
    throw new DocumentVersionConflictError(
      `document "${relativePath}" is at version ${currentVersion}, expected ${input.expectedVersion}`,
    )
  }

  // Same-directory temp file, full flush, atomic rename (SPEC §5.5 steps
  // 5–7): a failure here never leaves partial target content.
  const tmp = join(dirname(candidate), `.${basename(candidate)}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tmp, 'wx')
    writeSync(fd, input.content, null, 'utf8')
    fsyncSync(fd)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
  try {
    renameSync(tmp, candidate)
  } catch (error) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      // Best-effort cleanup; the target is untouched either way.
    }
    throw error
  }

  // Re-read, hash, bump the projection version (SPEC §5.5 steps 8–9; AC-5).
  const writtenHash = sha256(readFileSync(candidate, 'utf8'))
  const record = projectDocument(
    { id: DocumentId(relativePath), relativePath, content: input.content, source: candidate },
    previous,
  )
  documents.commitWrite(record)
  session?.append(DOCUMENT_WRITTEN_EVENT_TYPE, {
    documentId: relativePath,
    version: record.version,
    contentHash: writtenHash,
    source: candidate,
  })
  return { relativePath, version: record.version, contentHash: writtenHash, source: candidate }
}

// ---------------------------------------------------------------------------
// Crash recovery (SPEC §5.5: crash between the rename and the event commit)
// ---------------------------------------------------------------------------

export interface DocumentWriteRecoveryOptions {
  /** The SESSION database driver (hosts `action_executions`, the journal). */
  driver: StorageDriver
  /** The Documents service (projection bumps). */
  documents: DocumentsService
  /** Resolve a session for event replay (optional). */
  sessionResolver?: (sessionId: string) => Session | undefined
  /**
   * Journal action names to recover. Multi-session hosts register one
   * per-session name (`document.write:<sessionId>`); defaults to the plain
   * {@link WRITE_DOCUMENT_ACTION_NAME} for single-session hosts and tests.
   */
  actionNames?: readonly string[]
}

export interface DocumentWriteRecoveryOutcome {
  /** Rows whose rename provably happened — success replayed. */
  replayed: number
  /** Rows marked `recovery-required` — never re-written. */
  recoveryRequired: number
}

/**
 * Recovery pass for crash-orphaned document.write executions (SPEC §5.5):
 * for every `proposed`/`running` journal row of `document.write`, compare
 * the TARGET file hash against the EXPECTED OUTPUT hash (derived from the
 * journaled request content). Equal → the atomic rename happened: replay
 * the success (projection bump, journal to `succeeded`, event replay via
 * the session resolver) — the projection bump is idempotent, so repeated
 * recovery passes are safe. Different → `recovery-required`; the file is
 * NEVER re-written without user consent.
 */
export async function recoverDocumentWrites(options: DocumentWriteRecoveryOptions): Promise<DocumentWriteRecoveryOutcome> {
  const { driver, documents } = options
  const names = options.actionNames ?? [WRITE_DOCUMENT_ACTION_NAME]
  if (names.length === 0) return { replayed: 0, recoveryRequired: 0 }
  const rows = driver.query<Record<string, unknown>>(
    `SELECT * FROM action_executions
     WHERE action_name IN (${names.map(() => '?').join(', ')}) AND state IN ('proposed', 'running')`,
    names,
  )
  let replayed = 0
  let recoveryRequired = 0
  for (const row of rows) {
    const executionId = String(row.id)
    const input = JSON.parse(String(row.request_json)) as DocumentWriteInput
    const session = options.sessionResolver?.(String(row.session_id))
    const root = session?.header.cwd
    if (typeof root !== 'string' || root.length === 0) {
      // No resolvable root — cannot verify; keep it for a later pass.
      continue
    }
    const candidate = resolve(root, input.relativePath)
    const actual = existsSync(candidate) ? sha256(readFileSync(candidate, 'utf8')) : undefined
    const expected = sha256(input.content)
    const now = new Date().toISOString()
    if (actual === expected) {
      // The rename happened: replay the success without touching the file.
      const previous = documents.projection(DocumentId(input.relativePath))
      const record = projectDocument(
        { id: DocumentId(input.relativePath), relativePath: input.relativePath, content: input.content, source: candidate },
        previous,
      )
      documents.commitWrite(record)
      driver.run(
        `UPDATE action_executions SET state = 'succeeded', result_json = ?, finished_at = ? WHERE id = ?`,
        [
          JSON.stringify({ relativePath: input.relativePath, version: record.version, contentHash: actual }),
          now,
          executionId,
        ],
      )
      session?.append(DOCUMENT_WRITTEN_EVENT_TYPE, {
        documentId: input.relativePath,
        version: record.version,
        contentHash: actual,
        source: candidate,
      })
      replayed += 1
    } else {
      driver.run(
        `UPDATE action_executions SET state = 'recovery-required', error_json = ?, finished_at = ? WHERE id = ?`,
        [
          JSON.stringify({
            code: 'RECOVERY_REQUIRED',
            message: 'the atomic rename did not provably complete; re-verify before writing again',
          }),
          now,
          executionId,
        ],
      )
      recoveryRequired += 1
    }
  }
  return { replayed, recoveryRequired }
}

export default createWriteDocumentAction
