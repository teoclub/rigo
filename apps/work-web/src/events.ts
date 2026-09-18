/**
 * Rigo Work Web view-model derivation (Issue 033): folds the SSE session
 * event stream into the UI state — incremental assistant output, the agent
 * status, the detailed phases, knowledge sources and approval state.
 *
 * The UI NEVER consumes a raw LLM provider stream: every byte arrives as a
 * session event (SPEC §4.5/§5.6).
 *
 * @module @teoclub/work-web/events
 */

import type { SseFrame } from './api.ts'

/** Detailed agent phases (SPEC §5.6 progress events). */
export type AgentPhase =
  | 'idle'
  | 'context'
  | 'retrieval'
  | 'llm'
  | 'approval'
  | 'action'
  | 'running'

/** One locatable knowledge source (from `knowledge/retrieved`). */
export interface UiSourceReference {
  refId: string
  provider: string
  documentId: string
  chunk: number | undefined
  title?: string
}

/** One observed action execution (Issue 034 AC-5/6). */
export interface UiActionEvent {
  executionId: string
  action: string
  status: string
  durationMs?: number
  /** Redacted result summary (the write outcome: version/hash). */
  resultSummary?: string
}

/** One completed chat turn fragment reconstructed from the session log. */
export interface UiChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

/** The UI state derived from the event stream. */
export interface StreamViewModel {
  agentStatus: 'idle' | 'running'
  phase: AgentPhase
  /** Incremental assistant text (assistant/chunk payloads). */
  assistantText: string
  /** Incremental reasoning text. */
  reasoningText: string
  /** Completed user/assistant turns (the current assistant stays in `assistantText`). */
  messages: UiChatMessage[]
  /** Knowledge sources of the current answer, in rank order. */
  sources: UiSourceReference[]
  /** Whether the last retrieval found nothing (AC-5 explicit empty state). */
  retrievalEmpty: boolean
  /** Pending approvals count. */
  pendingApprovals: number
  /** Observed action executions. */
  actions: UiActionEvent[]
  /** The last observed event seq. */
  lastSeq: number
  turnId: number | undefined
}

const MAX_ACTIONS = 40
const MAX_MESSAGES = 120

function capped<T>(items: readonly T[], max: number): T[] {
  return items.length <= max ? [...items] : items.slice(-max)
}

export function initialViewModel(): StreamViewModel {
  return {
    agentStatus: 'idle',
    phase: 'idle',
    assistantText: '',
    reasoningText: '',
    messages: [],
    sources: [],
    retrievalEmpty: false,
    pendingApprovals: 0,
    actions: [],
    lastSeq: -1,
    turnId: undefined,
  }
}

/** Parse a `knowledge/retrieved` event into source references. */
export function sourcesFromRetrieval(data: Record<string, unknown>): UiSourceReference[] {
  const ids = Array.isArray(data.sourceIds) ? data.sourceIds.map(String) : []
  return ids.map((id, index) => {
    const [provider, documentId, chunkPart] = id.split('#')
    const chunk = Number.parseInt(chunkPart ?? '', 10)
    return {
      refId: `s${index + 1}`,
      provider: provider ?? 'unknown',
      documentId: documentId ?? id,
      chunk: Number.isNaN(chunk) ? undefined : chunk,
    }
  })
}

/** Extract the assistant text of one chunk payload. */
export function chunkText(payload: Record<string, unknown>): { text?: string; reasoning?: string } {
  const chunk = payload.chunk as { type?: unknown; text?: unknown } | undefined
  if (chunk === undefined || typeof chunk !== 'object') return {}
  if (chunk.type === 'reasoning') {
    const reasoning = typeof chunk.text === 'string' ? chunk.text : undefined
    return reasoning === undefined ? {} : { reasoning }
  }
  const text = typeof chunk.text === 'string' ? chunk.text : undefined
  return text === undefined ? {} : { text }
}

function contentText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed.length === 0 ? undefined : trimmed
  }
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const text = (block as { text?: unknown }).text
    if (typeof text === 'string' && text.length > 0) parts.push(text)
  }
  const joined = parts.join('\n').trim()
  return joined.length === 0 ? undefined : joined
}

/**
 * Visible user-prompt text from a `user/message` payload. Injected plugin
 * context (AGENTS.md, notices, catalogs) stays out of the chat transcript.
 */
export function userPromptText(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const row = payload as { source?: { kind?: unknown }; content?: unknown; text?: unknown; message?: unknown }
  if (row.source !== undefined && row.source.kind !== 'user') return undefined
  return contentText(row.content)
    ?? (typeof row.text === 'string' && row.text.trim().length > 0 ? row.text.trim() : undefined)
    ?? userPromptText(row.message === payload ? undefined : row.message)
}

function archiveAssistant(view: StreamViewModel): UiChatMessage[] {
  if (view.assistantText.trim().length === 0) return view.messages
  return capped([
    ...view.messages,
    {
      id: `assistant-${view.turnId ?? view.lastSeq}`,
      role: 'assistant',
      text: view.assistantText,
    },
  ], MAX_MESSAGES)
}

