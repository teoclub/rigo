/**
 * Rigo default agent-loop protocol (Issue 014; SPEC §5.1, §5.6, §5.8; PRD
 * US-007, FR-10/11/12).
 *
 * Pins the ported default loop's turn/step choreography as a verifiable
 * contract:
 *
 *   - {@link runTurn} drives one user input to quiescence through the public
 *     agent surface and summarizes the turn;
 *   - {@link turnSummary} projects the canonical per-turn facts (steps,
 *     assistant messages, tool calls/results, end reason) from the session
 *     event log — the projection UI/SDK read;
 *   - {@link assertTurnChoreography} validates the SPEC §5.1 event sequence
 *     (turn/start → step/start → user/message → assistant/chunk* →
 *     assistant/message → tool/call → tool/result → step/end → turn/end)
 *     and returns structured violations.
 *
 * The ported loop writes every Turn/Step/LLM/Tool event to the session log;
 * unknown tools produce a FAILED tool result (the next step can correct),
 * and a stream that ends mid tool-arguments creates no tool at all. The
 * upstream loop suites remain the behavioral ground truth (dual runtime).
 *
 * @module @teoclub/harness-loop-protocol
 */

import type { Context } from '@teoclub/cordis'
import type { Session, SessionEvent, SessionId } from '@teoclub/harness-session'
import type { PublicAgent } from '@teoclub/harness-agent-protocol'
import type { PreToolDecision } from '@teoclub/harness-tools'

/** One canonical step projection. */
export interface StepSummary {
  step: number
  /** Number of streamed assistant chunks. */
  chunks: number
  /** The final assembled assistant message text ('' when the step had none). */
  assistantText: string
  /** Tool calls made in this step, in order. */
  toolCalls: { callId: string; name: string; arguments: string }[]
  /** Tool results in this step, in order (aligned with calls by callId). */
  toolResults: { callId: string; isError: boolean }[]
}

/** One canonical turn projection. */
export interface TurnSummary {
  turn: number
  /** Steps executed inside the turn (0 for a rejected/empty turn). */
  steps: StepSummary[]
  /** User messages claimed into the turn. */
  userMessages: number
  /** The turn's end reason. */
  reason: unknown
  /** The turn's events, in seq order (the durable slice). */
  events: SessionEvent[]
}

/**
 * Project every completed turn from a session's event log.
 * @param session - the session whose log to project.
 * @returns one summary per turn, in order.
 */
export function turnSummary(session: Session): TurnSummary[] {
  const turns: TurnSummary[] = []
  let current: TurnSummary | undefined
  let step: StepSummary | undefined
  for (const event of session.events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, steps: [], userMessages: 0, reason: undefined, events: [] }
      turns.push(current)
    }
    if (current === undefined) continue
    current.events.push(event)
    if (event.type === 'step/start') {
      step = { step: event.data.step, chunks: 0, assistantText: '', toolCalls: [], toolResults: [] }
      current.steps.push(step)
    } else if (event.type === 'user/message') {
      current.userMessages += 1
    } else if (event.type === 'assistant/chunk' && step !== undefined) {
      step.chunks += 1
    } else if (event.type === 'assistant/message' && step !== undefined) {
      step.assistantText = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
    } else if (event.type === 'tool/call' && step !== undefined) {
      step.toolCalls.push({ callId: event.data.callId, name: event.data.name, arguments: event.data.arguments })
    } else if (event.type === 'tool/result' && step !== undefined) {
      const block = event.data.message.content[0]
      step.toolResults.push({ callId: block?.toolCallId ?? '', isError: block?.isError === true })
    } else if (event.type === 'step/end') {
      step = undefined
    } else if (event.type === 'turn/end') {
      current.reason = event.data.reason
      current = undefined
      step = undefined
    }
  }
  return turns
}

export interface TurnRunResult {
  /** The turn(s) opened by this input (normally exactly one). */
  turns: TurnSummary[]
  /** Choreography violations found in the turn(s). */
  violations: TurnChoreographyViolation[]
}

/**
 * Drive one user input to quiescence and summarize the resulting turn over a
 * specific session (its log is the durable source of truth).
 * @param agent - the public agent surface.
 * @param session - the session whose log to project.
 * @param text - the user message.
 * @returns the turn projection and any choreography violations.
 */
export async function runTurn(agent: PublicAgent, session: Session, text: string): Promise<TurnRunResult> {
  const before = session.events.filter((event) => event.type === 'turn/start').length
  agent.send(text)
  await agent.whenIdle()
  const turns = turnSummary(session)
  const opened = turns.slice(before)
  return { turns: opened, violations: assertTurnChoreography(session) }
}

export interface TurnChoreographyViolation {
  /** Stable violation code. */
  code:
    | 'TOOL_CALL_UNRESOLVED'
    | 'TOOL_RESULT_UNMATCHED'
    | 'CHUNK_OUTSIDE_STEP'
    | 'MESSAGE_OUTSIDE_STEP'
    | 'TOOL_EVENT_OUTSIDE_STEP'
    | 'STEP_END_BEFORE_TOOL_RESULT'
    | 'INVALID_TOOL_ARGUMENTS'
  /** Human-readable description naming the offending event seq. */
  message: string
  /** The first offending event seq. */
  seq: number
}

/**
 * Validate the SPEC §5.1 turn choreography over a session log: tool calls
 * resolve to results (same turn), results match a preceding call, streaming
 * chunks and assembled messages stay inside their step, tool events stay
 * inside a step, and a step ends only after its tool results.
 * @param session - the session whose log to validate.
 * @returns every violation found; empty means the choreography is canonical.
 */
