/**
 * Rigo Runtime Facade + in-process SDK (Issue 027; SPEC §2.4, §4.1, §9.3;
 * PRD US-015, FR-9, FR-31, FR-32).
 *
 * The one surface the web host and embedded callers share (SPEC §4.1:
 * "Headless SDK 直接调用相同的 Runtime Facade"):
 *
 *   - {@link RuntimeFacade} wraps a booted context — sessions
 *     (create/get/close/resume + projections), agents (send/abort, status),
 *     the cancelable `session/event` subscription, the Approval API
 *     (pending queries, approve/deny) and the Audit projection;
 *   - {@link InProcessSdk} is the in-process SDK: it ONLY wraps the facade
 *     (SPEC §2.5: the SDK depends on the agent/session-event/approval APIs,
 *     never on a concrete agent loop, SQLite provider or domain provider —
 *     the host injects those through the facade options) and normalizes
 *     every failure into the unified {@link SdkError} with a structured
 *     code (structured domain codes are preserved; anything else becomes
 *     `INTERNAL_ERROR`);
 *   - subscriptions return disposers; unsubscribing removes the listener,
 *     so a released SDK never retains event listeners.
 *
 * @module @teoclub/api-sdk
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@teoclub/cordis'
import {
  SessionId,
  type AgentCancelCause,
  type Session,
  type SessionEvent,
} from '@teoclub/harness-session'
import type { PublicAgent } from '@teoclub/harness-agent-protocol'
import type { ApprovalRecord, ApprovalResolveResult } from '@teoclub/shared-approvals'
import type { AuditEntry } from '@teoclub/shared-audit'

// ---------------------------------------------------------------------------
// Unified errors (AC-5)
// ---------------------------------------------------------------------------

/** The unified SDK error: structured code + safe details. */
export class SdkError extends Error {
  readonly code: string
  readonly retryable: boolean
  /** Structured details (never the raw exception object). */
  readonly details?: unknown

