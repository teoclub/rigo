import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import DocumentsService, {
  DOCUMENTS_MIGRATIONS,
  DocumentId,
  DocumentNotFoundError,
  DocumentValidationError,
  MAX_DOCUMENT_SIZE_BYTES,
  projectDocument,
  SUPPORTED_MEDIA_TYPES,
  type DocumentInput,
  type DocumentProvider,
} from '@teoclub/work-documents'

/**
 * Issue 016: Documents Service Definition (SPEC §3.5, §2.4; PRD US-009,
 * FR-25, D-008): stable read/version/provider interfaces, the documents
 * table with the unique relative-path constraint, the full projection
 * fields, the MVP media allowlist, the 5 MiB ceiling, monotonic versioning,
 * and full decoupling from any filesystem provider.
 *
 * The pure validation/versioning rules are runtime-agnostic (dual Node/Bun);
 * the storage-backed service projection uses node:sqlite, so that part is
 * skipped under Bun.
 */

const isBun = typeof Bun !== 'undefined'

class MemoryDocumentProvider implements DocumentProvider {
  readonly name: string
  constructor(name: string, private readonly store: Map<string, DocumentInput>) {
    this.name = name
  }

  async read(id: string): Promise<DocumentInput> {
    const input = this.store.get(id)
    if (input === undefined) throw new DocumentNotFoundError(`document "${id}" not found`)
    return input
  }
}

function input(id: string, relativePath: string, content: string, source = `/workspace/${relativePath}`): DocumentInput {
  return { id: DocumentId(id), relativePath, content, source }
}

