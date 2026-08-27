/**
 * Rigo SQLite FTS5 Knowledge Provider (Issue 019; SPEC §3.6, §5.3, §8.2,
 * §8.3, §9.1; PRD US-008, FR-23, FR-24, D-004).
 *
 * The local knowledge backend over the Issue 007 storage foundation:
 *
 *   - `knowledge_chunks` (id, document_id FK -> documents, document_version,
 *     ordinal, title, body, location_json, UNIQUE(document_id,
 *     document_version, ordinal)) + the external-content FTS5 virtual table
 *     `knowledge_fts` (content='knowledge_chunks', content_rowid='id') +
 *     a small `knowledge_meta` table holding the persisted index version
 *     (SPEC §3.6, plus the version marker AC);
 *   - documents are chunked at a 1,000–2,000 Unicode Code Point target with
 *     200 code points of overlap (SPEC §5.3); empty documents index no
 *     chunks — no fabricated chunks (SPEC §5.8);
 *   - retrieval runs BM25 with the deterministic three-level tie-break
 *     (score, then document id, then chunk ordinal — SPEC §3.6), so the
 *     same index and query always produce the same order;
 *   - the provider's index version is a persisted monotonic counter bumped
 *     by every index mutation; every result carries `indexedVersion` and the
 *     chunk's `documentVersion`, and `indexDocuments` also refreshes the
 *     documents projection's `indexed_version`, so stale index data is
 *     explicitly marked (SPEC §5.8) — and an indexing failure never blocks
 *     document reads (reads go through the Documents service).
 *
 * Storage composition: the provider shares the DOCUMENTS database (the
 * chunk FK resolves against `documents(id)`), so the HOST runs the composed
 * migration set `[...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS]` on the
 * driver before constructing this provider (the migration framework verifies
 * every applied migration against the set it is given, so a single database
 * always migrates as one complete set). The provider pre-flights both the
 * `documents` table and the knowledge tables and fails fast with a
 * structured error when the host wired the database incompletely.
 *
 * @module @teoclub/shared-knowledge-sqlite-fts
 */

import {
  type StorageDriver,
  type StorageMigration,
} from '@teoclub/shared-storage-sqlite-node/definition'
import {
  SourceId,
  type KnowledgeProvider,
  type KnowledgeRequest,
  type KnowledgeResult,
  validateKnowledgeRequest,
} from '@teoclub/shared-knowledge'

// ---------------------------------------------------------------------------
// Schema (SPEC §3.6)
// ---------------------------------------------------------------------------

/**
 * Knowledge schema migrations. Version 2 because these tables live in the
 * documents database (version 1 = documents projection; the chunk FK
 * resolves against it). Run the documents migrations first on the same
 * driver.
 */
