/**
 * Issue 029 integration: SSE event stream (SPEC §4.5, §6.2, §8.2; PRD
 * US-014, US-015, FR-28, FR-31, FR-32).
 *
 * Live-streaming/replay over the in-memory facade is dual-runtime; the
 * SQLite persisted-replay and 1,000-event latency suites are Node-only.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'
import { SessionStore, SessionId, type Session } from '@teoclub/harness-session'
import type { PublicAgent } from '@teoclub/harness-agent-protocol'
import { RuntimeFacade } from '@teoclub/api-sdk'
import { createApiServer, sseReconnectDelay, SSE_RECONNECT_BACKOFF_MS, type ApiServer } from '@teoclub/api-http'

const isBun = typeof Bun !== 'undefined'

interface SseFrame {
  id: number
  event: string
  data: unknown
}

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

async function liveServer(): Promise<{ base: string; ctx: Context; facade: RuntimeFacade; sessionId: string }> {
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
  const created = await facade.createSession({ cwd: '/tmp/sse-workspace' })
  return { base: `http://127.0.0.1:${port}`, ctx, facade, sessionId: created.sessionId }
}

afterEach(async () => {
  while (openServers.length > 0) {
    const handle = openServers.pop()!
    await handle.api.close()
    await handle.ctx.fiber.dispose()
  }
})

/** Read SSE frames until `until` is satisfied (then abort the connection). */
async function collectSse(
  base: string,
  path: string,
  until: (frames: SseFrame[]) => boolean,
  lastEventId?: number,
): Promise<SseFrame[]> {
  const controller = new AbortController()
  const response = await fetch(`${base}${path}`, {
    headers: {
      accept: 'text/event-stream',
      ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }),
    },
    signal: controller.signal,
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: SseFrame[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const id = Number.parseInt(raw.match(/^id: (.+)$/m)?.[1] ?? '-1', 10)
        const event = raw.match(/^event: (.+)$/m)?.[1] ?? ''
        const dataLine = raw.match(/^data: (.+)$/m)?.[1]
        frames.push({ id, event, data: dataLine === undefined ? undefined : JSON.parse(dataLine) })
        if (until(frames)) {
          controller.abort()
          break
        }
      }
      if (until(frames)) break
    }
  } catch {
    // AbortError on the reader after the controller aborts.
  }
  return frames
}

function eventFrames(frames: SseFrame[]): SseFrame[] {
  return frames.filter((frame) => frame.event === 'session.event')
}

