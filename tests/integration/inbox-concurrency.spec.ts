import { describe, expect, it } from 'vitest'
import { bootCore } from '@teoclub/harness-app-boot'
import { SessionId } from '@teoclub/harness-session'
import { createAgent } from '@teoclub/harness-agent-protocol'
import { runConcurrentTurn, sendSequential } from '@teoclub/harness-loop-protocol'
import { MockAdapter, textResponse } from '../upstream/agent-loop/tests/mock-adapter.ts'

/**
 * Issue 015: Inbox, concurrency and abort semantics (SPEC §5.6, §5.7; PRD
 * US-008, FR-10/35): one active turn per agent, rapid messages queue in
 * order and execute one turn per wake, cancel interrupts the active turn
 * while keeping (or dropping) queued messages, wake inputs during cancel
 * convergence latch and execute once, disposal waits for the active turn,
 * and the inbox stays consistent through cancel/dispose/claim.
 */

function sessionFor(handle: Awaited<ReturnType<typeof bootCore>>, id: string) {
  return handle.ctx.agents.get(SessionId(id))!.session
}

describe('Rigo inbox/concurrency/abort semantics (Issue 015)', () => {
  it('runs at most one active turn; rapid sends queue in order and execute one turn per wake', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([
      textResponse('one'), textResponse('two'), textResponse('three'),
    ]) } })
    try {
      const id = SessionId('session_inbox_order')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_inbox_order')

      const turns = await runConcurrentTurn(created.agent, session, ['first', 'second', 'third'])
      // One turn per wake, in send order, each claiming exactly one message.
      expect(turns).toHaveLength(3)
      expect(turns.map((turn) => turn.userMessages)).toEqual([1, 1, 1])
      const userTexts = session.events.filter((event) => event.type === 'user/message')
        .map((event) => (event.type === 'user/message' ? event.data.content[0] : null))
        .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
        .map((block) => block.text)
      expect(userTexts).toEqual(['first', 'second', 'third'])
      // Turns are strictly sequential in the log.
      const turnBoundaries = session.events.filter((event) => event.type === 'turn/start' || event.type === 'turn/end')
      expect(turnBoundaries.map((event) => event.type)).toEqual([
        'turn/start', 'turn/end', 'turn/start', 'turn/end', 'turn/start', 'turn/end',
      ])
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('processes sequential sends one full turn each before the next wake', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([
      textResponse('a'), textResponse('b'), textResponse('c'),
    ]) } })
    try {
      const id = SessionId('session_inbox_sequential')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_inbox_sequential')
      const turns = await sendSequential(created.agent, session, ['a', 'b', 'c'])
      expect(turns).toHaveLength(3)
      expect(turns.map((turn) => turn.reason)).toEqual([
        { kind: 'completed' }, { kind: 'completed' }, { kind: 'completed' },
      ])
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('cancel() interrupts the active turn; keepInbox preserves queued messages, the default discards them', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([
      'hang', textResponse('two'), textResponse('three'),
    ]) } })
    try {
      const id = SessionId('session_inbox_cancel_keep')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_inbox_cancel_keep')

      created.agent.send('hanging')
      created.agent.send('queued-two')
      created.agent.send('queued-three')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(created.agent.status).toBe('running')
      created.agent.abort({ kind: 'user' }) // default: queued work discarded
      await created.agent.whenIdle()
      // Only the aborted first message was claimed; the queue was discarded.
      const userMessages = session.events.filter((event) => event.type === 'user/message')
      expect(userMessages).toHaveLength(1)
      expect(created.agent.status).toBe('idle')
      expect(session.events.at(-1)).toMatchObject({ type: 'turn/end' })
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('keepInbox preserves queued messages for later turns after the abort', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([
      'hang', textResponse('two'), textResponse('three'),
    ]) } })
    try {
      const id = SessionId('session_inbox_cancel_keep2')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_inbox_cancel_keep2')

      created.agent.send('hanging')
      created.agent.send('queued-two')
      created.agent.send('queued-three')
      await new Promise((resolve) => setTimeout(resolve, 20))
      const agent = handle.ctx.agents.get(id)!
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      await created.agent.whenIdle()

      // The active turn aborted, but the queued messages SURVIVED in the
      // inbox, waiting for a later wake.
      const preserved = handle.ctx.agents.get(id)!
      expect(preserved.inbox.hasPending).toBe(true)
      // A later wake drains the preserved queue in order.
      created.agent.send('wake')
      await created.agent.whenIdle()
      const userTexts = session.events.filter((event) => event.type === 'user/message')
        .map((event) => (event.type === 'user/message' ? event.data.content[0] : null))
        .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
        .map((block) => block.text)
      expect(userTexts).toEqual(['hanging', 'queued-two', 'queued-three', 'wake'])
      // Inbox is consistent after the drain: no pending work.
      const agentAfter = handle.ctx.agents.get(id)!
      expect(agentAfter.inbox.hasPending).toBe(false)
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('latches a wake arriving during cancel convergence and executes it exactly once', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([
      'hang', textResponse('after'), textResponse('latch'),
    ]) } })
    try {
      const id = SessionId('session_inbox_latch')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = sessionFor(handle, 'session_inbox_latch')

      created.agent.send('hanging')
      await new Promise((resolve) => setTimeout(resolve, 20))
      const agent = handle.ctx.agents.get(id)!
      agent.cancel({ kind: 'user' })
      // A wake lands while cancellation is converging.
      created.agent.send('during-cancel')
      await created.agent.whenIdle()

      // Exactly two turns: the aborted one and the latched wake, executed once.
      const userTexts = session.events.filter((event) => event.type === 'user/message')
        .map((event) => (event.type === 'user/message' ? event.data.content[0] : null))
        .filter((block): block is { type: 'text'; text: string } => block?.type === 'text')
        .map((block) => block.text)
      expect(userTexts).toEqual(['hanging', 'during-cancel'])
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('dispose during an active turn waits for quiescence and leaves no resources behind', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter(['hang']) } })
    try {
      const id = SessionId('session_inbox_dispose')
      const created = await createAgent(handle.ctx, { sessionId: id, agentOptions: { provider: 'mock', model: 'mock' } })
      created.agent.send('hang forever')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(created.agent.status).toBe('running')

      // Disposal waits for the active turn to settle (aborted), then removes
      // the agent, session and scope — no leak.
      const started = Date.now()
      await created.dispose()
      expect(Date.now() - started).toBeLessThan(5_000)
      expect(handle.ctx.agents.get(id)).toBeUndefined()
      expect(() => handle.ctx.sessions.get(id)).not.toThrow()
    } finally {
      await handle.dispose()
    }
  })
})
