/**
 * Rigo Local Documents Provider (Issue 017; SPEC §4.3, §5.8, §6.1, §7.2; PRD
 * US-009, FR-25, D-005, D-008).
 *
 * Reads Markdown and plain-text documents strictly inside the per-session
 * Workspace Root — the session header's persisted `cwd` (or an explicitly
 * configured absolute root):
 *
 *   - the document API accepts only workspace-relative paths; absolute paths
 *     and `..` traversal are rejected with {@link WorkspaceBoundaryError}
 *     (SPEC §6.1 `PATH_OUTSIDE_WORKSPACE`);
 *   - the read target's `realpath` must stay inside the root's `realpath`, so
 *     escaping symlinks are rejected (SPEC §7.2 Workspace Boundary);
 *   - content is decoded as strict UTF-8: invalid byte sequences raise
 *     {@link DocumentEncodingError} (SPEC §6.1 `DOCUMENT_ENCODING_INVALID`);
 *   - a missing file raises the Issue 016 `DocumentNotFoundError` (§6.1
 *     `DOCUMENT_NOT_FOUND`); an empty document reads as `''` — no fabricated
 *     content (SPEC §5.8);
 *   - every successful read appends a `document/read` session event carrying
 *     the session, document, and resolved source location.
 *
 * Versioning and media-type detection are NOT duplicated here: the provider
 * returns {@link DocumentInput} and the Issue 016 service projection
 * (`projectDocument`) computes the monotonic version and media type.
 *
 * @module @teoclub/work-documents-local
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import { KNOWN_SESSION_EVENT_TYPES, type Session } from '@teoclub/harness-session'
import {
  DocumentNotFoundError,
  type DocumentId,
  type DocumentInput,
  type DocumentProvider,
} from '@teoclub/work-documents'

/** The session event type appended for every successful document read. */
export const DOCUMENT_READ_EVENT_TYPE = 'document/read'

// Ordinary event types join the known vocabulary without a format bump (the
// documented growth mechanism — see SESSION_FORMAT_VERSION). Persistence
// refuses unknown REQUIRED events on load, so a live-appended read event must
// be a known type; the underlying set is never frozen by the ported package,
// and the cast is the extension seam.
{
  const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
  known.add(DOCUMENT_READ_EVENT_TYPE)
}

/** Data shape of the {@link DOCUMENT_READ_EVENT_TYPE} session event. */
export interface DocumentReadEvent {
  /** The session that performed the read. */
  sessionId: string
  /** The document identity (the workspace-relative path). */
  documentId: string
  /** Provider-specific source location (the resolved real path). */
  source: string
}

// Augment the ported session event map so `session.append(DOCUMENT_READ_EVENT_TYPE, …)`
// typechecks and the event travels through the ported log/persistence.
declare module '@teoclub/harness-session' {
  interface SessionEventMap {
    'document/read': DocumentReadEvent
  }
}

/** Structured workspace escape (SPEC §6.1 `PATH_OUTSIDE_WORKSPACE`). */
export class WorkspaceBoundaryError extends Error {
  readonly code = 'PATH_OUTSIDE_WORKSPACE'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WorkspaceBoundaryError'
  }
}

/** Structured text decode failure (SPEC §6.1 `DOCUMENT_ENCODING_INVALID`). */
export class DocumentEncodingError extends Error {
  readonly code = 'DOCUMENT_ENCODING_INVALID'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentEncodingError'
  }
}

export interface LocalDocumentProviderConfig {
  /**
   * Absolute workspace root. When omitted, the session header's persisted
   * `cwd` supplies the root (SPEC §4.3: session creation fixes an absolute
   * workspace root; the header is validated absolute and persisted).
   */
  root?: string
  /** The session whose log records reads (the event carries its id). */
  session?: Session
  /**
   * Registry key (default `local`). Multi-session hosts register one
   * provider per session and must give each a unique name.
   */
  name?: string
}

/**
 * Assert the workspace-root contract (SPEC §4.3): absolute, existing,
 * directory. Raises {@link WorkspaceBoundaryError} otherwise.
 * @param root - the candidate root.
 */
export function assertWorkspaceRoot(root: string): void {
  if (!isAbsolute(root)) {
    throw new WorkspaceBoundaryError(`workspace root must be an absolute path, got "${root}"`)
  }
  if (!existsSync(root)) {
    throw new WorkspaceBoundaryError(`workspace root "${root}" does not exist`)
  }
  const stats = statSync(root)
  if (!stats.isDirectory()) {
    throw new WorkspaceBoundaryError(`workspace root "${root}" is not a directory`)
  }
}

