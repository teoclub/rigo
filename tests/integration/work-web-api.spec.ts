/**
 * Rigo Work Web API client tests (Issue 033): live flows against a real
 * api-http server, plus the reconnect/last-event-id behavior with a stubbed
 * fetch. Dual-runtime.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'
import { SessionStore, SessionId, type Session } from '@teoclub/harness-session'
import type { PublicAgent } from '@teoclub/harness-agent-protocol'
import { RuntimeFacade } from '@teoclub/api-sdk'
import { createApiServer, type ApiServer } from '@teoclub/api-http'
import { WorkApiClient, ApiError, sseReconnectDelay } from '../../apps/work-web/src/api.ts'

const isBun = typeof Bun !== 'undefined'

function makeFakeAgent(session: Session): { agent: PublicAgent; dispose(): Promise<void> } {
  let status: 'idle' | 'running' = 'idle'
  return {
    agent: {
      id: session.id,
      get status() {
        return status
      },
      send() {
        status = 'running'
      },
      abort() {
        status = 'idle'
      },
    },
    async dispose() {
      status = 'idle'
    },
  }
}

const openServers: { api: ApiServer; ctx: Context }[] = []

async function liveServer(): Promise<{ base: string; ctx: Context; sessionId: string; client: WorkApiClient }> {
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
  const api = createApiServer({ facade })
  const port = await api.listen(0)
  openServers.push({ api, ctx })
  const created = await facade.createSession({ cwd: '/tmp/rigo-ui-ws' })
  return { base: `http://127.0.0.1:${port}`, ctx, sessionId: created.sessionId, client: new WorkApiClient(`http://127.0.0.1:${port}`) }
}

afterEach(async () => {
  while (openServers.length > 0) {
    const handle = openServers.pop()!
    await handle.api.close()
    await handle.ctx.fiber.dispose()
  }
})

describe('work web api client (Issue 033)', () => {
  it('reads health and creates/opens sessions with the CSRF flow', async () => {
    const { client } = await liveServer()
    const health = await client.health()
    expect(health).toMatchObject({ status: 'ok', runtime: 'ready' })
    const created = await client.createSession({
      providerId: 'openai-compatible',
      modelId: 'default',
      workspaceRoot: '/tmp/rigo-ui-ws',
      title: 'UI session',
    })
    expect(created.sessionId).toBeDefined()
    expect(created.title).toBe('UI session')
    const read = await client.getSession(created.sessionId)
    expect(read).toMatchObject({ sessionId: created.sessionId, status: 'active' })
    expect(await client.getSession('session_ghost')).toBeUndefined()
  })

  it('sends messages with a unique clientMessageId and replays duplicates', async () => {
    const { client, sessionId } = await liveServer()
    const first = await client.sendMessage(sessionId, 'hello', 'ui-msg-1')
    expect(first).toMatchObject({ status: 'accepted' })
    const duplicate = await client.sendMessage(sessionId, 'hello', 'ui-msg-1')
    expect(duplicate).toEqual({ turnId: first.turnId, status: 'replayed' })
  })

  it('streams session events and folds assistant output without the raw provider stream', async () => {
    const { client, ctx, sessionId } = await liveServer()
    const session = ctx.sessions.get(SessionId(sessionId))!
    const controller = new AbortController()
    const frames: { id: number; event: string; type?: string }[] = []
    const stream = client.openEventStream(sessionId, {
      signal: controller.signal,
      onEvent: (frame) => frames.push({ id: frame.id, event: frame.event, ...(frame.data.type === undefined ? {} : { type: String(frame.data.type) }) }),
      onStatus: (status) => {
        if (status === 'connected') {
          // Start emitting once connected.
          session.append('turn/start', { turn: 1 })
          session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text', text: 'Streamed ' } })
          session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text', text: 'output' } })
          session.append('knowledge/retrieved', {
            querySummary: 'q', queryBytes: 1, status: 'found', sourceIds: ['sqlite-fts#docs/a.md#0'], topK: 8,
          })
          session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        }
      },
    })
    const deadline = Date.now() + 10000
    while (frames.filter((frame) => frame.event === 'session.event').length < 5 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    controller.abort()
    await stream
    const events = frames.filter((frame) => frame.event === 'session.event')
    expect(events.map((frame) => frame.type)).toEqual([
      'turn/start', 'assistant/chunk', 'assistant/chunk', 'knowledge/retrieved', 'turn/end',
    ])
    expect(events[0]!.id).toBe(0)
    expect(events[4]!.id).toBe(4)
  })

  it('maps the server error envelope into ApiError with code and requestId', async () => {
    const { client } = await liveServer()
    try {
      await client.sendMessage('session_ghost', 'x', 'm1')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      const apiError = error as ApiError
      expect(apiError.code).toBe('SESSION_NOT_FOUND')
      expect(apiError.requestId).toMatch(/^req_/)
      expect(apiError.retryable).toBe(false)
    }
  })

  it('reconnects with Last-Event-ID after a dropped stream (capped backoff)', async () => {
    const originalFetch = globalThis.fetch
    const requestedLastIds: (string | undefined)[] = []
    let call = 0
    const frames = [
      'id: 0\nevent: session.snapshot\ndata: {"sessionId":"s"}\n\n',
      'id: 1\nevent: session.event\ndata: {"seq":1,"type":"turn/start","payload":{"turn":1}}\n\n',
    ]
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      call += 1
      const requested = (init?.headers as Record<string, string> | undefined)?.['last-event-id']
      requestedLastIds.push(requested)
      if (call === 1) {
        // First connection: stream two frames then END (server drop).
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frames.join('')))
            controller.close()
          },
        })
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      }
      // Reconnect: one more frame.
      void url
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('id: 2\nevent: session.event\ndata: {"seq":2,"type":"turn/end","payload":{"turn":1,"reason":{"kind":"completed"}}}\n\n'))
          controller.close()
        },
      })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch

    const received: { id: number }[] = []
    const statuses: string[] = []
    const controller = new AbortController()
    try {
      const client = new WorkApiClient('http://127.0.0.1:0')
      const stream = client.openEventStream('s', {
        signal: controller.signal,
        onEvent: (frame) => received.push({ id: frame.id }),
        onStatus: (status) => statuses.push(status),
      })
      const deadline = Date.now() + 5000
      while (received.length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      controller.abort()
      await stream
      // The reconnect carried the LAST delivered event id (1).
      expect(requestedLastIds).toEqual([undefined, '1'])
      expect(received.map((frame) => frame.id)).toEqual([0, 1, 2])
      expect(statuses[0]).toBe('connected')
      expect(statuses).toContain('reconnecting')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('exposes the capped reconnect backoff sequence', () => {
    expect(sseReconnectDelay(1)).toBe(1000)
    expect(sseReconnectDelay(2)).toBe(2000)
    expect(sseReconnectDelay(3)).toBe(5000)
    expect(sseReconnectDelay(4)).toBe(10000)
    expect(sseReconnectDelay(9)).toBe(10000)
  })
})

// ---------------------------------------------------------------------------
// Node-only: approvals + audit API flows (SQLite-backed).
// ---------------------------------------------------------------------------
describe.skipIf(isBun)('work web approval/audit api client (Node)', async () => {
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
      ActionsService: actions.ActionsService,
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
    return mkdtempSync(join(tmpdir(), 'rigo-web-api-'))
  }

  it('lists pending approvals, decides them and reads the audit timeline through the client', async () => {
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const driver = new (m().NodeSqliteDriver)(path)
    m().runMigrations(driver, { migrations: [
      ...m().SESSION_PERSISTENCE_MIGRATIONS,
      ...m().ACTION_MIGRATIONS,
      ...m().APPROVAL_MIGRATIONS,
    ] })
    const ctx = new Context()
    const api = createApiServer({ facade: new RuntimeFacade(ctx) })
    try {
      await ctx.plugin(SessionStore)
      await ctx.plugin(m().SqliteSessionPersistence as never, { path, migrations: [
        ...m().SESSION_PERSISTENCE_MIGRATIONS,
        ...m().ACTION_MIGRATIONS,
        ...m().APPROVAL_MIGRATIONS,
      ] })
      await ctx.plugin(m().ActionsService, { driver })
      await ctx.plugin(m().ApprovalsService, { driver })
      await ctx.plugin(m().AuditService)
      const session = ctx.sessions.create(SessionId('session_web'), {})
      session.append('turn/start', { turn: 1 })
      await ctx.sessions.flush(session)
      ctx.actions.registerAction({
        name: 'needs-approval',
        description: 'write',
        inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        sideEffect: 'none',
        execute: (input) => ({ written: (input as { path: string }).path }),
      })
      ctx.actions.beforePolicy(() => ({ decision: 'require-approval', reason: 'policy', policy: 'strict' }))
      const suspended = await ctx.actions.execute({
        action: 'needs-approval', input: { path: 'a.md' }, idempotencyKey: 'web-1', sessionId: 'session_web',
      })
      if (suspended.status !== 'requires-approval') throw new Error('unreachable')
      const approval = await ctx.approvals.create({
        sessionId: 'session_web',
        actionExecutionId: suspended.executionId,
        actionName: 'needs-approval',
        target: 'a.md',
        paramsSummary: 'write a.md',
        expectedImpact: 'overwrites a.md',
      })
      const port = await api.listen(0)
      const client = new WorkApiClient(`http://127.0.0.1:${port}`)
      // AC-1: the pending approval card data.
      const pending = await client.listPendingApprovals('session_web')
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        actionName: 'needs-approval',
        target: 'a.md',
        paramsSummary: 'write a.md',
        expectedImpact: 'overwrites a.md',
        state: 'pending',
        version: 1,
      })
      // AC-3: approve with the current expected version.
      const resolved = await client.decideApproval(approval.id, { decision: 'approved', expectedVersion: 1 })
      expect(resolved.approval.state).toBe('approved')
      expect(resolved.execution).toMatchObject({ status: 'completed' })
      // AC-4: a duplicate decision surfaces the conflict error.
      await expect(client.decideApproval(approval.id, { decision: 'approved', expectedVersion: 2 }))
        .rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED' })
      // AC-7: the audit timeline is ordered by seq with categories.
      const entries = await client.auditProjection('session_web')
      expect(entries.map((entry) => entry.seq)).toEqual(session.events.map((event) => event.seq))
      expect(entries.some((entry) => entry.category === 'approval')).toBe(true)
      expect(entries.some((entry) => entry.category === 'turn')).toBe(true)
    } finally {
      try {
        await api.close()
      } catch {
        // The server may never have listened when setup failed earlier.
      }
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
