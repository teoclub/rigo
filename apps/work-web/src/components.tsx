/**
 * Rigo Work Web UI components (Issue 033): session creation, chat with
 * SSE-streamed assistant output, agent status + detailed phases, and
 * locatable knowledge sources. Failures are always rendered as TEXT (AC-7);
 * streaming and source regions are keyboard-navigable.
 *
 * @module @teoclub/work-web/components
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import {
  WorkApiClient,
  type SendMessageResult,
  type SessionSnapshot,
} from './api.ts'
import {
  actionStateLabel,
  foldEvent,
  initialViewModel,
  phaseLabel,
  type AgentPhase,
  type StreamViewModel,
} from './events.ts'
import { renderMarkdown } from './markdown.tsx'
import type { ApprovalRecord, ApprovalResolveResult, AuditEntry } from './api.ts'

export interface SessionFormValues {
  providerId: string
  modelId: string
  workspaceRoot: string
  title: string
}

export function SessionCreateForm(props: {
  client: WorkApiClient
  onCreated: (session: SessionSnapshot) => void
}): JSX.Element {
  const [values, setValues] = useState<SessionFormValues>({ providerId: '', modelId: '', workspaceRoot: '', title: '' })
  const [error, setError] = useState<string>('')
  const [creating, setCreating] = useState(false)

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const problems: string[] = []
    if (values.providerId.trim().length === 0) problems.push('Provider is required.')
    if (values.modelId.trim().length === 0) problems.push('Model is required.')
    if (!values.workspaceRoot.trim().startsWith('/')) problems.push('Workspace root must be an absolute path.')
    if (Array.from(values.title).length > 200) problems.push('Title must be at most 200 characters.')
    if (problems.length > 0) {
      setError(problems.join(' '))
      return
    }
    setError('')
    setCreating(true)
    try {
      const session = await props.client.createSession({
        providerId: values.providerId.trim(),
        modelId: values.modelId.trim(),
        workspaceRoot: values.workspaceRoot.trim(),
        ...(values.title.trim().length === 0 ? {} : { title: values.title.trim() }),
      })
      props.onCreated(session)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to create the session.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} aria-label="Create session">
      <label>
        Provider
        <input
          data-testid="provider"
          value={values.providerId}
          onChange={(event) => setValues({ ...values, providerId: event.target.value })}
          placeholder="openai-compatible"
          aria-required="true"
        />
      </label>
      <label>
        Model
        <input
          data-testid="model"
          value={values.modelId}
          onChange={(event) => setValues({ ...values, modelId: event.target.value })}
          placeholder="default"
          aria-required="true"
        />
      </label>
      <label>
        Workspace root
        <input
          data-testid="workspaceRoot"
          value={values.workspaceRoot}
          onChange={(event) => setValues({ ...values, workspaceRoot: event.target.value })}
          placeholder="/absolute/workspace/path"
          aria-required="true"
        />
      </label>
      <label>
        Title (optional)
        <input
          data-testid="title"
          value={values.title}
          onChange={(event) => setValues({ ...values, title: event.target.value })}
        />
      </label>
      {error.length > 0 && (
        <p role="alert" data-testid="createError">
          {error}
        </p>
      )}
      <button type="submit" disabled={creating} data-testid="createButton">
        {creating ? 'Creating…' : 'Create session'}
      </button>
    </form>
  )
}

export function SessionOpenForm(props: {
  client: WorkApiClient
  onOpened: (session: SessionSnapshot) => void
}): JSX.Element {
  const [sessionId, setSessionId] = useState('')
  const [error, setError] = useState('')

  const open = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setError('')
    const session = await props.client.getSession(sessionId.trim())
    if (session === undefined) {
      setError(`Session "${sessionId.trim()}" was not found.`)
      return
    }
    props.onOpened(session)
  }

  return (
    <form onSubmit={(event) => void open(event)} aria-label="Open session">
      <label>
        Session id
        <input
          data-testid="sessionId"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          placeholder="session_…"
        />
      </label>
      {error.length > 0 && (
        <p role="alert" data-testid="openError">
          {error}
        </p>
      )}
      <button type="submit" data-testid="openButton">
        Open session
      </button>
    </form>
  )
}

export function StatusBar(props: { view: StreamViewModel }): JSX.Element {
  const { view } = props
  const phase: AgentPhase = view.agentStatus === 'idle' ? 'idle' : view.phase === 'idle' ? 'running' : view.phase
  return (
    <div data-testid="statusBar" role="status" aria-live="polite">
      <span data-testid="agentStatus">Agent: {view.agentStatus}</span>
      <span data-testid="agentPhase">Phase: {phaseLabel(phase)}</span>
      {view.pendingApprovals > 0 && (
        <span data-testid="pendingApprovals">Pending approvals: {view.pendingApprovals}</span>
      )}
    </div>
  )
}

export function StreamingMessage(props: { view: StreamViewModel }): JSX.Element {
  const { view } = props
  return (
    <div
      data-testid="assistantOutput"
      tabIndex={0}
      aria-label="Assistant output, streaming"
      aria-live="polite"
      role="log"
    >
      {view.assistantText.length === 0
        ? <p data-testid="assistantEmpty">Waiting for the assistant…</p>
        : renderMarkdown(view.assistantText)}
    </div>
  )
}

export function SourcesPanel(props: { view: StreamViewModel }): JSX.Element {
  const { view } = props
  if (view.retrievalEmpty) {
    // AC-5: explicit empty-retrieval state (text, not color-only).
    return (
      <section data-testid="sourcesPanel" aria-label="Knowledge sources">
        <h3>Sources</h3>
        <p data-testid="noSources">No relevant material found in the knowledge base.</p>
      </section>
    )
  }
  if (view.sources.length === 0) return <></>
  return (
    <section data-testid="sourcesPanel" aria-label="Knowledge sources">
      <h3>Sources</h3>
      <ul>
        {view.sources.map((source) => (
          <li key={source.refId}>
            <button
              type="button"
              data-testid={`source-${source.refId}`}
              data-source={JSON.stringify(source)}
              aria-label={`Source ${source.refId}: ${source.documentId}${source.chunk === undefined ? '' : `, chunk ${source.chunk}`}`}
            >
              [{source.refId}] {source.documentId}
              {source.chunk === undefined ? '' : ` · chunk ${source.chunk}`}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Pending approvals with approve/deny controls (Issue 034 AC-1/3). */
