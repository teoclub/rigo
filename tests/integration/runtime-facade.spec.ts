/**
 * Issue 027 integration: Runtime Facade + in-process SDK (SPEC §4.1, §9.3;
 * PRD US-015, FR-9, FR-31, FR-32).
 *
 * The facade/session core is dual-runtime (in-memory store, fake agents);
 * the approvals/audit/persistence suites are Node-only (SQLite).
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'
import { createUserMessage } from '@teoclub/harness-llm'
import {
  InProcessSdk,
  RuntimeFacade,
  SdkError,
  createInProcessSdk,
  toSdkError,
  type FacadeApiFields,
  type FacadeSessionRow,
  type SessionEventPayload,
} from '@teoclub/api-sdk'
import { SessionStore, SessionId, type AgentCancelCause, type Session } from '@teoclub/harness-session'
import type { PublicAgent } from '@teoclub/harness-agent-protocol'

const isBun = typeof Bun !== 'undefined'

function makeFakeAgent(session: Session): {
  agent: PublicAgent
  dispose(): Promise<void>
  log: { sends: string[]; aborts: AgentCancelCause[]; disposed: boolean }
} {
  const log = { sends: [], aborts: [], disposed: false } as { sends: string[]; aborts: AgentCancelCause[]; disposed: boolean }
  let status: 'idle' | 'running' = 'idle'
  return {
    agent: {
      id: session.id,
      get status() {
        return status
      },
      send(text: string) {
        log.sends.push(text)
        status = 'running'
      },
      abort(cause?: AgentCancelCause) {
        log.aborts.push(cause ?? { kind: 'user' })
        status = 'idle'
      },
    },
    async dispose() {
      log.disposed = true
      status = 'idle'
    },
    log,
  }
}

describe('runtime facade + in-process sdk (Issue 027)', () => {
  it('creates, reads and closes sessions with projections', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const facade = new RuntimeFacade(ctx, {
      agentFactory: (input) => {
        const session = ctx.sessions.create(undefined, {
          ...(input.cwd === undefined ? {} : { meta: { cwd: input.cwd } }),
        })
        return makeFakeAgent(session)
      },
    })
    const sdk = createInProcessSdk(facade)
    try {
      const created = await sdk.createSession({ cwd: '/tmp/rigo-workspace' })
      expect(created.status).toBe('active')
      expect(created.cwd).toBe('/tmp/rigo-workspace')
      expect(created.agentStatus).toBe('idle')
      expect(created.eventCount).toBe(created.lastSeq + 1)
      const read = sdk.getSession(created.sessionId)!
      expect(read.sessionId).toBe(created.sessionId)
      expect(read.eventCount).toBe(created.eventCount)
      expect(sdk.getSession('session_missing')).toBeUndefined()
      await sdk.closeSession(created.sessionId)
      const closed = sdk.getSession(created.sessionId)!
      expect(closed.status).toBe('closed')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('sends messages and aborts through the agent, reflecting status', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const handle = { current: undefined as { log: ReturnType<typeof makeFakeAgent>['log'] } | undefined }
    const facade = new RuntimeFacade(ctx, {
      agentFactory: () => {
        const session = ctx.sessions.create(undefined, {})
        const made = makeFakeAgent(session)
        handle.current = made
        return made
      },
    })
    const sdk = createInProcessSdk(facade)
    try {
      const created = await sdk.createSession({})
      sdk.sendMessage(created.sessionId, 'hello there')
      expect(handle.current!.log.sends).toEqual(['hello there'])
      expect(sdk.getSession(created.sessionId)!.agentStatus).toBe('running')
      sdk.abort(created.sessionId, { kind: 'user' })
      expect(handle.current!.log.aborts).toEqual([{ kind: 'user' }])
      expect(sdk.getSession(created.sessionId)!.agentStatus).toBe('idle')
      // Unknown sessions surface unified errors.
      expect(() => sdk.sendMessage('ghost', 'x')).toThrowError(SdkError)
      expect(() => sdk.sendMessage('ghost', 'x')).toThrowError(/no live agent/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('streams session events and releases listeners on unsubscribe', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const facade = new RuntimeFacade(ctx)
    const sdk = createInProcessSdk(facade)
    try {
      const created = await sdk.createSession({})
      const session = ctx.sessions.get(SessionId(created.sessionId))!
      const received: SessionEventPayload[] = []
      const unsubscribe = sdk.subscribeSessionEvents((payload) => received.push(payload))
      session.append('turn/start', { turn: 1 })
      expect(received).toHaveLength(1)
      expect(received[0]!.sessionId).toBe(created.sessionId)
      expect(received[0]!.event.type).toBe('turn/start')
      unsubscribe()
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(received).toHaveLength(1) // no listener retained after unsubscribe
      // A second subscription is independent and also cancelable.
      const second: SessionEventPayload[] = []
      const unsubscribe2 = sdk.subscribeSessionEvents((payload) => second.push(payload))
      session.append('step/start', { turn: 2, step: 1 })
      expect(second).toHaveLength(1)
      unsubscribe2()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('lists sessions through the persistence seam, live state over durable rows', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const saved: Array<[string, FacadeApiFields]> = []
    let rows: FacadeSessionRow[] = []
    const facade = new RuntimeFacade(ctx, {
      agentFactory: () => makeFakeAgent(ctx.sessions.create(undefined, {})),
      persistence: {
        listSessions: () => rows,
        saveApiFields: (id, fields) => {
          saved.push([id, fields])
        },
      },
    })
    const sdk = createInProcessSdk(facade)
    try {
      const created = await sdk.createSession({ providerId: 'mock', modelId: 'mock', title: 'MVP' })
      // Creation upserts the API fields through the seam.
      expect(saved).toEqual([[created.sessionId, { providerId: 'mock', modelId: 'mock', title: 'MVP' }]])
      // Without durable rows the list is live-only.
      expect((await sdk.listSessions()).map((row) => row.sessionId)).toEqual([created.sessionId])

      // A durable-only row from a previous run lists as not-live.
      rows = [{ id: 'session_old', status: 'active', cwd: '/tmp/old', title: 'Previous run', eventCount: 4, lastSeq: 3, createdAt: '2026-02-15T00:00:00.000Z', updatedAt: '2026-02-15T00:00:00.000Z' }]
      let listed = await sdk.listSessions()
      expect(listed.map((row) => row.sessionId)).toEqual([created.sessionId, 'session_old'])
      expect(listed[0]).toMatchObject({ title: 'MVP', agentStatus: 'idle', eventCount: 0, lastSeq: -1 })
      expect(listed[1]).toMatchObject({
        title: 'Previous run',
        agentStatus: 'unavailable',
        status: 'active',
        cwd: '/tmp/old',
        eventCount: 4,
        lastSeq: 3,
        createdAt: '2026-02-15T00:00:00.000Z',
        updatedAt: '2026-02-15T00:00:00.000Z',
      })

      // A durable row for the LIVE session: live counters win, in-memory
      // metadata wins over the row, and the row backfills the timestamps.
      rows = [
        ...rows,
        { id: created.sessionId, status: 'active', providerId: 'stale', eventCount: 9, createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' },
      ]
      listed = await sdk.listSessions()
      // The durable-only row is newer than the live session's watermark.
      expect(listed.map((row) => row.sessionId)).toEqual(['session_old', created.sessionId])
      expect(listed[1]).toMatchObject({ title: 'MVP', providerId: 'mock', eventCount: 0, lastSeq: -1, createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' })

      // Live events past the durable watermark count as activity now: the
      // session reclaims the top of the list.
      ctx.sessions.get(SessionId(created.sessionId))!.append('turn/start', { turn: 1 })
      listed = await sdk.listSessions()
      expect(listed.map((row) => row.sessionId)).toEqual([created.sessionId, 'session_old'])
      expect(listed[0]).toMatchObject({ eventCount: 1, lastSeq: 0 })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resumes agents through the seam with metadata backfilled from persistence', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const rows: FacadeSessionRow[] = [
      { id: 'session_resumed', status: 'active', providerId: 'mock', modelId: 'mock', title: 'Back from disk', eventCount: 2, lastSeq: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]
    let made: ReturnType<typeof makeFakeAgent> | undefined
    const facade = new RuntimeFacade(ctx, {
      persistence: {
        listSessions: () => rows,
        saveApiFields: () => {},
      },
      resumeAgent: (sessionId) => {
        if (sessionId !== 'session_resumed') return undefined
        const session = ctx.sessions.create(SessionId('session_resumed'), {
          seed: [
            { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
            { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
          ],
        })
        made = makeFakeAgent(session)
        return made
      },
    })
    const sdk = createInProcessSdk(facade)
    try {
      const resumed = await sdk.resumeSession('session_resumed')
      expect(resumed).toMatchObject({
        sessionId: 'session_resumed',
        title: 'Back from disk',
        providerId: 'mock',
        modelId: 'mock',
        agentStatus: 'idle',
      })
      // The seeded turn plus the store's end-seed boundary marker.
      expect(resumed!.eventCount).toBeGreaterThanOrEqual(2)
      expect(resumed!.lastSeq).toBe(resumed!.eventCount - 1)
      // The resumed agent is live for messaging.
      sdk.sendMessage('session_resumed', 'still there')
      expect(made!.log.sends).toEqual(['still there'])
      // Unknown ids resolve undefined; live ones conflict.
      await expect(sdk.resumeSession('session_ghost')).resolves.toBeUndefined()
      await expect(sdk.resumeSession('session_resumed')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects with INTERNAL_ERROR and disposes when the resume seam publishes no session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let disposed = false
    const facade = new RuntimeFacade(ctx, {
      resumeAgent: () => ({
        agent: {
          id: SessionId('session_ghost'),
          sessionId: SessionId('session_ghost'),
          status: 'idle',
          send() {},
          steer() {},
          inject() {},
          abort() {},
          async whenIdle() {},
        },
        dispose: async () => {
          disposed = true
        },
      }),
    })
    try {
      await expect(facade.resumeSession('session_ghost')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
      expect(disposed).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('normalizes every failure into unified structured errors', () => {
    const ctx = new Context()
    void ctx
    const error = new SdkError('MODEL_RATE_LIMITED', 'provider throttled', { retryable: true })
    expect(toSdkError(error)).toBe(error)
    const domain = Object.assign(new Error('boom'), { code: 'DOCUMENT_NOT_FOUND', retryable: false })
    const normalized = toSdkError(domain)
    expect(normalized).toBeInstanceOf(SdkError)
    expect(normalized.code).toBe('DOCUMENT_NOT_FOUND')
    expect(normalized.retryable).toBe(false)
    expect(normalized.message).toBe('boom')
    const plain = toSdkError(new Error('opaque'))
    expect(plain.code).toBe('INTERNAL_ERROR')
    expect(plain.retryable).toBe(false)
    // Facade-level failures are already unified.
    const bare = new RuntimeFacade(new Context())
    void bare
  })
})

// ---------------------------------------------------------------------------
// Node-only: approvals, audit projection and session restore over SQLite.
// ---------------------------------------------------------------------------
describe.skipIf(isBun)('runtime facade with approvals/audit/persistence (Node)', async () => {
  async function loadNodeModules() {
    const approvals = await import('@teoclub/shared-approvals') as typeof import('@teoclub/shared-approvals')
    const audit = await import('@teoclub/shared-audit') as typeof import('@teoclub/shared-audit')
    const actions = await import('@teoclub/shared-actions') as typeof import('@teoclub/shared-actions')
    const persistence = await import('@teoclub/shared-session-persistence-sqlite') as typeof import('@teoclub/shared-session-persistence-sqlite')
    const storage = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const definition = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    return {
      ApprovalsService: approvals.ApprovalsService,
      APPROVAL_MIGRATIONS: approvals.APPROVAL_MIGRATIONS,
      AuditService: audit.AuditService,
      ACTION_MIGRATIONS: actions.ACTION_MIGRATIONS,
      SqliteSessionPersistence: persistence.default,
      SESSION_PERSISTENCE_MIGRATIONS: persistence.SESSION_PERSISTENCE_MIGRATIONS,
      SESSION_API_FIELDS_MIGRATION: persistence.SESSION_API_FIELDS_MIGRATION,
      NodeSqliteDriver: storage.NodeSqliteDriver,
      runMigrations: definition.runMigrations,
    }
  }

  function m(): Awaited<ReturnType<typeof loadNodeModules>> {
    return nodeMods!
  }
  const nodeMods = typeof Bun === 'undefined' ? await loadNodeModules() : undefined

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rigo-facade-'))
  }

  it('queries and decides approvals through the SDK with unified errors', async () => {
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const driver = new (m().NodeSqliteDriver)(path)
    m().runMigrations(driver, {
      migrations: [...m().SESSION_PERSISTENCE_MIGRATIONS, ...m().ACTION_MIGRATIONS, ...m().APPROVAL_MIGRATIONS],
    })
    driver.run(
      "INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES ('session_ap', 'active', '{}', 'now', 'now')",
    )
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(m().SqliteSessionPersistence as never, { path, migrations: [...m().SESSION_PERSISTENCE_MIGRATIONS, ...m().ACTION_MIGRATIONS, ...m().APPROVAL_MIGRATIONS] })
      await ctx.plugin(m().ApprovalsService, { driver })
      await ctx.plugin(m().AuditService)
      const facade = new RuntimeFacade(ctx)
      const sdk = createInProcessSdk(facade)

      const pending = await ctx.approvals.create({
        sessionId: 'session_ap',
        actionExecutionId: 'action_facade_1',
        actionName: 'document.write',
        target: 'docs/plan.md',
        paramsSummary: 'write plan',
        expectedImpact: 'overwrites docs/plan.md',
      })
      expect(sdk.listPendingApprovals('session_ap').map((a) => a.id)).toEqual([pending.id])
      // expectedVersion defaults to the current optimistic version.
      const resolved = await sdk.decideApproval(pending.id, { decision: 'approved' })
      expect(resolved.approval.state).toBe('approved')
      expect(sdk.listPendingApprovals('session_ap')).toEqual([])
      // A duplicate decision is a unified APPROVAL_ALREADY_DECIDED error.
      await expect(sdk.decideApproval(pending.id, { decision: 'approved', expectedVersion: 2 }))
        .rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED', retryable: false })
      await expect(sdk.decideApproval('ghost', { decision: 'approved', expectedVersion: 1 }))
        .rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' })
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('projects the audit log and restores a persisted session after restart', async () => {
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const cwd = join(dir, 'workspace')
    let sessionId = 'session_restart'

    // First runtime: create the session, append events, flush.
    const firstCtx = new Context()
    try {
      await firstCtx.plugin(SessionStore)
      await firstCtx.plugin(m().SqliteSessionPersistence as never, { path, migrations: [...m().SESSION_PERSISTENCE_MIGRATIONS, ...m().ACTION_MIGRATIONS, ...m().APPROVAL_MIGRATIONS] })
      await firstCtx.plugin(m().AuditService)
      const facade = new RuntimeFacade(firstCtx)
      const sdk = createInProcessSdk(facade)
      const created = await sdk.createSession({ cwd })
      const createdId = created.sessionId
      expect(createdId).toMatch(/^session-/)
      const session = firstCtx.sessions.get(SessionId(createdId))!
      session.append('turn/start', { turn: 1 })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
      const projection = sdk.auditProjection(createdId)
      expect(projection.map((entry) => entry.seq)).toEqual(session.events.map((event) => event.seq))
      expect(projection.some((entry) => entry.category === 'turn')).toBe(true)
      await firstCtx.sessions.flush(session)
      sessionId = createdId
    } finally {
      await firstCtx.fiber.dispose()
    }

    // Second runtime over the same database: restore the session.
    const secondCtx = new Context()
    const reader = new (m().NodeSqliteDriver)(path)
    try {
      await secondCtx.plugin(SessionStore)
      await secondCtx.plugin(m().SqliteSessionPersistence as never, { path, migrations: [...m().SESSION_PERSISTENCE_MIGRATIONS, ...m().ACTION_MIGRATIONS, ...m().APPROVAL_MIGRATIONS] })
      const facade = new RuntimeFacade(secondCtx, {
        loadSession: async (id) => {
          const loaded = await secondCtx.sessionPersistence.load(SessionId(id))
          const row = reader.query<{ workspace_root: string | null }>(
            'SELECT workspace_root FROM sessions WHERE id = ?', [id],
          )[0]
          return { events: loaded.events, ...(row?.workspace_root ? { cwd: row.workspace_root } : {}) }
        },
      })
      const sdk = createInProcessSdk(facade)
      const restored = await sdk.resumeSession(sessionId)
      expect(restored).toBeDefined()
      expect(restored!.eventCount).toBeGreaterThanOrEqual(3)
      expect(restored!.cwd).toBe(cwd)
      expect(sdk.getSession(sessionId)!.status).toBe('active')
      // The restored log replays identically.
      expect(secondCtx.sessions.get(SessionId(sessionId))!.deriveMessages().length).toBeGreaterThan(0)
      // A second resume of the same id conflicts.
      await expect(sdk.resumeSession(sessionId)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    } finally {
      await secondCtx.fiber.dispose()
      reader.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists api fields on create and lists durable sessions across a restart', async () => {
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const migrations = () => [...m().SESSION_PERSISTENCE_MIGRATIONS, ...m().ACTION_MIGRATIONS, ...m().APPROVAL_MIGRATIONS, m().SESSION_API_FIELDS_MIGRATION]
    const wire = (ctx: Context) => ({
      persistence: {
        listSessions: () => ctx.sessionPersistence.listApiSessions(),
        saveApiFields: (id: string, fields: FacadeApiFields) => ctx.sessionPersistence.setApiFields(SessionId(id), fields),
      },
    })
    let sessionId = ''

    const firstCtx = new Context()
    try {
      await firstCtx.plugin(SessionStore)
      await firstCtx.plugin(m().SqliteSessionPersistence as never, { path, migrations: migrations() })
      const sdk = createInProcessSdk(new RuntimeFacade(firstCtx, wire(firstCtx)))
      const created = await sdk.createSession({ cwd: '/tmp/facade-list', providerId: 'mock', modelId: 'mock', title: 'Across restarts' })
      sessionId = created.sessionId
      // Not yet materialized (no events): the live overlay still lists it.
      let listed = await sdk.listSessions()
      expect(listed.map((row) => row.sessionId)).toEqual([sessionId])
      expect(listed[0]).toMatchObject({ title: 'Across restarts', eventCount: 0 })
      const session = firstCtx.sessions.get(SessionId(sessionId))!
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await firstCtx.sessions.flush(session)
    } finally {
      await firstCtx.fiber.dispose()
    }

    const secondCtx = new Context()
    try {
      await secondCtx.plugin(SessionStore)
      await secondCtx.plugin(m().SqliteSessionPersistence as never, { path, migrations: migrations() })
      const sdk = createInProcessSdk(new RuntimeFacade(secondCtx, wire(secondCtx)))
      const listed = await sdk.listSessions()
      expect(listed.map((row) => row.sessionId)).toEqual([sessionId])
      expect(listed[0]).toMatchObject({
        title: 'Across restarts',
        providerId: 'mock',
        modelId: 'mock',
        cwd: '/tmp/facade-list',
        status: 'active',
        agentStatus: 'unavailable',
        eventCount: 2,
        lastSeq: 1,
      })
      expect(listed[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(listed[0]!.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    } finally {
      await secondCtx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
