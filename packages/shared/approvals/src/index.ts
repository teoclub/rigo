/**
 * Rigo Approval Service (Issue 023; SPEC §2.4, §3.3, §4.6, §5.4, §5.6,
 * §5.7; PRD US-012, FR-19, FR-20).
 *
 * The persistent write-approval state machine:
 *
 *   - the SPEC §3.3 `approvals` table (UNIQUE action-execution link,
 *     optimistic `version` column) lives in the SESSION database (version 3,
 *     after sessions v1 and action_executions v2); the host composes
 *     `[...SESSION_PERSISTENCE_MIGRATIONS, ...ACTION_MIGRATIONS,
 *     ...APPROVAL_MIGRATIONS]`;
 *   - read actions (`none`/`local-read`) never need approval; write actions
 *     are suspended by the Issue 021 pipeline (`requires-approval`) BEFORE
 *     execution, and the host creates the Approval Request at that point —
 *     the request carries the action name, target, parameter summary,
 *     expected impact and expiry (AC-3);
 *   - `pending` transitions to `approved` / `denied` / `expired` /
 *     `cancelled` exactly once (SPEC §5.7): every decision uses the SPEC
 *     §3.3 conditional update (`WHERE state = 'pending' AND version = ?`),
 *     so a duplicate or stale decision raises {@link ApprovalAlreadyDecidedError}
 *     and an overdue request raises {@link ApprovalExpiredError};
 *   - `approved` revalidates the action (still registered, input still
 *     valid) and resumes the suspended execution via `ctx.actions.resume`;
 *     `denied`/`cancelled`/`expired` never execute — the underlying action
 *     is cancelled through `ctx.actions.cancelExecution`;
 *   - pending approvals are persisted, so a restart can reload them
 *     (`listPending`) and keep the agent's `approval/waiting` progress:
 *     every request/resolution is also written to the session event log
 *     (`approval/requested`, `approval/resolved` — known event types).
 *
 * @module @teoclub/shared-approvals
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@teoclub/cordis'
import { KNOWN_SESSION_EVENT_TYPES, type Session } from '@teoclub/harness-session'
import type { StorageDriver, StorageMigration } from '@teoclub/shared-storage-sqlite-node/definition'

/** Approval states (SPEC §3.3/§5.7). */
export const APPROVAL_STATES = ['pending', 'approved', 'denied', 'expired', 'cancelled'] as const
export type ApprovalState = typeof APPROVAL_STATES[number]

/** Default request lifetime (SPEC §4.6 approvals expire; 10 minutes). */
export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000

/**
 * Approval schema (SPEC §3.3). Version 3 in the session database (1 =
 * session tables, 2 = action_executions).
 */
export const APPROVAL_MIGRATIONS: StorageMigration[] = [
  {
    version: 3,
    name: 'approvals',
    sql: `
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  action_execution_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'approved', 'denied', 'expired', 'cancelled')
  ),
  request_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decision_json TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`,
  },
]

/** The session event type appended when a request is created. */
export const APPROVAL_REQUESTED_EVENT_TYPE = 'approval/requested'
/** The session event type appended when a request is resolved. */
export const APPROVAL_RESOLVED_EVENT_TYPE = 'approval/resolved'

{
  const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
  known.add(APPROVAL_REQUESTED_EVENT_TYPE)
  known.add(APPROVAL_RESOLVED_EVENT_TYPE)
}

/** Data shape of {@link APPROVAL_REQUESTED_EVENT_TYPE}. */
export interface ApprovalRequestedEvent {
  approvalId: string
  sessionId: string
  actionName: string
  actionExecutionId: string
  expiresAt: string
}

/** Data shape of {@link APPROVAL_RESOLVED_EVENT_TYPE}. */
export interface ApprovalResolvedEvent {
  approvalId: string
  sessionId: string
  outcome: 'approved' | 'denied' | 'expired' | 'cancelled'
}

declare module '@teoclub/harness-session' {
  interface SessionEventMap {
    'approval/requested': ApprovalRequestedEvent
    'approval/resolved': ApprovalResolvedEvent
  }
}

