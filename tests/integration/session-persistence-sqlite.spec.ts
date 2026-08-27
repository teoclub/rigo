import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@teoclub/cordis'
import { Session, SessionId, type SessionEvent, type SessionHeader } from '@teoclub/harness-session'
import { runCoordinatorContract, type CoordinatorFixture } from '../upstream/session-persistence/tests/coordinator-contract.ts'

/**
 * Issue 008: SQLite session persistence (SPEC §3.2, §3.8, §6.1, §8.1; PRD
 * US-004, FR-11/12/32, NFR-4). `node:sqlite` is Node-only, so this suite is
 * skipped under Bun; the shared coordinator orchestration contract (the
 * full upstream write-path suite) runs against the SQLite backend, plus
 * backend-specific storage tests: SPEC tables, per-event schema_version /
 * turn/step columns, atomic seq+write, retryable STORAGE_BUSY, restart
 * recovery consistency, and the 100,000-event reference load.
 */

const isBun = typeof Bun !== 'undefined'

type SqliteFace = typeof import('@teoclub/shared-session-persistence-sqlite')

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rigo-sess-persist-'))
}

describe.skipIf(isBun)('sqlite session persistence (Issue 008)', () => {
  // The complete shared orchestration contract: creation, event wiring,
  // fork seeds, adoption, collisions, crash-tail repair, reload, flush and
  // disposal quiescence — every scenario against real SQLite.
  runCoordinatorContract('sqlite', async (): Promise<CoordinatorFixture> => {
    const { default: SqliteSessionPersistence } = await import('@teoclub/shared-session-persistence-sqlite') as SqliteFace
    const dir = tempDir()
    return {
      mount: (ctx: Context) => ctx.plugin(SqliteSessionPersistence as never, { path: join(dir, 'rigo.sqlite') }),
      cleanup: async () => {
        rmSync(dir, { recursive: true, force: true })
      },
    }
  })

  it('creates the SPEC §3.2 sessions/session_events schema with constraints and indexes', async () => {
    const { SESSION_PERSISTENCE_MIGRATIONS } = await import('@teoclub/shared-session-persistence-sqlite') as SqliteFace
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const dir = tempDir()
    const driver = new NodeSqliteDriver(join(dir, 'rigo.sqlite'))
    try {
      const { runMigrations } = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
      runMigrations(driver, { migrations: SESSION_PERSISTENCE_MIGRATIONS })

      const tables = driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      ).map((row) => row.name)
      expect(tables).toContain('sessions')
      expect(tables).toContain('session_events')
      expect(tables).toContain('schema_migrations')

      const sessionColumns = driver.query<{ name: string }>('PRAGMA table_info(sessions)').map((row) => row.name)
      expect(sessionColumns).toEqual([
        'id', 'status', 'provider_id', 'model_id', 'title', 'workspace_root', 'metadata_json', 'created_at', 'updated_at',
      ])
      const eventColumns = driver.query<{ name: string }>('PRAGMA table_info(session_events)').map((row) => row.name)
      expect(eventColumns).toEqual([
        'session_id', 'seq', 'type', 'turn_id', 'step_id', 'schema_version', 'payload_json', 'created_at',
      ])
      const indexes = driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'session_events'",
      ).map((row) => row.name)
      expect(indexes).toContain('idx_session_events_turn')
      // The status CHECK constraint and the composite primary key are real.
      expect(() => driver.run("INSERT INTO sessions (id, status, created_at, updated_at) VALUES ('s1', 'bogus', 't', 't')")).toThrow()
    } finally {
      driver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('derives schema_version, turn_id and step_id columns through the Rigo protocol', async () => {
    const { default: SqliteSessionPersistence } = await import('@teoclub/shared-session-persistence-sqlite') as SqliteFace
    const { Context } = await import('@teoclub/cordis') as typeof import('@teoclub/cordis')
    const { SessionStore } = await import('@teoclub/harness-session') as typeof import('@teoclub/harness-session')
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteSessionPersistence as never, { path })
    try {
      const id = SessionId('session_cols')
      const session = ctx.sessions.create(id)
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)

      // Inspect the stored rows: schema_version is stamped per event and the
      // derived turn/step ids land in their dedicated columns.
      const probe = new NodeSqliteDriver(path)
      try {
        const rows = probe.query<{ seq: number; type: string; schema_version: number; turn_id: string | null; step_id: string | null }>(
          'SELECT seq, type, schema_version, turn_id, step_id FROM session_events ORDER BY seq',
        )
        expect(rows.map((row) => row.schema_version)).toEqual([1, 1, 1, 1])
        expect(rows[0]).toMatchObject({ type: 'turn/start', turn_id: `${id}:turn:1`, step_id: null })
        expect(rows[1]).toMatchObject({ type: 'step/start', turn_id: `${id}:turn:1`, step_id: `${id}:step:1:1` })
        expect(rows[3]).toMatchObject({ type: 'turn/end', turn_id: `${id}:turn:1` })
      } finally {
        probe.close()
      }
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('allocates seq and writes events in one transaction; duplicates and gaps cannot persist', async () => {
    const { default: SqliteSessionPersistence } = await import('@teoclub/shared-session-persistence-sqlite') as SqliteFace
    const { Context } = await import('@teoclub/cordis') as typeof import('@teoclub/cordis')
    const { SessionStore, SESSION_FORMAT_VERSION } = await import('@teoclub/harness-session') as typeof import('@teoclub/harness-session')
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteSessionPersistence as never, { path })
    try {
      const id = SessionId('session_atomic')
      const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 1 }
      const persistence = ctx.get('sessionPersistence') as unknown as {
        create(meta: SessionHeader): Promise<void>
        appendBatch(meta: SessionHeader, events: readonly SessionEvent[], materialized: boolean): Promise<void>
        load(id: SessionId): Promise<{ events: SessionEvent[] }>
      }
      await persistence.create(header)
      const good = [
        { type: 'turn/start' as const, seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end' as const, seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ]
      await persistence.appendBatch(header, good, false)
      // A duplicate batch (same first seq) is rejected inside the write
      // transaction: nothing partial can persist.
      await expect(persistence.appendBatch(header, good, true)).rejects.toThrow(/stored tail is 2/)
      // A gapped batch is rejected the same way.
      await expect(persistence.appendBatch(header, [
        { type: 'turn/start' as const, seq: 5, time: 3, data: { turn: 2 } },
      ], true)).rejects.toThrow(/stored tail is 2/)
      const loaded = await persistence.load(id)
      expect(loaded.events.map((event) => event.seq)).toEqual([0, 1])
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('maps SQLite lock timeouts to retryable STORAGE_BUSY without corrupting committed events', async () => {
    const { default: SqliteSessionPersistence, StorageBusyError } = await import('@teoclub/shared-session-persistence-sqlite') as SqliteFace
    const { Context } = await import('@teoclub/cordis') as typeof import('@teoclub/cordis')
    const { SessionStore } = await import('@teoclub/harness-session') as typeof import('@teoclub/harness-session')
    const { NodeSqliteDriver } = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // A short busy timeout makes the lock contention surface quickly.
    await ctx.plugin(SqliteSessionPersistence as never, { path, busyTimeoutMs: 50 })
    try {
      const id = SessionId('session_busy')
      const session = ctx.sessions.create(id)
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.sessions.flush(session)

      // A second connection holds an exclusive write lock.
      const locker = new NodeSqliteDriver(path)
      locker.exec('BEGIN EXCLUSIVE')
      try {
        const blocked = ctx.sessions.create(SessionId('session_busy_two'))
        blocked.append('turn/start', { turn: 1 })
        blocked.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await expect(ctx.sessions.flush(blocked)).rejects.toThrowError(StorageBusyError)
      } finally {
        locker.exec('ROLLBACK')
        locker.close()
      }
      // Committed events are intact and readable after the contention clears.
      const loaded = await ctx.sessionPersistence.load(id)
      expect(loaded.events).toHaveLength(2)
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('restarts with the identical projection and derived model history', async () => {
    const { default: SqliteSessionPersistence } = await import('@teoclub/shared-session-persistence-sqlite') as SqliteFace
    const { Context } = await import('@teoclub/cordis') as typeof import('@teoclub/cordis')
    const { SessionStore } = await import('@teoclub/harness-session') as typeof import('@teoclub/harness-session')
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const id = SessionId('session_restart')

    const firstCtx = new Context()
    await firstCtx.plugin(SessionStore)
    await firstCtx.plugin(SqliteSessionPersistence as never, { path })
    const firstSession = firstCtx.sessions.create(id)
    firstSession.append('turn/start', { turn: 1 })
    firstSession.append('step/start', { turn: 1, step: 1 })
    firstSession.append('step/end', { turn: 1, step: 1 })
    firstSession.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const historyBefore = firstSession.deriveMessages()
    await firstCtx.sessions.flush(firstSession)
    await firstCtx.fiber.dispose()

    const secondCtx = new Context()
    await secondCtx.plugin(SessionStore)
    await secondCtx.plugin(SqliteSessionPersistence as never, { path })
    try {
      const loaded = await secondCtx.sessionPersistence.load(id)
      expect(loaded.events.map((event) => event.seq)).toEqual([0, 1, 2, 3])
      // Replaying the stored log reconstructs the same session projection;
      // the replayed Session stamps its own end-seed marker (upstream
      // semantics), so the comparison is on the projection, not the marker.
      const replayed = Session.create(id, loaded.events)
      expect(replayed.deriveMessages()).toEqual(historyBefore)
      expect(replayed.events.slice(0, 4)).toEqual([...firstSession.events])
    } finally {
      await secondCtx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('handles the 100,000-event reference load (SPEC §8.1)', async () => {
    const { default: SqliteSessionPersistence } = await import('@teoclub/shared-session-persistence-sqlite') as SqliteFace
    const { Context } = await import('@teoclub/cordis') as typeof import('@teoclub/cordis')
    const { SessionStore, SESSION_FORMAT_VERSION } = await import('@teoclub/harness-session') as typeof import('@teoclub/harness-session')
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SqliteSessionPersistence as never, { path })
    try {
      const id = SessionId('session_100k')
      const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: 1 }
      const persistence = ctx.get('sessionPersistence') as unknown as {
        create(meta: SessionHeader): Promise<void>
      } & { appendBatch(meta: SessionHeader, events: readonly SessionEvent[], materialized: boolean): Promise<void> }
      const backend = persistence as typeof persistence & {
        appendBatch(meta: SessionHeader, events: readonly SessionEvent[], materialized: boolean): Promise<void>
      }
      await persistence.create(header)
      // 50,000 completed turns = 100,000 boundary events.
      const events: SessionEvent[] = []
      for (let turn = 1; turn <= 50_000; turn += 1) {
        const seq = (turn - 1) * 2
        events.push({ type: 'turn/start', seq, time: seq + 1, data: { turn } })
        events.push({ type: 'turn/end', seq: seq + 1, time: seq + 2, data: { turn, reason: { kind: 'completed' } } })
      }
      const started = Date.now()
      // Write in one durable batch transaction (storage-layer reference load).
      await backend.appendBatch(header, events, false)
      const stored = await ctx.sessionPersistence.load(id)
      const elapsed = Date.now() - started
      expect(stored.events).toHaveLength(100_000)
      expect(stored.events[99_999]!.seq).toBe(99_999)
      // Reference-load sanity bound: far below any interactive threshold.
      expect(elapsed).toBeLessThan(30_000)
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
