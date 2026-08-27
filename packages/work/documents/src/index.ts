/**
 * Rigo Documents Service Definition (Issue 016; SPEC §2.4, §3.5; PRD
 * US-009, FR-25, D-008).
 *
 * The domain-agnostic `ctx.documents` contract: stable read / version query /
 * provider registration, plus the SPEC §3.5 `documents` table projection
 * (id, relative_path UNIQUE, version, content_hash, media_type, size_bytes,
 * indexed_version) over the Issue 007 storage foundation.
 *
 * The service definition is fully decoupled from the filesystem: content
 * arrives through registered {@link DocumentProvider}s (the local provider
 * lands in Issue 019), and the projection/validation/versioning rules live
 * here:
 *
 *   - MVP media types: `text/markdown` and `text/plain` only;
 *   - single documents above 5 MiB are rejected with a structured
 *     validation error;
 *   - the version is monotonic: unchanged hash keeps the version, any
 *     content change bumps it.
 *
 * @module @teoclub/work-documents
 */

import { Context, Service } from '@teoclub/cordis'
import { createHash } from 'node:crypto'
import { runMigrations, type StorageDriver, type StorageMigration } from '@teoclub/shared-storage-sqlite-node/definition'

/** Branded stable document identity. */
export type DocumentId = string & { readonly __documentId: unique symbol }

/** Brand a string as a {@link DocumentId}. */
export function DocumentId(id: string): DocumentId {
  return id as DocumentId
}

/** SPEC §3.5 documents table as the first migration. */
export const DOCUMENTS_MIGRATIONS: StorageMigration[] = [
  {
    version: 1,
    name: 'documents-table',
    sql: `
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  indexed_version INTEGER,
  updated_at TEXT NOT NULL
);
`,
  },
]

/** MVP-supported media types (SPEC §3.5). */
export const SUPPORTED_MEDIA_TYPES = ['text/markdown', 'text/plain'] as const
export type SupportedMediaType = typeof SUPPORTED_MEDIA_TYPES[number]

/** Single-document size ceiling (SPEC §3.5: 5 MiB). */
export const MAX_DOCUMENT_SIZE_BYTES = 5 * 1024 * 1024

/** One document projection row (SPEC §3.5). */
export interface DocumentRecord {
  id: DocumentId
  /** Unique workspace-relative path. */
  relativePath: string
  /** Monotonic version; unchanged content keeps the version. */
  version: number
  /** sha256 hex of the content. */
  contentHash: string
  mediaType: SupportedMediaType
  sizeBytes: number
  /** Knowledge index version, when the document was indexed (Issue 018). */
  indexedVersion: number | undefined
  updatedAt: string
}

/** Structured validation failure (SPEC §6.1 `DOCUMENT_VALIDATION_FAILED`). */
export class DocumentValidationError extends Error {
  readonly code = 'DOCUMENT_VALIDATION_FAILED'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentValidationError'
  }
}

/** Structured not-found failure (SPEC §6.1 `DOCUMENT_NOT_FOUND`). */
export class DocumentNotFoundError extends Error {
  readonly code = 'DOCUMENT_NOT_FOUND'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentNotFoundError'
  }
}

/** Structured version-mismatch failure (SPEC §6.1 `DOCUMENT_VERSION_CONFLICT`). */
export class DocumentVersionConflictError extends Error {
  readonly code = 'DOCUMENT_VERSION_CONFLICT'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'DocumentVersionConflictError'
  }
}

/** A document's content plus its traceable source location. */
export interface DocumentContent {
  record: DocumentRecord
  content: string
  /** Provider-specific source location (e.g. the absolute file path). */
  source: string
}

/** Content supplied by a provider for projection/validation. */
export interface DocumentInput {
  id: DocumentId
  relativePath: string
  content: string
  source: string
}

/** The stable provider interface — the service never touches the filesystem. */
export interface DocumentProvider {
  /** Stable provider name (registry key). */
  readonly name: string
  /** Resolve one document by identity; reject with {@link DocumentNotFoundError} when absent. */
  read(id: DocumentId, signal?: AbortSignal): Promise<DocumentInput>
}