/** One persistent approval request (AC-3 fields). */
export interface ApprovalRequestInput {
  /** Owning session (SPEC §3.3 FK). */
  sessionId: string
  /** The suspended action execution (SPEC §3.3 UNIQUE link). */
  actionExecutionId: string
  /** The action name. */
  actionName: string
  /** The action's target (e.g. a workspace-relative document path). */
  target: string
  /** Summarized parameters (audit-safe; never raw credentials). */
  paramsSummary: string
  /** The expected impact of approving (e.g. "overwrites docs/plan.md"). */
  expectedImpact: string
  /** Explicit expiry; defaults to the service TTL. */
  expiresAt?: string
  /** The session to record `approval/requested` into (optional). */
  session?: Session
}

/** The persisted approval row (SPEC §3.3). */
export interface ApprovalRecord {
  id: string
  sessionId: string
  actionExecutionId: string
  actionName: string
  target: string
  paramsSummary: string
  expectedImpact: string
  state: ApprovalState
  /** Optimistic lock version (SPEC §3.3; §4.6 expectedVersion). */
  version: number
  createdAt: string
  expiresAt: string
  decidedAt: string | undefined
  decision: string | undefined
}

/** One decision (SPEC §4.6). */
export interface ApprovalDecision {
  decision: 'approved' | 'denied' | 'cancelled'
  /** Optimistic lock: the version the client saw (SPEC §3.3/§4.6). */
  expectedVersion: number
  /** Optional human-readable comment (audit-visible). */
  comment?: string
  /** The session to record `approval/resolved` into (optional). */
  session?: Session
}

export interface ApprovalResolveResult {
  approval: ApprovalRecord
  /** The resumed execution outcome, when the action pipeline resumed it. */
  execution?: { status: string; executionId: string; action: string }
}

/** Structured unknown-approval failure (SPEC §6.1 `APPROVAL_NOT_FOUND`). */
export class ApprovalNotFoundError extends Error {
  readonly code = 'APPROVAL_NOT_FOUND'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApprovalNotFoundError'
  }
}

/** Structured duplicate/stale decision failure (SPEC §6.1 `APPROVAL_ALREADY_DECIDED`). */
export class ApprovalAlreadyDecidedError extends Error {
  readonly code = 'APPROVAL_ALREADY_DECIDED'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApprovalAlreadyDecidedError'
  }
}

/** Structured overdue failure (SPEC §6.1 `APPROVAL_EXPIRED`). */
export class ApprovalExpiredError extends Error {
  readonly code = 'APPROVAL_EXPIRED'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ApprovalExpiredError'
  }
}

export interface ApprovalsConfig {
  /** The SESSION database driver (pre-migrated by the host). */
  driver: StorageDriver
  /** Default request lifetime (default {@link DEFAULT_APPROVAL_TTL_MS}). */
  defaultTtlMs?: number
}

/** The Approval service. Mount via `ctx.plugin(ApprovalsService, config)`. */
export class ApprovalsService extends Service {
  private readonly driver: StorageDriver
  private readonly ttlMs: number

