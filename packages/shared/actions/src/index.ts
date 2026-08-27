/**
 * Rigo Action Service (Issues 021/022; SPEC §2.4, §3.4, §5.4, §6.1, §8.3;
 * PRD US-010, FR-17, FR-18, FR-21, FR-35, NFR-6).
 *
 * The unified domain-action pipeline:
 *
 *   - {@link ActionDefinition} declares a name, description, input JSON
 *     Schema and the execute function, plus the {@link SideEffectClass}
 *     (`none` | `local-read` | `local-write` | `external-write` — SPEC §5.4
 *     "determine side-effect class");
 *   - `ctx.actions` registers / looks up / unloads definitions; unload
 *     (disposer or fiber) rejects NEW calls with {@link ActionNotFoundError}
 *     and routes in-flight executions into the cancellation flow (their
 *     execute signal aborts, results report `cancelled`);
 *   - input is validated against the JSON Schema BEFORE any policy hook,
 *     approval decision or side effect runs (SPEC §5.4 step 2; §6.1
 *     `ACTION_VALIDATION_FAILED`);
 *   - every request receives a unique execution id (`action_<uuid>`,
 *     SPEC §4.6 example shape);
 *   - the `actions/pre-policy` stage runs registered hooks in order and
 *     resolves ONE structured decision: any `deny` wins, otherwise any
 *     `require-approval`, otherwise `allow`; with no hook registered the
 *     default follows SPEC §11.3 ("all write operations require approval"):
 *     `none`/`local-read` run immediately, `local-write`/`external-write`
 *     return `requires-approval` WITHOUT executing (the Issue 022 approval
 *     machinery resumes suspended executions);
 *   - execution results are normalized: `completed` carries the value,
 *     `failed` carries only a safe message (never the raw exception),
 *     `cancelled` reports the abort reason, `denied` / `requires-approval`
 *     carry the deciding policy.
 *
 * @module @teoclub/shared-actions
 */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@teoclub/cordis'
import {
  assertSupportedJsonSchema,
  validateJsonSchemaValue,
  type JsonSchemaNode,
} from '@teoclub/harness-tools'
import {
  type StorageDriver,
  type StorageMigration,
} from '@teoclub/shared-storage-sqlite-node/definition'

/** Declared side-effect classes (SPEC §5.4; PRD FR-35). */
export const SIDE_EFFECT_CLASSES = ['none', 'local-read', 'local-write', 'external-write'] as const
export type SideEffectClass = typeof SIDE_EFFECT_CLASSES[number]

/** Action execution states (SPEC §3.4). */
export const ACTION_STATES = [
  'proposed',
  'awaiting-approval',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'recovery-required',
] as const
export type ActionState = typeof ACTION_STATES[number]

/**
 * Action persistence schema (SPEC §3.4). Version 2 because the table lives
 * in the SESSION database (the FK resolves against `sessions(id)`; version 1
 * there is the session-tables migration). The host runs the composed set
 * `[...SESSION_MIGRATIONS, ...ACTION_MIGRATIONS]` on the session driver.
 */
export const ACTION_MIGRATIONS: StorageMigration[] = [
  {
    version: 2,
    name: 'action-executions',
    sql: `
CREATE TABLE action_executions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  step_id TEXT,
  action_name TEXT NOT NULL,
  side_effect TEXT NOT NULL CHECK (
    side_effect IN ('none', 'local-read', 'local-write', 'external-write')
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'proposed',
      'awaiting-approval',
      'running',
      'succeeded',
      'failed',
      'cancelled',
      'recovery-required'
    )
  ),
  idempotency_key TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE(action_name, idempotency_key),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);
`,
  },
]

/** One registered domain action (SPEC §5.4 step 1). */
export interface ActionDefinition {
  /** Stable action name (registry key). */
  name: string
  /** Human-readable description. */
  description: string
  /** Raw JSON Schema for the input (normalized at registration). */
  inputSchema: Record<string, unknown>
  /** Declared side-effect class. */
  sideEffect: SideEffectClass
  /**
   * Execute an accepted call. The signal aborts when the request is
   * cancelled or when the defining plugin unloads mid-flight.
   */
  execute(input: unknown, signal?: AbortSignal): Promise<unknown> | unknown
}

