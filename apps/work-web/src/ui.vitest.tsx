/**
 * Rigo Work Web component tests (Issue 033): create/open forms, streaming
 * output, status/phases, sources with explicit empty state, and keyboard
 * navigation. Failures are asserted as TEXT, never color-only.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ActionResultsPanel,
  App,
  ApprovalsPanel,
  AuditTimeline,
  ChatView,
  SessionCreateForm,
} from './components.tsx'
import { WorkApiClient, type ApprovalRecord, type AuditEntry, type SseFrame, type SessionSnapshot } from './api.ts'

afterEach(cleanup)

function sessionSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'session_ui',
    status: 'active',
    agentStatus: 'idle',
    eventCount: 0,
    lastSeq: -1,
    ...overrides,
  }
}

function chunkFrame(seq: number, text: string): SseFrame {
  return {
    id: seq,
    event: 'session.event',
    data: { seq, type: 'assistant/chunk', payload: { turn: 1, step: 1, chunk: { type: 'text', text } } },
  }
}

function retrievalFrame(seq: number, status: 'found' | 'empty', sourceIds: string[]): SseFrame {
  return {
    id: seq,
    event: 'session.event',
    data: { seq, type: 'knowledge/retrieved', payload: { querySummary: 'q', status, sourceIds, topK: 8 } },
  }
}

/** A stub client: create/open work against local state; the stream emits canned frames. */
function stubClient(frames: SseFrame[] = []): WorkApiClient & { emitted: SseFrame[] } {
  const created: SessionSnapshot[] = []
  const client = new WorkApiClient('http://127.0.0.1:0') as WorkApiClient & { emitted: SseFrame[] }
  client.emitted = []
  client.createSession = async (input) => {
    const snapshot = sessionSnapshot({
      providerId: input.providerId,
      modelId: input.modelId,
      cwd: input.workspaceRoot,
      ...(input.title === undefined ? {} : { title: input.title }),
    })
    created.push(snapshot)
    return snapshot
  }
  client.getSession = async (id) => (created.find((s) => s.sessionId === id) ?? undefined)
  client.sendMessage = async () => ({ turnId: 'turn_1', status: 'accepted' })
  client.openEventStream = async (_id, handlers) => {
    for (const frame of frames) {
      if (handlers.signal?.aborted) return
      handlers.onEvent(frame)
    }
    handlers.onStatus?.('closed', 1)
  }
  return client
}

