/**
 * Rigo Work Web UI components (Issue 033): session creation, chat with
 * SSE-streamed assistant output, agent status + detailed phases, and
 * locatable knowledge sources. Failures are always rendered as TEXT (AC-7);
 * streaming and source regions are keyboard-navigable.
 *
 * The visual system lives in styles.css (token-based, light + dark). The
 * component contracts are pinned by the unit suite (ui.vitest.tsx) and the
 * E2E suites: every data-testid, role and user-visible label below is part
 * of that contract — restyle freely, never rename.
 *
 * @module @teoclub/work-web/components
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import {
  actionStateLabel,
  foldEvents,
  initialViewModel,
  isSurfaceRefreshFrame,
  phaseLabel,
  type AgentPhase,
  type StreamViewModel,
  type UiChatMessage,
} from './events.ts'
import { renderMarkdown } from './markdown.tsx'
import type {
  ApprovalRecord,
  ApprovalResolveResult,
  AuditEntry,
  SendMessageResult,
  SessionSnapshot,
  SseFrame,
  WorkApiClient,
} from './api.ts'
import { Icon, ICONS, LogoMark } from './icons.tsx'
import type { ShellRenderSlot } from './slot-map.ts'

export { SessionCreateForm, SessionOpenForm, type SessionFormValues } from './forms.tsx'

const AUDIT_RENDER_LIMIT = 100
const SURFACE_REFRESH_MS = 250

function isNoisyAudit(entry: AuditEntry): boolean {
  if (entry.category === 'step') return true
  if (entry.category === 'other' && /assistant\/chunk|context\//.test(entry.summary)) return true
  return false
}

function compactAuditEntries(entries: AuditEntry[]): AuditEntry[] {
  const useful = entries.filter((entry) => !isNoisyAudit(entry))
  return useful.length > AUDIT_RENDER_LIMIT ? useful.slice(-AUDIT_RENDER_LIMIT) : useful
}

// ---------------------------------------------------------------------------
// Status + conversation
// ---------------------------------------------------------------------------

export function StatusBar(props: { view: StreamViewModel }): JSX.Element {
  const { view } = props
  const phase: AgentPhase = view.agentStatus === 'idle' ? 'idle' : view.phase === 'idle' ? 'running' : view.phase
  const running = view.agentStatus === 'running'
  return (
    <div className="status-bar" data-testid="statusBar" role="status" aria-live="polite">
      <span className={`pill ${running ? 'pill--accent' : 'pill--ok'}`} data-testid="agentStatus">
        <span className="pill-dot" aria-hidden="true" />
        Agent: {view.agentStatus}
      </span>
      <span
        className={`pill ${phase === 'approval' ? 'pill--warn' : running ? 'pill--accent' : ''}`}
        data-testid="agentPhase"
      >
        Phase: {phaseLabel(phase)}
      </span>
      {view.pendingApprovals > 0 && (
        <span className="pill pill--warn" data-testid="pendingApprovals">
          <span className="pill-dot" aria-hidden="true" />
          Pending approvals: {view.pendingApprovals}
        </span>
      )}
    </div>
  )
}

export function StreamingMessage(props: { view: StreamViewModel }): JSX.Element {
  const { view } = props
  const streaming = view.agentStatus === 'running'
  return (
    <div
      data-testid="assistantOutput"
      tabIndex={0}
      aria-label="Assistant output, streaming"
      aria-live="polite"
      role="log"
      className="assistant-body md"
    >
      {view.assistantText.length === 0
        ? (
          <p className="assistant-empty" data-testid="assistantEmpty">
            {streaming ? 'Thinking…' : 'Waiting for the assistant…'}
          </p>
        )
        : (
          <>
            {renderMarkdown(view.assistantText)}
            {streaming && <span className="caret" aria-hidden="true" />}
          </>
        )}
    </div>
  )
}

export function SourcesPanel(props: { view: StreamViewModel }): JSX.Element {
  const { view } = props
  if (view.retrievalEmpty) {
    // AC-5: explicit empty-retrieval state (text, not color-only).
    return (
      <section className="rail-section" data-testid="sourcesPanel" aria-label="Knowledge sources">
        <h3 className="rail-head">
          <Icon path={ICONS.sources} size={13} />
          Sources
        </h3>
        <p className="rail-empty" data-testid="noSources">
          <span className="rail-empty-icon"><Icon path={ICONS.doc} size={20} /></span>
          No relevant material found in the knowledge base.
        </p>
      </section>
    )
  }
  if (view.sources.length === 0) return <></>
  return (
    <section className="rail-section" data-testid="sourcesPanel" aria-label="Knowledge sources">
      <h3 className="rail-head">
        <Icon path={ICONS.sources} size={13} />
        Sources
        <span className="count">{view.sources.length}</span>
      </h3>
      <ul className="sources-list">
        {view.sources.map((source) => (
          <li key={source.refId}>
            <button
              type="button"
              className="source-card"
              data-testid={`source-${source.refId}`}
              data-source={JSON.stringify(source)}
              aria-label={`Source ${source.refId}: ${source.documentId}${source.chunk === undefined ? '' : `, chunk ${source.chunk}`}`}
            >
              <span className="source-ref" aria-hidden="true">{source.refId}</span>
              <span className="source-body">
                <span className="source-doc">{source.documentId}</span>
                <span className="source-provider">
                  {source.provider}{source.chunk === undefined ? '' : ` · chunk ${source.chunk}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Re-render every interval so expiry countdowns stay live. */