  constructor(ctx: Context, config: ApprovalsConfig) {
    super(ctx, 'approvals')
    if (config?.driver === undefined) {
      throw new TypeError('approvals service requires a storage driver')
    }
    // Pre-flight the composed schema (host runs the full migration set).
    const sessions = config.driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    )
    if (sessions.length === 0) {
      throw new Error('approvals require the session tables: run the session migrations (version 1) on this driver first')
    }
    const approvals = config.driver.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approvals'",
    )
    if (approvals.length === 0) {
      throw new Error(
        'the approvals table is missing: run the composed migration set [...SESSION_PERSISTENCE_MIGRATIONS, ...ACTION_MIGRATIONS, ...APPROVAL_MIGRATIONS] on this driver first',
      )
    }
    this.driver = config.driver
    this.ttlMs = config.defaultTtlMs ?? DEFAULT_APPROVAL_TTL_MS
  }

  /**
   * Create a `pending` approval request for a suspended write execution
   * (SPEC §5.4: persisted BEFORE the action runs). Appends
   * `approval/requested` when a session is supplied.
   * @param input - the request fields.
   * @returns the persisted approval record.
   */
  async create(input: ApprovalRequestInput): Promise<ApprovalRecord> {
    if (input === null || typeof input !== 'object') {
      throw new TypeError('approval request must be an object')
    }
    if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) {
      throw new TypeError('approval request sessionId must be a non-empty string')
    }
    if (typeof input.actionExecutionId !== 'string' || input.actionExecutionId.length === 0) {
      throw new TypeError('approval request actionExecutionId must be a non-empty string')
    }
    if (typeof input.actionName !== 'string' || input.actionName.length === 0) {
      throw new TypeError('approval request actionName must be a non-empty string')
    }
    if (typeof input.target !== 'string' || input.target.length === 0) {
      throw new TypeError('approval request target must be a non-empty string')
    }
    if (typeof input.paramsSummary !== 'string') {
      throw new TypeError('approval request paramsSummary must be a string')
    }
    if (typeof input.expectedImpact !== 'string') {
      throw new TypeError('approval request expectedImpact must be a string')
    }
    const id = `approval_${randomUUID()}`
    const now = Date.now()
    const expiresAt = input.expiresAt ?? new Date(now + this.ttlMs).toISOString()
    const requestJson = JSON.stringify({
      actionName: input.actionName,
      target: input.target,
      paramsSummary: input.paramsSummary,
      expectedImpact: input.expectedImpact,
    })
    this.driver.transaction(() => {
      this.driver.run(
        `INSERT INTO approvals (id, session_id, action_execution_id, state, request_json, version, created_at, expires_at)
         VALUES (?, ?, ?, 'pending', ?, 1, ?, ?)`,
        [id, input.sessionId, input.actionExecutionId, requestJson, new Date(now).toISOString(), expiresAt],
      )
    })
    input.session?.append(APPROVAL_REQUESTED_EVENT_TYPE, {
      approvalId: id,
      sessionId: input.sessionId,
      actionName: input.actionName,
      actionExecutionId: input.actionExecutionId,
      expiresAt,
    })
    return this.get(id)!
  }

  /** One approval by id, or `undefined`. */
  get(id: string): ApprovalRecord | undefined {
    const row = this.driver.query<Record<string, unknown>>(
      'SELECT * FROM approvals WHERE id = ?',
      [id],
    )[0]
    return row === undefined ? undefined : rowToRecord(row)
  }

  /** Pending approvals, newest first (restart reload — AC-8). */
  listPending(sessionId?: string): ApprovalRecord[] {
    const rows = sessionId === undefined
      ? this.driver.query<Record<string, unknown>>(
        "SELECT * FROM approvals WHERE state = 'pending' ORDER BY created_at DESC",
      )
      : this.driver.query<Record<string, unknown>>(
        "SELECT * FROM approvals WHERE state = 'pending' AND session_id = ? ORDER BY created_at DESC",
        [sessionId],
      )
    return rows.map(rowToRecord)
  }

  /**
   * Resolve one pending request (SPEC §4.6). The decision is applied with
   * the SPEC §3.3 optimistic conditional update — a duplicate or stale
   * decision raises {@link ApprovalAlreadyDecidedError}; an overdue request
   * is transitioned to `expired` and raises {@link ApprovalExpiredError}.
   * An `approved` decision revalidates the action (via
   * `ctx.actions.resume`, which re-checks registration and schema) and
   * resumes the suspended execution; `denied`/`cancelled` cancel the
   * underlying action without executing it.
   * @param id - the approval id.
   * @param decision - the decision.
   * @returns the updated approval plus the resumed execution outcome.
   */
  async decide(id: string, decision: ApprovalDecision): Promise<ApprovalResolveResult> {
    if (decision === null || typeof decision !== 'object'
      || !['approved', 'denied', 'cancelled'].includes(decision.decision)
      || !Number.isSafeInteger(decision.expectedVersion) || decision.expectedVersion < 1) {
      throw new TypeError('approval decision must carry a valid decision and expectedVersion')
    }
    const approval = this.get(id)
    if (approval === undefined) {
      throw new ApprovalNotFoundError(`approval "${id}" not found`)
    }
    const now = new Date().toISOString()
    if (approval.state === 'pending' && Date.parse(approval.expiresAt) <= Date.now()) {
      // Overdue: one terminal transition to expired (SPEC §5.7), then fail.
      this.applyConditionalUpdate(id, 'expired', decision, now)
      this.cancelSuspended(approval, 'approval expired')
      decision.session?.append(APPROVAL_RESOLVED_EVENT_TYPE, {
        approvalId: id,
        sessionId: approval.sessionId,
        outcome: 'expired',
      })
      throw new ApprovalExpiredError(`approval "${id}" expired at ${approval.expiresAt}`)
    }
    const outcome = decision.decision
    const changed = this.applyConditionalUpdate(id, outcome, decision, now)
    if (!changed) {
      throw new ApprovalAlreadyDecidedError(`approval "${id}" was already decided`)
    }
    decision.session?.append(APPROVAL_RESOLVED_EVENT_TYPE, {
      approvalId: id,
      sessionId: approval.sessionId,
      outcome,
    })
    const updated = this.get(id)!
    if (outcome === 'approved') {
      // Revalidate the action and resume the suspended execution (AC-7).
      const execution = await this.resumeSuspended(updated)
      return { approval: updated, ...(execution === undefined ? {} : { execution }) }
    }
    this.cancelSuspended(updated, `approval ${outcome}`)
    return { approval: updated }
  }

  /** The SPEC §3.3 conditional update; returns whether exactly one row moved. */
  private applyConditionalUpdate(
    id: string,
    state: ApprovalState,
    decision: ApprovalDecision,
    now: string,
  ): boolean {
    const decisionJson = JSON.stringify({
      decision: decision.decision,
      ...(decision.comment === undefined ? {} : { comment: decision.comment }),
    })
    const outcome = this.driver.transaction(() => {
      return this.driver.run(
        `UPDATE approvals
         SET state = ?, decision_json = ?, decided_at = ?, version = version + 1
         WHERE id = ? AND state = 'pending' AND version = ?`,
        [state, decisionJson, now, id, decision.expectedVersion],
      )
    })
    return Number(outcome.changes) === 1
  }

  /** Resume the suspended action through the Issue 021 pipeline, when mounted. */
  private async resumeSuspended(approval: ApprovalRecord): Promise<{ status: string; executionId: string; action: string } | undefined> {
    let actions: { resume(executionId: string): Promise<unknown> } | undefined
    try {
      actions = (this.ctx as { actions?: unknown }).actions as { resume(executionId: string): Promise<unknown> } | undefined
    } catch {
      return undefined
    }
    if (actions === undefined) return undefined
    const result = await actions.resume(approval.actionExecutionId) as { status: string; executionId: string; action: string }
    return result
  }

  /** Cancel the suspended action (denied/expired/cancelled → never executed). */
  private cancelSuspended(approval: ApprovalRecord, reason: string): void {
    try {
      const actions = (this.ctx as { actions?: unknown }).actions as { cancelExecution(executionId: string, reason: string): boolean } | undefined
      if (actions !== undefined) actions.cancelExecution(approval.actionExecutionId, reason)
    } catch {
      // No action pipeline mounted — the approval outcome still stands.
    }
  }
}

function rowToRecord(row: Record<string, unknown>): ApprovalRecord {
  const request = JSON.parse(String(row.request_json)) as {
    actionName: string
    target: string
    paramsSummary: string
    expectedImpact: string
  }
  const decision = row.decision_json === null || row.decision_json === undefined
    ? undefined
    : String(row.decision_json)
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    actionExecutionId: String(row.action_execution_id),
    actionName: request.actionName,
    target: request.target,
    paramsSummary: request.paramsSummary,
    expectedImpact: request.expectedImpact,
    state: String(row.state) as ApprovalState,
    version: Number(row.version),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    decidedAt: row.decided_at === null || row.decided_at === undefined ? undefined : String(row.decided_at),
    decision,
  }
}

declare module '@teoclub/cordis' {
  interface Context {
    /** The Approval service (Issue 023). */
    approvals: ApprovalsService
  }
}

export default ApprovalsService
