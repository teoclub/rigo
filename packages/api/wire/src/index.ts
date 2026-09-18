/**
 * Rigo `/api/v1` wire contract (Issue 039).
 *
 * The single source for every shape crossing HTTP or SSE between the host
 * (`@teoclub/api-http`) and the browser (`@teoclub/work-web`), plus the two
 * pieces of protocol logic both sides must agree on exactly: the reconnect
 * backoff and the SSE framing.
 *
 * Before this package the same interfaces and the same framing regexes were
 * hand-copied in three places — `apps/work-web/src/api.ts`,
 * `tests/integration/work-web-api.spec.ts` and
 * `tests/e2e/work-failure-paths.e2e.ts` — and parity was enforced only by the
 * integration tests. Derived types (`SseFrame`, `SessionSnapshot`, …) are the
 * contract; the only runtime code here is `sseReconnectDelay` and
 * `SseDecoder`, each extracted verbatim from the copy that was already
 * authoritative so this is a pure consolidation, not a behaviour change.
 *
 * @module @teoclub/api-wire
 */

// ── Errors ──────────────────────────────────────────────────────────────

/** The unified error envelope body (SPEC §4.7). */
export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    retryable: boolean
    /** Structured details; `null` when none (never the raw provider response). */
    details: unknown
    requestId: string
  }
}

/** Status-code mapping for the structured codes the facade raises. Unknown codes are 500. */
export const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  INVALID_REQUEST: 400,
  PATH_OUTSIDE_WORKSPACE: 403,
  SESSION_NOT_FOUND: 404,
  PROVIDER_NOT_FOUND: 422,
  SESSION_BUSY: 409,
  IDEMPOTENCY_CONFLICT: 409,
  APPROVAL_NOT_FOUND: 404,
  APPROVAL_ALREADY_DECIDED: 409,
  APPROVAL_EXPIRED: 410,
  DOCUMENT_NOT_FOUND: 404,
  DOCUMENT_VERSION_CONFLICT: 409,
  DOCUMENT_ENCODING_INVALID: 422,
  OPERATION_ABORTED: 409,
  MODEL_RATE_LIMITED: 503,
  STORAGE_BUSY: 503,
}

// ── Sessions ────────────────────────────────────────────────────────────

export interface SessionSnapshot {
  sessionId: string
  status: 'active' | 'closed'
  agentStatus: 'idle' | 'running' | 'unavailable'
  cwd?: string
  providerId?: string
  modelId?: string
  title?: string
  eventCount: number
  lastSeq: number
  createdAt?: string
  updatedAt?: string
}

export interface CreateSessionInput {
  providerId: string
  modelId: string
  workspaceRoot: string
  title?: string
}

export interface SendMessageInput {
  clientMessageId: string
  content: string
}

export interface SendMessageResult {
  turnId: string
  status: 'accepted' | 'replayed'
}

export interface HealthResponse {
  status: string
  runtime: string
  database: string
}

// ── Approvals ───────────────────────────────────────────────────────────

/**
 * One pending approval card.
 *
 * `source` distinguishes the two families that share this panel: `'action'`
 * is an action execution suspended by the approval pipeline (SQLite-backed,
 * optimistic `version`), `'tool'` is a tool call gated by the tool-permission
 * waterfall (in-memory, one-shot). Absent means `'action'` — additive, so
 * every existing construction site and test stays valid.
 */
export interface ApprovalRecord {
  id: string
  sessionId: string
  actionExecutionId: string
  actionName: string
  target: string
  paramsSummary: string
  expectedImpact: string
  state: string
  version: number
  createdAt: string
  expiresAt: string
  decidedAt?: string
  decision?: string
  source?: 'action' | 'tool'
}

export interface ApprovalDecisionInput {
  decision: 'approved' | 'denied' | 'cancelled'
  expectedVersion?: number
  comment?: string
}

export interface ApprovalResolveResult {
  approval: ApprovalRecord
  execution?: { status: string; executionId: string; action: string; error?: { message: string; code?: string } }
}

/** Answer for one tool-permission request (the `'tool'` family). */
export interface ToolApprovalDecisionInput {
  outcome: 'allowed-once' | 'rejected'
}

