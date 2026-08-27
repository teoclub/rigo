/**
 * Issue 028 integration: HTTP API host (SPEC §4.1–§4.4, §6.1; PRD US-015,
 * FR-28, FR-31).
 *
 * Dual-runtime: the server runs on node:http over the in-memory facade.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import { SessionStore, type AgentCancelCause, type Session } from '@teoclub/harness-session'
import type { PublicAgent } from '@teoclub/harness-agent-protocol'
import { RuntimeFacade, type SessionSnapshot } from '@teoclub/api-sdk'
import { createApiServer, type ApiServer } from '@teoclub/api-http'

const isBun = typeof Bun !== 'undefined'

interface FakeAgentState {
  sends: string[]
  aborts: AgentCancelCause[]
  disposed: boolean
}

function makeFakeAgent(session: Session, state: FakeAgentState): { agent: PublicAgent; dispose(): Promise<void> } {
  let status: 'idle' | 'running' = 'idle'
  return {
    agent: {
      id: session.id,
      get status() {
        return status
      },
      send() {
        state.sends.push('sent')
        status = 'running'
      },
      abort(cause?: AgentCancelCause) {
        state.aborts.push(cause ?? { kind: 'user' })
        status = 'idle'
      },
    },
    async dispose() {
      state.disposed = true
      status = 'idle'
    },
  }
}

async function openServer(): Promise<{
  base: string
  api: ApiServer
  ctx: Context
  facade: RuntimeFacade
  agents: Map<string, FakeAgentState>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const agents = new Map<string, FakeAgentState>()
  const facade = new RuntimeFacade(ctx, {
    agentFactory: (input) => {
      const session = ctx.sessions.create(undefined, {
        ...(input.cwd === undefined ? {} : { meta: { cwd: input.cwd } }),
      })
      const state = { sends: [], aborts: [], disposed: false } as FakeAgentState
      agents.set(session.id, state)
      return makeFakeAgent(session, state)
    },
    modelValidator: (providerId) => providerId === 'openai-compatible',
    checkDatabase: () => true,
  })
  const api = createApiServer({ facade })
  const port = await api.listen(0)
  return { base: `http://127.0.0.1:${port}`, api, ctx, facade, agents }
}

const openServers: { api: ApiServer; ctx: Context }[] = []

async function server(): Promise<ReturnType<typeof openServer>> {
  const handle = await openServer()
  openServers.push(handle)
  return handle
}

afterEach(async () => {
  while (openServers.length > 0) {
    const handle = openServers.pop()!
    await handle.api.close()
    await handle.ctx.fiber.dispose()
  }
})

const csrfTokens = new WeakMap<object, string>()

/** Fetch the startup CSRF token for a server (SPEC §7.1). */
async function csrfTokenOf(base: string): Promise<string> {
  const response = await fetch(`${base}/api/v1/csrf`)
  const body = (await response.json()) as { csrfToken: string }
  return body.csrfToken
}

async function jsonFetch(base: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const method = init.method ?? 'GET'
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (method !== 'GET' && method !== 'HEAD') {
    headers['x-csrf-token'] = await csrfTokenOf(base)
  }
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
  })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
}