export function assertTurnChoreography(session: Session): TurnChoreographyViolation[] {
  const violations: TurnChoreographyViolation[] = []
  let openTurn = false
  let openStep: number | undefined
  const unresolvedCalls = new Map<string, { name: string; seq: number }>()
  const seenResults = new Set<string>()

  const fail = (code: TurnChoreographyViolation['code'], message: string, seq: number): void => {
    violations.push({ code, message, seq })
  }

  for (const event of session.events) {
    switch (event.type) {
      case 'turn/start':
        openTurn = true
        openStep = undefined
        unresolvedCalls.clear()
        seenResults.clear()
        break
      case 'turn/end':
        openTurn = false
        openStep = undefined
        break
      case 'step/start':
        if (!openTurn) break
        openStep = event.data.step
        break
      case 'step/end':
        if (openStep !== undefined) {
          for (const [callId, call] of unresolvedCalls) {
            if (call.seq < event.seq) {
              fail('STEP_END_BEFORE_TOOL_RESULT', `tool call "${call.name}" (${callId}, seq ${call.seq}) has no result before step/end at seq ${event.seq}`, event.seq)
              break
            }
          }
        }
        openStep = undefined
        break
      case 'assistant/chunk':
        if (openStep === undefined) {
          fail('CHUNK_OUTSIDE_STEP', `assistant/chunk at seq ${event.seq} outside an open step`, event.seq)
        }
        break
      case 'assistant/message':
        if (openStep === undefined) {
          fail('MESSAGE_OUTSIDE_STEP', `assistant/message at seq ${event.seq} outside an open step`, event.seq)
        }
        break
      case 'tool/call':
        if (openStep === undefined) {
          fail('TOOL_EVENT_OUTSIDE_STEP', `tool/call at seq ${event.seq} outside an open step`, event.seq)
        } else {
          try {
            JSON.parse(event.data.arguments)
          } catch {
            fail('INVALID_TOOL_ARGUMENTS', `tool/call "${event.data.name}" at seq ${event.seq} carries unparseable arguments (torn stream?)`, event.seq)
          }
          unresolvedCalls.set(event.data.callId, { name: event.data.name, seq: event.seq })
        }
        break
      case 'tool/result': {
        if (openStep === undefined) {
          fail('TOOL_EVENT_OUTSIDE_STEP', `tool/result at seq ${event.seq} outside an open step`, event.seq)
          break
        }
        const callId = event.data.message.content[0]?.toolCallId ?? ''
        if (!unresolvedCalls.has(callId)) {
          fail('TOOL_RESULT_UNMATCHED', `tool/result at seq ${event.seq} has no preceding tool/call for "${callId}"`, event.seq)
        } else {
          unresolvedCalls.delete(callId)
          seenResults.add(callId)
        }
        break
      }
      default:
        break
    }
  }
  if (unresolvedCalls.size > 0) {
    const [callId, call] = [...unresolvedCalls.entries()][0]!
    fail('TOOL_CALL_UNRESOLVED', `tool call "${call.name}" (${callId}, seq ${call.seq}) never resolved`, call.seq)
  }
  return violations
}

/**
 * Install the Rigo torn-tool guard (Issue 014 AC: a stream that ends mid
 * tool-arguments must not create a Tool or Action). The ported loop records
 * the tool/call event (the durable fact); this guard denies the DISPATCH of
 * any call whose arguments never parsed as JSON (the torn-block signature),
 * so no tool executes and no Action is created. Opt-in: the upstream
 * pass-through of completed-but-malformed arguments remains available to
 * deployments that do not install it.
 * @param ctx - a context with the tool registry mounted.
 * @returns the disposer removing the guard.
 */
export function installTornToolGuard(ctx: Context): () => void {
  return ctx.on('tools/pre-execute', (exec, next) => {
    // A completed tool call carries parsed JSON arguments; a raw string means
    // the model's arguments were incomplete or unparseable — deny dispatch.
    if (typeof exec.arguments === 'string') {
      return Promise.resolve({ kind: 'deny', reason: 'torn or unparseable tool arguments' } satisfies PreToolDecision)
    }
    return next()
  })
}

/**
 * Send several messages rapidly (one wake) and wait for the whole queue to
 * drain. The loop processes them one turn at a time, in send order.
 * @param agent - the public agent surface.
 * @param session - the session whose log to project.
 * @param texts - the messages, in send order.
 * @returns one turn summary per processed turn.
 */
export async function sendSequential(
  agent: PublicAgent,
  session: Session,
  texts: readonly string[],
): Promise<TurnSummary[]> {
  const turns: TurnSummary[] = []
  for (const text of texts) {
    const before = session.events.filter((event) => event.type === 'turn/start').length
    agent.send(text)
    await agent.whenIdle()
    turns.push(...turnSummary(session).slice(before))
  }
  return turns
}

/**
 * Send every message immediately (a single wake with all of them queued),
 * then wait for the queue to drain.
 * @param agent - the public agent surface.
 * @param session - the session whose log to project.
 * @param texts - the messages, in send order.
 * @returns one turn summary per processed turn, in order.
 */
export async function runConcurrentTurn(
  agent: PublicAgent,
  session: Session,
  texts: readonly string[],
): Promise<TurnSummary[]> {
  const before = session.events.filter((event) => event.type === 'turn/start').length
  for (const text of texts) agent.send(text)
  await agent.whenIdle()
  return turnSummary(session).slice(before)
}

/**
 * The agent's inbox consistency projection: queued work and the live agent.
 */
export interface InboxState {
  /** Whether the agent still has queued or active work. */
  hasPending: boolean
  /** Whether the agent is live in the registry. */
  live: boolean
}

export type { SessionEvent, SessionId }