/**
 * The local Markdown/text provider. Register on the Issue 016 Documents
 * service via `ctx.documents.registerProvider(provider)`.
 */
export class LocalDocumentProvider implements DocumentProvider {
  readonly name: string

  /** The asserted absolute workspace root. */
  readonly root: string
  /** The root's real path — containment is judged against this (SPEC §7.2). */
  readonly rootReal: string
  private readonly session: Session | undefined

  constructor(config: LocalDocumentProviderConfig = {}) {
    this.name = config.name ?? 'local'
    const root = config.root ?? config.session?.header.cwd
    if (typeof root !== 'string' || root.length === 0) {
      throw new TypeError(
        'local document provider requires an absolute workspace root (config.root or a session with a persisted header cwd)',
      )
    }
    assertWorkspaceRoot(root)
    this.root = root
    this.rootReal = realpathSync(root)
    this.session = config.session
  }

  /**
   * Resolve and read one document by its workspace-relative identity.
   * @param id - the document identity: the workspace-relative path itself.
   * @param signal - optional cancellation.
   * @returns the content plus its traceable source location (the real path).
   * @throws {@link WorkspaceBoundaryError} for absolute/`..`/escaping paths.
   * @throws {@link DocumentNotFoundError} when the file is missing.
   * @throws {@link DocumentEncodingError} for invalid UTF-8 content.
   */
  async read(id: DocumentId, signal?: AbortSignal): Promise<DocumentInput> {
    signal?.throwIfAborted()
    const relativePath = this.assertRelativePath(id)
    const candidate = resolve(this.root, relativePath)
    const real = this.resolveInsideWorkspace(candidate, id)

    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(real)
    } catch (error) {
      if (isEnoent(error)) {
        throw new DocumentNotFoundError(`document "${id}" not found`, { cause: error })
      }
      throw error
    }
    if (!stats.isFile()) {
      throw new DocumentNotFoundError(`document "${id}" is not a regular file`)
    }

    let buffer: Buffer
    try {
      buffer = readFileSync(real)
    } catch (error) {
      if (isEnoent(error)) {
        throw new DocumentNotFoundError(`document "${id}" not found`, { cause: error })
      }
      throw error
    }
    // Strict UTF-8: a lone byte sequence that is not valid UTF-8 raises
    // DOCUMENT_ENCODING_INVALID instead of silently substituting U+FFFD.
    // An empty document decodes to '' — no fabricated content (SPEC §5.8).
    const content = decodeStrictUtf8(buffer, id)

    this.session?.append(DOCUMENT_READ_EVENT_TYPE, {
      sessionId: this.session.id,
      documentId: id,
      source: real,
    })

    return { id, relativePath, content, source: real }
  }

  private assertRelativePath(id: DocumentId): string {
    const relativePath = String(id)
    if (
      relativePath.length === 0
      || isAbsolute(relativePath)
      || relativePath.split('/').includes('..')
    ) {
      throw new WorkspaceBoundaryError(
        `document path must be workspace-relative and must not escape the workspace, got "${relativePath}"`,
      )
    }
    return relativePath
  }

  /** `realpath` the candidate and enforce containment inside the root's real path. */
  private resolveInsideWorkspace(candidate: string, id: DocumentId): string {
    let real: string
    try {
      real = realpathSync(candidate)
    } catch (error) {
      if (isEnoent(error)) {
        throw new DocumentNotFoundError(`document "${id}" not found`, { cause: error })
      }
      throw error
    }
    const prefix = this.rootReal.endsWith(sep) ? this.rootReal : `${this.rootReal}${sep}`
    if (real !== this.rootReal && !real.startsWith(prefix)) {
      throw new WorkspaceBoundaryError(
        `document "${id}" resolves to "${real}", outside the workspace root "${this.rootReal}" (escaping symlink)`,
      )
    }
    return real
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

function decodeStrictUtf8(buffer: Buffer, id: DocumentId): string {
  try {
    return strictUtf8.decode(buffer)
  } catch {
    throw new DocumentEncodingError(`document "${id}" is not valid UTF-8 text`)
  }
}

export default LocalDocumentProvider
