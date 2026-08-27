import { describe, expect, it, vi } from 'vitest'
import { bootCore } from '@teoclub/harness-app-boot'
import { SessionId } from '@teoclub/harness-session'
import { createAgent } from '@teoclub/harness-agent-protocol'
import { assertTurnChoreography, installTornToolGuard, runTurn, turnSummary } from '@teoclub/harness-loop-protocol'
import { MockAdapter, textResponse, toolCallResponse } from '../upstream/agent-loop/tests/mock-adapter.ts'
import type { StreamChunk } from '@teoclub/harness-llm'

/**
 * Issue 014: default Agent Turn/Step multi-step loop (SPEC §5.1, §5.6, §5.8;
 * PRD US-007, FR-10/11/12): no-tool turns complete turn/start → step →
 * turn/end; tool-calling turns run multiple steps; every turn/step/LLM/tool
 * event lands in the log; streamed chunks assemble into the final assistant
 * message; unknown tools produce a failed result the next step can correct;
 * a stream torn mid tool-arguments creates no tool.
 */

function sessionFor(handle: Awaited<ReturnType<typeof bootCore>>, id: string) {
  return handle.ctx.agents.get(SessionId(id))!.session
}

describe('Rigo default agent-loop protocol (Issue 014)', () => {
  it('completes a no-tool turn with turn/start, one step and turn/end', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([textResponse('hello there')]) } })
    try {
      const id = SessionId('session_loop_basic')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_loop_basic')
      const result = await runTurn(created.agent, session, 'hi')
      // The canonical choreography appears in order (the log also carries
      // loop bookkeeping events like inbox splices and request headers).
      const canonical = session.events.filter((event) => [
        'turn/start', 'step/start', 'user/message', 'assistant/chunk',
        'assistant/message', 'step/end', 'turn/end',
      ].includes(event.type)).map((event) => event.type)
      // Consecutive chunk runs collapse (one per streamed chunk).
      const collapsed = canonical.filter((type, index) => type !== canonical[index - 1])
      expect(collapsed).toEqual([
        'turn/start',
        'step/start',
        'user/message',
        'assistant/chunk',
        'assistant/message',
        'step/end',
        'turn/end',
      ])
      expect(result.turns).toHaveLength(1)
      expect(result.turns[0]!.steps).toHaveLength(1)
      expect(result.turns[0]!.reason).toEqual({ kind: 'completed' })
      expect(result.violations).toEqual([])
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('runs a multi-step turn: tool call → result → follow-up model request', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'ping' }, 'calling'),
      textResponse('done'),
    ]) } })
    try {
      handle.ctx.tools.register({
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: (args) => ({ echoed: (args as { text: string }).text }),
      })
      const id = SessionId('session_loop_multistep')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_loop_multistep')
      const result = await runTurn(created.agent, session, 'use the tool')

      // Two steps in one turn: the tool step and the follow-up model step.
      expect(result.turns).toHaveLength(1)
      const steps = result.turns[0]!.steps
      expect(steps.map((step) => step.step)).toEqual([1, 2])
      expect(steps[0]!.toolCalls).toEqual([{ callId: 'c1', name: 'echo', arguments: JSON.stringify({ text: 'ping' }) }])
      expect(steps[0]!.toolResults).toEqual([{ callId: 'c1', isError: false }])
      expect(steps[1]!.assistantText).toBe('done')
      expect(result.violations).toEqual([])

      // Canonical event families all present (SPEC §5.1).
      const types = new Set(session.events.map((event) => event.type))
      for (const family of ['turn/start', 'step/start', 'user/message', 'assistant/chunk', 'assistant/message', 'tool/call', 'tool/result', 'step/end', 'turn/end']) {
        expect(types.has(family), family).toBe(true)
      }
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('assembles streamed chunks into the final assistant message', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([textResponse('streamed answer')]) } })
    try {
      const id = SessionId('session_loop_chunks')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_loop_chunks')
      const result = await runTurn(created.agent, session, 'stream')
      const step = result.turns[0]!.steps[0]!
      // The streamed text deltas (one per character) assemble into the final
      // assistant message; block boundaries and usage are chunk events too.
      const chunks = session.events.filter((event) => event.type === 'assistant/chunk')
      const deltaText = chunks.map((event) => (event.type === 'assistant/chunk' ? event.data.chunk : ''))
        .filter((chunk): chunk is { type: 'text-delta'; text: string } => chunk.type === 'text-delta')
        .map((chunk) => chunk.text)
        .join('')
      expect(deltaText).toBe('streamed answer')
      expect(step.assistantText).toBe('streamed answer')
      expect(step.chunks).toBe(chunks.length)
      expect(result.violations).toEqual([])
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('turns an unknown tool into a failed tool result the next step can correct', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([
      toolCallResponse('c1', 'no-such-tool', { x: 1 }, ''),
      textResponse('that tool does not exist'),
    ]) } })
    try {
      const id = SessionId('session_loop_unknown_tool')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_loop_unknown_tool')
      const result = await runTurn(created.agent, session, 'call the tool')

      const steps = result.turns[0]!.steps
      expect(steps).toHaveLength(2)
      expect(steps[0]!.toolCalls).toEqual([{ callId: 'c1', name: 'no-such-tool', arguments: JSON.stringify({ x: 1 }) }])
      expect(steps[0]!.toolResults).toEqual([{ callId: 'c1', isError: true }])
      // The follow-up step ran and corrected.
      expect(steps[1]!.assistantText).toBe('that tool does not exist')
      expect(result.violations).toEqual([])
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('creates no Action when the stream tears mid tool-arguments (torn-tool guard)', async () => {
    const torn: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'echo', argumentsDelta: '{"text": "par' },
      // The stream ends (finish) before the tool-call block completed.
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const handle = await bootCore({ adapters: { mock: new MockAdapter([torn]) } })
    try {
      const executed = vi.fn()
      handle.ctx.tools.register({
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: (args) => { executed(args); return { echoed: true } },
      })
      const removeGuard = installTornToolGuard(handle.ctx)
      const id = SessionId('session_loop_torn')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_loop_torn')
      const result = await runTurn(created.agent, session, 'torn stream')

      // The durable log records the attempted call (loop fact), but the torn
      // guard DENIED dispatch: the tool never executed and no Action ran.
      expect(session.events.filter((event) => event.type === 'tool/call')).toHaveLength(1)
      const results = session.events.filter((event) => event.type === 'tool/result')
      expect(results).toHaveLength(1)
      const block = results[0]!.type === 'tool/result' ? results[0]!.data.message.content[0] : undefined
      expect(block?.isError).toBe(true)
      expect(executed).not.toHaveBeenCalled()
      // The choreography validator flags the torn arguments explicitly.
      expect(result.violations.map((violation) => violation.code)).toContain('INVALID_TOOL_ARGUMENTS')
      removeGuard()
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('moves the agent state machine idle → running → idle per turn', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([textResponse('ok')]) } })
    try {
      const id = SessionId('session_loop_state')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const statuses: string[] = []
      handle.ctx.on('agent/status', ({ agent, status }) => {
        if (agent.id === id) statuses.push(status)
      })
      const session = sessionFor(handle, 'session_loop_state')
      await runTurn(created.agent, session, 'go')
      expect(statuses).toEqual(['running', 'idle'])
      expect(turnSummary(session)[0]!.reason).toEqual({ kind: 'completed' })
      // A second turn repeats the same state machine.
      await runTurn(created.agent, session, 'again')
      expect(statuses).toEqual(['running', 'idle', 'running', 'idle'])
      expect(turnSummary(session)).toHaveLength(2)
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('flags a choreography violation (tool result without a preceding call)', () => {
    const session = {
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
        {
          type: 'tool/result',
          seq: 2,
          time: 3,
          data: {
            turn: 1,
            step: 1,
            callId: 'c9',
            message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c9', content: [], isError: true }], source: { kind: 'tool' } },
          },
        },
        { type: 'step/end', seq: 3, time: 4, data: { turn: 1, step: 1 } },
        { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
    } as never
    const violations = assertTurnChoreography(session as never)
    expect(violations.map((violation) => violation.code)).toEqual(['TOOL_RESULT_UNMATCHED'])
  })
})