/** One execution request (SPEC §5.4: resolve → validate → policy → execute). */
export interface ActionExecutionRequest {
  /** The action name. */
  action: string
  /** Input to validate and execute. */
  input: unknown
  /**
   * Idempotency key (SPEC §3.4): the same `action + idempotency_key` pair
   * replays the persisted outcome instead of re-executing. Required for
   * idempotent replay when persistence is enabled; key-less calls persist
   * with an auto-generated key and carry no dedupe guarantee.
   */
  idempotencyKey?: string
  /** Owning session (SPEC §3.4 FK; required when persistence is enabled). */
  sessionId?: string
}

/** Structured pre-policy outcome (SPEC §5.4 `actions/pre-policy`). */
export interface ActionPolicyResult {
  /** The resolved decision. */
  decision: 'allow' | 'deny' | 'require-approval'
  /** Human-readable reason (audit-visible). */
  reason: string
  /** The policy/hook that produced this result (or `default`). */
  policy: string
  /** Version to revalidate on approval (SPEC §5.4 revalidate step). */
  expectedVersion?: number
}

/** The context handed to policy hooks. */
export interface ActionExecutionContext {
  executionId: string
  action: string
  description: string
  sideEffect: SideEffectClass
  input: unknown
}

/** One `actions/pre-policy` hook. Hooks run in registration order. */
export type ActionPolicyHook = (
  ctx: Context,
  execution: ActionExecutionContext,
  signal?: AbortSignal,
) => ActionPolicyResult | Promise<ActionPolicyResult>

/**
 * One execution lifecycle fact for the SPEC §6.3 audit gate. The host
 * forwards it to the Audit service (`recordActionExecution`), which appends
 * the redacted `action/executed` session event. The `running` record is the
 * gate: it fires BEFORE the executor runs, so a recording failure prevents
 * the side effect.
 */
export interface ActionExecutionAuditEntry {
  executionId: string
  action: string
  sessionId: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'denied' | 'requires-approval'
  /** Structured input (summarized + redacted by the recorder). */
  input: unknown
  /** Structured result (summarized + redacted when present). */
  result?: unknown
  /** Safe failure record (message plus the structured code when present). */
  error?: { message: string; code?: string }
  reason?: string
  durationMs?: number
}

/** Normalized execution outcomes (SPEC §5.4 mark succeeded/failed). */
export type ActionExecutionResult =
  | {
    status: 'completed'
    executionId: string
    action: string
    result: unknown
    durationMs: number
    /** True when the outcome was replayed from a persisted execution. */
    replayed?: true
  }
  | {
    status: 'failed'
    executionId: string
    action: string
    /** Safe failure record: message plus the structured error code when the executor threw one. */
    error: { message: string; code?: string }
    durationMs: number
    replayed?: true
  }
  | {
    status: 'cancelled'
    executionId: string
    action: string
    reason: string
    replayed?: true
  }
  | {
    status: 'recovery-required'
    executionId: string
    action: string
    reason: string
    replayed?: true
  }
  | {
    status: 'in-progress'
    executionId: string
    action: string
    /** The persisted state the same-key call found (SPEC §3.4). */
    state: 'proposed' | 'running' | 'awaiting-approval'
  }
  | {
    status: 'denied'
    executionId: string
    action: string
    reason: string
    policy: string
  }
  | {
    status: 'requires-approval'
    executionId: string
    action: string
    reason: string
    policy: string
    expectedVersion?: number
  }

/** Structured unknown-action failure (SPEC §6.1 `ACTION_NOT_FOUND`). */
export class ActionNotFoundError extends Error {
  readonly code = 'ACTION_NOT_FOUND'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ActionNotFoundError'
  }
}

