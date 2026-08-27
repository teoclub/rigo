/**
 * Rigo Session Event Protocol (Issue 006; SPEC §3.1, §5.1, §9.1; PRD
 * US-004, FR-11/FR-12).
 *
 * The stable, domain-agnostic face over the ported session log:
 *
 *   - every event carries the session id, a monotonic per-session sequence
 *     number, the canonical event type, a per-event payload Schema Version
 *     (forward migration), and derived stable Turn/Step ids;
 *   - the log is append-only at the tail (the ported Session enforces this);
 *   - model history is derived deterministically from the same event log
 *     (`deriveModelHistory` is THE history contract);
 *   - illegal event orders are rejected structurally by
 *     `validateSessionLog` (the ported invariant companion enforces them at
 *     append time); the five event families every turn writes — user
 *     message, assistant chunk, assistant message, tool call, tool result —
 *     are verified by `eventVocabularyCoverage`.
 *
 * Turn/Step ids are DETERMINISTIC derivations from the durable event facts
 * (`turn:<sessionId>:<n>` / `step:<sessionId>:<turn>:<step>`), so they are
 * replay-stable without persisting extra state; SPEC §3.1's `turn_<uuid>`
 * convention applies to created entities, and the derived ids keep the same
 * prefixed-string shape for correlation across UI, audit and SDK.
 *
 * @module @teoclub/harness-session-protocol
 */

import type { Message } from '@teoclub/harness-llm'
import type {
  Session,
  SessionEvent,
  SessionEventType,
  SessionId,
} from '@teoclub/harness-session'

/** Per-event payload schema version stamped by the Rigo protocol. */
export const RIGO_EVENT_SCHEMA_VERSION = 1

/** Stable turn identity derived from the event log: `turn:<sessionId>:<n>`. */
export type TurnId = string & { readonly __turnId: unique symbol }

/** Stable step identity derived from the event log: `step:<sessionId>:<turn>:<step>`. */
export type StepId = string & { readonly __stepId: unique symbol }

/** Derive the stable turn id for turn `n` of `sessionId`. */
export function turnId(sessionId: SessionId, turn: number): TurnId {
  return `${sessionId}:turn:${turn}` as TurnId
}

/** Derive the stable step id for step `step` of turn `turn` of `sessionId`. */
export function stepId(sessionId: SessionId, turn: number, step: number): StepId {
  return `${sessionId}:step:${turn}:${step}` as StepId
}

/**
 * The stable Rigo event envelope: session identity, monotonic seq, canonical
 * type, per-event Schema Version, derived turn/step ids and the payload.
 */
export interface RigoSessionEvent<T extends SessionEventType = SessionEventType> {
  /** Stable session identity. */
  sessionId: SessionId
  /** Monotonic, zero-based contiguous sequence number within the session. */
  seq: number
  /** Canonical event type (the Rigo vocabulary). */
  type: T
  /** Per-event payload schema version (forward migration). */
  schemaVersion: number
  /** Derived stable turn id, present when the event belongs to a turn. */
  turn?: TurnId
  /** Derived stable step id, present when the event belongs to a step. */
  step?: StepId
  /** Unix epoch milliseconds. */
  time: number
  /** The event payload. */
  data: SessionEvent<T>['data']
}

interface TurnScoped {
  turn?: number
  step?: number
}

/**
 * Stamp one event with the protocol envelope, deriving turn/step ids from
 * the event's own payload when present, or from the enclosing turn/step the
 * log cursor is inside.
 * @param session - the owning session (its id brands the derived ids).
 * @param event - a frozen event from the session log.
 * @returns the protocol envelope.
 */
export function encodeSessionEvent(session: Session, event: SessionEvent): RigoSessionEvent {
  const scoped = event.data as TurnScoped
  const turn = scoped.turn
  const step = scoped.step
  return {
    sessionId: session.id,
    seq: event.seq,
    type: event.type,
    schemaVersion: RIGO_EVENT_SCHEMA_VERSION,
    ...(turn === undefined ? {} : { turn: turnId(session.id, turn) }),
    ...(turn === undefined || step === undefined ? {} : { step: stepId(session.id, turn, step) }),
    time: event.time,
    data: event.data,
  }
}

/**
 * Encode the whole log. For events without an explicit turn/step payload
 * (e.g. `user/message`), the enclosing turn/step ids from the surrounding
 * boundary events are stamped, so the encoding is deterministic across
 * replays of the same log.
 * @param session - the owning session.
 * @returns the complete protocol envelope list, in seq order.
 */
