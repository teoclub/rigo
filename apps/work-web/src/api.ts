/**
 * Rigo Work Web API client (Issue 033): the same-origin HTTP + SSE surface
 * over the Issue 028/029 `/api/v1` endpoints. Framework-free — tested
 * directly against a real api-http server.
 *
 * @module @teoclub/work-web/api
 */

/** Unified API error (SPEC §4.7 envelope). */
export class ApiError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details: unknown
  readonly requestId: string

  constructor(code: string, message: string, options: { retryable?: boolean; details?: unknown; requestId?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ApiError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details ?? null
    this.requestId = options.requestId ?? ''
  }
}

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
}

export interface CreateSessionInput {
  providerId: string
  modelId: string
  workspaceRoot: string
  title?: string
}

export interface SendMessageResult {
  turnId: string
  status: 'accepted' | 'replayed'
}

export interface SseFrame {
  id: number
  event: string
  data: Record<string, unknown>
}

export interface HealthResponse {
  status: string
  runtime: string
  database: string
}

/** One pending approval (SPEC §4.6; Issue 034). */
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
}

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

export interface ApprovalDecisionInput {
  decision: 'approved' | 'denied' | 'cancelled'
  expectedVersion?: number
  comment?: string
}

export interface ApprovalResolveResult {
  approval: ApprovalRecord
  execution?: { status: string; executionId: string; action: string; error?: { message: string; code?: string } }
}

export class WorkApiClient {
  private csrfToken: string | undefined

  constructor(private readonly base: string) {}

  /** Fetch the startup CSRF token once (SPEC §7.1 same-origin flow). */
  private async ensureCsrf(): Promise<string> {
    if (this.csrfToken === undefined) {
      const response = await fetch(`${this.base}/api/v1/csrf`)
      if (!response.ok) throw await this.envelopeError(response)
      this.csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken
    }
    return this.csrfToken
  }

  async health(): Promise<HealthResponse> {
    const response = await fetch(`${this.base}/api/v1/health`)
    if (!response.ok) throw await this.envelopeError(response)
    return (await response.json()) as HealthResponse
  }

  /** Create a session (AC-1). */
  async createSession(input: CreateSessionInput): Promise<SessionSnapshot> {
    const response = await this.stateFetch('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!response.ok) throw await this.envelopeError(response)
    return ((await response.json()) as { session: SessionSnapshot }).session
  }

  /** Read one session projection (AC-2). */
  async getSession(sessionId: string): Promise<SessionSnapshot | undefined> {
    const response = await fetch(`${this.base}/api/v1/sessions/${encodeURIComponent(sessionId)}`)
    if (response.status === 404) return undefined
    if (!response.ok) throw await this.envelopeError(response)
    return ((await response.json()) as { session: SessionSnapshot }).session
  }

  /** Send one user message with a unique clientMessageId (AC-2). */
  async sendMessage(sessionId: string, content: string, clientMessageId: string): Promise<SendMessageResult> {
    const response = await this.stateFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ clientMessageId, content }),
    })
    if (!response.ok) throw await this.envelopeError(response)
    return (await response.json()) as SendMessageResult
  }

  /** Pending approvals of one session (Issue 034 AC-1). */
  async listPendingApprovals(sessionId: string): Promise<ApprovalRecord[]> {
    const response = await fetch(`${this.base}/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals`)
    if (!response.ok) throw await this.envelopeError(response)
    return ((await response.json()) as { approvals: ApprovalRecord[] }).approvals
  }

  /** Approve or deny one approval with the optimistic expected version (AC-3). */
  async decideApproval(approvalId: string, input: ApprovalDecisionInput): Promise<ApprovalResolveResult> {
    const response = await this.stateFetch(`/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!response.ok) throw await this.envelopeError(response)
    return (await response.json()) as ApprovalResolveResult
  }

  /** The ordered audit projection of one session (AC-7). */
  async auditProjection(sessionId: string): Promise<AuditEntry[]> {
    const response = await fetch(`${this.base}/api/v1/sessions/${encodeURIComponent(sessionId)}/audit`)
    if (!response.ok) throw await this.envelopeError(response)
    return ((await response.json()) as { entries: AuditEntry[] }).entries
  }

  /** Abort the session's current activity. */
  async abort(sessionId: string): Promise<void> {
    const response = await this.stateFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: 'POST',
    })
    if (!response.ok) throw await this.envelopeError(response)
  }

  /**
   * Open the session event stream (SPEC §4.5): SSE frames with the session
   * event seq as the id; on disconnect, RECONNECTS with `Last-Event-ID` and
   * the capped backoff policy (AC-6) until aborted.
   * @param sessionId - the session.
   * @param handlers - frame/status callbacks.
   * @returns a promise that resolves when the stream is closed (aborted).
   */
  async openEventStream(
    sessionId: string,
    handlers: {
      onEvent: (frame: SseFrame) => void
      onStatus?: (status: 'connected' | 'reconnecting' | 'closed', attempt?: number) => void
      signal?: AbortSignal
    },
  ): Promise<void> {
    let lastEventId: number | undefined
    let attempt = 0
    while (handlers.signal?.aborted !== true) {
      attempt += 1
      try {
        const response = await fetch(`${this.base}/api/v1/sessions/${encodeURIComponent(sessionId)}/events`, {
          headers: {
            accept: 'text/event-stream',
            ...(lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) }),
          },
          signal: handlers.signal ?? null,
        })
        if (response.status === 404) {
          throw new ApiError('SESSION_NOT_FOUND', `session "${sessionId}" not found`)
        }
        if (!response.ok) throw await this.envelopeError(response)
        handlers.onStatus?.('connected', attempt)
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
              const frame: SseFrame = { id, event, data: JSON.parse(dataLine) as Record<string, unknown> }
              if (frame.id >= 0) lastEventId = frame.id
              handlers.onEvent(frame)
            }
          }
        } catch (error) {
          if (handlers.signal?.aborted) break
          throw error
        }
        // The server closed the stream (or an error dropped it) — reconnect
        // from the last delivered event id.
      } catch (error) {
        if (handlers.signal?.aborted) break
        if (error instanceof ApiError && error.code === 'SESSION_NOT_FOUND') {
          handlers.onStatus?.('closed', attempt)
          return
        }
      }
      if (handlers.signal?.aborted) break
      handlers.onStatus?.('reconnecting', attempt)
      await delay(sseReconnectDelay(attempt))
    }
    handlers.onStatus?.('closed', attempt)
  }

  private async stateFetch(path: string, init: RequestInit): Promise<Response> {
    const token = await this.ensureCsrf()
    return fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': token,
        ...(init.headers as Record<string, string> | undefined),
      },
    })
  }

  private async envelopeError(response: Response): Promise<ApiError> {
    let envelope: { error?: { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown; requestId?: unknown } } = {}
    try {
      envelope = (await response.json()) as typeof envelope
    } catch {
      // Non-JSON failure — fall through to a generic error.
    }
    const error = envelope.error
    return new ApiError(
      typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR',
      typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`,
      {
        retryable: error?.retryable === true,
        details: error?.details,
        requestId: typeof error?.requestId === 'string' ? error.requestId : '',
      },
    )
  }
}

/** The capped SSE reconnect backoff (SPEC §6.2: 1s/2s/5s/10s). */
export function sseReconnectDelay(attempt: number): number {
  const sequence = [1000, 2000, 5000, 10000]
  const index = Math.min(Math.max(attempt, 1) - 1, sequence.length - 1)
  return sequence[index]!
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default WorkApiClient
