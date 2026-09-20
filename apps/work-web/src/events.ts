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
  /** Streaming assistant text of the current attempt (`assistant/attempt` payloads). */
  assistantText: string
  /** Streaming reasoning text of the current attempt. */
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
  /** Why the current turn failed, when it did. Cleared when a new turn starts. */
  turnError?: { message: string; code?: string }
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

/**
 * Extract the assistant text of one `assistant/attempt` payload.
 *
 * The attempt carries the stream as PACKED records rather than one event per
 * delta: a `text-chunks` record holds one run's successive deltas in `texts`,
 * and a run ends where the next record begins (a new `index`, or a
 * reasoning/tool run in between), so every run contributes in order. The fold
 * therefore REPLACES the view's text with this attempt's total instead of
 * appending — each attempt event is a snapshot of the attempt so far, so
 * appending would repeat everything already shown on every update.
 * @param payload - the event's `data` (a `{ turn, step, stream }` object).
 * @returns the attempt's whole text and reasoning, either one absent when the attempt carried none.
 */
export function attemptText(payload: Record<string, unknown>): { text?: string; reasoning?: string } {
  const stream = payload.stream
  if (!Array.isArray(stream)) return {}
  const text: string[] = []
  const reasoning: string[] = []
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const { type, texts } = record as { type?: unknown; texts?: unknown }
    if (type !== 'text-chunks' && type !== 'reasoning-chunks') continue
    if (!Array.isArray(texts)) continue
    const joined = texts.filter((part): part is string => typeof part === 'string').join('')
    if (joined.length === 0) continue
    ;(type === 'text-chunks' ? text : reasoning).push(joined)
  }
  return {
    ...(text.length === 0 ? {} : { text: text.join('') }),
    ...(reasoning.length === 0 ? {} : { reasoning: reasoning.join('') }),
  }
}

/**
 * A structured turn failure, from whichever event carries it.
 *
 * A turn can fail in two places, and they name the same facts differently: a
 * provider that never started fails inside the attempt's `finish` chunk
 * (`reason.failure`), while a turn that dies later records it on
 * `turn/end` (`reason.error`). Both are `{ message, code }`.
 * @param reason - the `reason` object of either carrier.
 * @param key - which member holds the failure on that carrier.
 * @returns the failure, or `undefined` when the reason is not an error.
 */
export function turnFailure(
  reason: unknown,
  key: 'failure' | 'error',
): { message: string; code?: string } | undefined {
  if (reason === null || typeof reason !== 'object') return undefined
  const row = reason as { kind?: unknown } & Record<string, unknown>
  if (row.kind !== 'error') return undefined
  const raw = row[key] ?? row['failure'] ?? row['error']
  if (raw === null || typeof raw !== 'object') {
    return { message: 'The turn failed, and the error carried no detail.' }
  }
  const failure = raw as { message?: unknown; code?: unknown }
  return {
    message: typeof failure.message === 'string' && failure.message.length > 0
      ? failure.message
      : 'The turn failed, and the error carried no message.',
    ...(typeof failure.code === 'string' && failure.code.length > 0 ? { code: failure.code } : {}),
  }
}

/** The `finish` chunk of an attempt stream, when the provider reported one. */
function attemptFailure(payload: Record<string, unknown>): { message: string; code?: string } | undefined {
  const stream = payload.stream
  if (!Array.isArray(stream)) return undefined
  for (const record of stream) {
    if (record === null || typeof record !== 'object') continue
    const chunk = (record as { chunk?: unknown }).chunk
    if (chunk === null || typeof chunk !== 'object') continue
    const row = chunk as { type?: unknown; reason?: unknown }
    if (row.type !== 'finish') continue
    const failure = turnFailure(row.reason, 'failure')
    if (failure !== undefined) return failure
  }
  return undefined
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
    case 'turn/start': {
      // The previous turn's failure must be REMOVED, not set to `undefined`:
      // under exactOptionalPropertyTypes an explicit undefined is a value, and
      // it would flow out as a present-but-empty field.
      const { turnError: _previousFailure, ...rest } = view
      return {
        ...rest,
        messages: archiveAssistant(view),
        assistantText: '',
        reasoningText: '',
        sources: [],
        retrievalEmpty: false,
        agentStatus: 'running',
        phase: 'context',
        turnId: Number((data.payload as { turn?: unknown })?.turn),
      }
    }
    case 'turn/end': {
      const payload = data.payload as { reason?: unknown } | undefined
      const failure = turnFailure(payload?.reason, 'error')
      return {
        ...view,
        agentStatus: 'idle',
        phase: 'idle',
        // A failed turn used to end here with an empty answer and no signal;
        // the failure is carried in the view model so the transcript can say
        // what happened instead of looking like a model that said nothing.
        ...(failure === undefined ? {} : { turnError: failure }),
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
    // The 0.1.6 baseline carries the assistant stream as packed records on
    // `assistant/attempt`; the per-delta `assistant/chunk` event it replaced
    // no longer exists, so this is the only place streamed text arrives.
    case 'assistant/attempt': {
      const payload = (data.payload ?? {}) as Record<string, unknown>
      const { text, reasoning } = attemptText(payload)
      const failure = attemptFailure(payload)
      return {
        ...view,
        phase: 'llm',
        assistantText: text ?? view.assistantText,
        reasoningText: reasoning ?? view.reasoningText,
        ...(failure === undefined ? {} : { turnError: failure }),
      }
    }
    // The completed assistant turn. Its `message.content` is the authoritative
    // text — a provider that answers in one shot produces ONLY this event, with
    // no `assistant/attempt` and no deltas — so the transcript must be read
    // from here or a non-streaming answer renders as an empty bubble.
    case 'assistant/message': {
      const payload = data.payload as { message?: { content?: unknown } } | undefined
      const text = contentText(payload?.message?.content)
      return text === undefined ? { ...view, phase: 'llm' } : { ...view, phase: 'llm', assistantText: text }
    }
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
