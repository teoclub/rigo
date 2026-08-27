/**
 * Rigo SQLite session persistence backend (Issue 008; SPEC §3.2, §3.8,
 * §6.1, §8.1; PRD US-004, FR-11/FR-12/FR-32, NFR-4; PRD D-003: SQLite is
 * the only official session persistence provider).
 *
 * Implements the ported {@link SessionPersistence} seam over the Issue 007
 * storage foundation:
 *
 *   - SPEC §3.2 `sessions` + `session_events` tables (turn_id, step_id and
 *     per-event `schema_version` columns derived through the Rigo session
 *     protocol);
 *   - sequence allocation and the event write commit in ONE transaction
 *     (per-batch atomicity; a crash never leaves a materialized-but-empty
 *     session or a partial batch);
 *   - reload projects the identical log and derived history (append-only
 *     tail, frozen rows); interrupted-turn crash recovery is the
 *     coordinator's cold-repair path over `commitRepair`;
 *   - SQLite lock timeouts surface as a retryable `STORAGE_BUSY` error and
 *     never corrupt committed events (WAL + short transactions + the
 *     coordinator's write-behind);
 *   - seek-capable `readFrom` (suffix read by seq);
 *   - the 100,000-event reference load (SPEC §8.1) is exercised in the
 *     integration suite.
 *
 * Node-only (node:sqlite); the runtime-agnostic storage definition stays in
 * @teoclub/shared-storage-sqlite-node/definition.
 *
 * @module @teoclub/shared-session-persistence-sqlite
 */

import { Context } from '@teoclub/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@teoclub/harness-session'
import {
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
} from '@teoclub/harness-session-persistence'
import { RIGO_EVENT_SCHEMA_VERSION, stepId, turnId } from '@teoclub/harness-session-protocol'
import {
  openRigoStorage,
  type StorageDriver,
  type StorageMigration,
} from '@teoclub/shared-storage-sqlite-node'

/** SPEC §3.2 schema as the first migration of the persistence database. */
export const SESSION_PERSISTENCE_MIGRATIONS: StorageMigration[] = [
  {
    version: 1,
    name: 'session-tables',
    sql: `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('active', 'closed')),
  -- provider/model/title arrive with the API layer (Issue 028); the core
  -- session model does not carry them, so they stay nullable until then.
  provider_id TEXT,
  model_id TEXT,
  title TEXT,
  -- The session's workspace root (header.cwd). Sessions without a cwd exist
  -- in the core model, so this is nullable (SPEC keeps it NOT NULL for
  -- API-created sessions).
  workspace_root TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE session_events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  turn_id TEXT,
  step_id TEXT,
  schema_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, seq),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE INDEX idx_session_events_turn
  ON session_events(session_id, turn_id, seq);
`,
  },
]

/** Retryable SQLite lock-timeout error (SPEC §6.1 `STORAGE_BUSY`, 503, retryable). */
export class StorageBusyError extends Error {
  readonly code = 'STORAGE_BUSY'
  readonly retryable = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'StorageBusyError'
  }
}

/** SQLITE_BUSY (5) / SQLITE_LOCKED (6) surface as a retryable busy error. */
function isBusyError(error: unknown): boolean {
  const candidate = error as { code?: string; errcode?: number; message?: string }
  return candidate?.errcode === 5 || candidate?.errcode === 6
    || (typeof candidate?.message === 'string'
      && (candidate.message.includes('database is locked') || candidate.message.includes('database table is locked')))
}

export interface SqlitePersistenceConfig {
  /** Database path (`:memory:` supported); defaults to `:memory:`. */
  path?: string
  /** Prebuilt driver (bypasses opening; the caller owns its lifecycle). */
  driver?: StorageDriver
  /** Busy timeout in ms (default 5000; low values exercise STORAGE_BUSY). */
  busyTimeoutMs?: number
  /** Migrations to run before the backend serves (defaults to the SPEC §3.2 set). */
  migrations?: StorageMigration[]
}

interface StoredRow extends Record<string, unknown> {
  id: string
  status: string
  provider_id: string | null
  model_id: string | null
  title: string | null
  workspace_root: string | null
  metadata_json: string
  created_at: string
  updated_at: string
}

