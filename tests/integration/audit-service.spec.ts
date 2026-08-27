/**
 * Issue 024 integration: Audit Service (SPEC §3.7, §6.3, §7.4, §9.1;
 * PRD US-013, FR-22, FR-33, FR-34).
 *
 * Fully runtime-agnostic: audit facts ride the in-memory session log.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import {
  ACTION_EXECUTED_EVENT_TYPE,
  APPROVAL_AUDIT_EVENT_TYPE,
  AuditService,
  normalizeError,
  REDACTED_PLACEHOLDER,
  redactValue,
  sensitivePaths,
  summarize,
} from '@teoclub/shared-audit'
import {
  KNOWN_SESSION_EVENT_TYPES,
  Session,
  SessionId,
  SESSION_FORMAT_VERSION,
} from '@teoclub/harness-session'

function makeSession(id = 'session_audit'): Session {
  return Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: Date.now(),
  })
}

describe('audit redaction and normalization (Issue 024)', () => {
  it('redacts credential fields at every nesting level without touching safe fields', () => {
    const input = {
      name: 'safe value',
      config: {
        apiKey: 'sk-123456',
        password: 'hunter2',
        Authorization: 'Bearer abc',
        nested: { clientSecret: 's3cr3t', proxy_authorization: 'basic x' },
        items: [{ token: 'tok-1' }, { label: 'kept' }],
      },
      'X-Cookie': 'sid=1',
      ok: true,
    }
    const redacted = redactValue(input) as Record<string, unknown>
    const config = redacted.config as Record<string, unknown>
    expect(config.apiKey).toBe(REDACTED_PLACEHOLDER)
    expect(config.password).toBe(REDACTED_PLACEHOLDER)
    expect(config.Authorization).toBe(REDACTED_PLACEHOLDER)
    expect(config.nested).toEqual({ clientSecret: REDACTED_PLACEHOLDER, proxy_authorization: REDACTED_PLACEHOLDER })
    expect((config.items as unknown[])[0]).toEqual({ token: REDACTED_PLACEHOLDER })
    expect((config.items as unknown[])[1]).toEqual({ label: 'kept' })
    expect(redacted['X-Cookie']).toBe(REDACTED_PLACEHOLDER)
    expect(redacted.name).toBe('safe value')
    expect(redacted.ok).toBe(true)
    // The source object is untouched (detached copy).
    expect(input.config.apiKey).toBe('sk-123456')
    expect(sensitivePaths(input)).toContain('config.apiKey')
    expect(sensitivePaths(input)).toContain('config.nested.clientSecret')
    expect(sensitivePaths(input)).not.toContain('name')
    // Scalars and arrays pass through.
    expect(redactValue('plain')).toBe('plain')
    expect(redactValue([1, 'two', { key: 'v' }])).toEqual([1, 'two', { key: 'v' }])
  })

  it('normalizes errors into safe records, never raw provider responses', () => {
    const error = new Error('boom')
    ;(error as Error & { code: string }).code = 'DOCUMENT_NOT_FOUND'
    expect(normalizeError(error)).toEqual({ message: 'boom', code: 'DOCUMENT_NOT_FOUND' })
    expect(normalizeError('string failure')).toEqual({ message: 'string failure' })
    // An arbitrary provider response object must never leak its fields.
    expect(normalizeError({ raw: 'provider payload', secret: 'x' })).toEqual({ message: 'unknown error' })
    expect(normalizeError(undefined)).toEqual({ message: 'unknown error' })
    const dom = new DOMException('aborted', 'AbortError')
    expect(normalizeError(dom)).toEqual({ message: 'aborted', name: 'AbortError' })
  })

  it('summarizes redacted bounded one-liners and rejects unserializable values', () => {
    expect(summarize({ action: 'write-doc', apiKey: 'sk-x', path: 'a.md' }))
      .toBe('{"action":"write-doc","apiKey":"[REDACTED]","path":"a.md"}')
    const long = summarize({ payload: 'x'.repeat(500) }, 60)
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long.endsWith('…')).toBe(true)
    const circular: Record<string, unknown> = { self: undefined }
    circular.self = circular
    expect(() => summarize(circular)).toThrow(TypeError)
  })
})

describe('audit service (Issue 024)', () => {
  it('records action executions with redacted summaries, status, result and duration', async () => {
    const ctx = new Context()
    await ctx.plugin(AuditService)
    try {
      const session = makeSession()
      const running = ctx.audit.recordActionExecution(session, {
        executionId: 'action_e1',
        action: 'write-doc',
        sessionId: session.id,
        status: 'running',
        input: { path: 'docs/plan.md', content: 'new', credential: 'sk-should-never-leak' },
      })
      expect(running.type).toBe(ACTION_EXECUTED_EVENT_TYPE)
      expect(running.data.inputSummary).toContain(REDACTED_PLACEHOLDER)
      expect(running.data.inputSummary).not.toContain('sk-should-never-leak')
      ctx.audit.recordActionExecution(session, {
        executionId: 'action_e1',
        action: 'write-doc',
        sessionId: session.id,
        status: 'succeeded',
        input: { path: 'docs/plan.md', content: 'new' },
        result: { written: true, token: 'res-token' },
        durationMs: 42,
      })
      const facts = session.events.filter((event) => event.type === ACTION_EXECUTED_EVENT_TYPE)
      expect(facts).toHaveLength(2)
      const done = facts[1]!.data
      expect(done).toMatchObject({ status: 'succeeded', durationMs: 42, executionId: 'action_e1' })
      expect(done.resultSummary).toContain(REDACTED_PLACEHOLDER)
      expect(done.resultSummary).not.toContain('res-token')
      expect(KNOWN_SESSION_EVENT_TYPES.has(ACTION_EXECUTED_EVENT_TYPE)).toBe(true)
      expect(KNOWN_SESSION_EVENT_TYPES.has(APPROVAL_AUDIT_EVENT_TYPE)).toBe(true)
      // The raw event payload is JSON-safe (lossless round trip).
      expect(JSON.parse(JSON.stringify(done))).toEqual(done)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records approval decisions with request, decision, time and handler', async () => {
    const ctx = new Context()
    await ctx.plugin(AuditService)
    try {
      const session = makeSession()
      ctx.audit.recordApprovalDecision(session, {
        approvalId: 'approval_a1',
        actionName: 'write-doc',
        sessionId: session.id,
        request: { target: 'docs/plan.md', paramsSummary: 'overwrite', authorization: 'Bearer leaked' },
        decision: 'approved',
        decidedAt: '2026-08-25T10:00:00.000Z',
        handledBy: 'user@rigo',
      })
      const event = session.events.at(-1)!
      expect(event.type).toBe(APPROVAL_AUDIT_EVENT_TYPE)
      expect(event.data).toMatchObject({
        approvalId: 'approval_a1',
        actionName: 'write-doc',
        decision: 'approved',
        decidedAt: '2026-08-25T10:00:00.000Z',
        handledBy: 'user@rigo',
      })
      expect(event.data.requestSummary).toContain(REDACTED_PLACEHOLDER)
      expect(event.data.requestSummary).not.toContain('Bearer leaked')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('gates external writes on a successful audit record (SPEC §6.3)', async () => {
    const ctx = new Context()
    await ctx.plugin(AuditService)
    try {
      const session = makeSession()
      let executed = 0
      const externalWrite = {
        run() {
          executed += 1
        },
      }
      // The host flow: record `running` BEFORE the external write starts.
      const circular: Record<string, unknown> = { path: 'x' }
      circular.self = circular
      expect(() => ctx.audit.recordActionExecution(session, {
        executionId: 'action_gate',
        action: 'external-write',
        sessionId: session.id,
        status: 'running',
        input: circular, // unserializable → the audit write fails
      })).toThrow(TypeError)
      // The failed audit write MUST prevent the side effect from starting.
      expect(executed).toBe(0)
      expect(session.events.some((event) => event.type === ACTION_EXECUTED_EVENT_TYPE)).toBe(false)
      // With a valid input the gate opens and the write proceeds.
      ctx.audit.recordActionExecution(session, {
        executionId: 'action_gate',
        action: 'external-write',
        sessionId: session.id,
        status: 'running',
        input: { path: 'x' },
      })
      externalWrite.run()
      ctx.audit.recordActionExecution(session, {
        executionId: 'action_gate',
        action: 'external-write',
        sessionId: session.id,
        status: 'succeeded',
        input: { path: 'x' },
        result: { ok: true },
        durationMs: 5,
      })
      expect(executed).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('projects the log into seq-ordered entries with correlatable identifiers', async () => {
    const ctx = new Context()
    await ctx.plugin(AuditService)
    try {
      const session = makeSession()
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      ctx.audit.recordActionExecution(session, {
        executionId: 'action_p1',
        action: 'write-doc',
        sessionId: session.id,
        status: 'succeeded',
        input: { path: 'a.md' },
        result: { ok: true },
        durationMs: 7,
      })
      ctx.audit.recordApprovalDecision(session, {
        approvalId: 'approval_p1',
        actionName: 'write-doc',
        sessionId: session.id,
        request: { target: 'a.md' },
        decision: 'approved',
        decidedAt: 'now',
        handledBy: 'user',
      })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      const entries = ctx.audit.project(session)
      expect(entries.map((entry) => entry.seq)).toEqual(session.events.map((event) => event.seq))
      // The session's end-seed marker projects as `other` (seq 0).
      expect(entries.map((entry) => entry.category)).toEqual([
        'other', 'turn', 'step', 'action', 'approval', 'turn',
      ])
      expect(entries[1]).toMatchObject({ correlationId: 'turn:1', summary: 'turn 1 started' })
      expect(entries[2]).toMatchObject({ correlationId: 'turn:1#step:1', summary: 'step 1.1 started' })
      expect(entries[3]).toMatchObject({
        correlationId: 'execution:action_p1',
        summary: 'action write-doc succeeded (7ms)',
        sessionId: session.id,
      })
      expect(entries[4]).toMatchObject({
        correlationId: 'approval:approval_p1',
        summary: 'approval approval_p1 approved by user',
      })
      expect(entries[5]).toMatchObject({ correlationId: 'turn:1', summary: 'turn 1 completed' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('orders multi-session projections by session then seq and covers retrieval/doc events', async () => {
    const ctx = new Context()
    await ctx.plugin(AuditService)
    try {
      const a = makeSession('session_a')
      const b = makeSession('session_b')
      // Session b first chronologically; projection must group by session.
      b.append('turn/start', { turn: 1 })
      a.append('turn/start', { turn: 1 })
      a.append('knowledge/retrieved', {
        querySummary: 'rockets',
        queryBytes: 7,
        status: 'found',
        sourceIds: ['sqlite-fts#docs/rockets.md#0'],
        topK: 8,
      })
      a.append('document/read', { sessionId: 'session_a', documentId: 'docs/rockets.md', source: '/ws/docs/rockets.md' })

      const entries = ctx.audit.projectAll([a, b])
      expect(entries.map((entry) => entry.sessionId)).toEqual([
        'session_a', 'session_a', 'session_a', 'session_a', 'session_b', 'session_b',
      ])
      expect(entries[0]!.category).toBe('other') // end-seed marker
      expect(entries[1]).toMatchObject({ category: 'turn', correlationId: 'turn:1' })
      expect(entries[2]).toMatchObject({
        category: 'retrieval',
        correlationId: 'query:rockets',
        summary: 'retrieved 1 sources for "rockets"',
      })
      expect(entries[3]).toMatchObject({
        category: 'document',
        correlationId: 'document:docs/rockets.md',
        summary: 'read docs/rockets.md',
      })
      expect(entries[4]!.sessionId).toBe('session_b')
      // Within each session the seq order is preserved.
      for (let i = 1; i < entries.length; i += 1) {
        if (entries[i]!.sessionId === entries[i - 1]!.sessionId) {
          expect(entries[i]!.seq).toBeGreaterThan(entries[i - 1]!.seq)
        }
      }
      // Unknown event types project as `other` with a stable summary.
      const weird = makeSession('session_weird')
      weird.append('todo/write', { entries: [] })
      const other = ctx.audit.project(weird).find((entry) => entry.summary.includes('todo/write'))!
      expect(other.category).toBe('other')
      expect(other.summary).toBe('event todo/write')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