export interface DocumentsConfig {
  /** Prebuilt storage driver (bypasses opening; caller owns lifecycle). */
  driver?: StorageDriver
  /** Open the projection storage (runtime-specific; Node default provided). */
  openStorage?: () => StorageDriver
  /** Migrations (defaults to the SPEC §3.5 documents table). */
  migrations?: StorageMigration[]
}

let defaultOpenStorage: (config: DocumentsConfig) => StorageDriver = () => {
  throw new Error('no storage driver: pass config.driver or config.openStorage (Node: @teoclub/shared-storage-sqlite-node/node)')
}

/**
 * Register the default storage opener (the Node driver). Kept OUT of this
 * module's import graph so the definition stays runtime-agnostic; the Node
 * host wires it at startup.
 */
export function configureDefaultStorage(opener: (config: DocumentsConfig) => StorageDriver): void {
  defaultOpenStorage = opener
}

function contentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Validate one document input against the MVP rules and compute its
 * projection record. Throws {@link DocumentValidationError} for unsupported
 * media types, oversized content, or invalid paths.
 * @param input - the provider-supplied content.
 * @param previous - the previous projection (for monotonic versioning).
 * @returns the validated projection record.
 */
export function projectDocument(
  input: DocumentInput,
  previous: DocumentRecord | undefined,
): DocumentRecord {
  const mediaType = detectMediaType(input.relativePath)
  if (mediaType === undefined) {
    throw new DocumentValidationError(
      `document "${input.relativePath}" has unsupported media type (MVP supports ${SUPPORTED_MEDIA_TYPES.join(', ')})`,
    )
  }
  if (input.relativePath.length === 0 || input.relativePath.startsWith('/') || input.relativePath.includes('..')) {
    throw new DocumentValidationError(`document "${input.relativePath}" is not a valid workspace-relative path`)
  }
  const sizeBytes = Buffer.byteLength(input.content, 'utf8')
  if (sizeBytes > MAX_DOCUMENT_SIZE_BYTES) {
    throw new DocumentValidationError(
      `document "${input.relativePath}" is ${sizeBytes} bytes, exceeding the ${MAX_DOCUMENT_SIZE_BYTES}-byte (5 MiB) limit`,
    )
  }
  const hash = contentHash(input.content)
  const version = previous === undefined ? 1 : previous.contentHash === hash ? previous.version : previous.version + 1
  return {
    id: input.id,
    relativePath: input.relativePath,
    version,
    contentHash: hash,
    mediaType,
    sizeBytes,
    indexedVersion: previous?.indexedVersion,
    updatedAt: new Date().toISOString(),
  }
}

/** Detect the MVP media type from the relative path extension. */
export function detectMediaType(relativePath: string): SupportedMediaType | undefined {
  if (relativePath.endsWith('.md') || relativePath.endsWith('.markdown')) return 'text/markdown'
  if (relativePath.endsWith('.txt')) return 'text/plain'
  return undefined
}

/** The Documents service. Mount via `ctx.plugin(DocumentsService, config)`. */
export class DocumentsService extends Service {
  private readonly driver: StorageDriver
  private readonly providers = new Map<string, DocumentProvider>()

  constructor(ctx: Context, config: DocumentsConfig = {}) {
    super(ctx, 'documents')
    if (config.driver !== undefined) {
      this.driver = config.driver
    } else {
      // Open the storage through the runtime-agnostic driver factory injected
      // at construction: the default is the Node driver from
      // @teoclub/shared-storage-sqlite-node/node (wired by the host).
      this.driver = config.openStorage?.() ?? defaultOpenStorage(config)
    }
    // The projection table is part of this service's storage contract;
    // migrations are idempotent, so pre-migrated drivers are safe.
    runMigrations(this.driver, { migrations: config.migrations ?? DOCUMENTS_MIGRATIONS })
    ctx.effect(() => () => {
      this.driver.close()
    }, 'documents.close()')
  }

