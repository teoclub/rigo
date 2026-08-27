/**
 * Rigo Audit Service (Issue 024; SPEC §3.7, §6.3, §7.4, §9.1; PRD US-013,
 * FR-22, FR-33, FR-34).
 *
 * The audit layer over the SESSION EVENT LOG — there is deliberately NO
 * second fact log (SPEC §3.7): every audit fact is a `session_events` entry,
 * and this service owns the redaction, normalization and projection around
 * that log:
 *
 *   - {@link redactValue} performs FIELD-LEVEL redaction (credential/sensitive
 *     field names, recursively) and {@link normalizeError} reduces any error
 *     to a safe `{message, code?, name?}` record — credential values,
 *     sensitive fields and raw provider responses never enter the session
 *     log, the audit projection, SSE or logs (§7.4);
 *   - {@link summarize} renders a redacted, bounded one-line summary of any
 *     structured value (action inputs/results);
 *   - {@link AuditService.recordActionExecution} appends the `action/executed`
 *     event with the input summary, status, result summary and execution
 *     time (AC-3); {@link AuditService.recordApprovalDecision} appends the
 *     `approval/audit` event with the request, decision, decided time and
 *     handler (AC-4). Both events carry correlatable ids (execution id /
 *     approval id) alongside the existing turn/step/retrieval/document
 *     events (AC-2);
 *   - an audit-record failure (a non-summarizable or non-serializable value)
 *     THROWS before the event is appended — the host must run
 *     `recordActionExecution(status: 'running')` BEFORE an external-write
 *     action starts, so a failing audit write prevents the side effect
 *     (SPEC §6.3: "Audit 写入失败时，外部写 Action 不得开始");
 *   - {@link AuditService.project} / {@link AuditService.projectAll} derive
 *     the UI projection: one entry per logged fact, ordered by session and
 *     seq (SPEC §3.7), each with its category and correlation id.
 *
 * @module @teoclub/shared-audit
 */

import { Context, Service } from '@teoclub/cordis'
import { KNOWN_SESSION_EVENT_TYPES, type Session } from '@teoclub/harness-session'

// ---------------------------------------------------------------------------
// Redaction (SPEC §7.4 field-level)
// ---------------------------------------------------------------------------

/** The value replacing every sensitive field (SPEC §7.4). */
export const REDACTED_PLACEHOLDER = '[REDACTED]'

/** Default sensitive field-name pattern (credential-shaped, case-insensitive). */
export const SENSITIVE_FIELD_PATTERN = /(^|[^a-z0-9])(api[_-]?key|token|secret|password|passwd|credential|authorization|cookie|proxy[_-]?authorization|private[_-]?key|access[_-]?key|client[_-]?secret|session[_-]?key)($|[^a-z0-9])/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Field-level redaction: every object property whose name matches the
 * sensitive pattern (recursively, arrays included) is replaced with
 * {@link REDACTED_PLACEHOLDER}. Scalars pass through untouched; the result is
 * a detached copy. Cyclic structures stay cyclic (a later serialization
 * step must reject them — they can never enter the log).
 */
export function redactValue(
  value: unknown,
  sensitive: RegExp = SENSITIVE_FIELD_PATTERN,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    return value.map((item) => redactValue(item, sensitive, seen))
  }
  if (isRecord(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      out[key] = sensitive.test(key) ? REDACTED_PLACEHOLDER : redactValue(item, sensitive, seen)
    }
    return out
  }
  return value
}

/** The set of sensitive positions found in a value (paths, for tests/audit). */
export function sensitivePaths(value: unknown, sensitive: RegExp = SENSITIVE_FIELD_PATTERN, path: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => sensitivePaths(item, sensitive, [...path, String(index)]))
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, item]) => [
      ...(sensitive.test(key) ? [path.concat(key).join('.')] : []),
      ...sensitivePaths(item, sensitive, [...path, key]),
    ])
  }
  return []
}

/** Safe error normalization (§7.4: never serialize raw provider responses). */
export function normalizeError(error: unknown): { message: string; code?: string; name?: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return {
      message: error.message,
      ...(typeof code === 'string' ? { code } : {}),
      ...(typeof error.name === 'string' && error.name !== 'Error' ? { name: error.name } : {}),
    }
  }
  if (typeof error === 'string') return { message: error }
  return { message: 'unknown error' }
}

/**
 * A bounded, redacted one-line summary of any structured value. Throws for
 * values that cannot be serialized (circular structures) — such a value must
 * never reach the log, and the caller must treat the throw as a failed audit
 * write (SPEC §6.3 gate).
 */
