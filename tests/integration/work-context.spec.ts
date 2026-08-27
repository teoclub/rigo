/**
 * Issue 020 integration: Work Knowledge Context Contributor (SPEC §3.7,
 * §5.2, §5.3; PRD US-008, FR-23, FR-24).
 *
 * The contributor and its contract are dual-runtime (no SQLite); the
 * fixed-knowledge-dataset end-to-end suite is Node-only (FTS5 index).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'
import { ContextService } from '@teoclub/harness-context'
import { createUserMessage } from '@teoclub/harness-llm'
import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
  SESSION_FORMAT_VERSION,
} from '@teoclub/harness-session'
import { KnowledgeService, SourceId, type KnowledgeProvider, type KnowledgeResult } from '@teoclub/shared-knowledge'
import {
  KNOWLEDGE_RETRIEVED_EVENT_TYPE,
  lastUserQuery,
  parseChunkLocator,
  WorkKnowledgeContributor,
} from '@teoclub/work-context'

const isBun = typeof Bun !== 'undefined'

function makeSession(id = 'session_work_ctx'): Session {
  return Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
  })
}

function ask(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function fakeRow(sourceId: string, title: string, snippet: string, overrides: Partial<KnowledgeResult> = {}): KnowledgeResult {
  return {
    sourceId: SourceId(sourceId),
    title,
    snippet,
    documentVersion: 2,
    locator: JSON.stringify({ ordinal: 0, start: 0, end: 60 }),
    ...overrides,
  }
}

function fakeProvider(rows: readonly KnowledgeResult[] | (() => readonly KnowledgeResult[])): KnowledgeProvider {
  return {
    name: 'fake',
    async retrieve() {
      const make = typeof rows === 'function' ? rows : () => rows
      return make()
    },
  }
}

describe('work knowledge contributor (Issue 020)', () => {
  it('extracts the query from the last user message', () => {
    const session = makeSession()
    expect(lastUserQuery(session)).toBeUndefined()
    ask(session, '  first question  ')
    ask(session, 'second question')
    // Tool-result messages (user role, tool source) never supply the query.
    session.append('user/message', createUserMessage({
      content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }], isError: false }],
      source: { kind: 'tool', callId: 'call-1' },
    }), { surfaceOp: 'append' })
    expect(lastUserQuery(session)).toBe('second question')
  })

  it('parses FTS locators into chunk + location', () => {
    expect(parseChunkLocator('{"ordinal":2,"start":1300,"end":2800}')).toEqual({
      chunk: 2,
      location: { start: 1300, end: 2800 },
    })
    expect(parseChunkLocator('not json')).toEqual({ chunk: undefined, location: undefined })
    expect(parseChunkLocator('{"start":1}')).toEqual({ chunk: undefined, location: undefined })
    expect(parseChunkLocator('"a string"')).toEqual({ chunk: undefined, location: undefined })
  })

  it('feeds retrieval into the assembly with traceable per-snippet references', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextService)
    await ctx.plugin(KnowledgeService)
    ctx.knowledge.registerProvider(fakeProvider([
      fakeRow('docs/rockets.md', 'Rocket Notes', 'rocket science launches rockets'),
      fakeRow('guide/engines.md', 'Engine Guide', 'engines burn fuel'),
    ]))
    const session = makeSession()
    ask(session, 'tell me about rockets')
    const contributor = new WorkKnowledgeContributor({ session, knowledge: ctx.knowledge })
    ctx.context.register(contributor)
    try {
      const assembly = await ctx.context.assemble(session)
      // The stable rank order reaches the model text verbatim.
      expect(assembly.text).toContain('[s1] Rocket Notes (docs/rockets.md · v2 · chunk 0 · fake)')
      expect(assembly.text).toContain('[s2] Engine Guide (guide/engines.md · v2 · chunk 0 · fake)')
      expect(assembly.text.indexOf('[s1]')).toBeLessThan(assembly.text.indexOf('[s2]'))
      expect(assembly.text).toContain('rocket science launches rockets')
      // The projection exposes locatable source references.
      const projection = contributor.projection!
      expect(projection.status).toBe('found')
      expect(projection.query).toBe('tell me about rockets')
      expect(projection.topK).toBe(8)
      expect(projection.sources).toHaveLength(2)
      expect(projection.sources[0]).toEqual({
        refId: 's1',
        provider: 'fake',
        documentId: 'docs/rockets.md',
        documentVersion: 2,
        chunk: 0,
        location: { start: 0, end: 60 },
        locator: JSON.stringify({ ordinal: 0, start: 0, end: 60 }),
        title: 'Rocket Notes',
      })
      // The knowledge/retrieved event carries the query summary + source ids
      // (the assembly appends context/contributed AFTER the retrieval, so
      // the retrieval event is not necessarily the log tail).
      const event = session.events.filter((entry) => entry.type === KNOWLEDGE_RETRIEVED_EVENT_TYPE).at(-1)!
      expect(event.data).toMatchObject({
        querySummary: 'tell me about rockets',
        queryBytes: 'tell me about rockets'.length,
        status: 'found',
        sourceIds: ['fake#docs/rockets.md#0', 'fake#guide/engines.md#0'],
        topK: 8,
      })
      // The event type is known to persistence.
      expect(KNOWN_SESSION_EVENT_TYPES.has(KNOWLEDGE_RETRIEVED_EVENT_TYPE)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is deterministic: the same session state assembles identical text', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextService)
    await ctx.plugin(KnowledgeService)
    ctx.knowledge.registerProvider(fakeProvider([
      fakeRow('docs/a.md', 'A', 'alpha content'),
      fakeRow('docs/b.md', 'B', 'beta content'),
    ]))
    const session = makeSession()
    ask(session, 'stable query')
    const contributor = new WorkKnowledgeContributor({ session, knowledge: ctx.knowledge })
    ctx.context.register(contributor)
    try {
      const first = await ctx.context.assemble(session)
      const second = await ctx.context.assemble(session)
      expect(second.text).toBe(first.text)
      expect(contributor.projection!.sources.map((source) => source.refId)).toEqual(['s1', 's2'])
      expect(session.events.filter((event) => event.type === KNOWLEDGE_RETRIEVED_EVENT_TYPE)).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports an explicit empty status without fabricating sources', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextService)
    await ctx.plugin(KnowledgeService)
    ctx.knowledge.registerProvider(fakeProvider([]))
    const session = makeSession()
    ask(session, 'nothing matches this')
    const contributor = new WorkKnowledgeContributor({ session, knowledge: ctx.knowledge })
    ctx.context.register(contributor)
    try {
      const assembly = await ctx.context.assemble(session)
      expect(assembly.text).toBe('')
      const projection = contributor.projection!
      expect(projection.status).toBe('empty')
      expect(projection.sources).toEqual([])
      const event = session.events.filter((entry) => entry.type === KNOWLEDGE_RETRIEVED_EVENT_TYPE).at(-1)!
      expect(event.data).toMatchObject({ status: 'empty', sourceIds: [], querySummary: 'nothing matches this' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips when no user query exists and appends no event', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextService)
    await ctx.plugin(KnowledgeService)
    ctx.knowledge.registerProvider(fakeProvider([fakeRow('docs/a.md', 'A', 'alpha')]))
    const session = makeSession() // no user message
    const contributor = new WorkKnowledgeContributor({ session, knowledge: ctx.knowledge })
    ctx.context.register(contributor)
    try {
      const assembly = await ctx.context.assemble(session)
      expect(assembly.text).toBe('')
      expect(contributor.projection!.status).toBe('skipped')
      expect(session.events.some((event) => event.type === KNOWLEDGE_RETRIEVED_EVENT_TYPE)).toBe(false)
      // Without a knowledge service the contributor also reports skipped.
      const bareCtx = new Context()
      await bareCtx.plugin(ContextService)
      const bare = new WorkKnowledgeContributor({ session })
      bareCtx.context.register(bare)
      try {
        await bareCtx.context.assemble(session)
        expect(bare.projection!.status).toBe('skipped')
      } finally {
        await bareCtx.fiber.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports failed retrievals without polluting the model text', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextService)
    await ctx.plugin(KnowledgeService)
    ctx.knowledge.registerProvider(fakeProvider(() => {
      throw new Error('index offline')
    }))
    const session = makeSession()
    ask(session, 'what do we know?')
    const contributor = new WorkKnowledgeContributor({ session, knowledge: ctx.knowledge })
    ctx.context.register(contributor)
    try {
      const assembly = await ctx.context.assemble(session)
      expect(assembly.text).toBe('')
      const projection = contributor.projection!
      expect(projection.status).toBe('failed')
      expect(projection.error).toContain('index offline')
      expect(projection.sources).toEqual([])
      expect(session.events.some((event) => event.type === KNOWLEDGE_RETRIEVED_EVENT_TYPE)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('supports a caller-supplied query and topK', async () => {
    const ctx = new Context()
    await ctx.plugin(ContextService)
    await ctx.plugin(KnowledgeService)
    let seen: string | undefined
    const provider: KnowledgeProvider = {
      name: 'spy',
      async retrieve(request) {
        seen = request.query
        return [fakeRow('docs/a.md', 'A', 'alpha')]
      },
    }
    ctx.knowledge.registerProvider(provider)
    const session = makeSession()
    ask(session, 'ignored message text')
    const contributor = new WorkKnowledgeContributor({
      session,
      knowledge: ctx.knowledge,
      topK: 3,
      query: () => 'custom query',
    })
    ctx.context.register(contributor)
    try {
      await ctx.context.assemble(session)
      expect(seen).toBe('custom query')
      expect(contributor.projection!.topK).toBe(3)
      expect(contributor.projection!.query).toBe('custom query')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Fixed-knowledge-dataset end-to-end (Node-only): FTS index → retrieval →
// assembly → event → projection.
// ---------------------------------------------------------------------------
describe.skipIf(isBun)('work knowledge contributor with FTS dataset (Node)', () => {
  it('retrieves, assembles, logs and projects sources end to end', async () => {
    const { default: SqliteFtsKnowledgeProvider, KNOWLEDGE_MIGRATIONS } = await import('@teoclub/shared-knowledge-sqlite-fts') as typeof import('@teoclub/shared-knowledge-sqlite-fts')
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const { DOCUMENTS_MIGRATIONS } = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const dir = mkdtempSync(join(tmpdir(), 'rigo-work-context-'))
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    const ctx = new Context()
    try {
      runMigrations(driver, { migrations: [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS] })
      // Fixed knowledge dataset: three docs, seeded projections + chunks.
      for (const [id, media] of [['docs/rockets.md', 'text/markdown'], ['docs/plants.md', 'text/markdown'], ['guide/engines.md', 'text/plain']] as const) {
        driver.run(
          `INSERT INTO documents (id, relative_path, version, content_hash, media_type, size_bytes, indexed_version, updated_at)
           VALUES (?, ?, 1, ?, ?, 1, NULL, ?)`,
          [id, id, 'hash-' + id, media, new Date().toISOString()],
        )
      }
      const provider = new SqliteFtsKnowledgeProvider({ driver })
      await provider.indexDocuments([
        { documentId: 'docs/rockets.md', documentVersion: 1, title: 'Rocket Notes', body: 'rocket science launches rockets into space. rocket fuel burns.' },
        { documentId: 'docs/plants.md', documentVersion: 1, title: 'Plant Notes', body: 'plants need water and sunlight to grow.' },
        { documentId: 'guide/engines.md', documentVersion: 1, title: 'Engine Guide', body: 'engines convert fuel into thrust for rockets.' },
      ])

      await ctx.plugin(ContextService)
      await ctx.plugin(KnowledgeService)
      ctx.knowledge.registerProvider(provider)
      const session = makeSession('session_work_fts')
      // Every term must be indexed: the FTS MATCH joins terms with AND.
      ask(session, 'rockets fuel')
      const contributor = new WorkKnowledgeContributor({ session, knowledge: ctx.knowledge })
      ctx.context.register(contributor)

      const assembly = await ctx.context.assemble(session)
      // The model text carries traceable snippets in stable order.
      expect(assembly.text).toContain('[s1]')
      expect(assembly.text).toContain('· sqlite-fts)')
      // The projection resolves provider/document/version/chunk/location.
      const sources = contributor.projection!.sources
      expect(sources.length).toBeGreaterThan(0)
      for (const source of sources) {
        expect(source.provider).toBe('sqlite-fts')
        expect(source.documentId).toMatch(/\.md$/)
        expect(source.documentVersion).toBe(1)
        expect(source.chunk).toBe(0)
        expect(source.location).toEqual({ start: 0, end: expect.any(Number) as number })
      }
      // The event carries rank-ordered source ids.
      const event = session.events.filter((entry) => entry.type === KNOWLEDGE_RETRIEVED_EVENT_TYPE).at(-1)!
      expect(event.type).toBe(KNOWLEDGE_RETRIEVED_EVENT_TYPE)
      expect(event.data).toMatchObject({ status: 'found' })
      expect(event.data.sourceIds.every((id: string) => id.startsWith('sqlite-fts#'))).toBe(true)

      // Deterministic: a second assembly reproduces the same order.
      const again = await ctx.context.assemble(session)
      expect(again.text).toBe(assembly.text)

      // An explicit no-match query reports empty with no fabricated sources.
      const emptySession = makeSession('session_work_empty')
      const emptyContributor = new WorkKnowledgeContributor({
        session: emptySession,
        knowledge: ctx.knowledge,
        query: () => 'zzzqqq not indexed',
      })
      const emptyCtx = new Context()
      await emptyCtx.plugin(ContextService)
      await emptyCtx.plugin(KnowledgeService)
      emptyCtx.knowledge.registerProvider(provider)
      emptyCtx.context.register(emptyContributor)
      try {
        const emptyAssembly = await emptyCtx.context.assemble(emptySession)
        expect(emptyAssembly.text).toBe('')
        expect(emptyContributor.projection!.status).toBe('empty')
        expect(emptyContributor.projection!.sources).toEqual([])
        const emptyEvent = emptySession.events.filter((entry) => entry.type === KNOWLEDGE_RETRIEVED_EVENT_TYPE).at(-1)!
        expect(emptyEvent.data).toMatchObject({ status: 'empty', sourceIds: [] })
      } finally {
        await emptyCtx.fiber.dispose()
      }
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