export function encodeSessionLog(session: Session): RigoSessionEvent[] {
  let openTurn: number | undefined
  let openStep: number | undefined
  return session.events.map((event) => {
    const scoped = event.data as TurnScoped
    if (event.type === 'turn/start') openTurn = scoped.turn
    else if (event.type === 'step/start') openStep = scoped.step
    else if (event.type === 'step/end') openStep = undefined
    else if (event.type === 'turn/end') {
      openTurn = undefined
      openStep = undefined
    }
    const turn = scoped.turn ?? openTurn
    const step = scoped.step ?? openStep
    return {
      sessionId: session.id,
      seq: event.seq,
      type: event.type,
      schemaVersion: RIGO_EVENT_SCHEMA_VERSION,
      ...(turn === undefined ? {} : { turn: turnId(session.id, turn) }),
      ...(turn === undefined || step === undefined ? {} : { step: stepId(session.id, turn, step) }),
      time: event.time,
      data: event.data,
    }
  })
}

/**
 * THE model-history contract: the deterministic derivation of the model
 * message history from the session event log. The same log always derives
 * the identical history (append-only tail + frozen events).
 * @param session - the session whose log to derive from.
 * @returns the ordered model message list.
 */
export function deriveModelHistory(session: Session): Message[] {
  return session.deriveMessages()
}

/** The five event families every turn must write to the log. */
export const REQUIRED_EVENT_FAMILIES = [
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
] as const

export interface EventVocabularyCoverage {
  /** Families present in the log. */
  present: SessionEventType[]
  /** Families absent from the log (legitimate for tool-less turns). */
  missing: SessionEventType[]
}

/**
 * Which of the five required event families the log actually contains.
 * @param session - the session to scan.
 * @returns the present/missing family split.
 */
export function eventVocabularyCoverage(session: Session): EventVocabularyCoverage {
  const present = new Set<SessionEventType>(session.events.map((event) => event.type))
  const missing: SessionEventType[] = []
  for (const family of REQUIRED_EVENT_FAMILIES) {
    if (!present.has(family)) missing.push(family)
  }
  return { present: [...present], missing }
}

export interface SessionLogViolation {
  /** Stable violation code. */
  code: 'SEQ_GAP' | 'SEQ_NON_MONOTONIC' | 'TURN_UNCLOSED' | 'STEP_OUTSIDE_TURN' | 'STEP_UNCLOSED'
  /** Human-readable description naming the offending seq. */
  message: string
  /** The first offending seq (or the boundary seq). */
  seq: number
}

/**
 * Structured invariant check over a session log (Issue 006 AC: illegal event
 * orders are rejected). Checks, in order:
 *   - sequence numbers are zero-based contiguous (no gaps, no repeats);
 *   - every step sits inside an open turn;
 *   - every opened turn is closed, and every opened step is closed.
 * The ported invariant companion enforces the full append-time state machine
 * (and rejects at append time); this validator gives the protocol a pure,
 * replay-independent projection of the same structural rules.
 * @param session - the session whose log to validate.
 * @returns every violation found; empty means the log is structurally valid.
 */
export function validateSessionLog(session: Session): SessionLogViolation[] {
  const violations: SessionLogViolation[] = []
  const events = session.events
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!
    if (event.seq !== index) {
      violations.push({
        code: event.seq < index ? 'SEQ_NON_MONOTONIC' : 'SEQ_GAP',
        message: `event "${event.type}" at log position ${index} carries seq ${event.seq} (expected ${index})`,
        seq: event.seq,
      })
      return violations
    }
  }
  let openTurn: number | undefined
  let openStep: number | undefined
  for (const event of events) {
    const scoped = event.data as TurnScoped
    if (event.type === 'turn/start') {
      openTurn = scoped.turn
      openStep = undefined
    } else if (event.type === 'step/start') {
      if (openTurn === undefined) {
        violations.push({
          code: 'STEP_OUTSIDE_TURN',
          message: `step/start for turn ${scoped.turn} outside an open turn (seq ${event.seq})`,
          seq: event.seq,
        })
        return violations
      }
      openStep = scoped.step
    } else if (event.type === 'step/end') {
      if (openStep === undefined) {
        violations.push({
          code: 'STEP_UNCLOSED',
          message: `step/end without an open step (seq ${event.seq})`,
          seq: event.seq,
        })
        return violations
      }
      openStep = undefined
    } else if (event.type === 'turn/end') {
      if (openTurn === undefined) {
        violations.push({
          code: 'TURN_UNCLOSED',
          message: `turn/end without an open turn (seq ${event.seq})`,
          seq: event.seq,
        })
        return violations
      }
      openTurn = undefined
      openStep = undefined
    }
  }
  if (openTurn !== undefined) {
    violations.push({
      code: 'TURN_UNCLOSED',
      message: `turn ${openTurn} is still open at the end of the log`,
      seq: events.length > 0 ? events[events.length - 1]!.seq : 0,
    })
  } else if (openStep !== undefined) {
    violations.push({
      code: 'STEP_UNCLOSED',
      message: `step ${openStep} is still open at the end of the log`,
      seq: events.length > 0 ? events[events.length - 1]!.seq : 0,
    })
  }
  return violations
}