function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [active, intervalMs])
  return now
}

/** "Expires in 1m 07s" — the countdown is TEXT state, never color-only. */
function expiryLabel(expiresAt: string, now: number): string {
  const remaining = Date.parse(expiresAt) - now
  if (remaining <= 0) return 'Expired'
  const minutes = Math.floor(remaining / 60000)
  const seconds = Math.floor((remaining % 60000) / 1000)
  if (minutes >= 1) return `Expires in ${minutes}m ${String(seconds).padStart(2, '0')}s`
  return `Expires in ${seconds}s`
}

/** Pending approvals with approve/deny controls (Issue 034 AC-1/3). */
export function ApprovalsPanel(props: {
  approvals: ApprovalRecord[]
  client: WorkApiClient
  onResolved: (result: ApprovalResolveResult) => void
}): JSX.Element {
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState<string>('')
  const now = useNow(props.approvals.length > 0)
  if (props.approvals.length === 0) return <></>
  return (
    <section className="approvals" data-testid="approvalsPanel" aria-label="Pending approvals">
      <h3 className="approvals-head">
        <Icon path={ICONS.alert} size={13} />
        Approval required — the agent is waiting for you
      </h3>
      {error.length > 0 && (
        <p role="alert" data-testid="approvalError" className="alert">
          <span className="alert-icon"><Icon path={ICONS.alert} size={14} /></span>
          {error}
        </p>
      )}
      <ul className="approvals-list">
        {props.approvals.map((approval) => {
          const expired = Date.parse(approval.expiresAt) <= now
          return (
            <li key={approval.id} className="approval-card" data-testid={`approval-${approval.id}`}>
              <h4 className="approval-title">
                <Icon path={ICONS.doc} size={14} />
                {approval.actionName}
              </h4>
              <dl className="approval-rows">
                <div className="approval-row approval-row--mono">
                  <dt>Target:</dt>
                  <dd>{approval.target}</dd>
                </div>
                <div className="approval-row approval-row--summary">
                  <dt>Request:</dt>
                  <dd>{approval.paramsSummary}</dd>
                </div>
                <div className="approval-row">
                  <dt>Impact:</dt>
                  <dd>{approval.expectedImpact}</dd>
                </div>
                <div className="approval-row">
                  <dt>Expires:</dt>
                  <dd>
                    <span data-testid={`approval-expiry-${approval.id}`}>
                      {expired ? 'Expired' : expiryLabel(approval.expiresAt, now)}
                    </span>
                  </dd>
                </div>
              </dl>
              <div className="approval-actions">
                <button
                  type="button"
                  className="btn btn--secondary"
                  data-testid={`deny-${approval.id}`}
                  disabled={busyId === approval.id || expired}
                  onClick={() => void decide('denied', approval)}
                >
                  <Icon path={ICONS.deny} size={13} />
                  Deny
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid={`approve-${approval.id}`}
                  disabled={busyId === approval.id || expired}
                  onClick={() => void decide('approved', approval)}
                >
                  <Icon path={ICONS.approve} size={13} />
                  Approve
                </button>
              </div>
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

/** Map an action status onto its status-chip tone (the text label carries the state). */
function actionChipClass(status: string): string {
  switch (status) {
    case 'succeeded': return 'status-chip status-chip--ok'
    case 'failed':
    case 'cancelled':
    case 'recovery-required':
    case 'denied': return 'status-chip status-chip--danger'
    case 'awaiting-approval':
    case 'requires-approval': return 'status-chip status-chip--warn'
    case 'running': return 'status-chip status-chip--accent'
    default: return 'status-chip'
  }
}

/** Action results with text state labels (Issue 034 AC-5/6). */
export function ActionResultsPanel(props: { actions: StreamViewModel['actions'] }): JSX.Element {
  if (props.actions.length === 0) return <></>
  return (
    <section className="rail-section" data-testid="actionsPanel" aria-label="Action results">
      <h3 className="rail-head">
        <Icon path={ICONS.activity} size={13} />
        Actions
        <span className="count">{props.actions.length}</span>
      </h3>
      <ul className="action-list">
        {props.actions.map((action, index) => (
          <li key={`${action.executionId}-${index}`} className="action-card" data-testid={`action-${index}`}>
            <div className="action-head">
              <span className={actionChipClass(action.status)}>
                <span className="status-dot" aria-hidden="true" />
                {actionStateLabel(action.status)}
              </span>
              <span className="action-name">{action.action}</span>
              {action.durationMs !== undefined && (
                <span className="action-duration">{action.durationMs.toFixed(0)}ms</span>
              )}
            </div>
            {action.resultSummary !== undefined && (
              <pre data-testid={`action-result-${index}`} className="action-result">{action.resultSummary}</pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The audit timeline ordered by session seq (Issue 034 AC-7). */
export function AuditTimeline(props: { entries: AuditEntry[] }): JSX.Element {
  const listRef = useRef<HTMLOListElement>(null)
  const visible = compactAuditEntries(props.entries)
  useEffect(() => {
    const element = listRef.current
    if (element !== null && typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight })
    }
  }, [visible])
  if (visible.length === 0) return <></>
  return (
    <section className="rail-section" data-testid="auditTimeline" aria-label="Audit timeline">
      <h3 className="rail-head">
        <Icon path={ICONS.ledger} size={13} />
        Audit timeline
        <span className="count">{visible.length}</span>
      </h3>
      {props.entries.length > visible.length && (
        <p className="rail-note">Showing notable events ({visible.length} of {props.entries.length})</p>
      )}
      <ol className="audit-list" ref={listRef}>
        {visible.map((entry) => (
          <li key={entry.seq} className="audit-item" data-testid={`audit-${entry.seq}`}>
            <span className="audit-seq" data-testid={`audit-seq-${entry.seq}`}>#{entry.seq}</span>
            <span className={`audit-category audit-category--${entry.category}`} data-testid={`audit-category-${entry.seq}`}>
              {entry.category}
            </span>
            <span className="audit-summary">{entry.summary}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function unmatchedOptimisticUsers(
  history: UiChatMessage[],
  pending: { id: string; text: string }[],
): { id: string; text: string }[] {
  const historyUsers = history.filter((message) => message.role === 'user').map((message) => message.text)
  let matched = 0
  for (
    let pendingIndex = pending.length - 1, historyIndex = historyUsers.length - 1;
    pendingIndex >= 0 && historyIndex >= 0;
    pendingIndex -= 1, historyIndex -= 1
  ) {
    if (pending[pendingIndex]!.text !== historyUsers[historyIndex]!) break
    matched += 1
  }
  return matched === 0 ? pending : pending.slice(0, pending.length - matched)
}

function ChatTranscript(props: {
  view: StreamViewModel
  pendingUser: { id: string; text: string }[]
}): JSX.Element {
  const extra = unmatchedOptimisticUsers(props.view.messages, props.pendingUser)
  return (
    <>
      {props.view.messages.map((message) => (
        message.role === 'user' ? (
          <p key={message.id} className="msg-user" data-testid={`user-${message.id}`}>
            {message.text}
          </p>
        ) : (
          <div key={message.id} className="msg-assistant">
            <span className="avatar" aria-hidden="true"><LogoMark size={18} /></span>
            <div className="assistant-body md">{renderMarkdown(message.text)}</div>
          </div>
        )
      ))}
      {extra.map((message) => (
        <p key={message.id} className="msg-user" data-testid={`user-${message.id}`}>
          {message.text}
        </p>
      ))}
      <div className="msg-assistant">
        <span className="avatar" aria-hidden="true"><LogoMark size={18} /></span>
        <StreamingMessage view={props.view} />
      </div>
    </>
  )
}

export function ChatView(props: {
  session: SessionSnapshot
  client: WorkApiClient
  onDisconnected: (error?: string) => void
  /**
   * Threaded down from the shell, which declares the chat seats. A render site
   * that is not the declarer only needs the rendering capability, not the
   * authority — so this is a plain optional prop, and its absence leaves a
   * bare `ChatView` (as the component tests render it) with no extensions.
   */
  renderSlot?: ShellRenderSlot | undefined
  initialMessage?: string
  onInitialMessageConsumed?: () => void
}): JSX.Element {
  const { session, client } = props
  const [view, setView] = useState<StreamViewModel>(initialViewModel)
  const [input, setInput] = useState('')
  const [sendError, setSendError] = useState('')
  const [streamStatus, setStreamStatus] = useState<'connected' | 'reconnecting' | 'closed'>('closed')
  const [userMessages, setUserMessages] = useState<{ id: string; text: string }[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRecord[]>([])
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [aborting, setAborting] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
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
      const entries = await client.auditProjection(session.sessionId)
      setAuditEntries(compactAuditEntries(entries))
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
    const pending: SseFrame[] = []
    let queued = false
    let cancelled = false
    let surfaceTimer = 0
    const flush = (): void => {
      queued = false
      if (cancelled) return
      const batch = pending.splice(0)
      if (batch.length === 0) return
      setView((current) => foldEvents(current, batch))
      if (batch.some(isSurfaceRefreshFrame)) {
        window.clearTimeout(surfaceTimer)
        surfaceTimer = window.setTimeout(() => {
          if (cancelled) return
          void refreshApprovals()
          void refreshAudit()
        }, SURFACE_REFRESH_MS)
      }
    }
    void client.openEventStream(session.sessionId, {
      signal: controller.signal,
      onEvent: (frame) => {
        pending.push(frame)
        if (queued) return
        queued = true
        queueMicrotask(flush)
      },
      onStatus: (status, attempt) => {
        setStreamStatus(status)
        if (status === 'reconnecting') {
          props.onDisconnected()
        }
        void attempt
      },
    })
    return () => {
      cancelled = true
      queued = false
      window.clearTimeout(surfaceTimer)
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId, client])

  const submitText = async (text: string, options?: { initial?: boolean }): Promise<void> => {
    if (text.length === 0) return
    if (options?.initial !== true) setInput('')
    setSendError('')
    if (options?.initial === true) {
      messageSeq.current = Math.max(messageSeq.current, 1)
    } else {
      messageSeq.current += 1
    }
    const clientMessageId = `client-${messageSeq.current}`
    setUserMessages((current) => (
      current.some((entry) => entry.id === clientMessageId)
        ? current
        : [...current, { id: clientMessageId, text }]
    ))
    let result: SendMessageResult
    try {
      result = await client.sendMessage(session.sessionId, text, clientMessageId)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Failed to send the message.')
      setUserMessages((current) => current.filter((entry) => entry.id !== clientMessageId))
      if (options?.initial !== true) setInput(text)
      return
    }
    if (result.status === 'replayed' && options?.initial !== true) {
      setSendError('This message was already submitted; no duplicate was created.')
    }
  }

  const initialSentFor = useRef('')
  useEffect(() => {
    const text = props.initialMessage?.trim() ?? ''
    if (text.length === 0) return
    if (initialSentFor.current === session.sessionId) return
    initialSentFor.current = session.sessionId
    void submitText(text, { initial: true })
    props.onInitialMessageConsumed?.()
    // Mount-once per session: the first-turn send is intentionally not
    // re-bound to submitText (which would retrigger on every keystroke).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId])

  // Keep the newest content in view while the user stays near the bottom.
  useEffect(() => {
    const element = messagesRef.current
    if (element === null) return
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 160
    if (nearBottom && typeof element.scrollTo === 'function') {
      element.scrollTo({ top: element.scrollHeight })
    }
  }, [view.assistantText, view.messages.length, userMessages.length, pendingApprovals.length])

  const send = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    await submitText(input.trim())
  }

  const abort = async (): Promise<void> => {
    setAborting(true)
    try {
      await client.abort(session.sessionId)
    } catch (cause) {
      setSendError(cause instanceof Error ? cause.message : 'Failed to abort the current turn.')
    } finally {
      setAborting(false)
    }
  }

  const running = view.agentStatus === 'running'

  return (
    <div className="work" aria-label={`Session ${session.sessionId}`}>
      <div className="conversation">
        <div className="conversation-toolbar">
          <StatusBar view={view} />
          <p data-testid="streamStatus" role="status" className={`stream-status stream-status--${streamStatus}`}>
            Stream: {streamStatus === 'connected' ? 'connected' : streamStatus === 'reconnecting' ? 'reconnecting…' : 'closed'}
          </p>
        </div>

        <div className="messages" data-testid="messages" ref={messagesRef}>
          <ChatTranscript view={view} pendingUser={userMessages} />
        </div>

        {props.renderSlot?.('chat.approvals', {
          sessionId: session.sessionId,
          client,
          approvals: pendingApprovals,
          onResolved: (result) => {
            setPendingApprovals((current) => current.filter((approval) => approval.id !== result.approval.id))
            void refreshApprovals()
            void refreshAudit()
          },
        })}

        <form onSubmit={(event) => void send(event)} aria-label="Send message" className="composer">
          {sendError.length > 0 && (
            <p role="alert" data-testid="sendError" className="alert composer-error">
              <span className="alert-icon"><Icon path={ICONS.alert} size={14} /></span>
              {sendError}
            </p>
          )}
          <div className="composer-row">
            <textarea
              className="textarea"
              data-testid="messageInput"
              rows={2}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submitText(input.trim())
                }
              }}
              placeholder="Ask about your knowledge base…"
              aria-label="Message"
            />
            {running && (
              <button
                type="button"
                className="btn btn--secondary"
                data-testid="abortButton"
                disabled={aborting}
                onClick={() => void abort()}
                title="Stop the current turn"
              >
                <Icon path={ICONS.stop} size={13} />
                Stop
              </button>
            )}
            <button type="submit" className="btn btn--primary" data-testid="sendButton" disabled={input.trim().length === 0}>
              <Icon path={ICONS.send} size={13} />
              Send
            </button>
            {props.renderSlot?.('chat.composer.bar', { sessionId: session.sessionId, client })}
          </div>
          <div className="composer-hint">
            <span><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line</span>
          </div>
        </form>
      </div>

      <aside className="rail" aria-label="Session context">
        <SourcesPanel view={view} />
        <ActionResultsPanel actions={view.actions} />
        <AuditTimeline entries={auditEntries} />
        {props.renderSlot?.('chat.rail', { view })}
      </aside>
    </div>
  )
}


