/**
 * Issue 038 E2E — Rigo Work failure & security paths (SPEC §5.5, §5.8, §6,
 * §7, §9.4; PRD US-018, FR-20/21/27/33/34/37).
 *
 * Every scenario boots its own isolated harness (fresh temp home, SQLite
 * databases, knowledge set, target documents, real bundle + Vite UI) and
 * cleans up afterwards. Denial, version conflicts, duplicate submissions,
 * SSE reconnects, path-escape rejection, credential hygiene, crash
 * recovery, and session-deletion abort are exercised against the real
 * pipeline — no mocks beyond the scripted LLM.
 */
import { expect, test } from '@playwright/test'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { SessionId } from '@teoclub/harness-session'
import { DocumentId, projectDocument } from '@teoclub/work-documents'
import { recoverDocumentWrites } from '@teoclub/work-documents-write'
import { NodeSqliteDriver } from '@teoclub/shared-storage-sqlite-node/node'
import {
  E2E_SECRET_MARKER,
  failingScript,
  happyPathScript,
  startHarness,
  type E2EHarness,
} from './harness.ts'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface SseFrame {
  id: number
  event: string
  data: Record<string, unknown>
}

/** One live SSE subscription with incremental frame collection. */
function openSse(baseUrl: string, sessionId: string, lastEventId?: number): {
  frames: SseFrame[]
  abort(): void
  waitFor(predicate: (frame: SseFrame) => boolean, timeoutMs?: number): Promise<SseFrame>
} {
  const frames: SseFrame[] = []
  const controller = new AbortController()
  void (async () => {
    const response = await fetch(`${baseUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
      headers: {
        accept: 'text/event-stream',
        ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }),
      },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`SSE HTTP ${response.status}`)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
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
          if (event.length === 0 || dataLine === undefined) continue
          frames.push({ id, event, data: JSON.parse(dataLine) as Record<string, unknown> })
        }
      }
    } catch {
      // Aborted (expected disconnect) or a dropped connection — done.
    }
  })()
  return {
    frames,
    abort: () => controller.abort(),
    waitFor: async (predicate, timeoutMs = 15000): Promise<SseFrame> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const found = frames.find(predicate)
        if (found !== undefined) return found
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      throw new Error(`SSE waitFor timed out after ${timeoutMs}ms (${frames.length} frames)`)
    },
  }
}

/** The CSRF token + JSON headers for state-changing API calls. */
async function apiHeaders(baseUrl: string): Promise<Record<string, string>> {
  const response = await fetch(`${baseUrl}/api/v1/csrf`)
  const { csrfToken } = (await response.json()) as { csrfToken: string }
  return { 'content-type': 'application/json', 'x-csrf-token': csrfToken }
}

/** Wait until the live session log contains an event matching `predicate`. */
async function waitForEvent(
  harness: E2EHarness,
  sessionId: string,
  predicate: (event: { type: string; data: Record<string, unknown> }) => boolean,
  timeoutMs = 15000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const session = harness.ctx.sessions.get(SessionId(sessionId))
    if (session?.events.some((event) => predicate(event as never)) === true) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`session "${sessionId}" never matched the event predicate in time`)
}

/** The session the browser UI created (the harness-created one is excluded). */
function uiSessionId(harness: E2EHarness): string {
  const id = harness.ctx.sessions.list().find((session) => session.id !== harness.sessionId)?.id
  if (id === undefined) throw new Error('the UI session was not created')
  return id
}

/**
 * The harness-created session: its `sessions` row is already materialized
 * (the seeding `document/read` event flushed during boot), so actions can
 * run against it immediately — a fresh session's row only appears after its
 * first event batch drains (SPEC §3.2 lazy materialization).
 */
function materializedSessionId(harness: E2EHarness): string {
  return harness.sessionId
}

/** Run one write proposal through the pipeline up to its approval request. */
async function proposeWrite(
  harness: E2EHarness,
  sessionId: string,
  input: { relativePath: string; expectedVersion: number; content: string; idempotencyKey: string },
): Promise<{ executionId: string; approvalId: string }> {
  const session = harness.ctx.sessions.get(SessionId(sessionId))!
  const action = `document.write:${sessionId}`
  const result = await harness.ctx.actions.execute({
    action,
    input,
    idempotencyKey: input.idempotencyKey,
    sessionId,
  })
  expect(result.status).toBe('requires-approval')
  const approval = await harness.ctx.approvals.create({
    sessionId,
    actionExecutionId: result.executionId,
    actionName: action,
    target: input.relativePath,
    paramsSummary: `writes ${input.relativePath}`,
    expectedImpact: `writes ${input.relativePath}`,
    session,
  })
  return { executionId: result.executionId, approvalId: approval.id }
}

/** Decide one approval through the facade (the same path the HTTP API uses). */
async function decide(
  harness: E2EHarness,
  approvalId: string,
  decision: 'approved' | 'denied',
): Promise<{ status: string; error?: { code?: string; message: string } }> {
  const result = await harness.facade.decideApproval(approvalId, {
    decision,
    expectedVersion: 1,
  })
  if (result.execution === undefined) return { status: 'no-execution' }
  return {
    status: result.execution.status,
    ...(result.execution.error === undefined ? {} : { error: result.execution.error }),
  }
}

// ---------------------------------------------------------------------------
// AC-1: Denial leaves the document untouched with a structured denial
// ---------------------------------------------------------------------------

test('denial: target document unchanged, UI + audit show the structured denial', async ({ page }) => {
  const harness = await startHarness({
    script: happyPathScript(),
    knowledge: {
      'knowledge.md': '# Knowledge\n\nWhat do rockets use? Rockets use fuel for thrust. The plan lives in docs/plan.md.\n',
    },
    documents: { 'docs/plan.md': '# Plan\n\nOriginal plan.\n' },
  })
  try {
    await page.goto(harness.baseUrl)
    await page.getByTestId('provider').fill('mock')
    await page.getByTestId('model').fill('mock')
    await page.getByTestId('workspaceRoot').fill(harness.workspace)
    await page.getByTestId('title').fill('Denial session')
    await page.getByTestId('createButton').click()
    await expect(page.getByTestId('sessionTitle')).toContainText('Denial session')

    await page.getByTestId('messageInput').fill('What do rockets use?')
    await page.getByTestId('sendButton').click()
    await expect(page.getByTestId('assistantOutput')).toContainText('rockets use fuel', { timeout: 20000 })
    await page.getByTestId('messageInput').fill('Please update the plan.')
    await page.getByTestId('sendButton').click()
    await expect(page.locator('[data-testid^="approval-"] h4')).toContainText('document.write:', { timeout: 20000 })

    // Deny through the UI.
    const deny = page.locator('[data-testid^="deny-"]').first()
    await deny.click()
    await expect(page.locator('[data-testid^="approval-"]')).toHaveCount(0, { timeout: 20000 })

    // The UI surfaces the structured denial (text, not color-only).
    await expect(page.getByTestId('actionsPanel')).toContainText('Denied', { timeout: 20000 })
    await expect(page.getByTestId('auditTimeline')).toContainText('denied', { timeout: 20000 })

    // The document never changed.
    expect(readFileSync(join(harness.workspace, 'docs/plan.md'), 'utf8')).toBe('# Plan\n\nOriginal plan.\n')
    expect(harness.ctx.documents.getVersion(DocumentId('docs/plan.md'))).toBe(1)

    // The session log carries the structured denial resolution event.
    const session = harness.ctx.sessions.get(SessionId(uiSessionId(harness)))!
    const resolved = session.events.find((event) => event.type === 'approval/resolved')
    expect(resolved).toBeDefined()
    expect((resolved!.data as { outcome?: string }).outcome).toBe('denied')
  } finally {
    // Drop the browser connections FIRST: the open page keeps the Vite HMR
    // websocket and the SSE proxy connection alive, which would otherwise
    // block the servers' close() during teardown.
    await page.close()
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// AC-2: External modification during the wait → version conflict, no overwrite
// ---------------------------------------------------------------------------

test('version conflict: an external edit during the approval wait is never overwritten', async () => {
  const harness = await startHarness({
    script: [/** no model calls — the write is driven directly */],
    documents: { 'docs/plan.md': '# Plan\n\nOriginal plan.\n' },
    warmUp: true,
  })
  try {
    // Materialize the baseline projection (first read → version 1).
    await harness.ctx.documents.read(DocumentId('docs/plan.md'))
    const sessionId = materializedSessionId(harness)
    const { approvalId } = await proposeWrite(harness, sessionId, {
      relativePath: 'docs/plan.md',
      expectedVersion: 1,
      content: '# Plan\n\nUpdated by the approved write.\n',
      idempotencyKey: 'conflict-write',
    })

    // ANOTHER writer modifies the document through the projection while the
    // approval is pending.
    const previous = harness.ctx.documents.projection(DocumentId('docs/plan.md'))!
    const externalContent = '# Plan\n\nExternally edited first.\n'
    writeFileSync(join(harness.workspace, 'docs/plan.md'), externalContent)
    harness.ctx.documents.commitWrite(projectDocument(
      {
        id: DocumentId('docs/plan.md'),
        relativePath: 'docs/plan.md',
        content: externalContent,
        source: join(harness.workspace, 'docs/plan.md'),
      },
      previous,
    ))

    // Approving now hits the version conflict and never overwrites.
    const outcome = await decide(harness, approvalId, 'approved')
    expect(outcome.status).toBe('failed')
    expect(outcome.error?.code).toBe('DOCUMENT_VERSION_CONFLICT')
    expect(readFileSync(join(harness.workspace, 'docs/plan.md'), 'utf8')).toBe(externalContent)
    expect(harness.ctx.documents.getVersion(DocumentId('docs/plan.md'))).toBe(2)

    // The failure is audit-visible with the structured code.
    const session = harness.ctx.sessions.get(SessionId(sessionId))!
    const executed = session.events.find((event) => event.type === 'action/executed' && event.data.status === 'failed')
    expect(executed).toBeDefined()
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// AC-3: Duplicate approvals / duplicate action submissions never re-write
// ---------------------------------------------------------------------------

test('duplicates: a second decision and a same-key submission never re-write', async () => {
  const harness = await startHarness({
    script: [/** no model calls — the write is driven directly */],
    documents: { 'docs/plan.md': '# Plan\n\nOriginal plan.\n' },
    warmUp: true,
  })
  try {
    await harness.ctx.documents.read(DocumentId('docs/plan.md'))
    const sessionId = materializedSessionId(harness)
    const input = {
      relativePath: 'docs/plan.md',
      expectedVersion: 1,
      content: '# Plan\n\nWritten exactly once.\n',
      idempotencyKey: 'once-only',
    }
    const { approvalId } = await proposeWrite(harness, sessionId, input)

    const first = await decide(harness, approvalId, 'approved')
    expect(first.status).toBe('completed')
    expect(readFileSync(join(harness.workspace, 'docs/plan.md'), 'utf8')).toBe(input.content)
    expect(harness.ctx.documents.getVersion(DocumentId('docs/plan.md'))).toBe(2)

    // A second decision on the same approval is rejected — nothing moves.
    await expect(decide(harness, approvalId, 'approved')).rejects.toThrow(/already decided|already been decided/i)
    expect(readFileSync(join(harness.workspace, 'docs/plan.md'), 'utf8')).toBe(input.content)
    expect(harness.ctx.documents.getVersion(DocumentId('docs/plan.md'))).toBe(2)

    // A re-submission with the same idempotency key replays the outcome
    // instead of executing — the file side effect happens exactly once.
    const replay = await harness.ctx.actions.execute({
      action: `document.write:${sessionId}`,
      input,
      idempotencyKey: input.idempotencyKey,
      sessionId,
    })
    expect(replay.status).toBe('completed')
    expect((replay as { replayed?: true }).replayed).toBe(true)
    expect(readFileSync(join(harness.workspace, 'docs/plan.md'), 'utf8')).toBe(input.content)
    expect(harness.ctx.documents.getVersion(DocumentId('docs/plan.md'))).toBe(2)
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// AC-4: SSE disconnect + reconnect loses nothing; projections stay consistent
// ---------------------------------------------------------------------------

test('SSE reconnect: no event loss, UI projection matches the persisted session', async () => {
  const harness = await startHarness({
    script: happyPathScript(),
    knowledge: {
      'knowledge.md': '# Knowledge\n\nWhat do rockets use? Rockets use fuel for thrust. The plan lives in docs/plan.md.\n',
    },
    documents: { 'docs/plan.md': '# Plan\n\nOriginal plan.\n' },
  })
  let stream1: ReturnType<typeof openSse> | undefined
  let stream2: ReturnType<typeof openSse> | undefined
  try {
    const headers = await apiHeaders(harness.baseUrl)
    const created = await (await fetch(`${harness.baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId: 'mock', modelId: 'mock', workspaceRoot: harness.workspace, title: 'SSE session' }),
    })).json() as { session: { sessionId: string } }
    const sessionId = created.session.sessionId
    const send = (content: string, clientMessageId: string): Promise<unknown> =>
      fetch(`${harness.baseUrl}/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ clientMessageId, content }),
      })

    // Connect BEFORE any message: everything streams live.
    stream1 = openSse(harness.baseUrl, sessionId)
    await send('What do rockets use?', 'client-1')
    const turn1End = await stream1.waitFor((frame) => frame.event === 'session.event' && frame.data.type === 'turn/end')
    const lastId = turn1End.id

    // Disconnect (network drop) — then run the second turn while offline.
    stream1.abort()
    await send('Please update the plan.', 'client-2')
    await waitForEvent(harness, sessionId, (event) => event.type === 'turn/end'
      && ((event.data as { turn?: number }).turn ?? 0) === 2)
    const session = harness.ctx.sessions.get(SessionId(sessionId))!
    const total = session.events.length
    const finalSeq = session.events[total - 1]!.seq

    // Reconnect with Last-Event-ID: the server replays strictly after it.
    stream2 = openSse(harness.baseUrl, sessionId, lastId)
    await stream2.waitFor((frame) => frame.event === 'session.event' && frame.data.seq === finalSeq)
    stream2.abort()

    // No loss, no duplicates: connection 1 saw 0..lastId, connection 2 saw
    // lastId+1..finalSeq, and every frame matches the live session log.
    const firstSeqs = stream1.frames.filter((f) => f.event === 'session.event').map((f) => f.data.seq as number)
    const secondSeqs = stream2.frames.filter((f) => f.event === 'session.event').map((f) => f.data.seq as number)
    expect(firstSeqs).toEqual(Array.from({ length: lastId + 1 }, (_, index) => index))
    expect(secondSeqs).toEqual(Array.from({ length: finalSeq - lastId }, (_, index) => lastId + 1 + index))
    const seen = new Set<number>()
    for (const frame of [...stream1.frames, ...stream2.frames]) {
      if (frame.event !== 'session.event') continue
      const seq = frame.data.seq as number
      expect(seen.has(seq)).toBe(false)
      seen.add(seq)
      expect(frame.data.type).toBe(session.events[seq]!.type)
    }
    expect(seen.size).toBe(session.events.length)

    // The UI projection (what the page renders) agrees with the live log…
    const projection = await harness.facade.auditProjection(sessionId)
    expect(projection.map((entry) => entry.seq)).toEqual(session.events.map((event) => event.seq))
    // …and with the PERSISTED log once the write-behind drains.
    await new Promise((resolve) => setTimeout(resolve, 600))
    const driver = new NodeSqliteDriver(join(harness.dataDir, 'session.sqlite'))
    const rows = driver.query<{ n: number }>('SELECT COUNT(*) AS n FROM session_events WHERE session_id = ?', [sessionId])[0]!.n
    driver.close()
    expect(rows).toBe(session.events.length)
  } finally {
    stream1?.abort()
    stream2?.abort()
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// AC-5: Absolute paths, `..` traversal and escaping symlinks are rejected
// ---------------------------------------------------------------------------

test('path escapes: absolute, traversal and symlink escapes never touch the outside', async () => {
  const harness = await startHarness({
    script: [/** no model calls — the write is driven directly */],
    documents: { 'docs/plan.md': '# Plan\n\nOriginal plan.\n' },
    warmUp: true,
  })
  try {
    await harness.ctx.documents.read(DocumentId('docs/plan.md'))
    const sessionId = materializedSessionId(harness)

    // Outside-world fixtures.
    const outsideDir = join(harness.workspace, '..', `outside-${Date.now()}`)
    mkdirSync(outsideDir, { recursive: true })
    const outsideFile = join(outsideDir, 'secret.md')
    writeFileSync(outsideFile, '# Outside secret.\n')
    symlinkSync(outsideDir, join(harness.workspace, 'escape-dir'))
    symlinkSync(outsideFile, join(harness.workspace, 'escape-link.md'))

    const attempts: { relativePath: string; expectCode: string }[] = [
      { relativePath: '/etc/rigo-escape.md', expectCode: 'PATH_OUTSIDE_WORKSPACE' },
      { relativePath: 'sub/../../escape.md', expectCode: 'PATH_OUTSIDE_WORKSPACE' },
      // A symlinked parent directory resolves outside the root.
      { relativePath: 'escape-dir/x.md', expectCode: 'PATH_OUTSIDE_WORKSPACE' },
      // A leaf symlink to an outside file cannot be written through.
      { relativePath: 'escape-link.md', expectCode: 'DOCUMENT_VERSION_CONFLICT' },
    ]
    for (const [index, attempt] of attempts.entries()) {
      const { approvalId } = await proposeWrite(harness, sessionId, {
        relativePath: attempt.relativePath,
        expectedVersion: 1,
        content: `# Escape ${index}\n`,
        idempotencyKey: `escape-${index}`,
      })
      const outcome = await decide(harness, approvalId, 'approved')
      expect(outcome.status).toBe('failed')
      expect(outcome.error?.code).toBe(attempt.expectCode)
    }

    // Nothing outside the workspace changed or appeared.
    expect(readFileSync(outsideFile, 'utf8')).toBe('# Outside secret.\n')
    expect(readdirNames(outsideDir)).toEqual(['secret.md'])
    // The workspace target stayed untouched too.
    expect(readFileSync(join(harness.workspace, 'docs/plan.md'), 'utf8')).toBe('# Plan\n\nOriginal plan.\n')
  } finally {
    await harness.dispose()
  }
})

