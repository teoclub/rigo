/**
 * Rigo HTTP API host (Issue 028; SPEC §4.1–§4.4, §6.1; PRD US-015, FR-28,
 * FR-31).
 *
 * The Node 24 `/api/v1` surface over the Issue 027 Runtime Facade:
 *
 *   - `GET /api/v1/health` — runtime + database health (AC-1);
 *   - `POST /api/v1/sessions` — create a session and agent, validating
 *     provider/model existence, the absolute workspace root and the title
 *     bound (AC-2);
 *   - `GET /api/v1/sessions/:id` — the session projection (404 envelope
 *     when missing);
 *   - `DELETE /api/v1/sessions/:id` — cancel an active turn first, then
 *     release the agent (AC-5);
 *   - `POST /api/v1/sessions/:id/messages` — accept one user message with a
 *     unique `clientMessageId`, returning `202` + the turn id; a duplicate
 *     `clientMessageId` returns the ORIGINAL turn id and creates no
 *     duplicate input (AC-4);
 *   - `POST /api/v1/sessions/:id/abort` — cancel the current activity
 *     (409 `SESSION_BUSY` when nothing is running);
 *   - every failure uses the unified error envelope (SPEC §4.7):
 *     `{ error: { code, message, retryable, requestId } }`, with JSON field
 *     validation failures as `INVALID_REQUEST` (AC-6);
 *   - the server binds to `127.0.0.1` only and stays same-origin with no
 *     CORS headers (AC-7).
 *
 * @module @teoclub/api-http
 */

import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { RuntimeFacade } from '@teoclub/api-sdk'

export interface ApiServerOptions {
  facade: RuntimeFacade
  /** Max JSON body bytes (default 1 MiB). */
  maxBodyBytes?: number
  /** Bound host (default `127.0.0.1` — AC-7). */
  host?: string
}

export interface ApiServer {
  /** The underlying node:http server. */
  readonly server: Server
  /** Listen on a port (default 0 = ephemeral). */
  listen(port?: number): Promise<number>
  /** Close the server. */
  close(): Promise<void>
}

/** Methods that mutate state (SPEC §7.1: CSRF + Origin checks apply). */
const STATE_MODIFYING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Client reconnect backoff sequence (SPEC §4.5/§6.2: 1s, 2s, 5s, 10s capped). */
export const SSE_RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000] as const

/** The capped exponential backoff delay for reconnect attempt `attempt` (1-based). */
export function sseReconnectDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) attempt = 1
  const index = Math.min(attempt - 1, SSE_RECONNECT_BACKOFF_MS.length - 1)
  return SSE_RECONNECT_BACKOFF_MS[index]!
}

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