interface EventRow extends Record<string, unknown> {
  session_id: string
  seq: number
  type: string
  turn_id: string | null
  step_id: string | null
  schema_version: number
  payload_json: string
  created_at: string
}

/** Reconstruct the durable header from the metadata_json column (its source of truth). */
function headerFromRow(row: StoredRow): SessionHeader {
  const stored = JSON.parse(row.metadata_json) as SessionHeader & { id?: string }
  if (stored.id !== row.id) {
    throw new Error(`session "${row.id}": stored header id mismatch`)
  }
  return stored
}

/**
 * The SQLite session persistence backend. Mount via
 * `ctx.plugin(SqliteSessionPersistence, { path })`; the coordinator (and the
 * write-behind batching) is constructed on mount, migrations run before the
 * backend serves anything.
 */
export default class SqliteSessionPersistence extends SessionPersistence implements PersistenceBackend<never> {
  override readonly supportsRawArtifacts = false

  static inject = ['sessions']

  override readonly name = 'session-persistence-sqlite'

  private readonly driver: StorageDriver
  private readonly coordinator: PersistenceCoordinator<never>

  constructor(ctx: Context, config: SqlitePersistenceConfig = {}) {
    super(ctx)
    if (config.driver !== undefined) {
      this.driver = config.driver
    } else {
      const opened = openRigoStorage(config.path ?? ':memory:', {
        ...(config.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: config.busyTimeoutMs }),
        migrations: config.migrations ?? SESSION_PERSISTENCE_MIGRATIONS,
      })
      this.driver = opened.driver
    }
    // The coordinator's constructor installs the write path and synchronously
    // seeds existing live sessions; the driver must exist first (done above).
    // The coordinator owns disposal: its dispose effect drains the write-behind
    // to quiescence and then calls `backend.close()` — the database must stay
    // open until that drain commits.
    this.coordinator = new PersistenceCoordinator(this.ctx, this)
  }

  /** Called by the coordinator after the final drain reaches quiescence. */
  async close(): Promise<void> {
    this.driver.close()
  }

  locate(): undefined {
    return undefined
  }

  // --- Service API (delegated to the coordinator) ---

  create(meta: SessionHeader): Promise<void> {
    return this.coordinator.create(meta)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): ReturnType<PersistenceCoordinator['prepare']> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.load(id).then((loaded) => ({ meta: loaded.meta, events: [...loaded.events] }))
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.inspect(id, signal)
      .then((loaded) => ({ meta: loaded.meta, events: [...loaded.events] }))
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    return this.withBusy(() => {
      return this.driver.query<StoredRow>('SELECT * FROM sessions ORDER BY id').map(headerFromRow)
    })
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    return this.withBusy(() => {
      return this.driver.query<StoredRow & { event_count: number; last_seq: number | null }>(
        `SELECT s.*, (SELECT COUNT(*) FROM session_events e WHERE e.session_id = s.id) AS event_count,
                (SELECT MAX(seq) FROM session_events e WHERE e.session_id = s.id) AS last_seq
         FROM sessions s ORDER BY s.id`,
      ).map((row) => ({
        header: headerFromRow(row),
        revision: this.revision(row, row.event_count, row.last_seq ?? undefined)!,
      }))
    })
  }

  // --- PersistenceBackend hooks (SQLite storage primitives) ---

  /** Revision token: source-qualified, changes on any metadata or event mutation. */
  private revision(row: Pick<StoredRow, 'updated_at'> | undefined, count: number, lastSeq: number | undefined): SessionPersistenceRevision | undefined {
    if (row === undefined) return undefined
    return SessionPersistenceRevision(`${this.driver.databasePath}|${row.updated_at}|${count}|${lastSeq ?? -1}`)
  }

  private withBusy<T>(operation: () => T): T {
    try {
      return operation()
    } catch (error) {
      if (isBusyError(error)) {
        throw new StorageBusyError(`storage is busy (SQLite lock timeout): ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      throw error
    }
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    signal?.throwIfAborted()
    return this.withBusy(() => {
      const rows = this.driver.query<StoredRow>(
        'SELECT * FROM sessions WHERE id = ?', [id],
      )
      if (rows.length === 0) return undefined
      const row = rows[0]!
      const events = this.driver.query<EventRow>(
        'SELECT * FROM session_events WHERE session_id = ? ORDER BY seq', [id],
      ).map((eventRow) => JSON.parse(eventRow.payload_json) as SessionEvent)
      const count = events.length
      const lastSeq = count > 0 ? events[count - 1]!.seq : undefined
      return {
        meta: headerFromRow(row),
        events,
        revision: this.revision(row, count, lastSeq)!,
      }
    })
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    return this.withBusy(() => {
      const rows = this.driver.query<Pick<StoredRow, 'updated_at'>>(
        'SELECT updated_at FROM sessions WHERE id = ?', [id],
      )
      if (rows.length === 0) return undefined
      const count = this.driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?', [id])[0]!.n
      const lastSeq = count > 0
        ? this.driver.query<{ seq: number }>('SELECT seq FROM session_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1', [id])[0]!.seq
        : undefined
      return this.revision(rows[0]!, count, lastSeq)
    })
  }

  async loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] } | undefined> {
    signal?.throwIfAborted()
    return this.withBusy(() => {
      const rows = this.driver.query<StoredRow>('SELECT * FROM sessions WHERE id = ?', [id])
      if (rows.length === 0) return undefined
      const row = rows[0]!
      const events = this.driver.query<EventRow>(
        'SELECT * FROM session_events WHERE session_id = ? AND seq >= ? ORDER BY seq', [id, fromSeq],
      ).map((eventRow) => JSON.parse(eventRow.payload_json) as SessionEvent)
      return { meta: headerFromRow(row), events }
    })
  }

  async appendBatch(meta: SessionHeader, events: readonly SessionEvent[], isMaterialized: boolean): Promise<void> {
    for (const event of events) {
      if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
        throw new Error(`event "${event.type}" carries invalid seq ${event.seq}`)
      }
    }
    this.withBusy(() => {
      this.driver.transaction(() => {
        const now = new Date().toISOString()
        const storedMeta = JSON.stringify(meta)
        if (isMaterialized) {
          this.driver.run(
            'UPDATE sessions SET status = ?, workspace_root = ?, metadata_json = ?, updated_at = ? WHERE id = ?',
            ['active', meta.cwd ?? null, storedMeta, now, meta.id],
          )
        } else {
          this.driver.run(
            `INSERT INTO sessions (id, status, workspace_root, metadata_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [meta.id, 'active', meta.cwd ?? null, storedMeta, now, now],
          )
        }
        // Sequence allocation and the event write commit in the SAME
        // transaction: the first event must continue the stored tail.
        const count = this.driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?', [meta.id])[0]!.n
        if (events.length > 0 && events[0]!.seq !== count) {
          throw new Error(
            `session "${meta.id}": batch starts at seq ${events[0]!.seq}, stored tail is ${count} (duplicate or gapped append)`,
          )
        }
        // Derive turn/step ids and schema version through the Rigo protocol.
        // A stored event's data may be null (a malformed legacy record the
        // coordinator will reject on load); never crash the write path on it.
        let openTurn: number | undefined
        let openStep: number | undefined
        for (const event of events) {
          const scoped = event.data as { turn?: number; step?: number } | null
          if (event.type === 'turn/start') openTurn = scoped?.turn
          else if (event.type === 'step/start') openStep = scoped?.step
          else if (event.type === 'step/end') openStep = undefined
          else if (event.type === 'turn/end') {
            openTurn = undefined
            openStep = undefined
          }
          const turn = scoped?.turn ?? openTurn
          const step = scoped?.step ?? openStep
          this.driver.run(
            `INSERT INTO session_events (session_id, seq, type, turn_id, step_id, schema_version, payload_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              meta.id,
              event.seq,
              event.type,
              turn === undefined ? null : turnId(meta.id, turn),
              turn === undefined || step === undefined ? null : stepId(meta.id, turn, step),
              RIGO_EVENT_SCHEMA_VERSION,
              JSON.stringify(event),
              new Date(event.time).toISOString(),
            ],
          )
        }
      })
    })
  }

  async commitRepair(meta: SessionHeader, tornMarker: never | undefined, closers: readonly SessionEvent[]): Promise<void> {
    // SQLite transactions are atomic: a torn tail (tornMarker) cannot exist
    // (the memory backend has the same property). Only synthetic closers land.
    void tornMarker
    if (closers.length === 0) return
    await this.appendBatch(meta, closers, true)
  }

}