function readdirNames(directory: string): string[] {
  return readdirSync(directory).sort()
}

// ---------------------------------------------------------------------------
// AC-6: Credential values never reach the page, events, audit, SSE or logs
// ---------------------------------------------------------------------------

test('credentials: the secret marker never appears in any surface', async ({ page }) => {
  const captured: string[] = []
  const originalError = console.error
  const originalWarn = console.warn
  console.error = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '))
    originalError(...args)
  }
  console.warn = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '))
    originalWarn(...args)
  }
  const harness = await startHarness({ script: failingScript() })
  try {
    await page.goto(harness.baseUrl)
    await page.getByTestId('provider').fill('mock')
    await page.getByTestId('model').fill('mock')
    await page.getByTestId('workspaceRoot').fill(harness.workspace)
    await page.getByTestId('title').fill('Credential session')
    await page.getByTestId('createButton').click()
    await page.getByTestId('messageInput').fill('first')
    await page.getByTestId('sendButton').click()
    await expect(page.getByTestId('assistantOutput')).toContainText('first answer', { timeout: 20000 })

    // The second model call explodes with the marker hidden on `error.internal`.
    await page.getByTestId('messageInput').fill('boom')
    await page.getByTestId('sendButton').click()
    await waitForEvent(harness, uiSessionId(harness), (event) => {
      if (event.type !== 'turn/end') return false
      const reason = (event.data as { reason: { kind: string } }).reason
      return reason?.kind === 'error'
    })

    // The turn failed with a SAFE structured reason.
    const session = harness.ctx.sessions.get(SessionId(uiSessionId(harness)))!
    const turnEnd = [...session.events].reverse().find((event) => event.type === 'turn/end')
    expect(turnEnd).toBeDefined()
    const reason = (turnEnd!.data as { reason: { kind: string; error?: { message: string; code: string } } }).reason
    expect(reason.kind).toBe('error')

    // Every surface is clean of the marker.
    const eventText = JSON.stringify(session.events)
    const auditText = JSON.stringify(await harness.facade.auditProjection(uiSessionId(harness)))
    const pageText = await page.locator('body').innerText()
    expect(eventText).not.toContain(E2E_SECRET_MARKER)
    expect(auditText).not.toContain(E2E_SECRET_MARKER)
    expect(pageText).not.toContain(E2E_SECRET_MARKER)
    expect(captured.join('\n')).not.toContain(E2E_SECRET_MARKER)
  } finally {
    console.error = originalError
    console.warn = originalWarn
    await page.close()
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// AC-7: Crash between the atomic rename and the outcome commit recovers
// ---------------------------------------------------------------------------

test('crash recovery: a rename-without-outcome journal recovers without re-writing', async () => {
  const harness = await startHarness({
    script: [/** no model calls — the write is driven directly */],
    documents: { 'docs/plan.md': '# Plan\n\nOriginal plan.\n' },
    warmUp: true,
  })
  try {
    await harness.ctx.documents.read(DocumentId('docs/plan.md'))
    const sessionId = materializedSessionId(harness)
    const action = `document.write:${sessionId}`
    const input = {
      relativePath: 'docs/plan.md',
      expectedVersion: 1,
      content: '# Plan\n\nCrash-written content.\n',
      idempotencyKey: 'crash-write',
    }

    // A REAL approved write lands the content and journals 'succeeded'.
    const { approvalId } = await proposeWrite(harness, sessionId, input)
    const outcome = await decide(harness, approvalId, 'approved')
    expect(outcome.status).toBe('completed')
    expect(harness.ctx.documents.getVersion(DocumentId('docs/plan.md'))).toBe(2)

    // Simulate the crash: the rename happened (file = expected output) but
    // the outcome commit never ran — flip the journal back to 'running'.
    const driver = new NodeSqliteDriver(join(harness.dataDir, 'session.sqlite'))
    const row = driver.query<{ id: string }>(
      'SELECT id FROM action_executions WHERE action_name = ? AND idempotency_key = ?',
      [action, input.idempotencyKey],
    )[0]!
    driver.run(
      'UPDATE action_executions SET state = ?, result_json = NULL, finished_at = NULL WHERE id = ?',
      ['running', row.id],
    )

    // Recovery compares the target hash with the expected output: match →
    // the success is replayed (journal + projection + event), never re-written.
    const recovery = await recoverDocumentWrites({
      driver,
      documents: harness.ctx.documents,
      sessionResolver: (id) => harness.ctx.sessions.get(SessionId(id)),
      actionNames: [action],
    })
    expect(recovery).toEqual({ replayed: 1, recoveryRequired: 0 })
    const after = driver.query<{ state: string }>('SELECT state FROM action_executions WHERE id = ?', [row.id])[0]!
    expect(after.state).toBe('succeeded')
    expect(readFileSync(join(harness.workspace, 'docs/plan.md'), 'utf8')).toBe(input.content)
    expect(harness.ctx.documents.getVersion(DocumentId('docs/plan.md'))).toBe(2)

    // A same-key submission after recovery replays — no second side effect.
    const replay = await harness.ctx.actions.execute({ action, input, idempotencyKey: input.idempotencyKey, sessionId })
    expect(replay.status).toBe('completed')
    expect((replay as { replayed?: true }).replayed).toBe(true)
    expect(harness.ctx.documents.getVersion(DocumentId('docs/plan.md'))).toBe(2)

    // A journal row whose target does NOT match the expected output is marked
    // `recovery-required` with the file left exactly as it is.
    driver.run(
      `INSERT INTO action_executions (id, session_id, action_name, side_effect, state, idempotency_key, request_json, created_at)
       VALUES (?, ?, ?, 'local-write', 'running', ?, ?, ?)`,
      ['action_crash_orphan', sessionId, action, 'crash-orphan',
        JSON.stringify({ ...input, relativePath: 'docs/other.md', idempotencyKey: 'crash-orphan' }),
        new Date().toISOString()],
    )
    writeFileSync(join(harness.workspace, 'docs/other.md'), '# Other, partial.\n')
    const second = await recoverDocumentWrites({
      driver,
      documents: harness.ctx.documents,
      sessionResolver: (id) => harness.ctx.sessions.get(SessionId(id)),
      actionNames: [action],
    })
    expect(second).toEqual({ replayed: 0, recoveryRequired: 1 })
    const orphan = driver.query<{ state: string }>('SELECT state FROM action_executions WHERE id = ?', ['action_crash_orphan'])[0]!
    expect(orphan.state).toBe('recovery-required')
    expect(readFileSync(join(harness.workspace, 'docs/other.md'), 'utf8')).toBe('# Other, partial.\n')
    driver.close()
  } finally {
    await harness.dispose()
  }
})

// ---------------------------------------------------------------------------
// AC-8: Deleting a session aborts the active turn and releases resources
// ---------------------------------------------------------------------------

test('session deletion: an active turn is aborted and resources are released', async () => {
  const harness = await startHarness({ script: ['hang'] })
  try {
    const headers = await apiHeaders(harness.baseUrl)
    const created = await (await fetch(`${harness.baseUrl}/api/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId: 'mock', modelId: 'mock', workspaceRoot: harness.workspace, title: 'Abort session' }),
    })).json() as { session: { sessionId: string } }
    const sessionId = created.session.sessionId

    // Start a turn that hangs in the model stream.
    await fetch(`${harness.baseUrl}/api/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ clientMessageId: 'hang-1', content: 'start' }),
    })
    await waitForEvent(harness, sessionId, (event) => event.type === 'step/start')
    const liveCountBefore = harness.ctx.sessions.get(SessionId(sessionId))!.events.length

    // DELETE the session: the live agent is aborted, its turn unwinds, the
    // write-behind drains, and only THEN the agent (and its folded session
    // lifecycle) is disposed. The response resolves after the durable flush.
    const deleted = await fetch(`${harness.baseUrl}/api/v1/sessions/${sessionId}`, { method: 'DELETE', headers })
    expect(deleted.status).toBe(200)

    // The live session is gone; the aborted turn/end lives in the PERSISTED
    // log, which closeSession already drained.
    expect(harness.ctx.sessions.get(SessionId(sessionId))).toBeUndefined()
    const driver = new NodeSqliteDriver(join(harness.dataDir, 'session.sqlite'))
    const rows = driver.query<{ seq: number; payload_json: string }>(
      'SELECT seq, payload_json FROM session_events WHERE session_id = ? ORDER BY seq',
      [sessionId],
    )
    driver.close()
    const turnEndRow = [...rows].reverse().find((row) => (JSON.parse(row.payload_json) as { type: string }).type === 'turn/end')
    expect(turnEndRow).toBeDefined()
    const reason = (JSON.parse(turnEndRow!.payload_json) as { data: { reason: { kind: string; reason?: { kind: string } } } }).data.reason
    expect(reason.kind).toBe('aborted')
    expect(reason.reason?.kind).toBe('disposed')

    // Resources are released: no live agent remains for the session…
    await expect(
      fetch(`${harness.baseUrl}/api/v1/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ clientMessageId: 'after-delete', content: 'ping' }),
      }),
    ).resolves.toHaveProperty('status', 404)

    // …and the persisted tail covers the aborted turn (no event was lost).
    expect(rows.length).toBeGreaterThan(liveCountBefore)
  } finally {
    await harness.dispose()
  }
})
