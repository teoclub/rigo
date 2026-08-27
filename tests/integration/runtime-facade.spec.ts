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
})