// ── Audit ───────────────────────────────────────────────────────────────

/** One audit entry (SPEC §3.7; Issue 034). */
export interface AuditEntry {
  sessionId: string
  seq: number
  time: number
  category: string
  correlationId: string
  summary: string
  data: Record<string, unknown>
}

// ── Client composition ──────────────────────────────────────────────────

/** One browser-half plugin the host has composed. */
export interface ClientPluginRow {
  id: string
  label: string
}

/**
 * The host's composition list.
 *
 * `rev` is the host's monotonic composition revision. Nothing reads it today —
 * it is on the wire from the start so the payload shape does not have to
 * change when on-demand plugin loading arrives.
 */
export interface ClientPluginsResponse {
  rev: number
  plugins: ClientPluginRow[]
}

// ── Settings ────────────────────────────────────────────────────────────

/** The values a new session is created with, stored host-side. */
export interface SessionDefaults {
  providerId: string
  modelId: string
  workspaceRoot: string
  title: string
}

export interface SessionDefaultsResponse {
  values: SessionDefaults
}

// ── SSE ─────────────────────────────────────────────────────────────────

export interface SseFrame {
  id: number
  event: string
  data: Record<string, unknown>
}

/** Client reconnect backoff sequence (SPEC §4.5/§6.2: 1s, 2s, 5s, 10s capped). */
export const SSE_RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000] as const

/** The capped exponential backoff delay for reconnect attempt `attempt` (1-based). */
export function sseReconnectDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) attempt = 1
  const index = Math.min(attempt - 1, SSE_RECONNECT_BACKOFF_MS.length - 1)
  return SSE_RECONNECT_BACKOFF_MS[index]!
}

/** Response headers the host must send for a live event stream. */
export const SSE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
}

/** The id the server uses for the opening snapshot frame (never a real seq). */
export const SSE_SNAPSHOT_EVENT_ID = -1

/**
 * Incremental SSE frame decoder.
 *
 * Frames are separated by a blank line; `id`, `event` and `data` are read by
 * line-anchored match, and a frame missing its `event` or `data` is skipped
 * rather than surfaced. The decoder is fed raw chunks and yields whole frames,
 * so a frame split across two reads is held until its terminator arrives.
 *
 * Feed it decoded text (`TextDecoder` with `{stream: true}`); it never touches
 * bytes, so the host (writing) and the browser (reading) cannot drift on
 * framing or on which frames are legal.
 */
export class SseDecoder {
  private buffer = ''

  /**
   * Feed one decoded chunk.
   * @param chunk - decoded text; a partial frame stays buffered.
   * @returns every frame completed by this chunk, in order.
   */
  push(chunk: string): SseFrame[] {
    this.buffer += chunk
    const frames: SseFrame[] = []
    let boundary: number
    while ((boundary = this.buffer.indexOf('\n\n')) !== -1) {
      const raw = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const frame = parseFrame(raw)
      if (frame !== undefined) frames.push(frame)
    }
    return frames
  }

  /** Drop any buffered partial frame (call when the stream is replaced). */
  reset(): void {
    this.buffer = ''
  }
}

function parseFrame(raw: string): SseFrame | undefined {
  const event = raw.match(/^event: (.+)$/m)?.[1] ?? ''
  const dataLine = raw.match(/^data: (.+)$/m)?.[1]
  if (event.length === 0 || dataLine === undefined) return undefined
  const id = Number.parseInt(raw.match(/^id: (.+)$/m)?.[1] ?? String(SSE_SNAPSHOT_EVENT_ID), 10)
  return { id, event, data: JSON.parse(dataLine) as Record<string, unknown> }
}

/**
 * Serialize one frame for the wire.
 * @param event - the SSE event name.
 * @param id - the frame id; omit for a frame whose id carries no meaning.
 * @param data - JSON-serializable payload.
 * @returns the complete frame, terminator included.
 */
export function encodeSseFrame(event: string, id: number | undefined, data: unknown): string {
  const lines = id === undefined ? [] : [`id: ${String(id)}`]
  lines.push(`event: ${event}`, `data: ${JSON.stringify(data)}`)
  return `${lines.join('\n')}\n\n`
}