  constructor(code: string, message: string, options: { retryable?: boolean; details?: unknown; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'SdkError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

/** Normalize any error into the unified shape, preserving structured codes. */
export function toSdkError(error: unknown): SdkError {
  if (error instanceof SdkError) return error
  const code = typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code)
    : 'INTERNAL_ERROR'
  const retryable = typeof (error as { retryable?: unknown })?.retryable === 'boolean'
    ? (error as { retryable: boolean }).retryable
    : false
  const message = error instanceof Error ? error.message : String(error)
  return new SdkError(code, message, { retryable, cause: error })
}

// ---------------------------------------------------------------------------
// Facade
// ---------------------------------------------------------------------------

/** One live session projection (AC-1). */
export interface SessionSnapshot {
  sessionId: string
  status: 'active' | 'closed'
  agentStatus: 'idle' | 'running' | 'unavailable'
  cwd?: string
  /** API-layer creation metadata (Issue 028: provider/model/title). */
  providerId?: string
  modelId?: string
  title?: string
  eventCount: number
  lastSeq: number
}

/** The result of one accepted message (SPEC §4.4: turn id + replay marker). */
export interface SendMessageResult {
  turnId: string
  status: 'accepted' | 'replayed'
}

/** One session event delivered to subscribers (AC-2). */
export interface SessionEventPayload {
  sessionId: string
  event: SessionEvent
}

/** The agent handle the facade drives. */
export interface FacadeAgentHandle {
  agent: PublicAgent
  dispose(): Promise<void>
}

/** The creation input handed to the agent factory. */
export interface AgentFactoryInput {
  cwd?: string
  providerId?: string
  modelId?: string
  title?: string
}

/**
 * How the host supplies agents. The factory owns session+agent creation
 * (the loop folds the session lifecycle into the agent), so it receives the
 * creation input and its agent's id must be the created session's id.
 */
export interface AgentFactory {
  (input: AgentFactoryInput): FacadeAgentHandle | Promise<FacadeAgentHandle>
}

/** Persistence loader for session resume (the host wires its backend). */
export interface SessionLoader {
  (sessionId: string): { events: SessionEvent[]; cwd?: string } | undefined | Promise<{ events: SessionEvent[]; cwd?: string } | undefined>
}

export interface RuntimeFacadeOptions {
  /** Agent factory; without it sessions are headless logs. */
  agentFactory?: AgentFactory
  /** Loads a persisted session log for {@link RuntimeFacade.resumeSession}. */
  loadSession?: SessionLoader
  /** Database health probe for {@link RuntimeFacade.health} (host wires a SQLite ping). */
  checkDatabase?: () => boolean | Promise<boolean>
  /** Provider/model existence check for session creation (host wires the LLM registry). */
  modelValidator?: (providerId: string, modelId: string) => boolean | Promise<boolean>
}

/** The shared runtime surface (SPEC §4.1). */
export class RuntimeFacade {
  private readonly closed = new Set<string>()
  private readonly agents = new Map<string, FacadeAgentHandle>()
  private readonly metadata = new Map<string, { providerId?: string; modelId?: string; title?: string }>()
  private readonly turns = new Map<string, string>()
  private readonly agentFactory: AgentFactory | undefined
  private readonly loadSession: SessionLoader | undefined
  private readonly checkDatabase: (() => boolean | Promise<boolean>) | undefined
  private readonly modelValidator: ((providerId: string, modelId: string) => boolean | Promise<boolean>) | undefined

  constructor(private readonly ctx: Context, options: RuntimeFacadeOptions = {}) {
    this.agentFactory = options.agentFactory
    this.loadSession = options.loadSession
    this.checkDatabase = options.checkDatabase
    this.modelValidator = options.modelValidator
  }

  /** Create a session (and its agent, when a factory is wired) (AC-1). */
  async createSession(input: {
    cwd?: string
    providerId?: string
    modelId?: string
    title?: string
  } = {}): Promise<SessionSnapshot> {
    if (this.modelValidator !== undefined && input.providerId !== undefined && input.modelId !== undefined) {
      const exists = await this.modelValidator(input.providerId, input.modelId)
      if (!exists) {
        throw new SdkError('PROVIDER_NOT_FOUND', `provider/model "${input.providerId}/${input.modelId}" is not registered`)
      }
    }
    if (this.agentFactory !== undefined) {
      // The factory owns session+agent creation (the loop folds the session
      // lifecycle into the agent); its agent's id IS the session id.
      const handle = await this.agentFactory(input)
      const session = this.ctx.sessions.get(SessionId(handle.agent.id))
      if (session === undefined) {
        throw new SdkError('INTERNAL_ERROR', 'the agent factory did not create a session')
      }
      this.agents.set(session.id, handle)
      this.metadata.set(session.id, {
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(input.title === undefined ? {} : { title: input.title }),
      })
      return this.snapshot(session)
    }
    const session = this.ctx.sessions.create(undefined, {
      ...(input.cwd === undefined ? {} : { meta: { cwd: input.cwd } }),
    })
    this.metadata.set(session.id, {
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.title === undefined ? {} : { title: input.title }),
    })
    return this.snapshot(session)
  }

  /** Runtime + database health (SPEC §4.2: `GET /api/v1/health`). */
  async health(): Promise<{ runtime: 'ready'; database: 'ok' | 'unavailable' }> {
    let database: 'ok' | 'unavailable' = 'ok'
    if (this.checkDatabase !== undefined) {
      try {
        database = (await this.checkDatabase()) ? 'ok' : 'unavailable'
      } catch {
        database = 'unavailable'
      }
    }
    return { runtime: 'ready', database }
  }

  /**
   * Send a user message (SPEC §4.4): a unique `clientMessageId` per session
   * returns the ORIGINAL turn id on duplicates without creating duplicate
   * input (AC-4).
   */
  sendMessage(sessionId: string, text: string, clientMessageId?: string): SendMessageResult {
    const handle = this.agents.get(SessionId(sessionId))
    if (handle === undefined) {
      throw new SdkError('SESSION_NOT_FOUND', `session "${sessionId}" has no live agent`)
    }
    if (clientMessageId !== undefined) {
      const key = `${sessionId}:${clientMessageId}`
      const existing = this.turns.get(key)
      if (existing !== undefined) {
        return { turnId: existing, status: 'replayed' }
      }
      const turnId = `turn_${randomUUID()}`
      this.turns.set(key, turnId)
      handle.agent.send(text)
      return { turnId, status: 'accepted' }
    }
    handle.agent.send(text)
    return { turnId: `turn_${randomUUID()}`, status: 'accepted' }
  }

  /** Resume a persisted session into the live store (AC-7: restore). */
  async resumeSession(sessionId: string): Promise<SessionSnapshot | undefined> {
    if (this.loadSession === undefined) return undefined
    const loaded = await this.loadSession(sessionId)
    if (loaded === undefined) return undefined
    const id = SessionId(sessionId)
    if (this.ctx.sessions.get(id) !== undefined) {
      throw new SdkError('IDEMPOTENCY_CONFLICT', `session "${sessionId}" is already live`)
    }
    const session = this.ctx.sessions.create(id, {
      seed: loaded.events,
      meta: {
        ...(loaded.cwd === undefined ? {} : { cwd: loaded.cwd }),
        seedLength: loaded.events.length,
      },
    })
    // Resume is headless at the facade level; hosts wire agent resume
    // separately through the agent protocol.
    return this.snapshot(session)
  }

  /** The live projection of one session (AC-1). */
  getSession(sessionId: string): SessionSnapshot | undefined {
    const session = this.ctx.sessions.get(SessionId(sessionId))
    return session === undefined ? undefined : this.snapshot(session)
  }

  /** Close a session: dispose its agent and flush its log (AC-1). */
  async closeSession(sessionId: string): Promise<void> {
    const id = SessionId(sessionId)
    const session = this.ctx.sessions.get(id)
    if (session === undefined) return
    const handle = this.agents.get(id)
    if (handle !== undefined) {
      // Cancel an active turn BEFORE releasing the agent (AC-5) and let it
      // unwind completely, so the aborted turn/end lands in the log…
      if (handle.agent.status === 'running') handle.agent.abort({ kind: 'disposed' })
      await handle.agent.whenIdle?.()
      // …then drain the write-behind while the session is STILL live: agent
      // disposal folds the session lifecycle and drops it from the store.
      await this.ctx.sessions.flush(session)
      await handle.dispose()
      this.agents.delete(id)
    } else {
      await this.ctx.sessions.flush(session)
    }
    this.closed.add(id)
  }

  /** Abort the session's agent (AC-2). */
  abort(sessionId: string, cause?: AgentCancelCause): void {
    const handle = this.agents.get(SessionId(sessionId))
    if (handle === undefined) {
      throw new SdkError('SESSION_NOT_FOUND', `session "${sessionId}" has no live agent`)
    }
    handle.agent.abort(cause)
  }

  /**
   * Subscribe to the session event stream (AC-2). The returned disposer
   * removes the listener — a released SDK retains nothing (AC-6).
   */
  subscribeSessionEvents(listener: (payload: SessionEventPayload) => void): () => void {
    const handler = (session: Session, event: SessionEvent): void => {
      listener({ sessionId: session.id, event })
    }
    // ctx.on returns the listener disposer — unsubscribing removes the
    // listener so a released SDK retains nothing (AC-6).
    return this.ctx.on('session/event', handler)
  }

  /** Pending approvals for one session (or all) (AC-3). */
  listPendingApprovals(sessionId?: string): ApprovalRecord[] {
    return this.requireApprovals().listPending(sessionId)
  }

  /**
   * Approve or deny a pending approval (AC-3). `expectedVersion` defaults
   * to the approval's current optimistic version.
   */
  async decideApproval(
    approvalId: string,
    decision: { decision: 'approved' | 'denied' | 'cancelled'; expectedVersion?: number; comment?: string },
  ): Promise<ApprovalResolveResult> {
    const service = this.requireApprovals()
    const approval = service.get(approvalId)
    if (approval === undefined) {
      throw new SdkError('APPROVAL_NOT_FOUND', `approval "${approvalId}" not found`)
    }
    // The live session (when present) receives the resolution event, so the
    // decision is SSE-visible (SPEC §4.5 event stream).
    const session = this.ctx.sessions.get(SessionId(approval.sessionId))
    return service.decide(approvalId, {
      decision: decision.decision,
      expectedVersion: decision.expectedVersion ?? approval.version,
      ...(decision.comment === undefined ? {} : { comment: decision.comment }),
      ...(session === undefined ? {} : { session }),
    })
  }

  /**
   * Replay the events of one session strictly after `afterSeq` (SPEC §4.5):
   * the LIVE log when the session is in memory, otherwise the persisted log
   * via the injected loader (the "ID too old but session exists" path).
   * Returns `undefined` when the session cannot be found anywhere.
   */
  async replaySessionEvents(sessionId: string, afterSeq: number): Promise<{ sessionId: string; events: SessionEvent[] } | undefined> {
    const live = this.ctx.sessions.get(SessionId(sessionId))
    if (live !== undefined) {
      return { sessionId, events: live.events.filter((event) => event.seq > afterSeq) }
    }
    if (this.loadSession === undefined) return undefined
    const loaded = await this.loadSession(sessionId)
    if (loaded === undefined) return undefined
    return { sessionId, events: loaded.events.filter((event) => event.seq > afterSeq) }
  }

  /** The audit projection of one session (AC-3). */
  auditProjection(sessionId: string): AuditEntry[] {
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) {
      throw new SdkError('SESSION_NOT_FOUND', `session "${sessionId}" not found`)
    }
    return this.requireAudit().project(session)
  }

