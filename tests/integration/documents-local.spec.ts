/**
 * Issue 017 integration: Local Documents Provider (SPEC §4.3, §5.8, §6.1,
 * §7.2; PRD US-009, FR-25, D-005, D-008).
 *
 * The provider itself is dual-runtime (node:fs works under Node and Bun);
 * the storage-backed suite (DocumentsService projection + persisted session
 * events) is Node-only because it opens SQLite.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DocumentEncodingError,
  DOCUMENT_READ_EVENT_TYPE,
  LocalDocumentProvider,
  WorkspaceBoundaryError,
} from '@teoclub/work-documents-local'
import { DocumentId, DocumentNotFoundError, projectDocument } from '@teoclub/work-documents'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@teoclub/harness-session'

const isBun = typeof Bun !== 'undefined'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rigo-docs-local-'))
}

describe('local document provider (Issue 017)', () => {
  it('reads a workspace-relative Markdown document with id, version, content, media type and source', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'guide.md'), '# Guide\n\nHello, world.\n')
    try {
      const provider = new LocalDocumentProvider({ root })
      const input = await provider.read(DocumentId('guide.md'))
      expect(input.relativePath).toBe('guide.md')
      expect(input.content).toBe('# Guide\n\nHello, world.\n')
      // The source is the real (resolved) location inside the root.
      expect(input.source).toBe(realpathSync(join(root, 'guide.md')))
      // Version and media type come from the Issue 016 projection.
      const record = projectDocument(input, undefined)
      expect(record.version).toBe(1)
      expect(record.mediaType).toBe('text/markdown')
      expect(record.sizeBytes).toBe(Buffer.byteLength(input.content, 'utf8'))
      // A nested path reads the same way.
      mkdirSync(join(root, 'docs'))
      writeFileSync(join(root, 'docs', 'nested.md'), '# Nested')
      const nested = await provider.read(DocumentId('docs/nested.md'))
      expect(nested.content).toBe('# Nested')
      expect(nested.source).toBe(realpathSync(join(root, 'docs', 'nested.md')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads plain text documents', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'notes.txt'), 'plain text')
    try {
      const provider = new LocalDocumentProvider({ root })
      const input = await provider.read(DocumentId('notes.txt'))
      expect(projectDocument(input, undefined).mediaType).toBe('text/plain')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects missing documents with DOCUMENT_NOT_FOUND', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    try {
      const provider = new LocalDocumentProvider({ root })
      await expect(provider.read(DocumentId('nope.md'))).rejects.toThrowError(DocumentNotFoundError)
      await expect(provider.read(DocumentId('nope.md'))).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' })
      // A directory is not a document either.
      mkdirSync(join(root, 'sub'))
      await expect(provider.read(DocumentId('sub'))).rejects.toThrowError(DocumentNotFoundError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects absolute paths and `..` traversal with PATH_OUTSIDE_WORKSPACE', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'secret.md'), 'top secret')
    try {
      const provider = new LocalDocumentProvider({ root })
      for (const id of [
        '../secret.md',
        '/etc/hostname',
        'a/../../secret.md',
        'sub/../../secret.md',
        '',
        './../secret.md',
      ]) {
        await expect(provider.read(DocumentId(id))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
      }
      // The target itself stays untouched.
      expect(await provider.read(DocumentId('secret.md'))).toMatchObject({ content: 'top secret' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects symlinks escaping the workspace root', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    const outside = join(dir, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside content')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.md'))
    try {
      const provider = new LocalDocumentProvider({ root })
      await expect(provider.read(DocumentId('link.md'))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
      // A deep symlink that resolves outside is caught the same way.
      mkdirSync(join(root, 'sub'))
      symlinkSync(join(outside, 'secret.txt'), join(root, 'sub', 'deep.md'))
      await expect(provider.read(DocumentId('sub/deep.md'))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allows symlinks that stay inside the workspace root', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'real.md'), 'real content')
    symlinkSync(join(root, 'real.md'), join(root, 'alias.md'))
    try {
      const provider = new LocalDocumentProvider({ root })
      const input = await provider.read(DocumentId('alias.md'))
      expect(input.content).toBe('real content')
      expect(input.source).toBe(realpathSync(join(root, 'real.md')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads empty documents as empty content — no fabricated content', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'empty.md'), '')
    try {
      const provider = new LocalDocumentProvider({ root })
      const input = await provider.read(DocumentId('empty.md'))
      expect(input.content).toBe('')
      const record = projectDocument(input, undefined)
      expect(record.sizeBytes).toBe(0)
      expect(record.version).toBe(1)
      expect(record.contentHash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855') // sha256('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid UTF-8 content with DOCUMENT_ENCODING_INVALID', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'broken.md'), Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x21])) // 'hi' + invalid bytes
    try {
      const provider = new LocalDocumentProvider({ root })
      await expect(provider.read(DocumentId('broken.md'))).rejects.toThrowError(DocumentEncodingError)
      await expect(provider.read(DocumentId('broken.md'))).rejects.toMatchObject({ code: 'DOCUMENT_ENCODING_INVALID' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('validates the workspace root contract (absolute, existing, directory)', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    const file = join(dir, 'file.txt')
    writeFileSync(file, 'x')
    try {
      expect(() => new LocalDocumentProvider({ root: 'relative/root' })).toThrowError(WorkspaceBoundaryError)
      expect(() => new LocalDocumentProvider({ root: join(dir, 'missing') })).toThrowError(WorkspaceBoundaryError)
      expect(() => new LocalDocumentProvider({ root: file })).toThrowError(WorkspaceBoundaryError)
      expect(() => new LocalDocumentProvider({})).toThrowError(TypeError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('derives the workspace root from the session header and appends a document/read event', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'guide.md'), '# Guide')
    try {
      const session = Session.create(SessionId('session_docs_local'), [], {
        version: SESSION_FORMAT_VERSION,
        id: SessionId('session_docs_local'),
        createdAt: Date.now(),
        cwd: root,
      })
      const provider = new LocalDocumentProvider({ session })
      expect(provider.root).toBe(root)
      const input = await provider.read(DocumentId('guide.md'))
      expect(input.content).toBe('# Guide')
      // The read is recorded with session, document and source identity.
      const event = session.events.at(-1)!
      expect(event.type).toBe(DOCUMENT_READ_EVENT_TYPE)
      expect(event.data).toEqual({
        sessionId: 'session_docs_local',
        documentId: 'guide.md',
        source: realpathSync(join(root, 'guide.md')),
      })
      // The appended event is lossless-JSON, so it survives persistence.
      expect(JSON.parse(JSON.stringify(event.data))).toEqual(event.data)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('honours an explicit root over the session root', async () => {
    const dir = tempDir()
    const rootA = join(dir, 'workspace-a')
    const rootB = join(dir, 'workspace-b')
    mkdirSync(rootA)
    mkdirSync(rootB)
    writeFileSync(join(rootA, 'a.md'), 'from A')
    writeFileSync(join(rootB, 'b.md'), 'from B')
    try {
      const session = Session.create(SessionId('session_docs_local_b'), [], {
        version: SESSION_FORMAT_VERSION,
        id: SessionId('session_docs_local_b'),
        createdAt: Date.now(),
        cwd: rootA,
      })
      const provider = new LocalDocumentProvider({ root: rootB, session })
      expect(provider.root).toBe(rootB)
      await expect(provider.read(DocumentId('a.md'))).rejects.toThrowError(DocumentNotFoundError)
      expect(await provider.read(DocumentId('b.md'))).toMatchObject({ content: 'from B' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Storage-backed wiring (Node-only): provider + Issue 016 service + persisted
// session log round-trip.
// ---------------------------------------------------------------------------
describe.skipIf(isBun)('local document provider with documents service (Node)', () => {
  it('projects reads through the service and persists the document/read event', async () => {
    const { default: SqliteSessionPersistence } = await import('@teoclub/shared-session-persistence-sqlite') as typeof import('@teoclub/shared-session-persistence-sqlite')
    const { Context } = await import('@teoclub/cordis') as typeof import('@teoclub/cordis')
    const { SessionStore } = await import('@teoclub/harness-session') as typeof import('@teoclub/harness-session')
    const { DocumentsService } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root)
    writeFileSync(join(root, 'guide.md'), '# Guide\n\nHello.\n')
    const sqlitePath = join(dir, 'rigo.sqlite')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteSessionPersistence as never, { path: sqlitePath })
    await ctx.plugin(DocumentsService, { openStorage: () => new NodeSqliteDriver(join(dir, 'documents.sqlite')) })
    try {
      const session = ctx.sessions.create(SessionId('session_docs_service'), { meta: { cwd: root } })
      const provider = new LocalDocumentProvider({ session })
      ctx.documents.registerProvider(provider)

      const content = await ctx.documents.read(DocumentId('guide.md'))
      expect(content.record.version).toBe(1)
      expect(content.record.mediaType).toBe('text/markdown')
      expect(content.content).toBe('# Guide\n\nHello.\n')
      expect(content.source).toBe(realpathSync(join(root, 'guide.md')))

      // The read event joins the session log and survives the persistence
      // round-trip (it is a KNOWN event type, so the load path accepts it).
      await ctx.sessions.flush(session)
      const loaded = await ctx.sessionPersistence.load(session.id)
      const readEvents = loaded.events.filter((event) => event.type === DOCUMENT_READ_EVENT_TYPE)
      expect(readEvents).toHaveLength(1)
      expect(readEvents[0]!.data).toEqual({
        sessionId: 'session_docs_service',
        documentId: 'guide.md',
        source: realpathSync(join(root, 'guide.md')),
      })

      // A second read keeps the monotonic version (same hash) and adds a
      // second read event; an escape never reaches the service.
      await ctx.documents.read(DocumentId('guide.md'))
      expect(ctx.documents.getVersion(DocumentId('guide.md'))).toBe(1)
      await expect(ctx.documents.read(DocumentId('../escape.md'))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' })
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