/** Fold one SSE frame into the view model (deterministic). */
export function foldEvent(view: StreamViewModel, frame: SseFrame): StreamViewModel {
  if (frame.event === 'session.snapshot') {
    return { ...initialViewModel(), lastSeq: frame.id >= 0 ? frame.id : view.lastSeq }
  }
  if (frame.event !== 'session.event') return view
  const data = frame.data as { type?: unknown; payload?: unknown; seq?: unknown }
  if (typeof data.seq === 'number') view = { ...view, lastSeq: data.seq }
  switch (data.type) {
    case 'turn/start':
      return {
        ...view,
        messages: archiveAssistant(view),
        assistantText: '',
        reasoningText: '',
        sources: [],
        retrievalEmpty: false,
        agentStatus: 'running',
        phase: 'context',
        turnId: Number((data.payload as { turn?: unknown })?.turn),
      }
    case 'turn/end': {
      const payload = data.payload as { reason?: { kind?: unknown } } | undefined
      return {
        ...view,
        agentStatus: 'idle',
        phase: 'idle',
        ...(payload?.reason?.kind === 'error' ? {} : {}),
      }
    }
    case 'user/message': {
      const text = userPromptText(data.payload)
      if (text === undefined) return view
      const id = typeof data.seq === 'number' ? `user-${data.seq}` : `user-${view.messages.length}`
      if (view.messages.some((message) => message.id === id)) return view
      return { ...view, messages: capped([...view.messages, { id, role: 'user', text }], MAX_MESSAGES) }
    }
    case 'context/contributed':
      return { ...view, phase: 'context' }
    case 'knowledge/retrieved': {
      const payload = data.payload as { sourceIds?: unknown; status?: unknown } | undefined
      const ids = Array.isArray(payload?.sourceIds) ? payload.sourceIds : []
      return {
        ...view,
        phase: 'retrieval',
        sources: sourcesFromRetrieval({ sourceIds: ids }),
        retrievalEmpty: ids.length === 0 && payload?.status === 'empty',
      }
    }
    case 'assistant/chunk': {
      const { text, reasoning } = chunkText((data.payload ?? {}) as Record<string, unknown>)
      return {
        ...view,
        phase: 'llm',
        assistantText: text === undefined ? view.assistantText : view.assistantText + text,
        reasoningText: reasoning === undefined ? view.reasoningText : view.reasoningText + reasoning,
      }
    }
    case 'assistant/message':
      return { ...view, phase: 'llm' }
    case 'approval/requested':
      return { ...view, phase: 'approval', pendingApprovals: view.pendingApprovals + 1 }
    case 'approval/resolved':
      return {
        ...view,
        pendingApprovals: Math.max(0, view.pendingApprovals - 1),
        ...((data.payload as { outcome?: unknown })?.outcome === 'denied'
          ? { phase: 'action', actions: capped([...view.actions, { executionId: 'approval', action: 'approval', status: 'denied' }], MAX_ACTIONS) }
          : {}),
      }
    case 'action/executed': {
      const payload = data.payload as {
        executionId?: unknown
        action?: unknown
        status?: unknown
        durationMs?: unknown
        resultSummary?: unknown
      } | undefined
      return {
        ...view,
        phase: payload?.status === 'running' || payload?.status === 'requires-approval' ? 'action' : view.phase,
        actions: capped([
          ...view.actions,
          {
            executionId: String(payload?.executionId ?? ''),
            action: String(payload?.action ?? ''),
            status: String(payload?.status ?? ''),
            ...(typeof payload?.durationMs === 'number' ? { durationMs: payload.durationMs } : {}),
            ...(typeof payload?.resultSummary === 'string' ? { resultSummary: payload.resultSummary } : {}),
          },
        ], MAX_ACTIONS),
      }
    }
    default:
      return view
  }
}

/** Fold a batch of frames in one pass (replay / rAF coalescing). */
export function foldEvents(view: StreamViewModel, frames: readonly SseFrame[]): StreamViewModel {
  return frames.reduce(foldEvent, view)
}

/** Frames that should refresh the approvals/audit HTTP surfaces. */
export function isSurfaceRefreshFrame(frame: SseFrame): boolean {
  if (frame.event === 'session.snapshot') return true
  if (frame.event !== 'session.event') return false
  const type = (frame.data as { type?: unknown }).type
  return type === 'turn/end'
    || type === 'approval/requested'
    || type === 'approval/resolved'
    || type === 'action/executed'
}

/** Human-readable action state labels (SPEC §3.4; AC-5 — text, never color-only). */
export function actionStateLabel(status: string): string {
  switch (status) {
    case 'awaiting-approval': return 'Waiting for approval'
    case 'running': return 'Running'
    case 'succeeded': return 'Succeeded'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
    case 'recovery-required': return 'Recovery required'
    case 'requires-approval': return 'Waiting for approval'
    case 'denied': return 'Denied'
    default: return status
  }
}

/** The human-readable phase label (TEXT — never color-only, AC-7). */
export function phaseLabel(phase: AgentPhase): string {
  switch (phase) {
    case 'idle': return 'Idle'
    case 'context': return 'Building context'
    case 'retrieval': return 'Retrieving knowledge'
    case 'llm': return 'Generating response'
    case 'approval': return 'Waiting for approval'
    case 'action': return 'Running action'
    case 'running': return 'Running'
  }
}