export const KNOWLEDGE_MIGRATIONS: StorageMigration[] = [
  {
    version: 2,
    name: 'knowledge-chunks-and-fts',
    sql: `
CREATE TABLE knowledge_chunks (
  id INTEGER PRIMARY KEY,
  document_id TEXT NOT NULL,
  document_version INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  location_json TEXT NOT NULL,
  UNIQUE(document_id, document_version, ordinal),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title,
  body,
  content='knowledge_chunks',
  content_rowid='id',
  tokenize='unicode61'
);

CREATE TABLE knowledge_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
]

// ---------------------------------------------------------------------------
// Chunking (SPEC §5.3: 1,000–2,000 code points, 200 overlap)
// ---------------------------------------------------------------------------

/** Smallest chunk target (SPEC §5.3). */
export const MIN_CHUNK_TARGET = 1000
/** Largest chunk target (SPEC §5.3). */
export const MAX_CHUNK_TARGET = 2000
/** Default chunk target (within the SPEC band). */
export const DEFAULT_CHUNK_TARGET = 1500
/** Default overlap between consecutive chunks (SPEC §5.3: 200). */
export const DEFAULT_CHUNK_OVERLAP = 200

/** One indexed chunk: 0-based ordinal plus code-point offsets into the document. */
export interface DocumentChunk {
  ordinal: number
  body: string
  /** Inclusive start offset, in Unicode code points. */
  start: number
  /** Exclusive end offset, in Unicode code points. */
  end: number
}

export interface ChunkingOptions {
  /** Chunk target in code points (default 1500, within 1,000–2,000). */
  target?: number
  /** Overlap in code points (default 200; must be below the target). */
  overlap?: number
}

/**
 * Split text into deterministic chunks measured in Unicode code points
 * (never UTF-16 units): stride = target - overlap. Empty text yields no
 * chunks (SPEC §5.8: no fabricated chunks); a document at or below the
 * target yields exactly one chunk.
 */
export function chunkDocument(text: string, options: ChunkingOptions = {}): DocumentChunk[] {
  const target = options.target ?? DEFAULT_CHUNK_TARGET
  const overlap = options.overlap ?? DEFAULT_CHUNK_OVERLAP
  if (!Number.isSafeInteger(target) || target < MIN_CHUNK_TARGET || target > MAX_CHUNK_TARGET) {
    throw new RangeError(`chunk target must be an integer between ${MIN_CHUNK_TARGET} and ${MAX_CHUNK_TARGET}, got ${String(target)}`)
  }
  if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap >= target) {
    throw new RangeError(`chunk overlap must be a non-negative integer below the target, got ${String(overlap)}`)
  }
  const points = Array.from(text)
  if (points.length === 0) return []
  if (points.length <= target) {
    return [{ ordinal: 0, body: text, start: 0, end: points.length }]
  }
  const stride = target - overlap
  const chunks: DocumentChunk[] = []
  for (let start = 0; start < points.length; start += stride) {
    const end = Math.min(start + target, points.length)
    chunks.push({ ordinal: chunks.length, body: points.slice(start, end).join(''), start, end })
    if (end === points.length) break
  }
  return chunks
}

// ---------------------------------------------------------------------------
// Indexing input and errors
// ---------------------------------------------------------------------------

/** One document to (re)index. Structural — no dependency on the Documents package. */
export interface KnowledgeIndexInput {
  /** The document's stable id (the workspace-relative path). */
  documentId: string
  /** The document's monotonic version at index time. */
  documentVersion: number
  /** Chunk title (the document title shared by every chunk). */
  title: string
  /** Full document body; chunked by {@link chunkDocument}. */
  body: string
  /** Media type (used for the retrieval filter; not stored per chunk). */
  mediaType?: string
}

/** Structured knowledge-indexing failure. */
export class KnowledgeIndexError extends Error {
  readonly code = 'INTERNAL_ERROR'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeIndexError'
  }
}

/** The persisted index-version meta key (SPEC §5.8 staleness marker). */
const INDEX_VERSION_KEY = 'index_version'

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export interface SqliteFtsKnowledgeProviderConfig {
  /**
   * The storage driver — MUST be the documents database (the chunk FK and
   * the `indexed_version` refresh resolve against `documents`).
   */
  driver: StorageDriver
}

/**
 * The local FTS5 knowledge provider. Register on the Issue 018 service via
 * `ctx.knowledge.registerProvider(provider)`; drive indexing through
 * {@link indexDocuments} / {@link deleteDocument} / {@link clear}.
 */
export class SqliteFtsKnowledgeProvider implements KnowledgeProvider {
  readonly name = 'sqlite-fts'
  readonly driver: StorageDriver

  constructor(config: SqliteFtsKnowledgeProviderConfig) {
    if (config?.driver === undefined) {
      throw new TypeError('sqlite-fts knowledge provider requires a storage driver')
    }
    this.driver = config.driver
    // Pre-flight the composed schema. The host runs the complete migration
    // set ([...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS]) before this
    // provider exists; a missing half is a wiring bug, not a lazy migration.
    const documents = this.driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'documents'",
    )
    if (documents.length === 0) {
      throw new KnowledgeIndexError(
        'the knowledge index requires the documents projection: run the documents migrations (version 1) on this driver first',
      )
    }
    const knowledge = this.driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_chunks'",
    )
    if (knowledge.length === 0) {
      throw new KnowledgeIndexError(
        'the knowledge tables are missing: run the composed migration set [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] on this driver first',
      )
    }
  }

  /** The persisted index version (0 = nothing indexed yet). */
  getIndexVersion(): number {
    const rows = this.driver.query<{ value: string }>(
      'SELECT value FROM knowledge_meta WHERE key = ?',
      [INDEX_VERSION_KEY],
    )
    const value = Number(rows[0]?.value ?? 0)
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  }

  /**
   * Index (or re-index) the given documents in ONE short transaction
   * (SPEC §8.3: batched FTS updates): each document's existing chunks are
   * replaced wholesale, the persisted index version bumps, and the
   * documents projection's `indexed_version` refreshes, so retrieval results
   * are explicitly marked with the version that produced them.
   * @param inputs - the documents to index.
   * @returns the index version after this mutation.
   */
  async indexDocuments(inputs: readonly KnowledgeIndexInput[]): Promise<number> {
    // Validate every input BEFORE any write so a bad row cannot partially
    // mutate the index inside the transaction.
    for (const input of inputs) this.assertIndexInput(input)
    return this.mutateIndex(() => {
      for (const input of inputs) {
        this.replaceDocumentChunks(input)
      }
    })
  }

  /**
   * Remove every chunk of one document and mark its projection unindexed.
   * @param documentId - the document to remove from the index.
   * @returns the index version after this mutation.
   */
  async deleteDocument(documentId: string): Promise<number> {
    return this.mutateIndex(() => {
      this.removeChunksForDocument(documentId)
      this.driver.run('UPDATE documents SET indexed_version = NULL WHERE id = ?', [documentId])
    })
  }

  /** Wipe the whole index (chunks + FTS + version counter). */
  async clear(): Promise<void> {
    this.driver.transaction(() => {
      this.removeAllChunks()
      this.driver.run('INSERT INTO knowledge_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
        INDEX_VERSION_KEY, '0',
      ])
    })
  }

  // -- KnowledgeProvider ---------------------------------------------------

  /**
   * Rank one query with BM25 and the deterministic tie-break (score,
   * document id, chunk ordinal — SPEC §3.6). The same index and query
   * always produce the same order.
   */
  async retrieve(request: KnowledgeRequest, signal?: AbortSignal): Promise<KnowledgeResult[]> {
    signal?.throwIfAborted()
    const validated = validateKnowledgeRequest(request)
    const terms = tokenizeQuery(validated.query)
    if (terms.length === 0) return []
    const indexVersion = this.getIndexVersion()

    const where: string[] = ['knowledge_fts MATCH ?']
    const params: unknown[] = [terms.join(' ')]
    if (validated.filter?.documentPath !== undefined) {
      where.push('kc.document_id = ?')
      params.push(validated.filter.documentPath)
    }
    if (validated.filter?.minDocumentVersion !== undefined) {
      where.push('kc.document_version >= ?')
      params.push(validated.filter.minDocumentVersion)
    }
    if (validated.filter?.mediaTypes !== undefined) {
      where.push(`d.media_type IN (${validated.filter.mediaTypes.map(() => '?').join(', ')})`)
      params.push(...validated.filter.mediaTypes)
    }
    params.push(validated.topK)

    const sql = `
      SELECT kc.document_id, kc.document_version, kc.ordinal, kc.title, kc.body, kc.location_json,
             d.media_type
      FROM knowledge_fts
      JOIN knowledge_chunks kc ON kc.id = knowledge_fts.rowid
      LEFT JOIN documents d ON d.id = kc.document_id
      WHERE ${where.join(' AND ')}
      ORDER BY bm25(knowledge_fts) ASC, kc.document_id ASC, kc.ordinal ASC
      LIMIT ?
    `
    const rows = this.driver.query<Record<string, unknown>>(sql, params)
    return rows.map((row) => ({
      sourceId: SourceId(String(row.document_id)),
      title: String(row.title),
      snippet: String(row.body),
      documentVersion: Number(row.document_version),
      locator: JSON.stringify({
        ordinal: Number(row.ordinal),
        ...(JSON.parse(String(row.location_json)) as { start: number; end: number }),
      }),
      indexedVersion: indexVersion,
      ...(row.media_type === null || row.media_type === undefined ? {} : { mediaType: String(row.media_type) }),
    }))
  }

  // -- internals -----------------------------------------------------------

  private mutateIndex(mutate: () => void): number {
    let version = 0
    try {
      this.driver.transaction(() => {
        mutate()
        const next = this.getIndexVersion() + 1
        this.driver.run('INSERT INTO knowledge_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [
          INDEX_VERSION_KEY, String(next),
        ])
        version = next
      })
    } catch (error) {
      throw new KnowledgeIndexError(
        `knowledge index mutation failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    return version
  }

  private assertIndexInput(input: KnowledgeIndexInput): void {
    if (input === null || typeof input !== 'object') {
      throw new KnowledgeIndexError('knowledge index input must be an object')
    }
    if (typeof input.documentId !== 'string' || input.documentId.length === 0) {
      throw new KnowledgeIndexError('knowledge index input documentId must be a non-empty string')
    }
    if (!Number.isSafeInteger(input.documentVersion) || input.documentVersion < 1) {
      throw new KnowledgeIndexError(`knowledge index input documentVersion must be a positive integer, got ${String(input.documentVersion)}`)
    }
    if (typeof input.title !== 'string') {
      throw new KnowledgeIndexError('knowledge index input title must be a string')
    }
    if (typeof input.body !== 'string') {
      throw new KnowledgeIndexError('knowledge index input body must be a string')
    }
  }

  private replaceDocumentChunks(input: KnowledgeIndexInput): void {
    this.removeChunksForDocument(input.documentId)
    const chunks = chunkDocument(input.body)
    for (const chunk of chunks) {
      const location = JSON.stringify({ start: chunk.start, end: chunk.end })
      const inserted = this.driver.run(
        `INSERT INTO knowledge_chunks (document_id, document_version, ordinal, title, body, location_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.documentId, input.documentVersion, chunk.ordinal, input.title, chunk.body, location],
      )
      const id = Number(inserted.lastInsertRowid)
      // External-content FTS5: the index receives the rowid + the exact
      // content values it indexes (SPEC §3.6 content_rowid='id').
      this.driver.run('INSERT INTO knowledge_fts (rowid, title, body) VALUES (?, ?, ?)', [id, input.title, chunk.body])
    }
    this.driver.run('UPDATE documents SET indexed_version = ? WHERE id = ?', [this.getIndexVersion() + 1, input.documentId])
  }

  /** Remove one document's chunks and their FTS entries (external-content delete command). */
  private removeChunksForDocument(documentId: string): void {
    const old = this.driver.query<{ id: number; title: string; body: string }>(
      'SELECT id, title, body FROM knowledge_chunks WHERE document_id = ?',
      [documentId],
    )
    for (const row of old) {
      this.driver.run("INSERT INTO knowledge_fts (knowledge_fts, rowid, title, body) VALUES ('delete', ?, ?, ?)", [
        row.id, row.title, row.body,
      ])
    }
    this.driver.run('DELETE FROM knowledge_chunks WHERE document_id = ?', [documentId])
  }

  private removeAllChunks(): void {
    const old = this.driver.query<{ id: number; title: string; body: string }>(
      'SELECT id, title, body FROM knowledge_chunks ORDER BY id',
    )
    for (const row of old) {
      this.driver.run("INSERT INTO knowledge_fts (knowledge_fts, rowid, title, body) VALUES ('delete', ?, ?, ?)", [
        row.id, row.title, row.body,
      ])
    }
    this.driver.run('DELETE FROM knowledge_chunks')
    this.driver.run('UPDATE documents SET indexed_version = NULL')
  }
}

/** Deterministic FTS5 term tokenization: lowercase Unicode words. */
export function tokenizeQuery(query: string): string[] {
  const tokens = Array.from(query.toLowerCase().matchAll(/[\p{L}\p{N}_]+/gu), (match) => match[0])
  // Double quotes make every term a literal phrase, so user punctuation can
  // never alter the FTS5 query grammar; joining with spaces is an implicit
  // AND. De-duplication keeps the MATCH string canonical.
  return [...new Set(tokens)].map((token) => `"${token}"`)
}

export default SqliteFtsKnowledgeProvider