describe('sse event stream (Issue 029)', () => {
  it('opens with a snapshot frame and streams canonical event frames', async () => {
    const { base, ctx, sessionId } = await liveServer()
    const session = ctx.sessions.get(SessionId(sessionId))!
    session.append('turn/start', { turn: 1 })
    const frames = await collectSse(base, `/api/v1/sessions/${sessionId}/events`, (list) => {
      return eventFrames(list).length >= 1
    })
    expect(frames[0]!.event).toBe('session.snapshot')
    expect(frames[0]!.id).toBe(-1)
    const events = eventFrames(frames)
    expect(events).toHaveLength(1)
    expect(events[0]!.id).toBe(0)
    expect(events[0]!.data).toMatchObject({ sessionId, seq: 0, type: 'turn/start', payload: { turn: 1 } })
  })

  it('delivers newly appended events live and replays from Last-Event-ID', async () => {
    const { base, ctx, sessionId } = await liveServer()
    const session = ctx.sessions.get(SessionId(sessionId))!
    const collector = collectSse(base, `/api/v1/sessions/${sessionId}/events`, (list) => {
      return eventFrames(list).length >= 2
    })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const first = await collector
    const firstEvents = eventFrames(first)
    expect(firstEvents.map((frame) => frame.id)).toEqual([0, 1])
    expect(firstEvents[0]!.data).toMatchObject({ type: 'turn/start', payload: { turn: 1 } })
    expect(firstEvents[1]!.data).toMatchObject({ type: 'turn/end' })

    // A reconnect with Last-Event-ID = 1 replays only what follows.
    session.append('step/start', { turn: 2, step: 1 })
    const replay = await collectSse(
      base,
      `/api/v1/sessions/${sessionId}/events`,
      (list) => eventFrames(list).length >= 1,
      1,
    )
    const replayEvents = eventFrames(replay)
    expect(replayEvents).toHaveLength(1)
    expect(replayEvents[0]!.id).toBe(2)
    expect(replayEvents[0]!.data).toMatchObject({ type: 'step/start' })
  })

  it('survives disconnects: the agent keeps running and reconnects lose nothing', async () => {
    const { base, ctx, facade, sessionId } = await liveServer()
    const session = ctx.sessions.get(SessionId(sessionId))!
    const firstCollector = collectSse(base, `/api/v1/sessions/${sessionId}/events`, (list) => {
      return eventFrames(list).length >= 2
    })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const first = await firstCollector
    const firstIds = eventFrames(first).map((frame) => frame.id)
    // While "disconnected", the agent keeps running and appends events.
    facade.sendMessage(sessionId, 'keep going')
    expect(facade.getSession(sessionId)!.agentStatus).toBe('running')
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    // Reconnect with the last delivered seq: the missed events replay once.
    const lastId = firstIds[firstIds.length - 1]!
    const second = await collectSse(
      base,
      `/api/v1/sessions/${sessionId}/events`,
      (list) => eventFrames(list).length >= 2,
      lastId,
    )
    const secondIds = eventFrames(second).map((frame) => frame.id)
    expect(secondIds).toEqual([lastId + 1, lastId + 2])
    // The union covers every seq exactly once (no loss, no duplicates).
    const union = [...firstIds, ...secondIds]
    expect(new Set(union).size).toBe(union.length)
    expect(union).toEqual([...union].sort((a, b) => a - b))
  })

  it('handles empty sessions and unknown sessions', async () => {
    const { base, sessionId } = await liveServer()
    const empty = await collectSse(base, `/api/v1/sessions/${sessionId}/events`, (list) => list.length >= 1)
    expect(empty[0]!.event).toBe('session.snapshot')
    expect(eventFrames(empty)).toHaveLength(0) // nothing appended yet
    // Last-Event-ID past the tail: only the snapshot arrives.
    const tail = await collectSse(base, `/api/v1/sessions/${sessionId}/events`, (list) => list.length >= 1, 99)
    expect(eventFrames(tail)).toHaveLength(0)
    // Unknown session → 404.
    const response = await fetch(`${base}/api/v1/sessions/session_ghost/events`, {
      headers: { accept: 'text/event-stream' },
    })
    expect(response.status).toBe(404)
    expect((await response.json()) as unknown).toMatchObject({ error: { code: 'SESSION_NOT_FOUND' } })
  })

  it('exposes the capped 1s/2s/5s/10s reconnect backoff policy', () => {
    expect(SSE_RECONNECT_BACKOFF_MS).toEqual([1000, 2000, 5000, 10000])
    expect(sseReconnectDelay(1)).toBe(1000)
    expect(sseReconnectDelay(2)).toBe(2000)
    expect(sseReconnectDelay(3)).toBe(5000)
    expect(sseReconnectDelay(4)).toBe(10000)
    expect(sseReconnectDelay(5)).toBe(10000) // capped
    expect(sseReconnectDelay(0)).toBe(1000) // degenerate attempt clamps
  })
})

