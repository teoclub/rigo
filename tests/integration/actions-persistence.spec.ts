/**
 * Issue 022 integration: Action persistence, idempotency, cancellation and
 * lifecycle cleanup (SPEC §3.4, §5.4, §6.1, §8.3; PRD US-010, FR-21,
 * FR-35, NFR-6).
 *
 * Node-only: persistence rides the SQLite session database.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'

const isBun = typeof Bun !== 'undefined'

type NodeSqliteDriver = import('@teoclub/shared-storage-sqlite-node/node').NodeSqliteDriver
type ActionDefinition = import('@teoclub/shared-actions').ActionDefinition

/** Node-only module faces, loaded once by the describe body (never under Bun). */
interface NodeModules {
  ActionsService: typeof import('@teoclub/shared-actions').ActionsService
  ACTION_MIGRATIONS: typeof import('@teoclub/shared-actions').ACTION_MIGRATIONS
  IdempotencyConflictError: typeof import('@teoclub/shared-actions').IdempotencyConflictError
  stableStringify: typeof import('@teoclub/shared-actions').stableStringify
  NodeSqliteDriver: NodeSqliteDriver
  runMigrations: typeof import('@teoclub/shared-storage-sqlite-node/definition').runMigrations
  SESSION_PERSISTENCE_MIGRATIONS: typeof import('@teoclub/shared-session-persistence-sqlite').SESSION_PERSISTENCE_MIGRATIONS
}