describe('Rigo documents service (Issue 016)', () => {
  describe.skipIf(isBun)('service projection (node:sqlite-backed)', () => {
    async function harness(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
      const ctx = new Context()
      const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
      await ctx.plugin(DocumentsService, {
        openStorage: () => new NodeSqliteDriver(':memory:'),
      })
      return { ctx, dispose: () => ctx.fiber.dispose() }
    }

    it('registers providers and exposes stable read/version/list interfaces', async () => {
      const { ctx, dispose } = await harness()
      try {
        const store = new Map<string, DocumentInput>([
          ['doc-1', input('doc-1', 'notes.md', '# Notes')],
          ['doc-2', input('doc-2', 'todo.txt', 'buy milk')],
        ])
        const provider = new MemoryDocumentProvider('memory', store)
        const revoke = ctx.documents.registerProvider(provider)
        expect(ctx.documents.listProviders()).toEqual(['memory'])

        await ctx.documents.read(DocumentId('doc-2'))
        const content = await ctx.documents.read(DocumentId('doc-1'))
        expect(content.content).toBe('# Notes')
        expect(content.source).toBe('/workspace/notes.md')
        expect(content.record).toMatchObject({
          id: 'doc-1',
          relativePath: 'notes.md',
          version: 1,
          mediaType: 'text/markdown',
          sizeBytes: '# Notes'.length,
          indexedVersion: undefined,
        })
        expect(content.record.contentHash).toHaveLength(64)
        expect(ctx.documents.getVersion(DocumentId('doc-1'))).toBe(1)
        expect(ctx.documents.getVersion(DocumentId('doc-missing'))).toBeUndefined()
        expect(ctx.documents.list().map((record) => record.relativePath)).toEqual(['notes.md', 'todo.txt'])

        // Unload removes the provider: reads become NOT_FOUND.
        revoke()
        expect(ctx.documents.listProviders()).toEqual([])
        await expect(ctx.documents.read(DocumentId('doc-1'))).rejects.toThrowError(DocumentNotFoundError)
      } finally {
        await dispose()
      }
    })

    it('creates the SPEC §3.5 documents table with the unique relative-path constraint', async () => {
      const { NodeSqliteDriver: Driver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
      const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
      const driver = new Driver(':memory:')
      try {
        runMigrations(driver, { migrations: DOCUMENTS_MIGRATIONS })
        const columns = driver.query<{ name: string }>('PRAGMA table_info(documents)').map((row) => row.name)
        expect(columns).toEqual([
          'id', 'relative_path', 'version', 'content_hash', 'media_type', 'size_bytes', 'indexed_version', 'updated_at',
        ])
        driver.run(
          `INSERT INTO documents (id, relative_path, version, content_hash, media_type, size_bytes, updated_at)
           VALUES ('a', 'same.md', 1, 'h', 'text/markdown', 1, 't')`,
        )
        // The UNIQUE relative-path constraint rejects a second row for the path.
        expect(() => driver.run(
          `INSERT INTO documents (id, relative_path, version, content_hash, media_type, size_bytes, updated_at)
           VALUES ('b', 'same.md', 1, 'h', 'text/markdown', 1, 't')`,
        )).toThrow()
      } finally {
        driver.close()
      }
    })

    it('accepts only the MVP media types through the service', async () => {
      const { ctx, dispose } = await harness()
      try {
        const store = new Map<string, DocumentInput>([
          ['md', input('md', 'readme.md', 'md')],
          ['txt', input('txt', 'notes.txt', 'txt')],
          ['pdf', input('pdf', 'guide.pdf', 'pdf')],
          ['none', input('none', 'noext', 'none')],
        ])
        ctx.documents.registerProvider(new MemoryDocumentProvider('memory', store))
        expect((await ctx.documents.read(DocumentId('md'))).record.mediaType).toBe('text/markdown')
        expect((await ctx.documents.read(DocumentId('txt'))).record.mediaType).toBe('text/plain')
        await expect(ctx.documents.read(DocumentId('pdf'))).rejects.toThrowError(DocumentValidationError)
        await expect(ctx.documents.read(DocumentId('none'))).rejects.toThrow(/unsupported media type/)
      } finally {
        await dispose()
      }
    })

    it('bumps the version monotonically only when the content hash changes', async () => {
      const { ctx, dispose } = await harness()
      try {
        const store = new Map<string, DocumentInput>([
          ['doc', input('doc', 'journal.md', 'v1 content')],
        ])
        ctx.documents.registerProvider(new MemoryDocumentProvider('memory', store))

        await ctx.documents.read(DocumentId('doc'))
        expect(ctx.documents.getVersion(DocumentId('doc'))).toBe(1)
        // Unchanged content: same hash, same version.
        await ctx.documents.read(DocumentId('doc'))
        expect(ctx.documents.getVersion(DocumentId('doc'))).toBe(1)

        store.set('doc', input('doc', 'journal.md', 'v2 content'))
        await ctx.documents.read(DocumentId('doc'))
        expect(ctx.documents.getVersion(DocumentId('doc'))).toBe(2)

        store.set('doc', input('doc', 'journal.md', 'v3 content'))
        await ctx.documents.read(DocumentId('doc'))
        expect(ctx.documents.getVersion(DocumentId('doc'))).toBe(3)
      } finally {
        await dispose()
      }
    })
  })

  // --- runtime-agnostic pure rules ---

  it('accepts only the MVP media types (pure rule)', () => {
    expect(SUPPORTED_MEDIA_TYPES).toEqual(['text/markdown', 'text/plain'])
    expect(projectDocument(input('a', 'readme.md', 'md'), undefined).mediaType).toBe('text/markdown')
    expect(projectDocument(input('b', 'notes.markdown', 'md'), undefined).mediaType).toBe('text/markdown')
    expect(projectDocument(input('c', 'notes.txt', 'txt'), undefined).mediaType).toBe('text/plain')
    expect(() => projectDocument(input('d', 'guide.pdf', 'pdf'), undefined)).toThrowError(DocumentValidationError)
    expect(() => projectDocument(input('e', 'noext', 'x'), undefined)).toThrow(/unsupported media type/)
    // Workspace-relative path discipline.
    expect(() => projectDocument(input('f', '/absolute.md', 'x'), undefined)).toThrow(/workspace-relative/)
    expect(() => projectDocument(input('g', '../escape.md', 'x'), undefined)).toThrow(/workspace-relative/)
  })

  it('rejects documents above the 5 MiB ceiling with a structured error', () => {
    const small = 'x'.repeat(1024)
    const record = projectDocument(input('small', 'small.md', small), undefined)
    expect(record.sizeBytes).toBe(1024)
    expect(record.version).toBe(1)

    const oversized = 'x'.repeat(MAX_DOCUMENT_SIZE_BYTES + 1)
    expect(() => projectDocument(input('big', 'big.md', oversized), undefined))
      .toThrowError(DocumentValidationError)
    try {
      projectDocument(input('big', 'big.md', oversized), undefined)
    } catch (error) {
      expect((error as DocumentValidationError).code).toBe('DOCUMENT_VALIDATION_FAILED')
      expect((error as DocumentValidationError).message).toContain('5 MiB')
    }
  })

  it('bumps the version monotonically only on content change (pure rule)', () => {
    const first = projectDocument(input('doc', 'journal.md', 'v1'), undefined)
    expect(first.version).toBe(1)
    // Unchanged hash keeps the version.
    expect(projectDocument(input('doc', 'journal.md', 'v1'), first).version).toBe(1)
    // Any content change bumps exactly once per change.
    const second = projectDocument(input('doc', 'journal.md', 'v2'), first)
    expect(second.version).toBe(2)
    expect(projectDocument(input('doc', 'journal.md', 'v3'), second).version).toBe(3)
  })

  it('stays decoupled from the filesystem: any provider implements the contract', async () => {
    const source = readFileSync(new URL('../../packages/work/documents/src/index.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/node:fs/)
    // A non-filesystem provider satisfies the contract shape.
    const apiProvider: DocumentProvider = {
      name: 'remote-api',
      read: async (id) => {
        if (String(id) !== 'api-doc') throw new DocumentNotFoundError(`document "${id}" not found`)
        return input('api-doc', 'api.md', 'from the api')
      },
    }
    expect(apiProvider.name).toBe('remote-api')
  })
})