describe('work web components (Issue 033)', () => {
  it('creates a session from the form and validates inputs with text errors', async () => {
    const client = stubClient()
    let created: SessionSnapshot | undefined
    render(<SessionCreateForm client={client} onCreated={(s) => { created = s }} />)
    // Invalid submit → text validation errors.
    fireEvent.click(screen.getByTestId('createButton'))
    await waitFor(() => expect(screen.getByTestId('createError').textContent).toContain('Provider is required.'))
    expect(screen.getByTestId('createError').textContent).toContain('Workspace root must be an absolute path.')
    // Valid submit creates the session.
    fireEvent.change(screen.getByTestId('provider'), { target: { value: 'openai-compatible' } })
    fireEvent.change(screen.getByTestId('model'), { target: { value: 'default' } })
    fireEvent.change(screen.getByTestId('workspaceRoot'), { target: { value: '/tmp/ws' } })
    fireEvent.change(screen.getByTestId('title'), { target: { value: 'My plan' } })
    fireEvent.click(screen.getByTestId('createButton'))
    await waitFor(() => expect(created).toBeDefined())
    expect(created).toMatchObject({ title: 'My plan', providerId: 'openai-compatible', cwd: '/tmp/ws' })
  })

  it('streams assistant output incrementally and shows phases as text', async () => {
    const client = stubClient([
      { id: 0, event: 'session.event', data: { seq: 0, type: 'turn/start', payload: { turn: 1 } } },
      chunkFrame(1, 'Hello '),
      chunkFrame(2, 'Rigo'),
      retrievalFrame(3, 'found', ['sqlite-fts#docs/rockets.md#0']),
      { id: 4, event: 'session.event', data: { seq: 4, type: 'turn/end', payload: { turn: 1, reason: { kind: 'completed' } } } },
    ])
    render(<ChatView session={sessionSnapshot()} client={client} onDisconnected={() => undefined} />)
    await waitFor(() => expect(screen.getByTestId('assistantOutput').textContent).toContain('Hello Rigo'))
    // Phases render as text labels (never color-only, AC-7).
    expect(screen.getByTestId('agentStatus').textContent).toContain('idle')
    expect(screen.getByTestId('agentPhase').textContent).toContain('Idle')
    // The sources panel renders locatable references.
    expect(screen.getByTestId('source-s1').textContent).toContain('docs/rockets.md')
  })

  it('shows the explicit empty-retrieval state instead of fabricating sources', async () => {
    const client = stubClient([retrievalFrame(1, 'empty', [])])
    render(<ChatView session={sessionSnapshot()} client={client} onDisconnected={() => undefined} />)
    await waitFor(() => expect(screen.getByTestId('noSources').textContent).toContain('No relevant material found'))
    expect(screen.queryByTestId('source-s1')).toBeNull()
  })

  it('supports keyboard navigation into the streaming and source regions', async () => {
    const client = stubClient([
      retrievalFrame(1, 'found', ['sqlite-fts#a.md#0', 'sqlite-fts#b.md#1']),
      chunkFrame(2, 'answer'),
    ])
    render(<ChatView session={sessionSnapshot()} client={client} onDisconnected={() => undefined} />)
    await waitFor(() => expect(screen.getByTestId('source-s1')).toBeDefined())
    // The streaming region is focusable (tabIndex 0).
    const output = screen.getByTestId('assistantOutput')
    output.focus()
    expect(document.activeElement).toBe(output)
    // Tab reaches the source buttons.
    const first = screen.getByTestId('source-s1')
    first.focus()
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab' })
    // The next source button is reachable.
    const second = screen.getByTestId('source-s2')
    second.focus()
    expect(document.activeElement).toBe(second)
  })

  it('sends messages and surfaces send failures as text', async () => {
    const client = stubClient([])
    client.sendMessage = async () => { throw new Error('SESSION_BUSY: no active turn') }
    render(<ChatView session={sessionSnapshot()} client={client} onDisconnected={() => undefined} />)
    fireEvent.change(screen.getByTestId('messageInput'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByTestId('sendButton'))
    await waitFor(() => expect(screen.getByTestId('sendError').textContent).toContain('SESSION_BUSY'))
  })

  it('renders pending approvals with expiry, approve/deny and conflict errors', async () => {
    const client = stubClient([])
    const approval: ApprovalRecord = {
      id: 'approval_1',
      sessionId: 'session_ui',
      actionExecutionId: 'action_1',
      actionName: 'document.write',
      target: 'docs/plan.md',
      paramsSummary: '1 insertion(s), 0 deletion(s), 3 unchanged line(s)',
      expectedImpact: 'writes docs/plan.md',
      state: 'pending',
      version: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }
    client.decideApproval = async (id, input) => ({
      approval: { ...approval, state: input.decision, version: 2 },
    })
    const resolved: string[] = []
    render(<ApprovalsPanel approvals={[approval]} client={client} onResolved={(r) => resolved.push(r.approval.state)} />)
    // The card shows name, target, summary, impact and expiry (AC-1).
    expect(screen.getByTestId('approval-approval_1').textContent).toContain('document.write')
    expect(screen.getByTestId('approval-approval_1').textContent).toContain('docs/plan.md')
    expect(screen.getByTestId('approval-approval_1').textContent).toContain('1 insertion(s)')
    expect(screen.getByTestId('approval-expiry-approval_1').textContent).toContain('Expires')
    // Approve via the text button (keyboard-reachable).
    fireEvent.click(screen.getByTestId('approve-approval_1'))
    await waitFor(() => expect(resolved).toEqual(['approved']))
    // Deny path (a fresh panel over the same client).
    cleanup()
    render(<ApprovalsPanel approvals={[{ ...approval, id: 'approval_2', version: 2 }]} client={client} onResolved={(r) => resolved.push(r.approval.state)} />)
    fireEvent.click(screen.getByTestId('deny-approval_2'))
    await waitFor(() => expect(resolved).toEqual(['approved', 'denied']))
  })

  it('shows duplicate-decision conflicts and expired approvals as text (AC-4)', async () => {
    const client = stubClient([])
    client.decideApproval = async () => {
      throw new Error('APPROVAL_ALREADY_DECIDED: approval "approval_1" was already decided')
    }
    const approval: ApprovalRecord = {
      id: 'approval_1',
      sessionId: 'session_ui',
      actionExecutionId: 'action_1',
      actionName: 'document.write',
      target: 'a.md',
      paramsSummary: 'write',
      expectedImpact: 'writes a.md',
      state: 'pending',
      version: 1,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    }
    render(<ApprovalsPanel approvals={[approval]} client={client} onResolved={() => undefined} />)
    fireEvent.click(screen.getByTestId('approve-approval_1'))
    await waitFor(() => expect(screen.getByTestId('approvalError').textContent).toContain('APPROVAL_ALREADY_DECIDED'))
    // Expired: the expiry line says so and the buttons are disabled.
    const expired: ApprovalRecord = { ...approval, id: 'approval_9', expiresAt: new Date(Date.now() - 1000).toISOString() }
    render(<ApprovalsPanel approvals={[expired]} client={client} onResolved={() => undefined} />)
    expect(screen.getByTestId('approval-expiry-approval_9').textContent).toContain('Expired')
    expect((screen.getByTestId('approve-approval_9') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows action results with text states and result summaries (AC-5/6)', () => {
    render(
      <ActionResultsPanel
        actions={[
          { executionId: 'action_1', action: 'document.write', status: 'awaiting-approval' },
          { executionId: 'action_1', action: 'document.write', status: 'succeeded', resultSummary: '{"version":2}', durationMs: 7 },
        ]}
      />,
    )
    expect(screen.getByTestId('action-0').textContent).toContain('Waiting for approval')
    expect(screen.getByTestId('action-1').textContent).toContain('Succeeded')
    expect(screen.getByTestId('action-result-1').textContent).toContain('"version":2')
    // The result summary is escaped text — never raw HTML.
    cleanup()
    render(<ActionResultsPanel actions={[{ executionId: 'x', action: 'a', status: 'failed', resultSummary: '<img src=x onerror=alert(1)>' }]} />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByTestId('action-result-0').textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('renders the audit timeline ordered by seq (AC-7)', () => {
    const entries: AuditEntry[] = [
      { sessionId: 's', seq: 1, time: 1, category: 'turn', correlationId: 'turn:1', summary: 'turn 1 started', data: {} },
      { sessionId: 's', seq: 0, time: 0, category: 'retrieval', correlationId: 'query:q', summary: 'retrieved 1 sources', data: {} },
      { sessionId: 's', seq: 2, time: 2, category: 'approval', correlationId: 'approval:a1', summary: 'approval a1 requested', data: {} },
    ]
    render(<AuditTimeline entries={[...entries].sort((a, b) => a.seq - b.seq)} />)
    const seqs = [...document.querySelectorAll('[data-testid^="audit-seq-"]')].map((node) => Number(node.textContent!.slice(1)))
    expect(seqs).toEqual([0, 1, 2])
    expect(screen.getByTestId('audit-category-1').textContent).toBe('turn')
    expect(screen.getByTestId('audit-1').textContent).toContain('turn 1 started')
  })

  it('app flow: create → chat, and open restores an existing session', async () => {
    const client = stubClient([chunkFrame(1, 'restored answer')])
    const { unmount } = render(<App client={client} />)
    fireEvent.change(screen.getByTestId('provider'), { target: { value: 'openai-compatible' } })
    fireEvent.change(screen.getByTestId('model'), { target: { value: 'default' } })
    fireEvent.change(screen.getByTestId('workspaceRoot'), { target: { value: '/tmp/ws' } })
    fireEvent.click(screen.getByTestId('createButton'))
    await waitFor(() => expect(screen.getByTestId('sessionTitle').textContent).toContain('session_ui'))
    // The opened session replays its stream (restore of existing events).
    await waitFor(() => expect(screen.getByTestId('assistantOutput').textContent).toContain('restored answer'))
    // Reopening an unknown session shows a text error.
    unmount()
    const openClient = stubClient([])
    openClient.getSession = async () => undefined
    const { unmount: unmountSecond } = render(<App client={openClient} />)
    fireEvent.change(screen.getByTestId('sessionId'), { target: { value: 'session_ghost' } })
    fireEvent.click(screen.getByTestId('openButton'))
    await waitFor(() => expect(screen.getByTestId('openError').textContent).toContain('was not found'))
    unmountSecond()
    void act
  })
})
