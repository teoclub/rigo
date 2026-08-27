import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import { createUserMessage } from '@teoclub/harness-llm'
import SessionStore, { Session, SessionId } from '@teoclub/harness-session'
import * as SessionInvariant from '@teoclub/harness-session/invariant'
import InvariantRegistry, { InvariantError } from '@teoclub/harness-invariants'
import { defineContentToolFixture } from '@teoclub/harness-tools'
import { bootCore } from '@teoclub/harness-app-boot'
import {
  RIGO_EVENT_SCHEMA_VERSION,
  deriveModelHistory,
  encodeSessionLog,
  eventVocabularyCoverage,
  REQUIRED_EVENT_FAMILIES,
  stepId,
  turnId,
  validateSessionLog,
} from '@teoclub/harness-session-protocol'
import { MockAdapter, textResponse, toolCallResponse } from '../upstream/agent-loop/tests/mock-adapter.ts'

/**
 * Issue 006: Session Event protocol and model-history derivation (SPEC
 * §3.1, §5.1, §9.1; PRD US-004, FR-11/FR-12).
 */

describe('Rigo Session Event protocol (Issue 006)', () => {
  it('defines the stable event envelope: session id, monotonic seq, type, schema version, turn/step ids', () => {
    const sessionId = SessionId('session_proto_envelope')
    const session = Session.create(sessionId)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const log = encodeSessionLog(session)
    expect(log).toHaveLength(4)
    for (const event of log) {
      expect(event.sessionId).toBe(sessionId)
      expect(event.schemaVersion).toBe(RIGO_EVENT_SCHEMA_VERSION)
    }
    expect(log.map((event) => event.seq)).toEqual([0, 1, 2, 3])
    expect(log.map((event) => event.type)).toEqual(['turn/start', 'step/start', 'step/end', 'turn/end'])
    // Derived stable ids: turn events carry the turn id; step events carry
    // both, scoped by the session.
    expect(log[0]!.turn).toBe(turnId(sessionId, 1))
    expect(log[0]!.step).toBeUndefined()
    expect(log[1]!.turn).toBe(turnId(sessionId, 1))
    expect(log[1]!.step).toBe(stepId(sessionId, 1, 1))
    expect(RIGO_EVENT_SCHEMA_VERSION).toBe(1)
  })

  it('keeps the log append-only at the tail: events are frozen, seq stays contiguous, no overwrite', () => {
    const session = Session.create(SessionId('session_proto_append_only'))
    const first = session.append('turn/start', { turn: 1 })
    const snapshot = session.events
    expect(snapshot).toHaveLength(1)
    expect(Object.isFrozen(snapshot[0])).toBe(true)
    // The frozen snapshot cannot be mutated into a different fact.
    expect(() => {
      (snapshot[0] as { data: { turn: number } }).data.turn = 99
    }).toThrow()
    expect(first.data.turn).toBe(1)
    // Appends only ever extend the tail.
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(session.events.map((event) => event.seq)).toEqual([0, 1])
    expect(session.events[0]).toBe(snapshot[0])
  })

  it('writes user message, assistant chunk, assistant message, tool call and tool result to the stream', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'ping' }, 'calling echo'),
      textResponse('done'),
    ])
    const handle = await bootCore({ adapters: { mock: adapter } })
    try {
      handle.ctx.tools.register(defineContentToolFixture({
        name: 'echo',
        description: 'echo back',
        parameters: { text: { type: 'string' } },
        async execute(args) {
          return [{ type: 'text', text: `echo: ${args.text}` }]
        },
      }))
      const agent = handle.ctx.agentLoop.create(SessionId('session_proto_loop'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the tool' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // The full vocabulary of the turn landed in the event stream.
      const coverage = eventVocabularyCoverage(agent.session)
      expect(coverage.missing).toEqual([])
      for (const family of REQUIRED_EVENT_FAMILIES) {
        expect(coverage.present, family).toContain(family)
      }

      // Every event carries the protocol envelope.
      const envelope = encodeSessionLog(agent.session)
      expect(envelope.length).toBe(agent.session.events.length)
      const toolCall = envelope.find((event) => event.type === 'tool/call')
      expect(toolCall?.turn).toBe(turnId(agent.session.id, 1))
      expect(toolCall?.step).toBe(stepId(agent.session.id, 1, 1))
    } finally {
      await handle.dispose()
    }
  })

  it('derives the identical model history from the same event log, replay included', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'ping' }, 'calling echo'),
      textResponse('done'),
    ])
    const handle = await bootCore({ adapters: { mock: adapter } })
    try {
      handle.ctx.tools.register(defineContentToolFixture({
        name: 'echo',
        description: 'echo back',
        parameters: { text: { type: 'string' } },
        async execute(args) {
          return [{ type: 'text', text: `echo: ${args.text}` }]
        },
      }))
      const agent = handle.ctx.agentLoop.create(SessionId('session_proto_history'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'use the tool' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const first = deriveModelHistory(agent.session)
      const second = deriveModelHistory(agent.session)
      expect(second).toEqual(first)
      // Replaying the identical event log derives the identical history.
      const replay = Session.create(agent.session.id, agent.session.events)
      expect(deriveModelHistory(replay)).toEqual(first)
      // The tool turn derives the full four-message shape.
      expect(first.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    } finally {
      await handle.dispose()
    }
  })

  it('rejects illegal event orders structurally and at append time', async () => {
    // (a) The protocol validator flags bracket violations on any log.
    const unopened = Session.create(SessionId('session_proto_bad_turn_end'), [
      { type: 'turn/end', seq: 0, time: 1, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    expect(validateSessionLog(unopened).map((violation) => violation.code)).toEqual(['TURN_UNCLOSED'])

    const stepOutside = Session.create(SessionId('session_proto_bad_step'), [
      { type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } },
    ])
    expect(validateSessionLog(stepOutside).map((violation) => violation.code)).toEqual(['STEP_OUTSIDE_TURN'])

    const danglingTurn = Session.create(SessionId('session_proto_dangling'), [
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    ])
    expect(validateSessionLog(danglingTurn).map((violation) => violation.code)).toEqual(['TURN_UNCLOSED'])

    // (b) The ported invariant companion rejects at append time.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SessionInvariant)
    try {
      const session = ctx.sessions.create(SessionId('session_proto_invariant'))
      expect(() => {
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      }).toThrow(InvariantError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('releases the session and its event stream with the owning tree', async () => {
    const handle = await bootCore()
    const session = handle.ctx.sessions.create(SessionId('session_proto_release'))
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(encodeSessionLog(session)).toHaveLength(2)
    await handle.dispose()
    // The store is gone with the tree; the detached events stay readable.
    expect(session.events).toHaveLength(2)
    expect(handle.ctx.get('sessions')).toBeUndefined()
  })
})