  private snapshot(session: Session): SessionSnapshot {
    const events = session.events
    const meta = this.metadata.get(session.id)
    return {
      sessionId: session.id,
      status: this.closed.has(session.id) ? 'closed' : 'active',
      agentStatus: this.agents.get(SessionId(session.id))?.agent.status ?? 'unavailable',
      ...(session.header.cwd === undefined ? {} : { cwd: session.header.cwd }),
      ...(meta?.providerId === undefined ? {} : { providerId: meta.providerId }),
      ...(meta?.modelId === undefined ? {} : { modelId: meta.modelId }),
      ...(meta?.title === undefined ? {} : { title: meta.title }),
      eventCount: events.length,
      lastSeq: events.length === 0 ? -1 : events[events.length - 1]!.seq,
    }
  }

  private requireApprovals(): { listPending(sessionId?: string): ApprovalRecord[]; get(id: string): ApprovalRecord | undefined; decide(id: string, decision: unknown): Promise<ApprovalResolveResult> } {
    const service = (this.ctx as unknown as { approvals?: unknown }).approvals as
      | { listPending(sessionId?: string): ApprovalRecord[]; get(id: string): ApprovalRecord | undefined; decide(id: string, decision: unknown): Promise<ApprovalResolveResult> }
      | undefined
    if (service === undefined) {
      throw new SdkError('PROVIDER_NOT_FOUND', 'the approvals service is not mounted')
    }
    return service
  }