/** Structured input validation failure (SPEC §6.1 `ACTION_VALIDATION_FAILED`). */
export class ActionValidationError extends Error {
  readonly code = 'ACTION_VALIDATION_FAILED'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ActionValidationError'
  }
}

/** Structured same-key-different-request failure (SPEC §6.1 `IDEMPOTENCY_CONFLICT`). */
export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'IdempotencyConflictError'
  }
}

/** The Action service. Mount via `ctx.plugin(ActionsService)`. */
export class ActionsService extends Service {
  private readonly definitions = new Map<string, { definition: ActionDefinition; schema: JsonSchemaNode }>()
  private readonly hooks: ActionPolicyHook[] = []
  /** executionId → in-flight controller (drives the unload cancellation flow). */
  private readonly inflight = new Map<string, { definition: ActionDefinition; controller: AbortController }>()
  /** Persistence driver (the SESSION database), when the host wired it. */
  private readonly driver: StorageDriver | undefined
  /** SPEC §6.3 audit gate: the host's action/executed recorder, when wired. */
  private readonly recordExecution: ((entry: ActionExecutionAuditEntry) => void) | undefined

  constructor(ctx: Context, config: { driver?: StorageDriver; recordExecution?: (entry: ActionExecutionAuditEntry) => void } = {}) {
    super(ctx, 'actions')
    this.recordExecution = config.recordExecution
    if (config.driver !== undefined) {
      // Pre-flight the composed schema: action_executions lives in the
      // session database (FK → sessions(id)); the host runs the complete
      // set [...SESSION_PERSISTENCE_MIGRATIONS, ...ACTION_MIGRATIONS] on
      // this driver BEFORE mounting (the migration framework verifies every
      // applied migration against the set it is given, so one database
      // always migrates as one complete set).
      const sessions = config.driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
      )
      if (sessions.length === 0) {
        throw new Error(
          'action persistence requires the session tables: run the session migrations (version 1) on this driver first',
        )
      }
      const executions = config.driver.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'action_executions'",
      )
      if (executions.length === 0) {
        throw new Error(
          'the action_executions table is missing: run the composed migration set [...SESSION_PERSISTENCE_MIGRATIONS, ...ACTION_MIGRATIONS] on this driver first',
        )
      }
      this.driver = config.driver
    }
  }

  /**
   * Register one action definition. The input schema is normalized and
   * validated up front (an unsupported JSON Schema rejects registration);
   * a duplicate name is rejected. Unload (or the disposer) removes the
   * definition — new calls then raise {@link ActionNotFoundError} — and
   * cancels its in-flight executions.
   * @param definition - the action to register.
   * @returns the disposer.
   */
  registerAction(definition: ActionDefinition): () => void {
    if (definition === null || typeof definition !== 'object') {
      throw new TypeError('action definition must be an object')
    }
    if (typeof definition.name !== 'string' || definition.name.length === 0) {
      throw new TypeError('action name must be a non-empty string')
    }
    if (typeof definition.description !== 'string') {
      throw new TypeError('action description must be a string')
    }
    if (!SIDE_EFFECT_CLASSES.includes(definition.sideEffect)) {
      throw new TypeError(`action sideEffect must be one of ${SIDE_EFFECT_CLASSES.join(', ')}, got ${String(definition.sideEffect)}`)
    }
    if (typeof definition.execute !== 'function') {
      throw new TypeError('action execute must be a function')
    }
    if (this.definitions.has(definition.name)) {
      throw new Error(`action "${definition.name}" is already registered`)
    }
    // Normalize the input schema BEFORE the definition becomes visible
    // (the same up-front contract as the tool registry).
    const rawSchema = definition.inputSchema as JsonSchemaNode
    assertSupportedJsonSchema(rawSchema)
    this.definitions.set(definition.name, { definition, schema: rawSchema })
    return this.ctx.effect(() => () => {
      this.definitions.delete(definition.name)
      this.cancelInflight(definition, `action "${definition.name}" plugin unloaded`)
    }, `actions.registerAction(${definition.name})`)
  }

  /** The registered definition for a name, or `undefined`. */
  getAction(name: string): ActionDefinition | undefined {
    return this.definitions.get(name)?.definition
  }

  /** Every registered action name (stable insertion order). */
  listActions(): string[] {
    return [...this.definitions.keys()]
  }

  /**
   * Register one `actions/pre-policy` hook (SPEC §5.4 step 4). Hooks run in
   * registration order; the FIRST `deny` wins, otherwise the FIRST
   * `require-approval`, otherwise `allow`. Unload removes the hook.
   * @param hook - the policy hook.
   * @returns the disposer.
   */
  beforePolicy(hook: ActionPolicyHook): () => void {
    if (typeof hook !== 'function') {
      throw new TypeError('action policy hook must be a function')
    }
    this.hooks.push(hook)
    return this.ctx.effect(() => () => {
      const index = this.hooks.indexOf(hook)
      if (index !== -1) this.hooks.splice(index, 1)
    }, 'actions.beforePolicy()')
  }

  /**
   * Run one action through the pipeline: resolve the definition, validate
   * the input (BEFORE any policy/approval/side effect), issue a unique
   * execution id, resolve the pre-policy decision, then either execute,
   * deny, or suspend for approval.
  /**
   * Run one action through the pipeline: resolve the definition, validate
   * the input (BEFORE any policy/approval/side effect), issue a unique
   * execution id, resolve the pre-policy decision, then either execute,
   * deny, or suspend for approval.
   * @param request - the action name and input.
   * @param signal - optional caller cancellation.
   * @returns the normalized execution outcome.
   * @throws {@link ActionNotFoundError} for an unknown action.
   * @throws {@link ActionValidationError} for invalid input.
   */
  /** Record one audit-gate fact when the host wired a recorder. */
  private recordAudit(
    entry: Omit<ActionExecutionAuditEntry, 'sessionId'>,
    sessionId: string | undefined,
  ): void {
    if (sessionId === undefined || this.recordExecution === undefined) return
    this.recordExecution({ ...entry, sessionId })
  }

  /**
   * Record one terminal/pre-execution fact without corrupting the execution
   * outcome: a recording failure (e.g. a non-serializable executor result)
   * must not turn a committed side effect into a journaled failure. Only the
   * `running` record is the strict SPEC §6.3 gate — it uses
   * {@link recordAudit} so a throw there still prevents the side effect.
   */
  private recordAuditSafe(
    entry: Omit<ActionExecutionAuditEntry, 'sessionId'>,
    sessionId: string | undefined,
  ): void {
    if (sessionId === undefined || this.recordExecution === undefined) return
    try {
      this.recordExecution({ ...entry, sessionId })
    } catch (error) {
      this.ctx.logger.warn(`actions: audit recording failed for "${entry.action}" (${entry.executionId}): ${String(error)}`)
    }
  }

  async execute(request: ActionExecutionRequest, signal?: AbortSignal): Promise<ActionExecutionResult> {
    signal?.throwIfAborted()
    const entry = this.definitions.get(request.action)
    if (entry === undefined) {
      throw new ActionNotFoundError(`action "${request.action}" is not registered`)
    }
    const { definition, schema } = entry

    // AC: input validation happens BEFORE any policy, approval or side
    // effect — an invalid call never reaches a hook or the executor.
    const violations = validateJsonSchemaValue(schema, request.input)
    if (violations.length > 0) {
      throw new ActionValidationError(
        `action "${definition.name}" input is invalid: ${violations.join('; ')}`,
      )
    }

    const executionId = `action_${randomUUID()}`
    const context: ActionExecutionContext = {
      executionId,
      action: definition.name,
      description: definition.description,
      sideEffect: definition.sideEffect,
      input: request.input,
    }

    // --- persistence: reserve the execution and honor idempotency (SPEC §3.4) ---
    let persistent = false
    if (this.driver !== undefined) {
      if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
        throw new ActionValidationError(
          `action "${definition.name}" requires sessionId when action persistence is enabled`,
        )
      }
      const idempotencyKey = request.idempotencyKey ?? `auto-${executionId}`
      const existing = this.findExecution(definition.name, idempotencyKey)
      if (existing !== undefined) {
        return this.replay(existing, request)
      }
      try {
        this.driver.transaction(() => {
          this.driver!.run(
            `INSERT INTO action_executions
               (id, session_id, action_name, side_effect, state, idempotency_key, request_json, created_at)
             VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?)`,
            [executionId, request.sessionId, definition.name, definition.sideEffect, idempotencyKey,
              stableStringify(request.input), new Date().toISOString()],
          )
        })
      } catch (error) {
        // UNIQUE(action_name, idempotency_key) race: another caller won —
        // re-lookup and replay/conflict against the committed row.
        const raced = this.findExecution(definition.name, idempotencyKey)
        if (raced !== undefined) return this.replay(raced, request)
        throw error
      }
      persistent = true
    }

    // The execution is tracked from the moment it enters the pipeline, so an
    // unload mid-policy still cancels it.
    const controller = new AbortController()
    this.inflight.set(executionId, { definition, controller })
    try {
      const policy = await this.resolvePolicy(context, signal)
      if (policy.decision === 'deny') {
        if (persistent) {
          this.persistOutcome(executionId, 'cancelled', {
            error: { code: 'POLICY_DENIED', message: policy.reason },
          })
        }
        this.recordAuditSafe({
          executionId, action: definition.name, status: 'denied', input: request.input,
          reason: policy.reason,
        }, request.sessionId)
        return { status: 'denied', executionId, action: definition.name, reason: policy.reason, policy: policy.policy }
      }
      if (policy.decision === 'require-approval') {
        // Short transition only — the approval wait happens OUTSIDE the
        // transaction (SPEC §8.3: never await user input inside one).
        if (persistent) this.transitionState(executionId, 'awaiting-approval')
        this.recordAuditSafe({
          executionId, action: definition.name, status: 'requires-approval', input: request.input,
          reason: policy.reason,
        }, request.sessionId)
        return {
          status: 'requires-approval',
          executionId,
          action: definition.name,
          reason: policy.reason,
          policy: policy.policy,
          ...(policy.expectedVersion === undefined ? {} : { expectedVersion: policy.expectedVersion }),
        }
      }

      // SPEC §6.3 audit gate: record `running` BEFORE the executor runs — a
      // recording failure must prevent the side effect.
      this.recordAudit({
        executionId, action: definition.name, status: 'running', input: request.input,
      }, request.sessionId)
      if (persistent) this.transitionState(executionId, 'running', { startedAt: true })
      // Allowed: run the executor with combined caller + lifecycle signals.
      const execSignal = signal === undefined
        ? controller.signal
        : AbortSignal.any([signal, controller.signal])
      const started = performance.now()
      try {
        const result = await definition.execute(request.input, execSignal)
        if (persistent) {
          this.persistOutcome(executionId, 'succeeded', { result })
        }
        this.recordAuditSafe({
          executionId, action: definition.name, status: 'succeeded', input: request.input,
          result, durationMs: performance.now() - started,
        }, request.sessionId)
        return {
          status: 'completed',
          executionId,
          action: definition.name,
          result,
          durationMs: performance.now() - started,
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          const reason = String(execSignal.reason ?? 'aborted')
          // A cancelled execution is persisted; committed side effects are
          // NOT rolled back (SPEC §5.8: no fabricated rollback).
          if (persistent) {
            this.persistOutcome(executionId, 'cancelled', { error: { code: 'CANCELLED', message: reason } })
          }
          this.recordAuditSafe({
            executionId, action: definition.name, status: 'cancelled', input: request.input, reason,
          }, request.sessionId)
          return {
            status: 'cancelled',
            executionId,
            action: definition.name,
            reason,
          }
        }
        const message = error instanceof Error ? error.message : String(error)
        const code = typeof (error as Error & { code?: unknown }).code === 'string'
          ? (error as Error & { code: string }).code
          : undefined
        // Failed actions never auto-retry their side effects (SPEC §3.4):
        // the caller must create a new idempotency key.
        if (persistent) {
          this.persistOutcome(executionId, 'failed', { error: { ...(code === undefined ? {} : { code }), message } })
        }
        this.recordAuditSafe({
          executionId, action: definition.name, status: 'failed', input: request.input,
          error: { ...(code === undefined ? {} : { code }), message },
          durationMs: performance.now() - started,
        }, request.sessionId)
        return {
          status: 'failed',
          executionId,
          action: definition.name,
          // Safe message only — never the raw exception object (§7.4).
          error: { ...(code === undefined ? {} : { code }), message },
          durationMs: performance.now() - started,
        }
      }
    } finally {
      this.inflight.delete(executionId)
    }
  }

  /**
   * Recovery pass for crash-orphaned executions (SPEC §3.4/§5.5): flips any
   * `proposed`/`running` row to `recovery-required` in one short
   * transaction. The host invokes this after the runtime starts, so a
   * `running` row can only be a crash orphan.
   * @returns the number of rows recovered.
   */
  recoverOrphanedExecutions(): number {
    if (this.driver === undefined) return 0
    const now = new Date().toISOString()
    const outcome = this.driver.transaction(() => {
      return this.driver!.run(
        `UPDATE action_executions
         SET state = 'recovery-required', error_json = ?, finished_at = ?
         WHERE state IN ('proposed', 'running')`,
        [JSON.stringify({ code: 'RECOVERY_REQUIRED', message: 'process ended before the execution finished' }), now],
      )
    })
    return Number(outcome.changes)
  }

  /** The persisted row for one action + idempotency key, or `undefined`. */
  getExecution(action: string, idempotencyKey: string): Record<string, unknown> | undefined {
    if (this.driver === undefined) return undefined
    return this.findExecution(action, idempotencyKey)
  }

  /**
   * Resume an `awaiting-approval` execution after the approval was granted
   * (SPEC §5.4 "on approval" branch). REVALIDATES before executing (AC-7):
   * the action definition must still be registered and the persisted input
   * must still satisfy the schema; target-version checks belong to the
   * executor itself (SPEC §5.5 step 4 runs inside the write action). The
   * policy is NOT re-run — the granted approval IS the policy outcome.
   * @param executionId - the persisted execution id.
   * @param signal - optional caller cancellation.
   * @returns the normalized execution outcome (the same shapes as
   *   {@link execute}).
   * @throws {@link ActionNotFoundError} when the execution or its action is gone.
   * @throws {@link ActionValidationError} when the input no longer validates.
   */
  async resume(executionId: string, signal?: AbortSignal): Promise<ActionExecutionResult> {
    signal?.throwIfAborted()
    if (this.driver === undefined) {
      throw new Error('action persistence is required to resume an execution')
    }
    const row = this.driver.query<Record<string, unknown>>(
      'SELECT * FROM action_executions WHERE id = ?',
      [executionId],
    )[0]
    if (row === undefined) {
      throw new ActionNotFoundError(`execution "${executionId}" not found`)
    }
    if (String(row.state) !== 'awaiting-approval') {
      throw new Error(`execution "${executionId}" is not awaiting approval (state: ${String(row.state)})`)
    }
    const action = String(row.action_name)
    const entry = this.definitions.get(action)
    if (entry === undefined) {
      throw new ActionNotFoundError(
        `action "${action}" is no longer registered — the approval cannot be resumed`,
      )
    }
    const input = JSON.parse(String(row.request_json)) as unknown
    const violations = validateJsonSchemaValue(entry.schema, input)
    if (violations.length > 0) {
      throw new ActionValidationError(
        `action "${action}" input no longer validates: ${violations.join('; ')}`,
      )
    }

    // The granted approval is the policy outcome; execute directly.
    // SPEC §6.3 audit gate: record `running` before the resumed executor runs.
    this.recordAudit({
      executionId, action, status: 'running', input,
    }, String(row.session_id))
    this.transitionState(executionId, 'running', { startedAt: true })
    const controller = new AbortController()
    const execSignal = signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal])
    this.inflight.set(executionId, { definition: entry.definition, controller })
    const started = performance.now()
    try {
      const result = await entry.definition.execute(input, execSignal)
      this.persistOutcome(executionId, 'succeeded', { result })
      this.recordAuditSafe({
        executionId, action, status: 'succeeded', input, result, durationMs: performance.now() - started,
      }, String(row.session_id))
      return {
        status: 'completed',
        executionId,
        action,
        result,
        durationMs: performance.now() - started,
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        const reason = String(execSignal.reason ?? 'aborted')
        this.persistOutcome(executionId, 'cancelled', { error: { code: 'CANCELLED', message: reason } })
        this.recordAuditSafe({
          executionId, action, status: 'cancelled', input, reason,
        }, String(row.session_id))
        return { status: 'cancelled', executionId, action, reason }
      }
      const message = error instanceof Error ? error.message : String(error)
      const code = typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : undefined
      this.persistOutcome(executionId, 'failed', { error: { ...(code === undefined ? {} : { code }), message } })
      this.recordAuditSafe({
        executionId, action, status: 'failed', input,
        error: { ...(code === undefined ? {} : { code }), message },
        durationMs: performance.now() - started,
      }, String(row.session_id))
      return {
        status: 'failed',
        executionId,
        action,
        error: { ...(code === undefined ? {} : { code }), message },
        durationMs: performance.now() - started,
      }
    } finally {
      this.inflight.delete(executionId)
    }
  }

  /**
   * Cancel a suspended execution (denied/expired approval, caller
   * cancellation): `awaiting-approval` → `cancelled` with the reason.
   * Terminal rows are left untouched (no-op).
   * @param executionId - the persisted execution id.
   * @param reason - the cancellation reason (audit-visible).
   * @returns whether a transition happened.
   */
  cancelExecution(executionId: string, reason: string): boolean {
    if (this.driver === undefined) return false
    const row = this.driver.query<Record<string, unknown>>(
      'SELECT state FROM action_executions WHERE id = ?',
      [executionId],
    )[0]
    if (row === undefined || String(row.state) !== 'awaiting-approval') return false
    this.persistOutcome(executionId, 'cancelled', { error: { code: 'CANCELLED', message: reason } })
    return true
  }

  private findExecution(action: string, idempotencyKey: string): Record<string, unknown> | undefined {
    return this.driver!.query<Record<string, unknown>>(
      'SELECT * FROM action_executions WHERE action_name = ? AND idempotency_key = ?',
      [action, idempotencyKey],
    )[0]
  }

  /** Replay (or surface) the persisted outcome for a same-key call (SPEC §3.4). */
  private replay(row: Record<string, unknown>, request: ActionExecutionRequest): ActionExecutionResult {
    const action = String(row.action_name)
    const executionId = String(row.id)
    const state = String(row.state) as ActionState
    if (stableStringify(JSON.parse(String(row.request_json))) !== stableStringify(request.input)) {
      throw new IdempotencyConflictError(
        `idempotency key "${String(row.idempotency_key)}" for action "${action}" was already used with different input`,
      )
    }
    switch (state) {
      case 'succeeded':
        return {
          status: 'completed',
          executionId,
          action,
          result: row.result_json === null || row.result_json === undefined ? undefined : JSON.parse(String(row.result_json)),
          durationMs: 0,
          replayed: true,
        }
      case 'failed':
        return {
          status: 'failed',
          executionId,
          action,
          error: row.error_json === null || row.error_json === undefined
            ? { message: 'unknown failure' }
            : JSON.parse(String(row.error_json)) as { message: string },
          durationMs: 0,
          replayed: true,
        }
      case 'cancelled': {
        const error = row.error_json === null || row.error_json === undefined
          ? undefined
          : JSON.parse(String(row.error_json)) as { message?: string }
        return {
          status: 'cancelled',
          executionId,
          action,
          reason: error?.message ?? 'cancelled',
          replayed: true,
        }
      }
      case 'recovery-required':
        return {
          status: 'recovery-required',
          executionId,
          action,
          reason: 'the previous execution requires recovery; create a new idempotency key',
          replayed: true,
        }
      default:
        // The same key is still in flight (SPEC §3.4: return current state).
        return { status: 'in-progress', executionId, action, state }
    }
  }

  /** One short state transition (SPEC §8.3: no awaits inside). */
  private transitionState(executionId: string, state: ActionState, options: { startedAt?: boolean } = {}): void {
    this.driver!.transaction(() => {
      if (options.startedAt) {
        this.driver!.run(
          'UPDATE action_executions SET state = ?, started_at = ? WHERE id = ?',
          [state, new Date().toISOString(), executionId],
        )
      } else {
        this.driver!.run('UPDATE action_executions SET state = ? WHERE id = ?', [state, executionId])
      }
    })
  }

  /** One short terminal write (result/error + state + finished_at). */
  private persistOutcome(
    executionId: string,
    state: 'succeeded' | 'failed' | 'cancelled',
    payload: { result?: unknown; error?: { code?: string; message: string } },
  ): void {
    this.driver!.transaction(() => {
      const resultJson = payload.result === undefined ? null : JSON.stringify(payload.result)
      const errorJson = payload.error === undefined ? null : JSON.stringify(payload.error)
      this.driver!.run(
        `UPDATE action_executions SET state = ?, result_json = ?, error_json = ?, finished_at = ? WHERE id = ?`,
        [state, resultJson, errorJson, new Date().toISOString(), executionId],
      )
    })
  }

  /** Execution ids currently running. */
  listInFlight(): string[] {
    return [...this.inflight.keys()]
  }

  private async resolvePolicy(execution: ActionExecutionContext, signal?: AbortSignal): Promise<ActionPolicyResult> {
    let requireApproval: ActionPolicyResult | undefined
    let explicitAllow: ActionPolicyResult | undefined
    for (const hook of this.hooks) {
      signal?.throwIfAborted()
      const result = await hook(this.ctx, execution, signal)
      if (result === null || typeof result !== 'object'
        || !['allow', 'deny', 'require-approval'].includes(result.decision)
        || typeof result.reason !== 'string'
        || typeof result.policy !== 'string') {
        throw new TypeError(`action policy hook returned an invalid structured result`)
      }
      if (result.decision === 'deny') return result
      if (result.decision === 'allow' && explicitAllow === undefined) explicitAllow = result
      if (result.decision === 'require-approval' && requireApproval === undefined) {
        requireApproval = result
      }
    }
    if (requireApproval !== undefined) return requireApproval
    // An explicit hook allow overrides the write-approval default.
    if (explicitAllow !== undefined) return explicitAllow
    // Default policy (SPEC §11.3: all write operations require approval).
    if (execution.sideEffect === 'local-write' || execution.sideEffect === 'external-write') {
      return {
        decision: 'require-approval',
        reason: `actions with side-effect "${execution.sideEffect}" require approval by default`,
        policy: 'default',
      }
    }
    return { decision: 'allow', reason: 'no policy restriction', policy: 'default' }
  }

  private cancelInflight(definition: ActionDefinition, reason: string): void {
    for (const [executionId, entry] of this.inflight) {
      if (entry.definition === definition) {
        entry.controller.abort(reason)
        this.inflight.delete(executionId)
      }
    }
  }
}

declare module '@teoclub/cordis' {
  interface Context {
    /** The Action service (Issue 021). */
    actions: ActionsService
  }
}

export default ActionsService

/** Deterministic JSON serialization: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}
