/**
 * Issue 023 integration: Approval Service (SPEC §3.3, §4.6, §5.4, §5.6,
 * §5.7; PRD US-012, FR-19, FR-20).
 *
 * Node-only: the approvals table lives in the SQLite session database.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION, KNOWN_SESSION_EVENT_TYPES } from '@teoclub/harness-session'

type NodeSqliteDriver = import('@teoclub/shared-storage-sqlite-node/node').NodeSqliteDriver
type ActionDefinition = import('@teoclub/shared-actions').ActionDefinition

interface NodeModules {
  ActionsService: typeof import('@teoclub/shared-actions').ActionsService
  ACTION_MIGRATIONS: typeof import('@teoclub/shared-actions').ACTION_MIGRATIONS
  ApprovalsService: typeof import('@teoclub/shared-approvals').ApprovalsService
  APPROVAL_MIGRATIONS: typeof import('@teoclub/shared-approvals').APPROVAL_MIGRATIONS
  APPROVAL_REQUESTED_EVENT_TYPE: typeof import('@teoclub/shared-approvals').APPROVAL_REQUESTED_EVENT_TYPE
  APPROVAL_RESOLVED_EVENT_TYPE: typeof import('@teoclub/shared-approvals').APPROVAL_RESOLVED_EVENT_TYPE
  ApprovalAlreadyDecidedError: typeof import('@teoclub/shared-approvals').ApprovalAlreadyDecidedError
  ApprovalExpiredError: typeof import('@teoclub/shared-approvals').ApprovalExpiredError
  ApprovalNotFoundError: typeof import('@teoclub/shared-approvals').ApprovalNotFoundError
  DEFAULT_APPROVAL_TTL_MS: typeof import('@teoclub/shared-approvals').DEFAULT_APPROVAL_TTL_MS
  NodeSqliteDriver: NodeSqliteDriver
  runMigrations: typeof import('@teoclub/shared-storage-sqlite-node/definition').runMigrations
  SESSION_PERSISTENCE_MIGRATIONS: typeof import('@teoclub/shared-session-persistence-sqlite').SESSION_PERSISTENCE_MIGRATIONS
}

describe.skipIf(typeof Bun !== 'undefined')('approval service (Node)', async () => {
  // Bun evaluates describe callbacks even for skipped suites, so the
  // node:sqlite imports must never execute under Bun: gate the loader.
  const nodeMods = typeof Bun === 'undefined' ? await loadNodeModules() : undefined

  async function loadNodeModules(): Promise<NodeModules> {
    const actions = await import('@teoclub/shared-actions') as typeof import('@teoclub/shared-actions')
    const approvals = await import('@teoclub/shared-approvals') as typeof import('@teoclub/shared-approvals')
    const storage = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const definition = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const session = await import('@teoclub/shared-session-persistence-sqlite') as typeof import('@teoclub/shared-session-persistence-sqlite')
    return {
      ActionsService: actions.ActionsService,
      ACTION_MIGRATIONS: actions.ACTION_MIGRATIONS,
      ApprovalsService: approvals.ApprovalsService,
      APPROVAL_MIGRATIONS: approvals.APPROVAL_MIGRATIONS,
      APPROVAL_REQUESTED_EVENT_TYPE: approvals.APPROVAL_REQUESTED_EVENT_TYPE,
      APPROVAL_RESOLVED_EVENT_TYPE: approvals.APPROVAL_RESOLVED_EVENT_TYPE,
      ApprovalAlreadyDecidedError: approvals.ApprovalAlreadyDecidedError,
      ApprovalExpiredError: approvals.ApprovalExpiredError,
      ApprovalNotFoundError: approvals.ApprovalNotFoundError,
      DEFAULT_APPROVAL_TTL_MS: approvals.DEFAULT_APPROVAL_TTL_MS,
      NodeSqliteDriver: storage.NodeSqliteDriver,
      runMigrations: definition.runMigrations,
      SESSION_PERSISTENCE_MIGRATIONS: session.SESSION_PERSISTENCE_MIGRATIONS,
    }
  }

  function mods(): NodeModules {
    if (nodeMods === undefined) throw new Error('node modules unavailable')
    return nodeMods
  }

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rigo-approvals-'))
  }

  function openDriver(path: string): NodeSqliteDriver {
    const m = mods()
    const driver = new m.NodeSqliteDriver(path)
    m.runMigrations(driver, {
      migrations: [...m.SESSION_PERSISTENCE_MIGRATIONS, ...m.ACTION_MIGRATIONS, ...m.APPROVAL_MIGRATIONS],
    })
    return driver
  }

  function seedSession(driver: NodeSqliteDriver, id = 'session_approval'): void {
    driver.run(
      "INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES (?, 'active', '{}', 'now', 'now')",
      [id],
    )
  }

  function writeAction(log?: { executed: number }, sideEffect: ActionDefinition['sideEffect'] = 'local-write'): ActionDefinition {
    return {
      name: 'write-doc',
      description: 'writes a document',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      sideEffect,
      execute(input) {
        if (log !== undefined) log.executed += 1
        return { written: (input as { path: string }).path }
      },
    }
  }

  function makeSession(id = 'session_approval_events'): Session {
    return Session.create(SessionId(id), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: Date.now(),
    })
  }

  it('creates the SPEC §3.3 schema with constraints and the unique execution link', async () => {
    const dir = tempDir()
    const driver = openDriver(join(dir, 'rigo.sqlite'))
    try {
      seedSession(driver)
      const tables = driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'",
      )
      expect(tables).toHaveLength(1)
      const insert = (id: string, execution: string) => driver.run(
        `INSERT INTO approvals (id, session_id, action_execution_id, state, request_json, version, created_at, expires_at)
         VALUES (?, 'session_approval', ?, 'pending', '{}', 1, 'now', 'later')`,
        [id, execution],
      )
      insert('ap-1', 'exec-1')
      // UNIQUE action_execution_id.
      expect(() => insert('ap-2', 'exec-1')).toThrow(/UNIQUE/i)
      // CHECK on state.
      expect(() => driver.run(
        `INSERT INTO approvals (id, session_id, action_execution_id, state, request_json, version, created_at, expires_at)
         VALUES ('ap-3', 'session_approval', 'exec-3', 'thinking', '{}', 1, 'now', 'later')`,
      )).toThrow(/CHECK/i)
      // sessions FK.
      expect(() => driver.run(
        `INSERT INTO approvals (id, session_id, action_execution_id, state, request_json, version, created_at, expires_at)
         VALUES ('ap-4', 'ghost', 'exec-4', 'pending', '{}', 1, 'now', 'later')`,
      )).toThrow(/FOREIGN KEY/i)
    } finally {
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('requires approval for writes BEFORE execution and resumes on approve', async () => {
    const dir = tempDir()
    const driver = openDriver(join(dir, 'rigo.sqlite'))
    const ctx = new Context()
    try {
      seedSession(driver)
      const log = { executed: 0 }
      await ctx.plugin(mods().ActionsService, { driver })
      await ctx.plugin(mods().ApprovalsService, { driver })
      ctx.actions.registerAction(writeAction(log))

      // The write is suspended before execution; the approval is created.
      const suspended = await ctx.actions.execute({
        action: 'write-doc',
        input: { path: 'docs/plan.md', content: 'new plan' },
        idempotencyKey: 'key-write-1',
        sessionId: 'session_approval',
      })
      expect(suspended.status).toBe('requires-approval')
      if (suspended.status !== 'requires-approval') throw new Error('unreachable')
      expect(log.executed).toBe(0)

      const approval = await ctx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: suspended.executionId,
        actionName: 'write-doc',
        target: 'docs/plan.md',
        paramsSummary: 'write new plan content',
        expectedImpact: 'overwrites docs/plan.md',
      })
      expect(approval.state).toBe('pending')
      expect(approval.version).toBe(1)
      expect(approval.actionName).toBe('write-doc')
      expect(approval.target).toBe('docs/plan.md')
      expect(approval.paramsSummary).toBe('write new plan content')
      expect(approval.expectedImpact).toBe('overwrites docs/plan.md')
      expect(log.executed).toBe(0)

      // Approve: the action resumes and executes exactly once.
      const resolved = await ctx.approvals.decide(approval.id, { decision: 'approved', expectedVersion: 1 })
      expect(resolved.approval.state).toBe('approved')
      expect(resolved.approval.version).toBe(2)
      expect(resolved.approval.decidedAt).toBeDefined()
      expect(resolved.execution).toMatchObject({ status: 'completed', action: 'write-doc' })
      expect(log.executed).toBe(1)
      expect(ctx.actions.getExecution('write-doc', 'key-write-1')!.state).toBe('succeeded')

      // A read action runs without any approval.
      const readLog = { executed: 0 }
      ctx.actions.registerAction({
        ...writeAction(readLog),
        name: 'read-doc',
        sideEffect: 'local-read',
        execute: () => {
          readLog.executed += 1
          return { ok: true }
        },
      })
      const read = await ctx.actions.execute({
        action: 'read-doc', input: { path: 'x', content: 'y' }, idempotencyKey: 'key-read', sessionId: 'session_approval',
      })
      expect(read.status).toBe('completed')
      expect(readLog.executed).toBe(1)
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies the pending-only one-shot state machine with optimistic decisions', async () => {
    const dir = tempDir()
    const driver = openDriver(join(dir, 'rigo.sqlite'))
    const ctx = new Context()
    try {
      seedSession(driver)
      await ctx.plugin(mods().ActionsService, { driver })
      await ctx.plugin(mods().ApprovalsService, { driver })
      ctx.actions.registerAction(writeAction())
      const suspended = await ctx.actions.execute({
        action: 'write-doc', input: { path: 'a.md', content: 'x' }, idempotencyKey: 'key-sm', sessionId: 'session_approval',
      })
      if (suspended.status !== 'requires-approval') throw new Error('unreachable')
      const approval = await ctx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: suspended.executionId,
        actionName: 'write-doc',
        target: 'a.md',
        paramsSummary: 'x',
        expectedImpact: 'writes a.md',
      })
      // First decision with the correct version succeeds.
      await ctx.approvals.decide(approval.id, { decision: 'approved', expectedVersion: 1 })
      // A duplicate decision is rejected.
      await expect(ctx.approvals.decide(approval.id, { decision: 'approved', expectedVersion: 2 }))
        .rejects.toThrowError(mods().ApprovalAlreadyDecidedError)
      // A stale version is rejected the same way.
      await expect(ctx.approvals.decide(approval.id, { decision: 'denied', expectedVersion: 1 }))
        .rejects.toMatchObject({ code: 'APPROVAL_ALREADY_DECIDED', retryable: false })
      // Unknown ids raise APPROVAL_NOT_FOUND.
      await expect(ctx.approvals.decide('ghost', { decision: 'approved', expectedVersion: 1 }))
        .rejects.toMatchObject({ code: 'APPROVAL_NOT_FOUND' })
      expect(ctx.approvals.get(approval.id)!.state).toBe('approved')
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('denies without executing and expires overdue requests', async () => {
    const dir = tempDir()
    const driver = openDriver(join(dir, 'rigo.sqlite'))
    const ctx = new Context()
    try {
      seedSession(driver)
      const log = { executed: 0 }
      await ctx.plugin(mods().ActionsService, { driver })
      await ctx.plugin(mods().ApprovalsService, { driver })
      ctx.actions.registerAction(writeAction(log))

      // Denied: the action never executes and its row is cancelled.
      const deniedExec = await ctx.actions.execute({
        action: 'write-doc', input: { path: 'deny.md', content: 'x' }, idempotencyKey: 'key-deny', sessionId: 'session_approval',
      })
      if (deniedExec.status !== 'requires-approval') throw new Error('unreachable')
      const denied = await ctx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: deniedExec.executionId,
        actionName: 'write-doc',
        target: 'deny.md',
        paramsSummary: 'x',
        expectedImpact: 'writes deny.md',
      })
      const deniedOutcome = await ctx.approvals.decide(denied.id, { decision: 'denied', expectedVersion: 1, comment: 'not needed' })
      expect(deniedOutcome.approval.state).toBe('denied')
      expect(deniedOutcome.approval.decision).toContain('not needed')
      expect(log.executed).toBe(0)
      expect(ctx.actions.getExecution('write-doc', 'key-deny')!.state).toBe('cancelled')

      // Expired: deciding an overdue request raises APPROVAL_EXPIRED and
      // transitions the row; the action never runs.
      const expiredExec = await ctx.actions.execute({
        action: 'write-doc', input: { path: 'late.md', content: 'x' }, idempotencyKey: 'key-expire', sessionId: 'session_approval',
      })
      if (expiredExec.status !== 'requires-approval') throw new Error('unreachable')
      const expired = await ctx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: expiredExec.executionId,
        actionName: 'write-doc',
        target: 'late.md',
        paramsSummary: 'x',
        expectedImpact: 'writes late.md',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      await expect(ctx.approvals.decide(expired.id, { decision: 'approved', expectedVersion: 1 }))
        .rejects.toThrowError(mods().ApprovalExpiredError)
      expect(ctx.approvals.get(expired.id)!.state).toBe('expired')
      expect(log.executed).toBe(0)
      expect(ctx.actions.getExecution('write-doc', 'key-expire')!.state).toBe('cancelled')

      // Cancelled decisions behave like denials.
      const cancelExec = await ctx.actions.execute({
        action: 'write-doc', input: { path: 'c.md', content: 'x' }, idempotencyKey: 'key-cancel', sessionId: 'session_approval',
      })
      if (cancelExec.status !== 'requires-approval') throw new Error('unreachable')
      const cancelled = await ctx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: cancelExec.executionId,
        actionName: 'write-doc',
        target: 'c.md',
        paramsSummary: 'x',
        expectedImpact: 'writes c.md',
      })
      await ctx.approvals.decide(cancelled.id, { decision: 'cancelled', expectedVersion: 1 })
      expect(ctx.approvals.get(cancelled.id)!.state).toBe('cancelled')
      expect(log.executed).toBe(0)
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('revalidates the action on approval and fails instead of executing', async () => {
    const dir = tempDir()
    const driver = openDriver(join(dir, 'rigo.sqlite'))
    const ctx = new Context()
    try {
      seedSession(driver)
      const log = { executed: 0 }
      await ctx.plugin(mods().ActionsService, { driver })
      await ctx.plugin(mods().ApprovalsService, { driver })
      const dispose = ctx.actions.registerAction(writeAction(log))
      const suspended = await ctx.actions.execute({
        action: 'write-doc', input: { path: 'a.md', content: 'x' }, idempotencyKey: 'key-revalidate', sessionId: 'session_approval',
      })
      if (suspended.status !== 'requires-approval') throw new Error('unreachable')
      const approval = await ctx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: suspended.executionId,
        actionName: 'write-doc',
        target: 'a.md',
        paramsSummary: 'x',
        expectedImpact: 'writes a.md',
      })
      // The action plugin unloads while the request is pending: approval
      // revalidation fails, nothing executes.
      dispose()
      await expect(ctx.approvals.decide(approval.id, { decision: 'approved', expectedVersion: 1 }))
        .rejects.toMatchObject({ code: 'ACTION_NOT_FOUND' })
      expect(log.executed).toBe(0)
      expect(ctx.approvals.get(approval.id)!.state).toBe('approved')
      expect(ctx.actions.getExecution('write-doc', 'key-revalidate')!.state).toBe('awaiting-approval')
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reloads pending approvals after a restart and keeps the waiting progress', async () => {
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const session = makeSession()
    const firstCtx = new Context()
    const firstDriver = openDriver(path)
    let executionId = ''
    try {
      seedSession(firstDriver)
      const log = { executed: 0 }
      await firstCtx.plugin(mods().ActionsService, { driver: firstDriver })
      await firstCtx.plugin(mods().ApprovalsService, { driver: firstDriver })
      firstCtx.actions.registerAction(writeAction(log))
      const suspended = await firstCtx.actions.execute({
        action: 'write-doc', input: { path: 'a.md', content: 'x' }, idempotencyKey: 'key-restart', sessionId: 'session_approval',
      })
      if (suspended.status !== 'requires-approval') throw new Error('unreachable')
      executionId = suspended.executionId
      const approval = await firstCtx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: executionId,
        actionName: 'write-doc',
        target: 'a.md',
        paramsSummary: 'x',
        expectedImpact: 'writes a.md',
        session,
      })
      expect(approval.id).toMatch(/^approval_/)
      // The request is recorded in the session event log (waiting progress).
      const requested = session.events.filter((event) => event.type === mods().APPROVAL_REQUESTED_EVENT_TYPE).at(-1)!
      expect(requested.data).toMatchObject({
        approvalId: approval.id,
        sessionId: 'session_approval',
        actionName: 'write-doc',
        actionExecutionId: executionId,
      })
      expect(KNOWN_SESSION_EVENT_TYPES.has(mods().APPROVAL_REQUESTED_EVENT_TYPE)).toBe(true)
      expect(KNOWN_SESSION_EVENT_TYPES.has(mods().APPROVAL_RESOLVED_EVENT_TYPE)).toBe(true)
    } finally {
      await firstCtx.fiber.dispose()
      firstDriver.close()
    }

    // "Restart": a fresh context over the same database.
    const secondCtx = new Context()
    const secondDriver = openDriver(path)
    try {
      await secondCtx.plugin(mods().ActionsService, { driver: secondDriver })
      await secondCtx.plugin(mods().ApprovalsService, { driver: secondDriver })
      const pending = secondCtx.approvals.listPending('session_approval')
      expect(pending).toHaveLength(1)
      expect(pending[0]!.actionExecutionId).toBe(executionId)
      expect(pending[0]!.state).toBe('pending')
      // The reloaded approval can still be decided and resumed.
      const log = { executed: 0 }
      secondCtx.actions.registerAction(writeAction(log))
      const resolved = await secondCtx.approvals.decide(pending[0]!.id, { decision: 'approved', expectedVersion: 1, session })
      expect(resolved.approval.state).toBe('approved')
      expect(resolved.execution).toMatchObject({ status: 'completed' })
      expect(log.executed).toBe(1)
      // The resolution landed in the session log too.
      const decided = session.events.filter((event) => event.type === mods().APPROVAL_RESOLVED_EVENT_TYPE).at(-1)!
      expect(decided.data).toMatchObject({ approvalId: pending[0]!.id, outcome: 'approved' })
      expect(secondCtx.approvals.listPending('session_approval')).toEqual([])
      // The default TTL applies when the caller omits an expiry.
      const fresh = await secondCtx.approvals.create({
        sessionId: 'session_approval',
        actionExecutionId: 'exec-ttl',
        actionName: 'write-doc',
        target: 'b.md',
        paramsSummary: 'x',
        expectedImpact: 'writes b.md',
      })
      const ttlMs = Date.parse(fresh.expiresAt) - Date.parse(fresh.createdAt)
      expect(ttlMs).toBeCloseTo(mods().DEFAULT_APPROVAL_TTL_MS, -2)
    } finally {
      await secondCtx.fiber.dispose()
      secondDriver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