describe('http api /api/v1 (Issue 028)', () => {
  it('reports runtime and database health', async () => {
    const { base } = await server()
    const health = await jsonFetch(base, '/api/v1/health')
    expect(health.status).toBe(200)
    expect(health.body).toEqual({ status: 'ok', runtime: 'ready', database: 'ok' })
  })

  it('reports an unavailable database when the probe fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const facade = new RuntimeFacade(ctx, { checkDatabase: () => false })
    const api = createApiServer({ facade })
    const port = await api.listen(0)
    openServers.push({ api, ctx })
    try {
      const health = await jsonFetch(`http://127.0.0.1:${port}`, '/api/v1/health')
      expect(health.body).toEqual({ status: 'ok', runtime: 'ready', database: 'unavailable' })
    } finally {
      await api.close()
      await ctx.fiber.dispose()
      openServers.pop()
    }
  })

  it('creates and reads sessions with validation', async () => {
    const { base, agents } = await server()
    // Invalid bodies → unified INVALID_REQUEST (400).
    for (const body of [
      {},
      { modelId: 'default' },
      { providerId: 'openai-compatible' },
      { providerId: 'openai-compatible', modelId: 'default', workspaceRoot: 'relative/path' },
      { providerId: 'openai-compatible', modelId: 'default', workspaceRoot: '/tmp/x', title: '长'.repeat(201) },
    ]) {
      const bad = await jsonFetch(base, '/api/v1/sessions', { method: 'POST', body: JSON.stringify(body) })
      expect(bad.status).toBe(400)
      expect(bad.body).toMatchObject({ error: { code: 'INVALID_REQUEST', retryable: false } })
      expect((bad.body as { error: { requestId: string } }).error.requestId).toMatch(/^req_/)
    }
    // A provider that does not exist → 422 PROVIDER_NOT_FOUND.
    const ghost = await jsonFetch(base, '/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ providerId: 'ghost-provider', modelId: 'x', workspaceRoot: '/tmp/ws' }),
    })
    expect(ghost.status).toBe(422)
    expect(ghost.body).toMatchObject({ error: { code: 'PROVIDER_NOT_FOUND' } })

    // A valid creation → 201 with the projection.
    const created = await jsonFetch(base, '/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        providerId: 'openai-compatible',
        modelId: 'default',
        workspaceRoot: '/tmp/rigo-workspace',
        title: 'Quarterly report',
      }),
    })
    expect(created.status).toBe(201)
    const session = (created.body as { session: SessionSnapshot }).session
    expect(session).toMatchObject({
      status: 'active',
      agentStatus: 'idle',
      providerId: 'openai-compatible',
      modelId: 'default',
      title: 'Quarterly report',
      cwd: '/tmp/rigo-workspace',
    })
    expect(agents.has(session.sessionId)).toBe(true)

    // GET returns the projection; unknown ids → 404 SESSION_NOT_FOUND.
    const read = await jsonFetch(base, `/api/v1/sessions/${session.sessionId}`)
    expect(read.status).toBe(200)
    expect((read.body as { session: SessionSnapshot }).session.sessionId).toBe(session.sessionId)
    const missing = await jsonFetch(base, '/api/v1/sessions/session_ghost')
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } })
  })

  it('accepts messages with unique clientMessageId and replays duplicates', async () => {
    const { base, agents } = await server()
    const created = await jsonFetch(base, '/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ providerId: 'openai-compatible', modelId: 'default', workspaceRoot: '/tmp/ws' }),
    })
    const id = (created.body as { session: SessionSnapshot }).session.sessionId

    const first = await jsonFetch(base, `/api/v1/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ clientMessageId: 'msg-1', content: 'hello' }),
    })
    expect(first.status).toBe(202)
    expect(first.body).toMatchObject({ status: 'accepted' })
    const turnId = (first.body as { turnId: string }).turnId
    expect(turnId).toMatch(/^turn_/)

    // Duplicate clientMessageId → the ORIGINAL turn id, no duplicate input.
    const duplicate = await jsonFetch(base, `/api/v1/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ clientMessageId: 'msg-1', content: 'hello' }),
    })
    expect(duplicate.status).toBe(202)
    expect(duplicate.body).toEqual({ turnId, status: 'replayed' })
    expect(agents.get(id)!.sends).toEqual(['sent']) // sent exactly once

    // Validation failures.
    const bad = await jsonFetch(base, `/api/v1/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: 'no id' }),
    })
    expect(bad.status).toBe(400)
    expect(bad.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
    const unknown = await jsonFetch(base, '/api/v1/sessions/session_ghost/messages', {
      method: 'POST',
      body: JSON.stringify({ clientMessageId: 'm', content: 'x' }),
    })
    expect(unknown.status).toBe(404)
    expect(unknown.body).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } })
  })

  it('aborts running sessions and rejects idle aborts with SESSION_BUSY', async () => {
    const { base, agents } = await server()
    const created = await jsonFetch(base, '/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ providerId: 'openai-compatible', modelId: 'default', workspaceRoot: '/tmp/ws' }),
    })
    const id = (created.body as { session: SessionSnapshot }).session.sessionId
    // Idle → 409 SESSION_BUSY.
    const idleAbort = await jsonFetch(base, `/api/v1/sessions/${id}/abort`, { method: 'POST' })
    expect(idleAbort.status).toBe(409)
    expect(idleAbort.body).toMatchObject({ error: { code: 'SESSION_BUSY', retryable: true } })
    // Running → 200 aborted.
    await jsonFetch(base, `/api/v1/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ clientMessageId: 'm1', content: 'go' }),
    })
    const aborted = await jsonFetch(base, `/api/v1/sessions/${id}/abort`, { method: 'POST' })
    expect(aborted.status).toBe(200)
    expect(aborted.body).toEqual({ status: 'aborted' })
    expect(agents.get(id)!.aborts).toEqual([{ kind: 'user' }])
  })

  it('deletes sessions by cancelling the active turn first, then releasing', async () => {
    const { base, agents } = await server()
    const created = await jsonFetch(base, '/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ providerId: 'openai-compatible', modelId: 'default', workspaceRoot: '/tmp/ws' }),
    })
    const id = (created.body as { session: SessionSnapshot }).session.sessionId
    await jsonFetch(base, `/api/v1/sessions/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ clientMessageId: 'm1', content: 'run' }),
    })
    const deleted = await jsonFetch(base, `/api/v1/sessions/${id}`, { method: 'DELETE' })
    expect(deleted.status).toBe(200)
    expect(deleted.body).toEqual({ status: 'closed' })
    // The running agent was cancelled BEFORE release.
    expect(agents.get(id)!.aborts).toEqual([{ kind: 'disposed' }])
    expect(agents.get(id)!.disposed).toBe(true)
    // Deletion is idempotent at the store level and the session reads closed.
    const read = await jsonFetch(base, `/api/v1/sessions/${id}`)
    expect(read.status).toBe(200)
    expect((read.body as { session: SessionSnapshot }).session.status).toBe('closed')
    // Deleting an unknown session → 404.
    const missing = await jsonFetch(base, '/api/v1/sessions/session_ghost', { method: 'DELETE' })
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } })
  })

  it('answers unknown endpoints with the unified envelope', async () => {
    const { base } = await server()
    const unknown = await jsonFetch(base, '/api/v1/nope')
    expect(unknown.status).toBe(404)
    expect(unknown.body).toMatchObject({ error: { code: 'INVALID_REQUEST', retryable: false } })
    const wrongMethod = await jsonFetch(base, '/api/v1/health', { method: 'POST' })
    expect(wrongMethod.status).toBe(404)
    expect((wrongMethod.body as { error: { code: string } }).error.code).toBe('INVALID_REQUEST')
  })
})