export function summarize(value: unknown, maxLength = 200): string {
  const redacted = redactValue(value)
  let text: string
  try {
    text = JSON.stringify(redacted)
  } catch {
    throw new TypeError('audit value is not JSON-serializable')
  }
  if (text === undefined) throw new TypeError('audit value is not JSON-serializable')
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

// ---------------------------------------------------------------------------
// Audit events (registered into the session vocabulary)
// ---------------------------------------------------------------------------

/** The session event type appended for every recorded action execution. */
export const ACTION_EXECUTED_EVENT_TYPE = 'action/executed'
/** The session event type appended for every recorded approval decision. */
export const APPROVAL_AUDIT_EVENT_TYPE = 'approval/audit'

{
  const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
  known.add(ACTION_EXECUTED_EVENT_TYPE)
  known.add(APPROVAL_AUDIT_EVENT_TYPE)
}

/** Data shape of {@link ACTION_EXECUTED_EVENT_TYPE} (redacted by construction). */
export interface ActionExecutedEvent {
  executionId: string
  action: string
  sessionId: string
  /** Redacted input summary (AC-3). */
  inputSummary: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'denied' | 'requires-approval'
  /** Redacted result summary, on terminal events (AC-3). */
  resultSummary?: string
  /** Execution time in milliseconds (AC-3). */
  durationMs?: number
}

/** Data shape of {@link APPROVAL_AUDIT_EVENT_TYPE} (redacted by construction). */
export interface ApprovalAuditEvent {
  approvalId: string
  actionName: string
  sessionId: string
  /** Redacted request summary. */
  requestSummary: string
  decision: 'approved' | 'denied' | 'expired' | 'cancelled'
  /** ISO decision time (AC-4). */
  decidedAt: string
  /** Handler information (AC-4). */
  handledBy: string
}

declare module '@teoclub/harness-session' {
  interface SessionEventMap {
    'action/executed': ActionExecutedEvent
    'approval/audit': ApprovalAuditEvent
  }
}

// ---------------------------------------------------------------------------
// Projection (SPEC §3.7)
// ---------------------------------------------------------------------------

/** Audit entry categories (AC-2: correlatable identifiers). */
export type AuditCategory = 'turn' | 'step' | 'retrieval' | 'approval' | 'action' | 'document' | 'agent' | 'other'

/** One projected audit entry, ordered by session and seq. */
export interface AuditEntry {
  sessionId: string
  /** The event's seq in the session log (stable order). */
  seq: number
  /** Event timestamp (ms). */
  time: number
  category: AuditCategory
  /** Correlatable identifier (turn, turn#step, execution, approval, document…). */
  correlationId: string
  /** One-line human-readable summary. */
  summary: string
  /** The (already redacted) event payload. */
  data: Record<string, unknown>
}

interface ProjectionRule {
  category: AuditCategory
  correlationId: (data: Record<string, unknown>) => string
  summary: (data: Record<string, unknown>) => string
}

function stringOf(data: Record<string, unknown>, key: string): string {
  return typeof data[key] === 'string' ? String(data[key]) : ''
}

const PROJECTION_RULES: Record<string, ProjectionRule> = {
  'turn/start': {
    category: 'turn',
    correlationId: (data) => `turn:${String(data.turn)}`,
    summary: (data) => `turn ${String(data.turn)} started`,
  },
  'turn/end': {
    category: 'turn',
    correlationId: (data) => `turn:${String(data.turn)}`,
    summary: (data) => `turn ${String(data.turn)} ${typeof data.reason === 'object' && data.reason !== null ? String((data.reason as { kind?: unknown }).kind ?? 'ended') : 'ended'}`,
  },
  'step/start': {
    category: 'step',
    correlationId: (data) => `turn:${String(data.turn)}#step:${String(data.step)}`,
    summary: (data) => `step ${String(data.turn)}.${String(data.step)} started`,
  },
  'step/end': {
    category: 'step',
    correlationId: (data) => `turn:${String(data.turn)}#step:${String(data.step)}`,
    summary: (data) => `step ${String(data.turn)}.${String(data.step)} ended`,
  },
  'knowledge/retrieved': {
    category: 'retrieval',
    correlationId: (data) => `query:${stringOf(data, 'querySummary')}`,
    summary: (data) => `retrieved ${String((data.sourceIds as unknown[])?.length ?? 0)} sources for "${stringOf(data, 'querySummary')}"`,
  },
  'approval/requested': {
    category: 'approval',
    correlationId: (data) => `approval:${stringOf(data, 'approvalId')}`,
    summary: (data) => `approval ${stringOf(data, 'approvalId')} requested for ${stringOf(data, 'actionName')}`,
  },
  'approval/resolved': {
    category: 'approval',
    correlationId: (data) => `approval:${stringOf(data, 'approvalId')}`,
    summary: (data) => `approval ${stringOf(data, 'approvalId')} ${stringOf(data, 'outcome')}`,
  },
  'approval/audit': {
    category: 'approval',
    correlationId: (data) => `approval:${stringOf(data, 'approvalId')}`,
    summary: (data) => `approval ${stringOf(data, 'approvalId')} ${stringOf(data, 'decision')} by ${stringOf(data, 'handledBy')}`,
  },
  'action/executed': {
    category: 'action',
    correlationId: (data) => `execution:${stringOf(data, 'executionId')}`,
    summary: (data) => `action ${stringOf(data, 'action')} ${stringOf(data, 'status')}${typeof data.durationMs === 'number' ? ` (${data.durationMs}ms)` : ''}`,
  },
  'document/read': {
    category: 'document',
    correlationId: (data) => `document:${stringOf(data, 'documentId')}`,
    summary: (data) => `read ${stringOf(data, 'documentId')}`,
  },
  'agent/inbox/spliced': {
    category: 'agent',
    correlationId: () => '',
    summary: () => 'agent inbox spliced',
  },
  'user/message': {
    category: 'agent',
    correlationId: () => '',
    summary: () => 'user message',
  },
}

/** The Audit service. Mount via `ctx.plugin(AuditService)`. */
export class AuditService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'audit')
  }

  /** Field-level redaction (passthrough to {@link redactValue}). */
  redact(value: unknown, sensitive?: RegExp): unknown {
    return redactValue(value, sensitive)
  }

  /**
   * Record one action execution (AC-3): input summary, status, result
   * summary and execution time, all redacted before the event is appended.
   * THIS is the SPEC §6.3 audit gate: the host records `running` BEFORE an
   * external-write action starts — a throw here must prevent the side
   * effect.
   * @param session - the session whose log receives the fact.
   * @param entry - the execution facts.
   * @returns the appended event.
   */
  recordActionExecution(
    session: Session,
    entry: Omit<ActionExecutedEvent, 'inputSummary' | 'resultSummary'> & {
      /** Structured input (summarized + redacted by the recorder). */
      input: unknown
      /** Structured result (summarized + redacted when present). */
      result?: unknown
    },
  ): import('@teoclub/harness-session').SessionEvent<'action/executed'> {
    const event: ActionExecutedEvent = {
      executionId: entry.executionId,
      action: entry.action,
      sessionId: entry.sessionId,
      inputSummary: summarize(entry.input),
      status: entry.status,
      ...(entry.result === undefined ? {} : { resultSummary: summarize(entry.result) }),
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
    }
    return session.append(ACTION_EXECUTED_EVENT_TYPE, event)
  }

  /**
   * Record one approval decision (AC-4): request summary, decision, decided
   * time and handler information, redacted before append.
   * @param session - the session whose log receives the fact.
   * @param entry - the decision facts.
   * @returns the appended event.
   */
  recordApprovalDecision(
    session: Session,
    entry: Omit<ApprovalAuditEvent, 'requestSummary'> & { request: unknown },
  ): import('@teoclub/harness-session').SessionEvent<'approval/audit'> {
    const event: ApprovalAuditEvent = {
      approvalId: entry.approvalId,
      actionName: entry.actionName,
      sessionId: entry.sessionId,
      requestSummary: summarize(entry.request),
      decision: entry.decision,
      decidedAt: entry.decidedAt,
      handledBy: entry.handledBy,
    }
    return session.append(APPROVAL_AUDIT_EVENT_TYPE, event)
  }

  /**
   * The UI projection for one session: one entry per logged fact, in seq
   * order (SPEC §3.7), each with its category and correlation id.
   * @param session - the session to project.
   * @returns the ordered audit entries.
   */
  project(session: Session): AuditEntry[] {
    return session.events.map((event) => {
      const rule = PROJECTION_RULES[event.type]
      const data = event.data as Record<string, unknown>
      if (rule === undefined) {
        return {
          sessionId: session.id,
          seq: event.seq,
          time: event.time,
          category: 'other',
          correlationId: '',
          summary: `event ${event.type}`,
          data,
        }
      }
      return {
        sessionId: session.id,
        seq: event.seq,
        time: event.time,
        category: rule.category,
        correlationId: rule.correlationId(data),
        summary: rule.summary(data),
        data,
      }
    })
  }

  /**
   * Project several sessions with the full SPEC §3.7 ordering: grouped by
   * session id, then by seq within each session.
   * @param sessions - the sessions to project.
   * @returns the ordered audit entries.
   */
  projectAll(sessions: readonly Session[]): AuditEntry[] {
    return sessions
      .flatMap((session) => this.project(session))
      .sort((left, right) => {
        const bySession = left.sessionId.localeCompare(right.sessionId)
        return bySession !== 0 ? bySession : left.seq - right.seq
      })
  }
}

declare module '@teoclub/cordis' {
  interface Context {
    /** The Audit service (Issue 024). */
    audit: AuditService
  }
}

export default AuditService
