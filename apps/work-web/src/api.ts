/**
 * Rigo Work Web API client (Issue 033): the same-origin HTTP + SSE surface
 * over the Issue 028/029 `/api/v1` endpoints. Framework-free — tested
 * directly against a real api-http server.
 *
 * The wire shapes themselves live in `@teoclub/api-wire` (Issue 039) and are
 * re-exported here so every existing `from './api.ts'` import site keeps
 * working. Only `ApiError` — a client-side `Error` subclass, not a payload —
 * is defined in this module.
 *
 * @module @teoclub/work-web/api
 */

import {
  SseDecoder,
  sseReconnectDelay,
  type ApprovalDecisionInput,
  type ApprovalRecord,
  type ApprovalResolveResult,
  type AuditEntry,
  type ClientPluginsResponse,
  type CreateSessionInput,
  type HealthResponse,
  type SendMessageResult,
  type SessionDefaults,
  type SessionDefaultsResponse,
  type SessionSnapshot,
  type SseFrame,
} from '@teoclub/api-wire'

export type {
  ApprovalDecisionInput,
  ClientPluginsResponse,
  ApprovalRecord,
  ApprovalResolveResult,
  AuditEntry,
  CreateSessionInput,
  HealthResponse,
  SendMessageResult,
  SessionDefaults,
  SessionSnapshot,
  SseFrame,
}

export { sseReconnectDelay }

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

  /** List sessions (durable rows overlaid with live ones, newest first). */
  async listSessions(): Promise<SessionSnapshot[]> {
    const response = await fetch(`${this.base}/api/v1/sessions`)
    if (!response.ok) throw await this.envelopeError(response)
    const listed = ((await response.json()) as { sessions?: SessionSnapshot[] }).sessions
    return Array.isArray(listed) ? listed : []
  }

  /** Resume a persisted session into the live store (undefined when unknown). */
  async resumeSession(sessionId: string): Promise<SessionSnapshot | undefined> {
    const response = await this.stateFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/resume`, {
      method: 'POST',
    })
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

  /** The host's session defaults — the settings surface reads these. */
  async sessionDefaults(): Promise<SessionDefaults> {
    const response = await fetch(`${this.base}/api/v1/settings/session-defaults`)
    if (!response.ok) throw await this.envelopeError(response)
    return ((await response.json()) as SessionDefaultsResponse).values
  }

  /** Merge a patch into the host's session defaults. */
  async saveSessionDefaults(patch: Partial<SessionDefaults>): Promise<SessionDefaults> {
    const response = await this.stateFetch('/api/v1/settings/session-defaults', {
      method: 'PUT',
      body: JSON.stringify(patch),
    })
    if (!response.ok) throw await this.envelopeError(response)
    return ((await response.json()) as SessionDefaultsResponse).values
  }

  /**
   * The host's browser-plugin composition.
   *
   * The host decides which client features the page runs; the browser only
   * resolves the ids it is given. A failure here is NOT a licence to compose
   * everything — see `main.tsx`.
   */
  async clientPlugins(): Promise<ClientPluginsResponse> {
    const response = await fetch(`${this.base}/api/v1/client/plugins`)
    if (!response.ok) throw await this.envelopeError(response)
    return (await response.json()) as ClientPluginsResponse
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
        const frames = new SseDecoder()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            for (const frame of frames.push(decoder.decode(value, { stream: true }))) {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default WorkApiClient
