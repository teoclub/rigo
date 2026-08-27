/**
 * Issue 019 integration: SQLite FTS5 Knowledge Provider (SPEC §3.6, §5.3,
 * §5.8, §8.2, §9.1; PRD US-008, FR-23, FR-24, D-004).
 *
 * The chunking/tokenization rules are dual-runtime; everything touching the
 * SQLite index is Node-only (node:sqlite, lazy imports inside each test).
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  chunkDocument,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_TARGET,
  MIN_CHUNK_TARGET,
  MAX_CHUNK_TARGET,
  tokenizeQuery,
} from '@teoclub/shared-knowledge-sqlite-fts'

const isBun = typeof Bun !== 'undefined'

describe('knowledge chunking and query tokenization (Issue 019)', () => {
  it('chunks at the 1,000–2,000 code-point target with 200-point overlap', () => {
    // An empty document produces no chunks (no fabricated chunks).
    expect(chunkDocument('')).toEqual([])
    // A short document is a single whole-text chunk.
    expect(chunkDocument('hello')).toEqual([{ ordinal: 0, body: 'hello', start: 0, end: 5 }])
    // A long document: stride = target - overlap.
    const text = 'a'.repeat(4000)
    const chunks = chunkDocument(text)
    expect(chunks.length).toBe(3)
    expect(chunks[0]!.body.length).toBe(1500)
    expect(chunks[0]).toEqual({ ordinal: 0, body: 'a'.repeat(1500), start: 0, end: 1500 })
    // Second chunk starts 1300 code points in (1500 - 200 overlap).
    expect(chunks[1]!.start).toBe(1300)
    expect(chunks[1]!.end).toBe(2800)
    expect(chunks[2]!.start).toBe(2600)
    expect(chunks[2]!.end).toBe(4000)
    // Overlap is real: the tail of chunk 0 reappears at the head of chunk 1.
    expect(chunks[0]!.body.slice(-200)).toBe(chunks[1]!.body.slice(0, 200))
    // Reassembling chunk bodies in order covers the full text (with overlap).
    expect(chunks.map((chunk) => chunk.body).join('').length).toBeGreaterThan(text.length)
  })

  it('counts Unicode code points, never UTF-16 units', () => {
    // 4000 astral-plane emoji: UTF-16 length is 8000, code points 4000.
    const text = '😀'.repeat(4000)
    const chunks = chunkDocument(text)
    expect(Array.from(chunks[0]!.body)).toHaveLength(1500) // 1500 code points
    expect(chunks[0]!.end).toBe(1500)
    // Mixed astral + BMP text keeps offsets in code points.
    const mixed = 'a😀b'.repeat(600)
    const mixedChunks = chunkDocument(mixed)
    expect(mixedChunks[0]!.end).toBe(1500)
    expect(Array.from(mixed).slice(0, 1500).join('')).toBe(mixedChunks[0]!.body)
  })

  it('is deterministic: the same text always chunks identically', () => {
    const text = 'deterministic '.repeat(300)
    const first = chunkDocument(text)
    for (let i = 0; i < 5; i += 1) {
      expect(chunkDocument(text)).toEqual(first)
    }
  })

  it('validates chunking options', () => {
    expect(() => chunkDocument('x'.repeat(3000), { target: MIN_CHUNK_TARGET - 1 })).toThrow(RangeError)
    expect(() => chunkDocument('x'.repeat(3000), { target: MAX_CHUNK_TARGET + 1 })).toThrow(RangeError)
    expect(() => chunkDocument('x'.repeat(3000), { target: DEFAULT_CHUNK_TARGET, overlap: DEFAULT_CHUNK_TARGET })).toThrow(RangeError)
    expect(() => chunkDocument('x'.repeat(3000), { target: DEFAULT_CHUNK_TARGET, overlap: -1 })).toThrow(RangeError)
  })

  it('tokenizes queries deterministically and grammar-safely', () => {
    expect(tokenizeQuery('Rocket Science')).toEqual(['"rocket"', '"science"'])
    // Punctuation can never alter the FTS5 grammar.
    expect(tokenizeQuery('c++ "quoted" (parens) OR')).toEqual(['"c"', '"quoted"', '"parens"', '"or"'])
    // Repeated terms collapse; empty input yields no terms.
    expect(tokenizeQuery('rocket rocket launch')).toEqual(['"rocket"', '"launch"'])
    expect(tokenizeQuery('!!! ???')).toEqual([])
    // Unicode words survive.
    expect(tokenizeQuery('中文 检索')).toEqual(['"中文"', '"检索"'])
  })
})

// ---------------------------------------------------------------------------
// SQLite-backed provider (Node-only)
// ---------------------------------------------------------------------------
describe.skipIf(isBun)('sqlite-fts knowledge provider (Node)', () => {
  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rigo-knowledge-fts-'))
  }

  function openDriver(): { driver: import('@teoclub/shared-storage-sqlite-node/node').NodeSqliteDriver; dir: string } {
    const dir = tempDir()
    return { driver: new (requireNodeDriver())(join(dir, 'rigo.sqlite')), dir }
  }

  /** Lazy Node driver accessor — the import never executes under Bun. */
  function requireNodeDriver(): typeof import('@teoclub/shared-storage-sqlite-node/node').NodeSqliteDriver {
    throw new Error('unreachable: replaced at test level')
  }

  /** Insert a projected document row so chunk FKs resolve. */
  function seedDocument(
    driver: import('@teoclub/shared-storage-sqlite-node/node').NodeSqliteDriver,
    id: string,
    version = 1,
    mediaType = 'text/markdown',
  ): void {
    driver.run(
      `INSERT INTO documents (id, relative_path, version, content_hash, media_type, size_bytes, indexed_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      [id, id, version, 'hash-' + id, mediaType, 1, new Date().toISOString()],
    )
  }

  it('pre-flights the documents projection and creates the SPEC §3.6 schema', async () => {
    const { default: SqliteFtsKnowledgeProvider, KnowledgeIndexError, KNOWLEDGE_MIGRATIONS } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const { DOCUMENTS_MIGRATIONS } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const dir = tempDir()
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    try {
      // On an empty database the provider fails fast (no documents table).
      expect(() => new SqliteFtsKnowledgeProvider({ driver })).toThrowError(KnowledgeIndexError)
      // Documents alone is still incomplete: the host must compose the set.
      runMigrations(driver, { migrations: DOCUMENTS_MIGRATIONS })
      expect(() => new SqliteFtsKnowledgeProvider({ driver })).toThrowError(KnowledgeIndexError)
      // The composed set lands the full SPEC §3.6 schema.
      runMigrations(driver, { migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      const provider = new SqliteFtsKnowledgeProvider({ driver })
      expect(provider.name).toBe('sqlite-fts')
      expect(provider.getIndexVersion()).toBe(0)
      const tables = driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name IN ('knowledge_chunks', 'knowledge_fts', 'knowledge_meta')",
      )
      expect(tables.map((row) => row.name).sort()).toEqual(['knowledge_chunks', 'knowledge_fts', 'knowledge_meta'])
      // The unique constraint is enforced…
      seedDocument(driver, 'doc-a')
      await provider.indexDocuments([{ documentId: 'doc-a', documentVersion: 1, title: 'A', body: 'x' }])
      expect(() => driver.run('INSERT INTO knowledge_chunks (document_id, document_version, ordinal, title, body, location_json) VALUES (?, ?, ?, ?, ?, ?)', ['doc-a', 1, 0, 'A', 'x', '{}']))
        .toThrow(/UNIQUE/i)
      // …and so is the documents foreign key.
      expect(() => driver.run('INSERT INTO knowledge_chunks (document_id, document_version, ordinal, title, body, location_json) VALUES (?, ?, ?, ?, ?, ?)', ['ghost', 1, 0, 'A', 'x', '{}']))
        .toThrow(/FOREIGN KEY/i)
    } finally {
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('indexes documents into chunks and retrieves with BM25 + deterministic tie-break', async () => {
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const { default: SqliteFtsKnowledgeProvider } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { KNOWLEDGE_MIGRATIONS } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { DOCUMENTS_MIGRATIONS } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const dir = tempDir()
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    try {
      runMigrations(driver, { migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      const provider = new SqliteFtsKnowledgeProvider({ driver })
      seedDocument(driver, 'notes/rockets.md')
      seedDocument(driver, 'notes/plants.md')
      seedDocument(driver, 'guide/rockets-guide.md')
      await provider.indexDocuments([
        { documentId: 'notes/rockets.md', documentVersion: 1, title: 'Rocket Notes', body: 'rocket science launches rockets into space. rocket fuel burns.' },
        { documentId: 'notes/plants.md', documentVersion: 1, title: 'Plant Notes', body: 'plants need water and sunlight to grow.' },
        { documentId: 'guide/rockets-guide.md', documentVersion: 3, title: 'Rocket Guide', body: 'a complete guide to rocket engines and rocket science.' },
      ])
      expect(provider.getIndexVersion()).toBe(1)

      // Every chunk row stores document id, version, ordinal, title, body, location.
      const chunkRows = driver.query<Record<string, unknown>>('SELECT document_id, document_version, ordinal, title, body, location_json FROM knowledge_chunks ORDER BY document_id, ordinal')
      expect(chunkRows).toHaveLength(3)
      expect(chunkRows[0]).toMatchObject({ document_id: 'guide/rockets-guide.md', document_version: 3, ordinal: 0, title: 'Rocket Guide' })
      const guideLocation = JSON.parse(String(chunkRows[0]!.location_json)) as { start: number; end: number }
      expect(guideLocation.start).toBe(0)
      expect(guideLocation.end).toBe(String(chunkRows[0]!.body).length)

      const results = await provider.retrieve({ query: 'rocket' })
      // Both rocket docs match; BM25 owns the exact score ordering, the
      // contract guarantees the order is STABLE for the same index+query.
      expect(results.map((result) => result.sourceId).sort()).toEqual([
        'guide/rockets-guide.md',
        'notes/rockets.md',
      ])
      const rocket = results.find((result) => result.sourceId === 'notes/rockets.md')!
      expect(rocket.title).toBe('Rocket Notes')
      expect(rocket.snippet).toContain('rocket science')
      expect(rocket.documentVersion).toBe(1)
      expect(JSON.parse(rocket.locator)).toMatchObject({ ordinal: 0 })
      expect(rocket.indexedVersion).toBe(1)
      expect(rocket.mediaType).toBe('text/markdown')

      // The same query is byte-identical across repeats.
      const again = await provider.retrieve({ query: 'rocket' })
      expect(again.map((result) => result.sourceId)).toEqual(results.map((result) => result.sourceId))

      // Deterministic tie-break: identical score → document id, then ordinal.
      seedDocument(driver, 'a.md')
      seedDocument(driver, 'b.md')
      await provider.indexDocuments([
        { documentId: 'a.md', documentVersion: 1, title: 'A', body: 'unique term here' },
        { documentId: 'b.md', documentVersion: 1, title: 'B', body: 'unique term there' },
      ])
      const tied = await provider.retrieve({ query: 'unique term' })
      expect(tied.map((result) => result.sourceId)).toEqual(['a.md', 'b.md'])
      for (let i = 0; i < 3; i += 1) {
        expect((await provider.retrieve({ query: 'unique term' })).map((r) => r.sourceId)).toEqual(['a.md', 'b.md'])
      }

      // Empty token queries and no-match queries return empty collections.
      expect(await provider.retrieve({ query: '!!!' })).toEqual([])
      expect(await provider.retrieve({ query: 'zzzqqq' })).toEqual([])
    } finally {
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('updates and deletes documents from the index with version marking', async () => {
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const { default: SqliteFtsKnowledgeProvider } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { KNOWLEDGE_MIGRATIONS } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { DOCUMENTS_MIGRATIONS } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const dir = tempDir()
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    try {
      runMigrations(driver, { migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      const provider = new SqliteFtsKnowledgeProvider({ driver })
      seedDocument(driver, 'doc.md')
      await provider.indexDocuments([{ documentId: 'doc.md', documentVersion: 1, title: 'Doc', body: 'alpha beta' }])
      expect(provider.getIndexVersion()).toBe(1)
      expect(driver.query<{ indexed_version: number | null }>('SELECT indexed_version FROM documents WHERE id = ?', ['doc.md'])[0]!.indexed_version).toBe(1)

      // Update: the document moves to version 2 with different content.
      driver.run('UPDATE documents SET version = 2 WHERE id = ?', ['doc.md'])
      await provider.indexDocuments([{ documentId: 'doc.md', documentVersion: 2, title: 'Doc', body: 'gamma delta' }])
      expect(provider.getIndexVersion()).toBe(2)
      const rows = driver.query<{ document_version: number; body: string }>('SELECT document_version, body FROM knowledge_chunks WHERE document_id = ?', ['doc.md'])
      expect(rows).toHaveLength(1)
      expect(rows[0]).toEqual({ document_version: 2, body: 'gamma delta' })
      expect(await provider.retrieve({ query: 'alpha' })).toEqual([])
      expect((await provider.retrieve({ query: 'gamma' }))[0]!.documentVersion).toBe(2)
      // The projection's index marker follows the index version.
      expect(driver.query<{ indexed_version: number | null }>('SELECT indexed_version FROM documents WHERE id = ?', ['doc.md'])[0]!.indexed_version).toBe(2)

      // Staleness marking: the document moves to version 3 but the index is
      // not refreshed — retrieval still works and the result is explicitly
      // marked with the indexed version (SPEC §5.8).
      driver.run('UPDATE documents SET version = 3 WHERE id = ?', ['doc.md'])
      const stale = await provider.retrieve({ query: 'gamma' })
      expect(stale[0]!.documentVersion).toBe(2)
      expect(stale[0]!.indexedVersion).toBe(2)

      // Delete: chunks vanish and the projection marker clears.
      await provider.deleteDocument('doc.md')
      expect(driver.query('SELECT count(*) AS c FROM knowledge_chunks WHERE document_id = ?', ['doc.md'])[0]!.c).toBe(0)
      expect(await provider.retrieve({ query: 'gamma' })).toEqual([])
      expect(driver.query<{ indexed_version: number | null }>('SELECT indexed_version FROM documents WHERE id = ?', ['doc.md'])[0]!.indexed_version).toBeNull()
      expect(provider.getIndexVersion()).toBe(3)
    } finally {
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies documentPath, minDocumentVersion and mediaTypes filters', async () => {
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const { default: SqliteFtsKnowledgeProvider } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { KNOWLEDGE_MIGRATIONS } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { DOCUMENTS_MIGRATIONS } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const dir = tempDir()
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    try {
      runMigrations(driver, { migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      const provider = new SqliteFtsKnowledgeProvider({ driver })
      seedDocument(driver, 'docs/a.md', 1)
      seedDocument(driver, 'docs/b.md', 2, 'text/plain')
      await provider.indexDocuments([
        { documentId: 'docs/a.md', documentVersion: 1, title: 'A', body: 'shared keyword' },
        { documentId: 'docs/b.md', documentVersion: 2, title: 'B', body: 'shared keyword' },
      ])
      expect(await provider.retrieve({ query: 'shared' })).toHaveLength(2)
      expect((await provider.retrieve({ query: 'shared', filter: { documentPath: 'docs/a.md' } })).map((r) => r.sourceId)).toEqual(['docs/a.md'])
      expect((await provider.retrieve({ query: 'shared', filter: { minDocumentVersion: 2 } })).map((r) => r.sourceId)).toEqual(['docs/b.md'])
      expect((await provider.retrieve({ query: 'shared', filter: { mediaTypes: ['text/plain'] } })).map((r) => r.sourceId)).toEqual(['docs/b.md'])
      expect(await provider.retrieve({ query: 'shared', filter: { mediaTypes: ['text/html'] } })).toEqual([])
    } finally {
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('indexes empty documents without fabricated chunks and clears the index', async () => {
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const { default: SqliteFtsKnowledgeProvider } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { KNOWLEDGE_MIGRATIONS } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { DOCUMENTS_MIGRATIONS } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const dir = tempDir()
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    try {
      runMigrations(driver, { migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      const provider = new SqliteFtsKnowledgeProvider({ driver })
      seedDocument(driver, 'empty.md')
      await provider.indexDocuments([{ documentId: 'empty.md', documentVersion: 1, title: 'Empty', body: '' }])
      expect(driver.query('SELECT count(*) AS c FROM knowledge_chunks')[0]!.c).toBe(0)
      expect(await provider.retrieve({ query: 'anything' })).toEqual([])

      seedDocument(driver, 'full.md')
      await provider.indexDocuments([{ documentId: 'full.md', documentVersion: 1, title: 'Full', body: 'real content here' }])
      expect(await provider.retrieve({ query: 'real' })).toHaveLength(1)
      await provider.clear()
      expect(driver.query('SELECT count(*) AS c FROM knowledge_chunks')[0]!.c).toBe(0)
      expect(await provider.retrieve({ query: 'real' })).toEqual([])
      expect(provider.getIndexVersion()).toBe(0)
    } finally {
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps document reads working when indexing fails (SPEC §6.3)', async () => {
    const { default: SqliteFtsKnowledgeProvider, KnowledgeIndexError } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const { KNOWLEDGE_MIGRATIONS } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { DOCUMENTS_MIGRATIONS, DocumentId, DocumentsService } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const { LocalDocumentProvider } = await import('@teoclub/work-documents-local') as typeof import('@teoclub/work-documents-local')
    const { Context } = await import('@teoclub/cordis') as typeof import('@teoclub/cordis')
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'guide.md'), '# Guide\n\nHello world.\n')
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    const ctx = new Context()
    try {
      runMigrations(driver, { migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      await ctx.plugin(DocumentsService, { driver, migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      ctx.documents.registerProvider(new LocalDocumentProvider({ root }))
      // The document reads and indexes fine.
      const content = await ctx.documents.read(DocumentId('guide.md'))
      expect(content.record.version).toBe(1)
      const provider = new SqliteFtsKnowledgeProvider({ driver })
      await provider.indexDocuments([{ documentId: 'guide.md', documentVersion: 1, title: 'Guide', body: content.content }])
      expect(await provider.retrieve({ query: 'hello' })).toHaveLength(1)
      // A failing index mutation (bad input) rejects…
      await expect(provider.indexDocuments([{ documentId: 'guide.md', documentVersion: 0, title: 'x', body: 'y' }]))
        .rejects.toThrowError(KnowledgeIndexError)
      // …but document reads are unaffected.
      const again = await ctx.documents.read(DocumentId('guide.md'))
      expect(again.content).toBe('# Guide\n\nHello world.\n')
      expect(ctx.documents.getVersion(DocumentId('guide.md'))).toBe(1)
    } finally {
      await ctx.fiber.dispose() // DocumentsService owns (and closes) the driver
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('serves retrievals through the Issue 018 knowledge service', async () => {
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const { default: SqliteFtsKnowledgeProvider } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { KNOWLEDGE_MIGRATIONS } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { DOCUMENTS_MIGRATIONS } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const { KnowledgeService } = await import('@teoclub/shared-knowledge') as typeof import('@teoclub/shared-knowledge')
    const { Context } = await import('@teoclub/cordis') as typeof import('@teoclub/cordis')
    const dir = tempDir()
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    const ctx = new Context()
    try {
      runMigrations(driver, { migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      const provider = new SqliteFtsKnowledgeProvider({ driver })
      seedDocument(driver, 'doc.md')
      await provider.indexDocuments([{ documentId: 'doc.md', documentVersion: 1, title: 'Doc', body: 'needle in the haystack' }])
      await ctx.plugin(KnowledgeService)
      ctx.knowledge.registerProvider(provider)
      const results = await ctx.knowledge.retrieve({ query: 'needle' })
      expect(results).toHaveLength(1)
      expect(results[0]!.sourceId).toBe('doc.md')
      // The service enforces the query contract on top of the provider.
      await expect(ctx.knowledge.retrieve({ query: '' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
      await expect(ctx.knowledge.retrieve({ query: 'needle', topK: 0 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('queries the 10,000-document reference set with p95 under 200 ms (SPEC §8.2)', async () => {
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const { default: SqliteFtsKnowledgeProvider } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { KNOWLEDGE_MIGRATIONS } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { DOCUMENTS_MIGRATIONS } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const dir = tempDir()
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    try {
      runMigrations(driver, { migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      const provider = new SqliteFtsKnowledgeProvider({ driver })
      // 10,000 documents × 2 chunks each — the SPEC §8.1 reference scale.
      const words = ['rocket', 'engine', 'fuel', 'orbit', 'launch', 'thrust', 'payload', 'booster', 'telemetry', 'reentry']
      const documents: { documentId: string; documentVersion: number; title: string; body: string }[] = []
      for (let i = 0; i < 10000; i += 1) {
        const id = `docs/doc-${String(i).padStart(5, '0')}.md`
        seedDocument(driver, id, 1)
        documents.push({
          documentId: id,
          documentVersion: 1,
          title: `Doc ${i}`,
          body: `${words[i % words.length]} ${words[(i + 3) % words.length]} ${words[(i + 7) % words.length]} `.repeat(120),
        })
      }
      await provider.indexDocuments(documents)
      const expectedChunks = documents.reduce((total, doc) => total + chunkDocument(doc.body).length, 0)
      expect(driver.query('SELECT count(*) AS c FROM knowledge_chunks')[0]!.c).toBe(expectedChunks)

      const samples: number[] = []
      for (let i = 0; i < 10; i += 1) {
        const start = performance.now()
        await provider.retrieve({ query: words[i % words.length], topK: 8 })
        samples.push(performance.now() - start)
      }
      samples.sort((a, b) => a - b)
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1]!
      expect(p95).toBeLessThan(200)
    } finally {
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