export function ApprovalsPanel(props: {
  approvals: ApprovalRecord[]
  client: WorkApiClient
  onResolved: (result: ApprovalResolveResult) => void
}): JSX.Element {
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string>('')
  if (props.approvals.length === 0) return <></>
  const now = Date.now()
  return (
    <section data-testid="approvalsPanel" aria-label="Pending approvals">
      <h3>Pending approvals</h3>
      {error.length > 0 && (
        <p role="alert" data-testid="approvalError">
          {error}
        </p>
      )}
      <ul>
        {props.approvals.map((approval) => {
          const expired = Date.parse(approval.expiresAt) <= now
          return (
            <li key={approval.id} data-testid={`approval-${approval.id}`}>
              <h4>{approval.actionName}</h4>
              <p>Target: {approval.target}</p>
              <p>Request: {approval.paramsSummary}</p>
              <p>Impact: {approval.expectedImpact}</p>
              <p data-testid={`approval-expiry-${approval.id}`}>
                {expired ? 'Expired' : `Expires ${new Date(approval.expiresAt).toLocaleTimeString()}`}
              </p>
              <button
                type="button"
                data-testid={`approve-${approval.id}`}
                disabled={busyId === approval.id || expired}
                onClick={() => void decide('approved', approval)}
              >
                Approve
              </button>
              <button
                type="button"
                data-testid={`deny-${approval.id}`}
                disabled={busyId === approval.id || expired}
                onClick={() => void decide('denied', approval)}
              >
                Deny
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )

  async function decide(decision: 'approved' | 'denied', approval: ApprovalRecord): Promise<void> {
    setError('')
    setBusyId(approval.id)
    try {
      const result = await props.client.decideApproval(approval.id, {
        decision,
        expectedVersion: approval.version,
      })
      props.onResolved(result)
    } catch (cause) {
      // AC-4: duplicate/expired decisions surface their conflict as TEXT.
      setError(cause instanceof Error ? cause.message : 'The decision failed.')
    } finally {
      setBusyId('')
    }
  }
}

/** Action results with text state labels (Issue 034 AC-5/6). */
export function ActionResultsPanel(props: { actions: StreamViewModel['actions'] }): JSX.Element {
  if (props.actions.length === 0) return <></>
  return (
    <section data-testid="actionsPanel" aria-label="Action results">
      <h3>Actions</h3>
      <ul>
        {props.actions.map((action, index) => (
          <li key={`${action.executionId}-${index}`} data-testid={`action-${index}`}>
            <span>{action.action}: {actionStateLabel(action.status)}</span>
            {action.resultSummary !== undefined && (
              <pre data-testid={`action-result-${index}`}>{action.resultSummary}</pre>
            )}
            {action.durationMs !== undefined && <span> · {action.durationMs.toFixed(0)}ms</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The audit timeline ordered by session seq (Issue 034 AC-7). */
export function AuditTimeline(props: { entries: AuditEntry[] }): JSX.Element {
  if (props.entries.length === 0) return <></>
  return (
    <section data-testid="auditTimeline" aria-label="Audit timeline">
      <h3>Audit timeline</h3>
      <ol>
        {props.entries.map((entry) => (
          <li key={entry.seq} data-testid={`audit-${entry.seq}`}>
            <span data-testid={`audit-seq-${entry.seq}`}>#{entry.seq}</span>{' '}
            <span data-testid={`audit-category-${entry.seq}`}>{entry.category}</span> — {entry.summary}
          </li>
        ))}
      </ol>
    </section>
  )
}

export function ChatView(props: {
  session: SessionSnapshot
  client: WorkApiClient
  onDisconnected: (error?: string) => void
}): JSX.Element {
  const { session, client } = props
  const [view, setView] = useState<StreamViewModel>(initialViewModel)
  const [input, setInput] = useState('')
  const [sendError, setSendError] = useState('')
  const [streamStatus, setStreamStatus] = useState<'connected' | 'reconnecting' | 'closed'>('closed')
  const [userMessages, setUserMessages] = useState<{ id: string; text: string }[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRecord[]>([])
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const messageSeq = useRef(0)

  const refreshApprovals = useCallback(async (): Promise<void> => {
    try {
      setPendingApprovals(await client.listPendingApprovals(session.sessionId))
    } catch {
      // The approvals surface is optional; the stream keeps working.
    }
  }, [client, session.sessionId])

  const refreshAudit = useCallback(async (): Promise<void> => {
    try {
      setAuditEntries(await client.auditProjection(session.sessionId))
    } catch {
      // The audit surface is optional; the stream keeps working.
    }
  }, [client, session.sessionId])

  useEffect(() => {
    setView(initialViewModel())
    setUserMessages([])
    setSendError('')
    setPendingApprovals([])
    setAuditEntries([])
    void refreshApprovals()
    void refreshAudit()
    const controller = new AbortController()
    void client.openEventStream(session.sessionId, {
      signal: controller.signal,
      onEvent: (frame) => {
        setView((current) => foldEvent(current, frame))
        void refreshApprovals()
        void refreshAudit()
      },
      onStatus: (status, attempt) => {
        setStreamStatus(status)
        if (status === 'reconnecting') {
          props.onDisconnected()
        }
        void attempt
      },
    })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, client])

  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = input.trim()
    if (text.length === 0) return
    setInput('')
    setSendError('')
    messageSeq.current += 1
    setUserMessages((current) => [...current, { id: `client-${messageSeq.current}`, text }])
    let result: SendMessageResult
    try {
      result = await client.sendMessage(session.sessionId, text, `client-${messageSeq.current}`)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Failed to send the message.')
      return
    }
    if (result.status === 'replayed') {
      setSendError('This message was already submitted; no duplicate was created.')
    }
  }

  return (
    <section aria-label={`Session ${session.sessionId}`}>
      <h2 data-testid="sessionTitle">{session.title ?? session.sessionId}</h2>
      <StatusBar view={view} />
      <p data-testid="streamStatus" role="status">
        Stream: {streamStatus === 'connected' ? 'connected' : streamStatus === 'reconnecting' ? 'reconnecting…' : 'closed'}
      </p>
      <div data-testid="messages">
        {userMessages.map((message) => (
          <p key={message.id} data-testid={`user-${message.id}`}>
            You: {message.text}
          </p>
        ))}
        <StreamingMessage view={view} />
      </div>
      <SourcesPanel view={view} />
      <ApprovalsPanel
        approvals={pendingApprovals}
        client={client}
        onResolved={(result) => {
          setPendingApprovals((current) => current.filter((approval) => approval.id !== result.approval.id))
          void refreshApprovals()
          void refreshAudit()
        }}
      />
      <ActionResultsPanel actions={view.actions} />
      <AuditTimeline entries={auditEntries} />
      <form onSubmit={(event) => void send(event)} aria-label="Send message">
        <input
          ref={inputRef}
          data-testid="messageInput"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Send a message…"
          aria-label="Message"
        />
        <button type="submit" data-testid="sendButton">
          Send
        </button>
      </form>
      {sendError.length > 0 && (
        <p role="alert" data-testid="sendError">
          {sendError}
        </p>
      )}
    </section>
  )
}

export function App(props: { client: WorkApiClient }): JSX.Element {
  const [session, setSession] = useState<SessionSnapshot | undefined>(undefined)
  const [notice, setNotice] = useState('')
  return (
    <main>
      <h1>Rigo Work</h1>
      {session === undefined ? (
        <>
          <SessionCreateForm client={props.client} onCreated={setSession} />
          <SessionOpenForm client={props.client} onOpened={setSession} />
        </>
      ) : (
        <ChatView
          session={session}
          client={props.client}
          onDisconnected={() => setNotice('Connection lost — reconnecting with the last event id…')}
        />
      )}
      {notice.length > 0 && (
        <p role="status" data-testid="notice">
          {notice}
        </p>
      )}
    </main>
  )
}
