import { Context } from '@teoclub/cordis'
import { SessionId, isJsonValue, type SessionEvent, type SessionHeader } from '@teoclub/harness-session'
import {
  PersistenceCoordinator,
  SessionPersistence,
  SessionPersistenceRevision,
  type PersistenceBackend,
  type SessionPersistenceSnapshot,
  type StoredPrefix,
} from '@teoclub/harness-session-persistence'

/**
 * Test-only replacement for the dropped `@deepseek-ai/dsh-session-persistence-jsonl`
 * provider (PRD D-003: SQLite is Rigo's only shipped session persistence). The
 * upstream agent-loop suites that boot a durable harness use the JSONL backend
 * purely as a reload-surviving store keyed by a temp directory; this helper
 * provides the same shape - `ctx.plugin(MemoryPersistence, { root })` - backed
 * by a Map shared per `root` string, the in-memory analogue of reopening one
 * directory (same pattern as the session-persistence contract tests).
 */

/** The durable store shape: materialized sessions only (no lazy entries). */
export type MemoryStore = Map<string, { meta: SessionHeader; events: SessionEvent[] }>

/** One store per root path, so contexts opened over the same root share history. */
const storesByRoot = new Map<string, MemoryStore>()

/** Optional plugin config, shape-compatible with the dropped JSONL provider's. */
export interface MemoryConfig {
  /** Directory-like key identifying the shared store. */
  root?: string
  /** An external store, when the caller manages sharing directly. */
  store?: MemoryStore
}

/** Test-store revision that changes for any metadata or event mutation. */
function memoryRevision(entry: { meta: SessionHeader; events: SessionEvent[] }): SessionPersistenceRevision {
  return SessionPersistenceRevision(JSON.stringify(entry))
}

export default class MemoryPersistence extends SessionPersistence implements PersistenceBackend<never> {
  override readonly supportsRawArtifacts = false

  static inject = ['sessions']

  override readonly name = 'session-persistence-memory'

  /** The whole durable store: materialized sessions only (no lazy entries). */
  private store: MemoryStore
  private coordinator: PersistenceCoordinator<never>

  constructor(ctx: Context, config?: MemoryConfig) {
    super(ctx)
    // Assign the store BEFORE constructing the coordinator: the coordinator's
    // constructor installs the write path and synchronously seeds existing live
    // sessions through loadStored(), so store must exist first.
    const key = config?.root ?? ''
    this.store = config?.store ?? (storesByRoot.get(key) ?? (() => {
      const created: MemoryStore = new Map()
      storesByRoot.set(key, created)
      return created
    })())
    this.coordinator = new PersistenceCoordinator<never>(this.ctx, this)
  }

  // --- Service API (delegated to the coordinator) ---

  locate(_meta: SessionHeader): undefined {
    return undefined
  }

  create(m: SessionHeader): Promise<void> {
    return this.coordinator.create(m)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): ReturnType<PersistenceCoordinator['prepare']> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.load(id).then(loaded => ({ meta: loaded.meta, events: [...loaded.events] }))
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.inspect(id, signal)
      .then(loaded => ({ meta: loaded.meta, events: [...loaded.events] }))
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  // --- PersistenceBackend hooks (the Map storage primitives) ---

  // A Map-backed store has no torn tails, so `tornMarker` is never set.
  async loadStored(id: SessionId): Promise<StoredPrefix<never> | undefined> {
    const entry = this.store.get(id)
    if (!entry) return undefined
    return {
      meta: structuredClone(entry.meta),
      events: structuredClone(entry.events),
      revision: memoryRevision(entry),
    }
  }

  async readStoredRevision(id: SessionId): Promise<SessionPersistenceRevision | undefined> {
    const entry = this.store.get(id)
    return entry === undefined ? undefined : memoryRevision(entry)
  }

  async appendBatch(m: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean): Promise<void> {
    // Defense-in-depth: the coordinator already validates serializability, but a
    // durable store must reject non-JSON data at its own boundary too.
    for (const e of events) {
      if (!isJsonValue(e.data)) throw new Error(`event "${e.type}" carries non-JSON-serializable data`)
    }
    const existing = this.store.get(m.id)
    if (!existing) {
      // The coordinator sends the first batch for materialization; later batches append.
      this.store.set(m.id, { meta: structuredClone(m), events: structuredClone(events) as SessionEvent[] })
    } else {
      existing.events.push(...structuredClone(events) as SessionEvent[])
    }
  }

  async commitRepair(m: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    // No torn tails in a Map store, so `_tornMarker` is always undefined; only the
    // synthetic closers are appended (the same DELETE+INSERT a DB backend does,
    // minus the truncate).
    const entry = this.store.get(m.id)
    /* v8 ignore next -- commitRepair only runs for a materialized (stored) session */
    if (!entry) return
    if (closers.length > 0) entry.events.push(...structuredClone(closers) as SessionEvent[])
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    return [...this.store.values()].map(e => structuredClone(e.meta))
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    return [...this.store.values()].map(entry => ({
      header: structuredClone(entry.meta),
      revision: memoryRevision(entry),
    }))
  }
}