// ---------------------------------------------------------------------------
// Node-only: persisted replay + 1,000-event latency.
// ---------------------------------------------------------------------------
describe.skipIf(isBun)('sse persisted replay (Node)', async () => {
  async function loadNodeModules() {
    const persistence = await import('@teoclub/shared-session-persistence-sqlite') as typeof import('@teoclub/shared-session-persistence-sqlite')
    const actions = await import('@teoclub/shared-actions') as typeof import('@teoclub/shared-actions')
    const approvals = await import('@teoclub/shared-approvals') as typeof import('@teoclub/shared-approvals')
    const storage = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const definition = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    return {
      SqliteSessionPersistence: persistence.default,
      SESSION_PERSISTENCE_MIGRATIONS: persistence.SESSION_PERSISTENCE_MIGRATIONS,
      ACTION_MIGRATIONS: actions.ACTION_MIGRATIONS,
      APPROVAL_MIGRATIONS: approvals.APPROVAL_MIGRATIONS,
      NodeSqliteDriver: storage.NodeSqliteDriver,
      runMigrations: definition.runMigrations,
    }
  }

  function m(): Awaited<ReturnType<typeof loadNodeModules>> {
    return nodeMods!
  }
  const nodeMods = typeof Bun === 'undefined' ? await loadNodeModules() : undefined

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rigo-sse-'))
  }

  const COMPOSED = () => [
    ...m().SESSION_PERSISTENCE_MIGRATIONS,
    ...m().ACTION_MIGRATIONS,
    ...m().APPROVAL_MIGRATIONS,
  ]

  it('replays from SQLite when the session id is too old for the live log', async () => {
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const sessionId = 'session_sse'
    const firstCtx = new Context()
    try {
      await firstCtx.plugin(SessionStore)
      await firstCtx.plugin(m().SqliteSessionPersistence as never, { path, migrations: COMPOSED() })
      const session = firstCtx.sessions.create(SessionId(sessionId), { meta: { cwd: '/tmp/ws' } })
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await firstCtx.sessions.flush(session)
    } finally {
      await firstCtx.fiber.dispose()
    }

    // A fresh runtime: no live session — replay comes from SQLite.
    const secondCtx = new Context()
    try {
      await secondCtx.plugin(SessionStore)
      await secondCtx.plugin(m().SqliteSessionPersistence as never, { path, migrations: COMPOSED() })
      const facade = new RuntimeFacade(secondCtx, {
        loadSession: async (id) => {
          const loaded = await secondCtx.sessionPersistence.load(SessionId(id))
          return { events: loaded.events }
        },
      })
      const port = await createApiServer({ facade }).listen(0)
      const base = `http://127.0.0.1:${port}`
      // No Last-Event-ID: the whole persisted log replays from SQLite.
      const frames = await collectSse(base, `/api/v1/sessions/${sessionId}/events`, (list) => {
        return eventFrames(list).length >= 2
      })
      const events = eventFrames(frames)
      expect(events.map((frame) => frame.id)).toEqual([0, 1])
      expect(events[0]!.data).toMatchObject({ type: 'turn/start' })
      expect(events[1]!.data).toMatchObject({ type: 'turn/end' })
      // A Last-Event-ID resumes from the next seq.
      const tailFrames = await collectSse(base, `/api/v1/sessions/${sessionId}/events`, (list) => {
        return eventFrames(list).length >= 1
      }, 0)
      const tail = eventFrames(tailFrames)
      expect(tail.map((frame) => frame.id)).toEqual([1])
    } finally {
      await secondCtx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replays 1,000 persisted events in under a second (SPEC §8.2)', async () => {
    const dir = tempDir()
    const path = join(dir, 'rigo.sqlite')
    const sessionId = 'session_perf'
    const firstCtx = new Context()
    try {
      await firstCtx.plugin(SessionStore)
      await firstCtx.plugin(m().SqliteSessionPersistence as never, { path, migrations: COMPOSED() })
      const session = firstCtx.sessions.create(SessionId(sessionId), { meta: { cwd: '/tmp/ws' } })
      for (let turn = 1; turn <= 500; turn += 1) {
        session.append('turn/start', { turn })
        session.append('turn/end', { turn, reason: { kind: 'completed' } })
      }
      await firstCtx.sessions.flush(session)
    } finally {
      await firstCtx.fiber.dispose()
    }

    const secondCtx = new Context()
    try {
      await secondCtx.plugin(SessionStore)
      await secondCtx.plugin(m().SqliteSessionPersistence as never, { path, migrations: COMPOSED() })
      const facade = new RuntimeFacade(secondCtx, {
        loadSession: async (id) => {
          const loaded = await secondCtx.sessionPersistence.load(SessionId(id))
          return { events: loaded.events }
        },
      })
      const port = await createApiServer({ facade }).listen(0)
      const base = `http://127.0.0.1:${port}`
      const started = performance.now()
      const frames = await collectSse(base, `/api/v1/sessions/${sessionId}/events`, (list) => {
        return eventFrames(list).length >= 1000
      })
      const elapsed = performance.now() - started
      const events = eventFrames(frames)
      expect(events).toHaveLength(1000)
      expect(events[0]!.id).toBe(0)
      expect(events[999]!.id).toBe(999)
      // The reference load replays sequentially in well under the 1s budget.
      expect(elapsed).toBeLessThan(1000)
    } finally {
      await secondCtx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