  /**
   * Register a content provider. Unload (or the disposer) removes it.
   * @param provider - the provider to register.
   * @returns the disposer.
   */
  registerProvider(provider: DocumentProvider): () => void {
    if (typeof provider?.name !== 'string' || provider.name.length === 0) {
      throw new TypeError('document provider name must be a non-empty string')
    }
    if (this.providers.has(provider.name)) {
      throw new Error(`document provider "${provider.name}" is already registered`)
    }
    this.providers.set(provider.name, provider)
    return this.ctx.effect(() => () => {
      this.providers.delete(provider.name)
    }, `documents.registerProvider(${provider.name})`)
  }

  /** Registered providers (stable names). */
  listProviders(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Read one document through the registered providers (first match wins),
   * project/validate it, and persist the projection. Missing documents raise
   * {@link DocumentNotFoundError}.
   * @param id - the document identity.
   * @param signal - optional cancellation.
   * @returns the content plus its validated projection.
   */
  async read(id: DocumentId, signal?: AbortSignal): Promise<DocumentContent> {
    signal?.throwIfAborted()
    const previous = this.projection(id)
    let input: DocumentInput | undefined
    for (const provider of this.providers.values()) {
      try {
        input = await provider.read(id, signal)
        break
      } catch (error) {
        if (error instanceof DocumentNotFoundError) continue
        throw error
      }
    }
    if (input === undefined) {
      throw new DocumentNotFoundError(`document "${id}" not found`)
    }
    const record = projectDocument(input, previous)
    this.commit(record)
    return { record, content: input.content, source: input.source }
  }

  /** The current projection for a document, or `undefined`. */
  projection(id: DocumentId): DocumentRecord | undefined {
    const rows = this.driver.query<Record<string, unknown>>('SELECT * FROM documents WHERE id = ?', [id])
    return rows.length === 0 ? undefined : rowToRecord(rows[0]!)
  }

  /** The current monotonic version of a document (AC: version query). */
  getVersion(id: DocumentId): number | undefined {
    const rows = this.driver.query<{ version: number }>('SELECT version FROM documents WHERE id = ?', [id])
    return rows.length === 0 ? undefined : rows[0]!.version
  }

  /** Every projected document, in relative-path order. */
  list(): DocumentRecord[] {
    return this.driver.query<Record<string, unknown>>('SELECT * FROM documents ORDER BY relative_path').map(rowToRecord)
  }

  /**
   * Commit a WRITE projection (Issue 025): like the read-path commit, but
   * the knowledge index version is cleared — the document changed, so any
   * previously indexed chunks are stale until re-indexed.
   * @param record - the validated projection to persist.
   */
  commitWrite(record: DocumentRecord): void {
    this.commit({ ...record, indexedVersion: undefined })
  }

  private commit(record: DocumentRecord): void {
    this.driver.transaction(() => {
      this.driver.run(
        `INSERT INTO documents (id, relative_path, version, content_hash, media_type, size_bytes, indexed_version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           relative_path = excluded.relative_path,
           version = excluded.version,
           content_hash = excluded.content_hash,
           media_type = excluded.media_type,
           size_bytes = excluded.size_bytes,
           indexed_version = excluded.indexed_version,
           updated_at = excluded.updated_at`,
        [
          record.id,
          record.relativePath,
          record.version,
          record.contentHash,
          record.mediaType,
          record.sizeBytes,
          record.indexedVersion ?? null,
          record.updatedAt,
        ],
      )
    })
  }
}

function rowToRecord(row: Record<string, unknown>): DocumentRecord {
  return {
    id: DocumentId(String(row.id)),
    relativePath: String(row.relative_path),
    version: Number(row.version),
    contentHash: String(row.content_hash),
    mediaType: String(row.media_type) as SupportedMediaType,
    sizeBytes: Number(row.size_bytes),
    indexedVersion: row.indexed_version === null || row.indexed_version === undefined ? undefined : Number(row.indexed_version),
    updatedAt: String(row.updated_at),
  }
}

// Re-export the migration runner so consumers compose storage sets.
export { runMigrations }

declare module '@teoclub/cordis' {
  interface Context {
    /** The Documents service (Issue 016). */
    documents: DocumentsService
  }
}

export default DocumentsService