  private requireAudit(): { project(session: Session): AuditEntry[] } {
    const service = (this.ctx as unknown as { audit?: unknown }).audit as { project(session: Session): AuditEntry[] } | undefined
    if (service === undefined) {
      throw new SdkError('PROVIDER_NOT_FOUND', 'the audit service is not mounted')
    }
    return service
  }
}

// ---------------------------------------------------------------------------
// In-process SDK (AC-4: wraps ONLY the facade)
// ---------------------------------------------------------------------------

/** The in-process SDK surface: identical operations, unified errors. */
export class InProcessSdk {
  constructor(private readonly facade: RuntimeFacade) {}

  createSession(input?: { cwd?: string; providerId?: string; modelId?: string; title?: string }): Promise<SessionSnapshot> {
    return this.wrap(() => this.facade.createSession(input))
  }

  health(): Promise<{ runtime: 'ready'; database: 'ok' | 'unavailable' }> {
    return this.wrap(() => this.facade.health())
  }

  resumeSession(sessionId: string): Promise<SessionSnapshot | undefined> {
    return this.wrap(() => this.facade.resumeSession(sessionId))
  }

  getSession(sessionId: string): SessionSnapshot | undefined {
    return this.wrap(() => this.facade.getSession(sessionId))
  }

  closeSession(sessionId: string): Promise<void> {
    return this.wrap(() => this.facade.closeSession(sessionId))
  }

  sendMessage(sessionId: string, text: string, clientMessageId?: string): SendMessageResult {
    return this.wrap(() => this.facade.sendMessage(sessionId, text, clientMessageId))
  }

  abort(sessionId: string, cause?: AgentCancelCause): void {
    this.wrap(() => this.facade.abort(sessionId, cause))
  }

  subscribeSessionEvents(listener: (payload: SessionEventPayload) => void): () => void {
    return this.facade.subscribeSessionEvents(listener)
  }

  listPendingApprovals(sessionId?: string): ApprovalRecord[] {
    return this.wrap(() => this.facade.listPendingApprovals(sessionId))
  }

  decideApproval(
    approvalId: string,
    decision: { decision: 'approved' | 'denied' | 'cancelled'; expectedVersion?: number; comment?: string },
  ): Promise<ApprovalResolveResult> {
    return this.wrap(() => this.facade.decideApproval(approvalId, decision))
  }

  auditProjection(sessionId: string): AuditEntry[] {
    return this.wrap(() => this.facade.auditProjection(sessionId))
  }

  /** The wrapped facade (hosts may call it directly). */
  get facadeSurface(): RuntimeFacade {
    return this.facade
  }

  private wrap<T>(fn: () => T): T {
    try {
      return fn()
    } catch (error) {
      throw toSdkError(error)
    }
  }
}

/** Build the in-process SDK over a facade. */
export function createInProcessSdk(facade: RuntimeFacade): InProcessSdk {
  return new InProcessSdk(facade)
}

export default RuntimeFacade
