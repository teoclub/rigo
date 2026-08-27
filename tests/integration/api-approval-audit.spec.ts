/**
 * Issue 030 integration: Approval/Audit HTTP API + unified error envelope
 * (SPEC §4.2, §4.6, §4.7, §6.1, §7.1; PRD US-012, US-013, US-015).
 *
 * Node-only: the approvals ride the SQLite-backed pipeline.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { Context } from '@teoclub/cordis'
import { SessionStore, SessionId } from '@teoclub/harness-session'
import { RuntimeFacade } from '@teoclub/api-sdk'
import { createApiServer } from '@teoclub/api-http'

const isBun = typeof Bun !== 'undefined'

describe.skipIf(isBun)('approval/audit http api (Node)', async () => {
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
    return mkdtempSync(join(tmpdir(), 'rigo-approval-api-'))
  }

  const COMPOSED = () => [
    ...m().SESSION_PERSISTENCE_MIGRATIONS,
    ...m().ACTION_MIGRATIONS,
    ...m().APPROVAL_MIGRATIONS,
  ]

  async function harness() {
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const driver = new (m().NodeSqliteDriver)(path)
    m().runMigrations(driver, { migrations: COMPOSED() })
    driver.run(
      "INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES ('session_approval', 'active', '{}', 'now', 'now')",
    )
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(SessionId('session_approval'), { meta: { cwd: '/tmp/ws' } })
    await ctx.plugin(m().SqliteSessionPersistence as never, { path, migrations: COMPOSED() })
    await ctx.plugin(m().ActionsService, { driver })
    await ctx.plugin(m().ApprovalsService, { driver })
    await ctx.plugin(m().AuditService)
    ctx.actions.registerAction({
      name: 'needs-approval',
      description: 'a write that needs approval',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      sideEffect: 'none',
      execute: (input) => ({ written: (input as { path: string }).path }),
    })
    ctx.actions.beforePolicy(() => ({
      decision: 'require-approval',
      reason: 'policy requires approval',
      policy: 'strict-policy',
    }))
    const facade = new RuntimeFacade(ctx)
    const api = createApiServer({ facade })
    const port = await api.listen(0)
    const base = `http://127.0.0.1:${port}`
    const token = (await (await fetch(`${base}/api/v1/csrf`)).json()) as { csrfToken: string }
    return {
      dir,
      path,
      driver,
      ctx,
      facade,
      api,
      base,
      token: token.csrfToken,
      close: async () => {
        await api.close()
        await ctx.fiber.dispose()
        driver.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  async function stateFetch(base: string, token: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
    const text = await response.text()
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
  }

  async function getJson(base: string, path: string): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`${base}${path}`)
    const text = await response.text()
    return { status: response.status, body: text.length === 0 ? undefined : JSON.parse(text) }
  }

  it('lists pending approvals per session and decides them with action status', async () => {
    const h = await harness()
    try {
      // A write suspended by the strict policy.
      const suspended = await h.ctx.actions.execute({
        action: 'needs-approval',
        input: { path: 'docs/plan.md' },
        idempotencyKey: 'api-key-1',
        sessionId: 'session_approval',
      })
      expect(suspended.status).toBe('requires-approval')
      const executionId = (suspended as { executionId: string }).executionId
      await h.ctx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: executionId,
        actionName: 'needs-approval',
        target: 'docs/plan.md',
        paramsSummary: 'write plan',
        expectedImpact: 'overwrites docs/plan.md',
        session: h.ctx.sessions.get(SessionId('session_approval')),
      })

      // Pending approvals by session.
      const pending = await getJson(h.base, '/api/v1/sessions/session_approval/approvals')
      expect(pending.status).toBe(200)
      const approvals = (pending.body as { approvals: { id: string; actionName: string; state: string }[] }).approvals
      expect(approvals).toHaveLength(1)
      expect(approvals[0]).toMatchObject({ actionName: 'needs-approval', state: 'pending' })
      const approvalId = approvals[0]!.id
      // Unknown session → 404.
      const missing = await getJson(h.base, '/api/v1/sessions/session_ghost/approvals')
      expect(missing.status).toBe(404)
      expect(missing.body).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } })

      // Approve: the response carries the updated approval AND the resumed
      // action status (completion itself streams over SSE as events).
      const decided = await stateFetch(h.base, h.token, `/api/v1/approvals/${approvalId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved', expectedVersion: 1, comment: 'looks good' }),
      })
      expect(decided.status).toBe(200)
      expect(decided.body).toMatchObject({
        approval: { state: 'approved', version: 2 },
        execution: { status: 'completed', executionId },
      })
      // The action completion events are in the session log (SSE-visible).
      const events = h.ctx.sessions.get(SessionId('session_approval'))!.events
      expect(events.some((event) => event.type === 'approval/requested')).toBe(true)
      expect(events.some((event) => event.type === 'approval/resolved')).toBe(true)
    } finally {
      await h.close()
    }
  })

  it('maps deny, duplicates, expiry and validation to the defined envelopes', async () => {
    const h = await harness()
    try {
      const makeApproval = async (key: string) => {
        const suspended = await h.ctx.actions.execute({
          action: 'needs-approval',
          input: { path: key },
          idempotencyKey: key,
          sessionId: 'session_approval',
        })
        return h.ctx.approvals.create({
          sessionId: 'session_approval',
          actionExecutionId: (suspended as { executionId: string }).executionId,
          actionName: 'needs-approval',
          target: key,
          paramsSummary: 'write',
          expectedImpact: `writes ${key}`,
        })
      }

      // Deny → 200 with the denied approval; the action never executed.
      const deniedApproval = await makeApproval('api-deny')
      const denied = await stateFetch(h.base, h.token, `/api/v1/approvals/${deniedApproval.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'denied', expectedVersion: 1 }),
      })
      expect(denied.status).toBe(200)
      expect(denied.body).toMatchObject({ approval: { state: 'denied' } })
      expect(h.ctx.actions.getExecution('needs-approval', 'api-deny')!.state).toBe('cancelled')

      // Duplicate decision → 409 APPROVAL_ALREADY_DECIDED (retryable false).
      const again = await stateFetch(h.base, h.token, `/api/v1/approvals/${deniedApproval.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved', expectedVersion: 2 }),
      })
      expect(again.status).toBe(409)
      expect(again.body).toMatchObject({
        error: { code: 'APPROVAL_ALREADY_DECIDED', retryable: false },
      })

      // Expired → 410 APPROVAL_EXPIRED.
      const expiredApproval = await h.ctx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: 'exec-expired',
        actionName: 'needs-approval',
        target: 'expired.md',
        paramsSummary: 'write',
        expectedImpact: 'writes expired.md',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      const expired = await stateFetch(h.base, h.token, `/api/v1/approvals/${expiredApproval.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved', expectedVersion: 1 }),
      })
      expect(expired.status).toBe(410)
      expect(expired.body).toMatchObject({ error: { code: 'APPROVAL_EXPIRED', retryable: false } })

      // Unknown approval → 404.
      const unknown = await stateFetch(h.base, h.token, '/api/v1/approvals/approval_ghost/decision', {
        method: 'POST',
        body: JSON.stringify({ decision: 'approved', expectedVersion: 1 }),
      })
      expect(unknown.status).toBe(404)
      expect(unknown.body).toMatchObject({ error: { code: 'APPROVAL_NOT_FOUND' } })

      // Invalid decision value → 400 INVALID_REQUEST.
      const invalid = await stateFetch(h.base, h.token, `/api/v1/approvals/${deniedApproval.id}/decision`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'maybe', expectedVersion: 1 }),
      })
      expect(invalid.status).toBe(400)
      expect(invalid.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
    } finally {
      await h.close()
    }
  })

  it('serves the ordered audit projection and redacts nothing sensitive', async () => {
    const h = await harness()
    try {
      const session = h.ctx.sessions.get(SessionId('session_approval'))!
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      const projection = await getJson(h.base, '/api/v1/sessions/session_approval/audit')
      expect(projection.status).toBe(200)
      const entries = (projection.body as { entries: { seq: number; category: string }[] }).entries
      expect(entries.map((entry) => entry.seq)).toEqual(session.events.map((event) => event.seq))
      expect(entries.some((entry) => entry.category === 'turn')).toBe(true)
      const missing = await getJson(h.base, '/api/v1/sessions/session_ghost/audit')
      expect(missing.status).toBe(404)

      // The envelope carries the full SPEC §4.7 shape (code/message/
      // retryable/details/requestId) and never leaks provider internals.
      const response = await fetch(`${h.base}/api/v1/approvals/approval_ghost/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': h.token },
        body: JSON.stringify({ decision: 'approved', expectedVersion: 1 }),
      })
      const envelope = (await response.json()) as { error: Record<string, unknown> }
      expect(envelope.error.code).toBe('APPROVAL_NOT_FOUND')
      expect(envelope.error.requestId).toMatch(/^req_/)
      expect(envelope.error).toHaveProperty('details')
      expect(envelope.error).toHaveProperty('retryable')
      // The error surface is a safe message only — no raw internals.
      expect(JSON.stringify(envelope)).not.toContain('SECRET_MARKER')
    } finally {
      await h.close()
    }
  })

  it('enforces same-origin Host, Origin and CSRF on state-modifying requests', async () => {
    const h = await harness()
    try {
      // Missing CSRF token → 403 envelope.
      const noToken = await fetch(`${h.base}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(noToken.status).toBe(403)
      expect((await noToken.json()) as unknown).toMatchObject({ error: { code: 'INVALID_REQUEST' } })

      // Wrong CSRF token → 403.
      const wrongToken = await fetch(`${h.base}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': 'wrong' },
        body: JSON.stringify({}),
      })
      expect(wrongToken.status).toBe(403)

      // Foreign Origin → 403.
      const foreignOrigin = await fetch(`${h.base}/api/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': h.token, origin: 'http://evil.example' },
        body: JSON.stringify({}),
      })
      expect(foreignOrigin.status).toBe(403)

      // A matching same-origin request passes validation and CSRF.
      const ok = await stateFetch(h.base, h.token, '/api/v1/sessions', {
        method: 'POST',
        body: JSON.stringify({ providerId: 'p', modelId: 'm', workspaceRoot: '/tmp/ws' }),
      })
      expect(ok.status).toBe(201)

      // A spoofed Host header → 403 (raw http to control the header).
      const spoofed = await new Promise<{ status: number }>((resolve, reject) => {
        const req = httpRequest({
          host: '127.0.0.1',
          port: new URL(h.base).port,
          path: '/api/v1/health',
          method: 'GET',
          headers: { host: 'evil.example' },
        }, (res) => {
          res.resume()
          res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
        })
        req.on('error', reject)
        req.end()
      })
      expect(spoofed.status).toBe(403)
    } finally {
      await h.close()
    }
  })
})