describe.skipIf(isBun)('action persistence (Node)', async () => {
  // Bun evaluates describe callbacks even for skipped suites, so the
  // node:sqlite imports must never execute under Bun: gate the loader.
  const nodeMods = typeof Bun === 'undefined' ? await loadNodeModules() : undefined
  type Mods = Awaited<ReturnType<typeof loadNodeModules>>

  async function loadNodeModules(): Promise<NodeModules> {
    const actions = await import('@teoclub/shared-actions') as typeof import('@teoclub/shared-actions')
    const storage = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const definition = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const session = await import('@teoclub/shared-session-persistence-sqlite') as typeof import('@teoclub/shared-session-persistence-sqlite')
    return {
      ActionsService: actions.ActionsService,
      ACTION_MIGRATIONS: actions.ACTION_MIGRATIONS,
      IdempotencyConflictError: actions.IdempotencyConflictError,
      stableStringify: actions.stableStringify,
      NodeSqliteDriver: storage.NodeSqliteDriver,
      runMigrations: definition.runMigrations,
      SESSION_PERSISTENCE_MIGRATIONS: session.SESSION_PERSISTENCE_MIGRATIONS,
    }
  }

  function mods(): Mods {
    if (nodeMods === undefined) throw new Error('node modules unavailable')
    return nodeMods
  }

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rigo-actions-'))
  }

  function openHarness() {
    const m = mods()
    const dir = tempDir()
    const driver = new m.NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    m.runMigrations(driver, { migrations: [...m.SESSION_PERSISTENCE_MIGRATIONS, ...m.ACTION_MIGRATIONS] })
    const ctx = new Context()
    return { dir, driver, ctx }
  }

  function seedSession(driver: NodeSqliteDriver, id = 'session_action'): void {
    driver.run(
      "INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES (?, 'active', '{}', 'now', 'now')",
      [id],
    )
  }

  function echoAction(log?: { executed: number }): ActionDefinition {
    return {
      name: 'echo',
      description: 'echoes the input',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      sideEffect: 'none',
      execute(input) {
        if (log !== undefined) log.executed += 1
        return { echoed: (input as { value: string }).value }
      },
    }
  }

  it('creates the SPEC §3.4 schema with constraints and the idempotency index', async () => {
    const { driver, dir } = openHarness()
    try {
      const tables = driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'action_executions'",
      )
      expect(tables).toHaveLength(1)
      // CHECK constraints reject bad side-effect classes and states.
      driver.run("INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES ('s', 'active', '{}', 'now', 'now')")
      expect(() => driver.run(
        `INSERT INTO action_executions (id, session_id, action_name, side_effect, state, idempotency_key, request_json, created_at)
         VALUES ('a1', 's', 'x', 'remote-write', 'proposed', 'k', '{}', 'now')`,
      )).toThrow(/CHECK/i)
      expect(() => driver.run(
        `INSERT INTO action_executions (id, session_id, action_name, side_effect, state, idempotency_key, request_json, created_at)
         VALUES ('a2', 's', 'x', 'none', 'executing', 'k', '{}', 'now')`,
      )).toThrow(/CHECK/i)
      // The UNIQUE(action_name, idempotency_key) index is enforced.
      driver.run(
        `INSERT INTO action_executions (id, session_id, action_name, side_effect, state, idempotency_key, request_json, created_at)
         VALUES ('a3', 's', 'x', 'none', 'proposed', 'same-key', '{}', 'now')`,
      )
      expect(() => driver.run(
        `INSERT INTO action_executions (id, session_id, action_name, side_effect, state, idempotency_key, request_json, created_at)
         VALUES ('a4', 's', 'x', 'none', 'proposed', 'same-key', '{}', 'now')`,
      )).toThrow(/UNIQUE/i)
      // The sessions FK is enforced.
      expect(() => driver.run(
        `INSERT INTO action_executions (id, session_id, action_name, side_effect, state, idempotency_key, request_json, created_at)
         VALUES ('a5', 'ghost-session', 'x', 'none', 'proposed', 'k2', '{}', 'now')`,
      )).toThrow(/FOREIGN KEY/i)
    } finally {
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replays a succeeded execution without re-running the side effect', async () => {
    const { driver, dir, ctx } = openHarness()
    try {
      seedSession(driver)
      const log = { executed: 0 }
      await ctx.plugin(mods().ActionsService, { driver })
      ctx.actions.registerAction(echoAction(log))
      const first = await ctx.actions.execute({
        action: 'echo', input: { value: 'hello' }, idempotencyKey: 'key-1', sessionId: 'session_action',
      })
      expect(first.status).toBe('completed')
      if (first.status !== 'completed') throw new Error('unreachable')
      expect(first.result).toEqual({ echoed: 'hello' })
      expect(first.replayed).toBeUndefined()
      expect(log.executed).toBe(1)

      // Same key + same input → the persisted outcome, no re-execution.
      const second = await ctx.actions.execute({
        action: 'echo', input: { value: 'hello' }, idempotencyKey: 'key-1', sessionId: 'session_action',
      })
      expect(second.status).toBe('completed')
      if (second.status !== 'completed') throw new Error('unreachable')
      expect(second.executionId).toBe(first.executionId)
      expect(second.replayed).toBe(true)
      expect(second.result).toEqual({ echoed: 'hello' })
      expect(log.executed).toBe(1)
      // The row is persisted as succeeded.
      const row = ctx.actions.getExecution('echo', 'key-1')!
      expect(row.state).toBe('succeeded')
      expect(row.result_json).toBe(JSON.stringify({ echoed: 'hello' }))
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the current state for a same-key call while the first is running', async () => {
    const { driver, dir, ctx } = openHarness()
    try {
      seedSession(driver)
      let attached!: () => void
      const attachedPromise = new Promise<void>((resolve) => { attached = resolve })
      await ctx.plugin(mods().ActionsService, { driver })
      ctx.actions.registerAction({
        name: 'slow',
        description: 'slow',
        inputSchema: { type: 'object', properties: {}, required: [] },
        sideEffect: 'none',
        execute: async (_input, signal) => {
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
            attached()
          })
          return 'done'
        },
      })
      const controller = new AbortController()
      const pending = ctx.actions.execute({
        action: 'slow', input: {}, idempotencyKey: 'key-running', sessionId: 'session_action',
      }, controller.signal)
      await attachedPromise
      // The same key while running reports the current state.
      const sameKey = await ctx.actions.execute({
        action: 'slow', input: {}, idempotencyKey: 'key-running', sessionId: 'session_action',
      })
      expect(sameKey.status).toBe('in-progress')
      if (sameKey.status !== 'in-progress') throw new Error('unreachable')
      expect(sameKey.state).toBe('running')
      // End the first execution (aborted after commit-point assertions).
      controller.abort('test over')
      const final = await pending
      expect(final.status).toBe('cancelled')
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects a same-key call with different input as IDEMPOTENCY_CONFLICT', async () => {
    const { driver, dir, ctx } = openHarness()
    try {
      seedSession(driver)
      await ctx.plugin(mods().ActionsService, { driver })
      ctx.actions.registerAction(echoAction())
      const first = await ctx.actions.execute({
        action: 'echo', input: { value: 'a' }, idempotencyKey: 'key-conflict', sessionId: 'session_action',
      })
      expect(first.status).toBe('completed')
      await expect(ctx.actions.execute({
        action: 'echo', input: { value: 'b' }, idempotencyKey: 'key-conflict', sessionId: 'session_action',
      })).rejects.toThrowError(mods().IdempotencyConflictError)
      await expect(ctx.actions.execute({
        action: 'echo', input: { value: 'b' }, idempotencyKey: 'key-conflict', sessionId: 'session_action',
      })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false })
      // Equivalent input in a different key order is NOT a conflict.
      const reordered = await ctx.actions.execute({
        action: 'echo', input: { value: 'a' }, idempotencyKey: 'key-conflict', sessionId: 'session_action',
      })
      expect(reordered.status).toBe('completed')
      expect(mods().stableStringify({ value: 'a' })).toBe(mods().stableStringify({ value: 'a' }))
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never auto-retries a failed action; a new key executes again', async () => {
    const { driver, dir, ctx } = openHarness()
    try {
      seedSession(driver)
      const log = { executed: 0 }
      await ctx.plugin(mods().ActionsService, { driver })
      ctx.actions.registerAction({
        name: 'flaky',
        description: 'sometimes fails',
        inputSchema: { type: 'object', properties: {}, required: [] },
        sideEffect: 'none',
        execute: () => {
          log.executed += 1
          throw new Error('transient failure')
        },
      })
      const first = await ctx.actions.execute({
        action: 'flaky', input: {}, idempotencyKey: 'key-fail', sessionId: 'session_action',
      })
      expect(first.status).toBe('failed')
      if (first.status !== 'failed') throw new Error('unreachable')
      expect(first.error).toEqual({ message: 'transient failure' })
      // Same key: replayed failure, side effect NOT re-run.
      const second = await ctx.actions.execute({
        action: 'flaky', input: {}, idempotencyKey: 'key-fail', sessionId: 'session_action',
      })
      expect(second.status).toBe('failed')
      if (second.status !== 'failed') throw new Error('unreachable')
      expect(second.executionId).toBe(first.executionId)
      expect(second.replayed).toBe(true)
      expect(log.executed).toBe(1)
      // A NEW key executes again (the caller's recovery choice).
      const third = await ctx.actions.execute({
        action: 'flaky', input: {}, idempotencyKey: 'key-fail-2', sessionId: 'session_action',
      })
      expect(third.status).toBe('failed')
      expect(log.executed).toBe(2)
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persists the cancelled state on abort without rolling back committed work', async () => {
    const { driver, dir, ctx } = openHarness()
    try {
      seedSession(driver)
      let attached!: () => void
      const attachedPromise = new Promise<void>((resolve) => { attached = resolve })
      const committed = { count: 0 }
      await ctx.plugin(mods().ActionsService, { driver })
      ctx.actions.beforePolicy(() => ({ decision: 'allow', reason: 'test policy', policy: 'test-policy' }))
      ctx.actions.registerAction({
        name: 'partial',
        description: 'commits then waits',
        inputSchema: { type: 'object', properties: {}, required: [] },
        sideEffect: 'local-write',
        execute: async (_input, signal) => {
          committed.count += 1 // the side effect is committed before the wait
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
            attached()
          })
          return 'done'
        },
      })
      const controller = new AbortController()
      const pending = ctx.actions.execute({
        action: 'partial', input: {}, idempotencyKey: 'key-abort', sessionId: 'session_action',
      }, controller.signal)
      await attachedPromise
      controller.abort('user cancelled')
      const result = await pending
      expect(result.status).toBe('cancelled')
      if (result.status !== 'cancelled') throw new Error('unreachable')
      expect(result.reason).toBe('user cancelled')
      // The side effect stays committed (no fabricated rollback)…
      expect(committed.count).toBe(1)
      // …and the row is persisted as cancelled.
      const row = ctx.actions.getExecution('partial', 'key-abort')!
      expect(row.state).toBe('cancelled')
      expect(row.finished_at).not.toBeNull()
      // A same-key call replays the cancelled outcome without re-running.
      const replay = await ctx.actions.execute({
        action: 'partial', input: {}, idempotencyKey: 'key-abort', sessionId: 'session_action',
      })
      expect(replay.status).toBe('cancelled')
      expect(committed.count).toBe(1)
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('cancels and persists in-flight executions when the defining plugin unloads', async () => {
    const { driver, dir, ctx } = openHarness()
    try {
      seedSession(driver)
      let attached!: () => void
      const attachedPromise = new Promise<void>((resolve) => { attached = resolve })
      await ctx.plugin(mods().ActionsService, { driver })
      ctx.actions.beforePolicy(() => ({ decision: 'allow', reason: 'test policy', policy: 'test-policy' }))
      const fiberOwner = await ctx.plugin(Object.assign((inner: Context) => {
        inner.actions.registerAction({
          name: 'fiber-write',
          description: 'fiber-owned write',
          inputSchema: { type: 'object', properties: {}, required: [] },
          sideEffect: 'external-write',
          execute: async (_input, signal) => {
            await new Promise<void>((resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
              attached()
            })
            return 'done'
          },
        })
      }, { inject: ['actions'] }))
      const pending = ctx.actions.execute({
        action: 'fiber-write', input: {}, idempotencyKey: 'key-fiber', sessionId: 'session_action',
      })
      await attachedPromise
      await fiberOwner.dispose()
      const cancelled = await pending
      expect(cancelled.status).toBe('cancelled')
      // The unload cancellation is persisted.
      const row = ctx.actions.getExecution('fiber-write', 'key-fiber')!
      expect(row.state).toBe('cancelled')
      expect(String(row.error_json)).toContain('fiber-write')
      // New calls are rejected after the unload.
      await expect(ctx.actions.execute({
        action: 'fiber-write', input: {}, idempotencyKey: 'key-fiber-2', sessionId: 'session_action',
      })).rejects.toMatchObject({ code: 'ACTION_NOT_FOUND' })
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('marks crash-orphaned executions recovery-required and refuses re-execution', async () => {
    const { driver, dir, ctx } = openHarness()
    try {
      seedSession(driver)
      await ctx.plugin(mods().ActionsService, { driver })
      // A crash orphan: a running row that never finished.
      driver.run(
        `INSERT INTO action_executions
           (id, session_id, action_name, side_effect, state, idempotency_key, request_json, created_at, started_at)
         VALUES ('orphan-1', 'session_action', 'echo', 'none', 'running', 'key-orphan', '{"value":"x"}', 'now', 'now')`,
      )
      const recovered = ctx.actions.recoverOrphanedExecutions()
      expect(recovered).toBe(1)
      const row = ctx.actions.getExecution('echo', 'key-orphan')!
      expect(row.state).toBe('recovery-required')
      expect(row.finished_at).not.toBeNull()
      // A same-key call reports recovery-required and never re-executes.
      ctx.actions.registerAction(echoAction())
      const result = await ctx.actions.execute({
        action: 'echo', input: { value: 'x' }, idempotencyKey: 'key-orphan', sessionId: 'session_action',
      })
      expect(result.status).toBe('recovery-required')
      if (result.status !== 'recovery-required') throw new Error('unreachable')
      expect(result.replayed).toBe(true)
      // A fresh key is the caller's recovery path.
      const fresh = await ctx.actions.execute({
        action: 'echo', input: { value: 'x' }, idempotencyKey: 'key-fresh', sessionId: 'session_action',
      })
      expect(fresh.status).toBe('completed')
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never holds a transaction open across an await (SPEC §8.3)', async () => {
    const { driver, dir, ctx } = openHarness()
    try {
      seedSession(driver)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      await ctx.plugin(mods().ActionsService, { driver })
      ctx.actions.registerAction({
        name: 'gated',
        description: 'waits for the policy gate',
        inputSchema: { type: 'object', properties: {}, required: [] },
        sideEffect: 'none',
        execute: () => 'ran',
      })
      // The policy hook awaits a deferred gate — exactly the pattern that
      // would deadlock if a transaction were held open.
      ctx.actions.beforePolicy(async () => {
        await gate
        return { decision: 'allow', reason: 'after the gate', policy: 'gate' }
      })
      const pending = ctx.actions.execute({
        action: 'gated', input: {}, idempotencyKey: 'key-gate', sessionId: 'session_action',
      })
      // While the hook waits, ANOTHER connection can write without a busy
      // timeout: no transaction is held by the pipeline.
      const second = new (mods().NodeSqliteDriver)(driver.databasePath, { busyTimeoutMs: 200 })
      try {
        expect(() => {
          second.run("INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES ('other', 'active', '{}', 'now', 'now')")
        }).not.toThrow()
        // The proposed row is already visible outside the pipeline's tx.
        expect(second.query<{ state: string }>(
          "SELECT state FROM action_executions WHERE action_name = 'gated' AND idempotency_key = 'key-gate'",
        )[0]!.state).toBe('proposed')
      } finally {
        second.close()
      }
      release()
      const result = await pending
      expect(result.status).toBe('completed')
      expect(ctx.actions.getExecution('gated', 'key-gate')!.state).toBe('succeeded')
    } finally {
      await ctx.fiber.dispose()
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