/** Status-code mapping for the structured codes the facade raises. */
const STATUS_BY_CODE: Record<string, number> = {
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

function statusFor(code: string): number {
  return STATUS_BY_CODE[code] ?? 500
}

/** Read and parse a JSON request body (bounded). */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Field-level validation helpers returning INVALID_REQUEST messages. */
function fieldErrors(input: Record<string, unknown> | undefined, rules: Record<string, (value: unknown) => string | undefined>): string[] {
  const errors: string[] = []
  for (const [field, check] of Object.entries(rules)) {
    const message = check(input?.[field])
    if (message !== undefined) errors.push(message)
  }
  return errors
}

function requireString(field: string): (value: unknown) => string | undefined {
  return (value) => {
    if (typeof value !== 'string' || value.length === 0) return `${field} must be a non-empty string`
    return undefined
  }
}

function requireAbsolutePath(field: string): (value: unknown) => string | undefined {
  return (value) => {
    if (typeof value !== 'string' || !value.startsWith('/')) return `${field} must be an absolute path`
    return undefined
  }
}

function requireTitle(): (value: unknown) => string | undefined {
  return (value) => {
    if (value === undefined) return undefined
    if (typeof value !== 'string') return 'title must be a string'
    if (Array.from(value).length > 200) return 'title must be at most 200 Unicode code points'
    return undefined
  }
}

function requireClientMessageId(): (value: unknown) => string | undefined {
  return (value) => {
    if (typeof value !== 'string' || value.length === 0) return 'clientMessageId must be a non-empty string'
    return undefined
  }
}

function requireMessageContent(): (value: unknown) => string | undefined {
  return (value) => {
    if (typeof value !== 'string') return 'content must be a text string'
    if (value.length === 0) return 'content must not be empty'
    return undefined
  }
}

/**
 * Create the `/api/v1` server. Everything delegates to the facade.
 */
export function createApiServer(options: ApiServerOptions): ApiServer {
  const facade = options.facade
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
  const host = options.host ?? '127.0.0.1'

  // Startup-generated CSRF token (SPEC §7.1): state-modifying requests must
  // echo it via `x-csrf-token`; the same-origin UI reads it from
  // `GET /api/v1/csrf` (an attacker's cross-origin page cannot read it).
  const csrfToken = randomUUID()
  const ownOrigin = `http://${host}`

  const server = createServer(async (req, res) => {
    const requestId = `req_${Math.random().toString(36).slice(2, 12)}`
    try {
      if (!guardRequest(req, res, requestId)) return
      await route(req, res, requestId)
    } catch (error) {
      sendEnvelope(res, error, requestId)
    }
  })

  /**
   * Same-origin / Host / Origin / CSRF guard (SPEC §7.1; AC-7): every
   * request must carry the bound Host; state-modifying requests must carry
   * no foreign Origin and the startup CSRF token.
   */
  function guardRequest(req: IncomingMessage, res: ServerResponse, requestId: string): boolean {
    const requestHost = req.headers.host
    if (requestHost === undefined || !requestHost.startsWith(host)) {
      sendEnvelope(res, { code: 'INVALID_REQUEST', message: 'invalid Host header' }, requestId, 403)
      return false
    }
    const method = req.method ?? 'GET'
    if (STATE_MODIFYING_METHODS.has(method)) {
      const origin = req.headers.origin
      if (origin !== undefined && origin !== ownOrigin && origin !== `http://${requestHost}`) {
        sendEnvelope(res, { code: 'INVALID_REQUEST', message: 'cross-origin request rejected' }, requestId, 403)
        return false
      }
      if (req.headers['x-csrf-token'] !== csrfToken) {
        sendEnvelope(res, { code: 'INVALID_REQUEST', message: 'missing or invalid CSRF token' }, requestId, 403)
        return false
      }
    }
    return true
  }

  async function route(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`)
    const parts = url.pathname.split('/').filter(Boolean)
    // /api/v1/...
    if (parts[0] !== 'api' || parts[1] !== 'v1') {
      sendEnvelope(res, { code: 'INVALID_REQUEST', message: 'unknown endpoint' }, requestId, 404)
      return
    }
    const route = parts.slice(2)
    const method = req.method ?? 'GET'

    if (route.length === 1 && route[0] === 'health' && method === 'GET') {
      const health = await facade.health()
      sendJson(res, 200, { status: 'ok', ...health })
      return
    }

    if (route.length === 1 && route[0] === 'csrf' && method === 'GET') {
      sendJson(res, 200, { csrfToken })
      return
    }

    if (route.length === 3 && route[0] === 'sessions' && route[2] === 'approvals' && method === 'GET') {
      if (facade.getSession(route[1]!) === undefined) {
        sendEnvelope(res, { code: 'SESSION_NOT_FOUND', message: `session "${route[1]}" not found` }, requestId, 404)
        return
      }
      const approvals = facade.listPendingApprovals(route[1]!)
      sendJson(res, 200, { approvals })
      return
    }

    if (route.length === 3 && route[0] === 'approvals' && route[2] === 'decision' && method === 'POST') {
      const body = (await readJsonBody(req, maxBodyBytes)) as Record<string, unknown> | undefined
      const decision = body?.decision
      const errors: string[] = []
      if (!['approved', 'denied', 'cancelled'].includes(String(decision))) {
        errors.push('decision must be one of approved, denied, cancelled')
      }
      if (body?.expectedVersion !== undefined
        && (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1)) {
        errors.push('expectedVersion must be a positive integer')
      }
      if (body?.comment !== undefined && typeof body.comment !== 'string') {
        errors.push('comment must be a string')
      }
      if (errors.length > 0) {
        sendEnvelope(res, { code: 'INVALID_REQUEST', message: errors.join('; ') }, requestId, 400)
        return
      }
      const resolved = await facade.decideApproval(route[1]!, {
        decision: decision as 'approved' | 'denied' | 'cancelled',
        ...(body?.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion as number }),
        ...(body?.comment === undefined ? {} : { comment: body.comment as string }),
      })
      // AC-3: the approve response carries the updated approval + action
      // status; the completion itself streams through SSE as session events.
      sendJson(res, 200, { approval: resolved.approval, ...(resolved.execution === undefined ? {} : { execution: resolved.execution }) })
      return
    }

    if (route.length === 3 && route[0] === 'sessions' && route[2] === 'audit' && method === 'GET') {
      const entries = facade.auditProjection(route[1]!)
      sendJson(res, 200, { entries })
      return
    }

    if (route.length === 1 && route[0] === 'sessions' && method === 'POST') {
      const body = (await readJsonBody(req, maxBodyBytes)) as Record<string, unknown> | undefined
      const errors = fieldErrors(body ?? {}, {
        providerId: requireString('providerId'),
        modelId: requireString('modelId'),
        workspaceRoot: requireAbsolutePath('workspaceRoot'),
        title: requireTitle(),
      })
      if (errors.length > 0) {
        sendEnvelope(res, { code: 'INVALID_REQUEST', message: errors.join('; ') }, requestId, 400)
        return
      }
      const created = await facade.createSession({
        cwd: body!.workspaceRoot as string,
        providerId: body!.providerId as string,
        modelId: body!.modelId as string,
        ...(body!.title === undefined ? {} : { title: body!.title as string }),
      })
      sendJson(res, 201, { session: created })
      return
    }

    if (route.length === 2 && route[0] === 'sessions' && method === 'GET') {
      const session = facade.getSession(route[1]!)
      if (session === undefined) {
        sendEnvelope(res, { code: 'SESSION_NOT_FOUND', message: `session "${route[1]}" not found` }, requestId, 404)
        return
      }
      sendJson(res, 200, { session })
      return
    }

    if (route.length === 2 && route[0] === 'sessions' && method === 'DELETE') {
      const session = facade.getSession(route[1]!)
      if (session === undefined) {
        sendEnvelope(res, { code: 'SESSION_NOT_FOUND', message: `session "${route[1]}" not found` }, requestId, 404)
        return
      }
      await facade.closeSession(route[1]!)
      sendJson(res, 200, { status: 'closed' })
      return
    }

    if (route.length === 3 && route[0] === 'sessions' && route[2] === 'messages' && method === 'POST') {
      const body = (await readJsonBody(req, maxBodyBytes)) as Record<string, unknown> | undefined
      const errors = fieldErrors(body ?? {}, {
        clientMessageId: requireClientMessageId(),
        content: requireMessageContent(),
      })
      if (errors.length > 0) {
        sendEnvelope(res, { code: 'INVALID_REQUEST', message: errors.join('; ') }, requestId, 400)
        return
      }
      const result = facade.sendMessage(route[1]!, body!.content as string, body!.clientMessageId as string)
      sendJson(res, 202, { turnId: result.turnId, status: result.status })
      return
    }

    if (route.length === 3 && route[0] === 'sessions' && route[2] === 'events' && method === 'GET') {
      await streamSessionEvents(req, res, route[1]!, requestId)
      return
    }

    if (route.length === 3 && route[0] === 'sessions' && route[2] === 'abort' && method === 'POST') {
      const session = facade.getSession(route[1]!)
      if (session === undefined) {
        sendEnvelope(res, { code: 'SESSION_NOT_FOUND', message: `session "${route[1]}" not found` }, requestId, 404)
        return
      }
      if (session.agentStatus !== 'running') {
        // SPEC §6.1: SESSION_BUSY is retryable.
        sendEnvelope(res, { code: 'SESSION_BUSY', message: 'no active turn to abort', retryable: true }, requestId, 409)
        return
      }
      facade.abort(route[1]!, { kind: 'user' })
      sendJson(res, 200, { status: 'aborted' })
      return
    }

    sendEnvelope(res, { code: 'INVALID_REQUEST', message: 'unknown endpoint' }, requestId, 404)
  }

  const SSE_HEADERS = {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  }

  /** Write one SSE frame (SPEC §4.5: seq as id, canonical event type). */
  function writeSse(res: ServerResponse, event: string, id: number, data: unknown): void {
    res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  /**
   * `GET /api/v1/sessions/:id/events` (SPEC §4.5): replay from
   * `Last-Event-ID` (live log, or the persisted log when the id is older),
   * then stream live events. A disconnect only ends the subscription — the
   * agent keeps running, and a reconnect with `Last-Event-ID` replays the
   * missed seqs exactly once.
   */
  async function streamSessionEvents(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    const lastEventId = Number.parseInt(String(req.headers['last-event-id'] ?? ''), 10)
    const afterSeq = Number.isNaN(lastEventId) ? -1 : lastEventId

    // Subscribe BEFORE replaying so events landing in between are buffered
    // and de-duplicated against the replay (no loss, no duplicates); once the
    // replay+flush completes, live events stream straight out.
    const buffered: { seq: number; event: import('@teoclub/harness-session').SessionEvent }[] = []
    let replayDone = false
    const unsubscribe = facade.subscribeSessionEvents((payload) => {
      if (payload.sessionId !== sessionId) return
      if (!replayDone) {
        buffered.push({ seq: payload.event.seq, event: payload.event })
        return
      }
      writeSse(res, 'session.event', payload.event.seq, {
        sessionId,
        seq: payload.event.seq,
        type: payload.event.type,
        payload: payload.event.data,
      })
    })

    const replay = await facade.replaySessionEvents(sessionId, afterSeq)
    if (replay === undefined) {
      unsubscribe()
      sendEnvelope(res, { code: 'SESSION_NOT_FOUND', message: `session "${sessionId}" not found` }, requestId, 404)
      return
    }

    res.writeHead(200, SSE_HEADERS)
    const snapshot = facade.getSession(sessionId)
    writeSse(res, 'session.snapshot', -1, {
      sessionId,
      ...(snapshot === undefined
        ? { status: 'active', agentStatus: 'unavailable', eventCount: replay.events.length, lastSeq: replay.events.at(-1)?.seq ?? afterSeq }
        : { snapshot }),
    })
    const delivered = new Set<number>()
    for (const event of replay.events) {
      delivered.add(event.seq)
      writeSse(res, 'session.event', event.seq, {
        sessionId,
        seq: event.seq,
        type: event.type,
        payload: event.data,
      })
    }
    for (const { seq, event } of buffered) {
      if (seq > afterSeq && !delivered.has(seq)) {
        writeSse(res, 'session.event', seq, {
          sessionId,
          seq,
          type: event.type,
          payload: event.data,
        })
      }
    }
    // Live events now stream directly (see the subscription handler above).
    replayDone = true
    req.on('close', () => {
      unsubscribe()
      res.end()
    })
  }

  function sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  function sendEnvelope(res: ServerResponse, error: unknown, requestId: string, forcedStatus?: number): void {
    const code = typeof (error as { code?: unknown })?.code === 'string'
      ? String((error as { code: string }).code)
      : 'INTERNAL_ERROR'
    const message = error instanceof Error ? error.message : String(error)
    const retryable = typeof (error as { retryable?: unknown })?.retryable === 'boolean'
      ? (error as { retryable: boolean }).retryable
      : false
    const details = typeof (error as { details?: unknown })?.details === 'undefined'
      ? null
      : (error as { details: unknown }).details
    const envelope: ErrorEnvelope = { error: { code, message, retryable, details, requestId } }
    sendJson(res, forcedStatus ?? statusFor(code), envelope)
  }

  return {
    server,
    listen: (port = 0) => new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : port)
      })
    }),
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

export default createApiServer
