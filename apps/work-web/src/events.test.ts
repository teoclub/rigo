/**
 * Rigo Work Web event derivation tests (Issue 033): the SSE stream folds
 * into the UI state — incremental output, phases, sources, empty retrieval.
 */
import { describe, expect, it } from 'vitest'
import type { SseFrame } from './api.ts'
import { actionStateLabel, attemptText, foldEvent, initialViewModel, phaseLabel, sourcesFromRetrieval } from './events.ts'

function frame(event: string, data: Record<string, unknown>): SseFrame {
  return { id: 0, event, data }
}

describe('work web event derivation (Issue 033)', () => {
  it('renders the latest assistant attempt snapshot, never a raw provider stream', () => {
    const attempt = (seq: number, stream: unknown[]): SseFrame => frame('session.event', {
      seq,
      type: 'assistant/attempt',
      payload: { turn: 1, step: 1, stream },
    })
    const textRun = (texts: string[]): Record<string, unknown> => ({ type: 'text-chunks', time0: 0, index: 0, dt: [], texts })

    let view = initialViewModel()
    view = foldEvent(view, frame('session.event', { seq: 0, type: 'turn/start', payload: { turn: 1 } }))
    expect(view.agentStatus).toBe('running')
    expect(view.phase).toBe('context')

    view = foldEvent(view, attempt(1, [textRun(['Hello'])]))
    expect(view.assistantText).toBe('Hello')
    expect(view.phase).toBe('llm')

    // Each attempt event carries the WHOLE attempt so far, so a later one
    // replaces the rendered text; appending would duplicate what is shown.
    view = foldEvent(view, attempt(2, [textRun(['Hello', ' world'])]))
    expect(view.assistantText).toBe('Hello world')

    view = foldEvent(view, attempt(3, [
      textRun(['Hello', ' world']),
      { type: 'reasoning-chunks', time0: 0, index: 1, dt: [], texts: ['thinking…'] },
    ]))
    expect(view.reasoningText).toBe('thinking…')
    expect(view.assistantText).toBe('Hello world')

    // A tool-call run carries no text: the rendered answer is left as it was.
    view = foldEvent(view, attempt(4, [
      textRun(['Hello', ' world']),
      { type: 'tool-call-chunks', time0: 0, index: 1, dt: [], id: 'c1', args: ['{}'] },
    ]))
    expect(view.assistantText).toBe('Hello world')

    view = foldEvent(view, frame('session.event', { seq: 5, type: 'turn/end', payload: { turn: 1, reason: { kind: 'completed' } } }))
    expect(view.agentStatus).toBe('idle')
    expect(view.lastSeq).toBe(5)
  })

  it('derives the detailed phases and approval/action progress', () => {
    let view = initialViewModel()
    view = foldEvent(view, frame('session.event', { seq: 0, type: 'context/contributed', payload: {} }))
    expect(view.phase).toBe('context')
    view = foldEvent(view, frame('session.event', {
      seq: 1,
      type: 'knowledge/retrieved',
      payload: { querySummary: 'rockets', status: 'found', sourceIds: ['sqlite-fts#docs/rockets.md#0'], topK: 8 },
    }))
    expect(view.phase).toBe('retrieval')
    expect(view.sources).toHaveLength(1)
    expect(view.sources[0]).toEqual({ refId: 's1', provider: 'sqlite-fts', documentId: 'docs/rockets.md', chunk: 0 })
    expect(view.retrievalEmpty).toBe(false)
    view = foldEvent(view, frame('session.event', {
      seq: 2,
      type: 'knowledge/retrieved',
      payload: { querySummary: 'zzz', status: 'empty', sourceIds: [], topK: 8 },
    }))
    expect(view.retrievalEmpty).toBe(true)
    view = foldEvent(view, frame('session.event', {
      seq: 3,
      type: 'approval/requested',
      payload: { approvalId: 'approval_1', sessionId: 's', actionName: 'document.write', actionExecutionId: 'action_1', expiresAt: 'x' },
    }))
    expect(view.phase).toBe('approval')
    expect(view.pendingApprovals).toBe(1)
    view = foldEvent(view, frame('session.event', {
      seq: 4,
      type: 'action/executed',
      payload: { executionId: 'action_1', action: 'document.write', sessionId: 's', inputSummary: '{}', status: 'running' },
    }))
    expect(view.phase).toBe('action')
    expect(view.actions.at(-1)).toMatchObject({ executionId: 'action_1', status: 'running' })
    view = foldEvent(view, frame('session.event', {
      seq: 5,
      type: 'approval/resolved',
      payload: { approvalId: 'approval_1', sessionId: 's', outcome: 'approved' },
    }))
    expect(view.pendingApprovals).toBe(0)
  })

  it('parses source ids and exposes text phase labels', () => {
    expect(sourcesFromRetrieval({ sourceIds: ['a#b/c.md#2', 'p#d.md'] })).toEqual([
      { refId: 's1', provider: 'a', documentId: 'b/c.md', chunk: 2 },
      { refId: 's2', provider: 'p', documentId: 'd.md', chunk: undefined },
    ])
    expect(phaseLabel('idle')).toBe('Idle')
    expect(phaseLabel('approval')).toBe('Waiting for approval')
    expect(phaseLabel('llm')).toBe('Generating response')
  })

  it('tracks action states and result summaries (Issue 034 AC-5/6)', () => {
    let view = initialViewModel()
    view = foldEvent(view, frame('session.event', {
      seq: 0,
      type: 'action/executed',
      payload: { executionId: 'action_1', action: 'document.write', sessionId: 's', inputSummary: '{}', status: 'requires-approval' },
    }))
    expect(view.phase).toBe('action')
    expect(view.actions.at(-1)).toMatchObject({ executionId: 'action_1', status: 'requires-approval' })
    view = foldEvent(view, frame('session.event', {
      seq: 1,
      type: 'action/executed',
      payload: { executionId: 'action_1', action: 'document.write', sessionId: 's', inputSummary: '{}', status: 'running' },
    }))
    view = foldEvent(view, frame('session.event', {
      seq: 2,
      type: 'action/executed',
      payload: {
        executionId: 'action_1', action: 'document.write', sessionId: 's', inputSummary: '{}',
        status: 'succeeded', resultSummary: '{"version":2,"contentHash":"abc"}', durationMs: 42,
      },
    }))
    expect(view.actions).toHaveLength(3)
    expect(view.actions.at(-1)).toMatchObject({ status: 'succeeded', durationMs: 42 })
    expect(view.actions.at(-1)!.resultSummary).toContain('"version":2')
    expect(actionStateLabel('awaiting-approval')).toBe('Waiting for approval')
    expect(actionStateLabel('recovery-required')).toBe('Recovery required')
    expect(actionStateLabel('succeeded')).toBe('Succeeded')
    expect(actionStateLabel('mystery')).toBe('mystery')
  })

  it('renders a completed assistant message even when the turn never streamed', () => {
    let view = initialViewModel()
    view = foldEvent(view, frame('session.event', { seq: 0, type: 'turn/start', payload: { turn: 1 } }))
    // A one-shot provider answer: no assistant/attempt, no deltas — the text
    // exists only on the message event's content blocks.
    view = foldEvent(view, frame('session.event', {
      seq: 1,
      type: 'assistant/message',
      payload: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'rockets use fuel' }] },
      },
    }))
    expect(view.assistantText).toBe('rockets use fuel')
    expect(view.phase).toBe('llm')

    // A message with no text block leaves the rendered answer untouched.
    view = foldEvent(view, frame('session.event', {
      seq: 2,
      type: 'assistant/message',
      payload: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call' }] } },
    }))
    expect(view.assistantText).toBe('rockets use fuel')
  })

  it('surfaces a failed turn instead of leaving an empty answer', () => {
    let view = initialViewModel()
    view = foldEvent(view, frame('session.event', { seq: 0, type: 'turn/start', payload: { turn: 1 } }))
    // A provider that never started reports the failure inside the attempt's
    // finish chunk (reason.failure), before turn/end arrives.
    view = foldEvent(view, frame('session.event', {
      seq: 1,
      type: 'assistant/attempt',
      payload: {
        turn: 1,
        step: 1,
        stream: [{
          type: 'chunk',
          time: 1,
          chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'no adapter', code: 'NO_ADAPTER' } } },
        }],
      },
    }))
    expect(view.turnError).toEqual({ message: 'no adapter', code: 'NO_ADAPTER' })
    expect(view.assistantText).toBe('')

    // turn/end carries the same facts under `reason.error`.
    view = foldEvent(view, frame('session.event', {
      seq: 2,
      type: 'turn/end',
      payload: { turn: 1, reason: { kind: 'error', error: { message: 'budget exhausted', code: 'LIMIT' } } },
    }))
    expect(view.turnError).toEqual({ message: 'budget exhausted', code: 'LIMIT' })

    // A clean turn leaves no failure behind.
    view = foldEvent(view, frame('session.event', { seq: 3, type: 'turn/start', payload: { turn: 2 } }))
    expect(view.turnError).toBeUndefined()
    view = foldEvent(view, frame('session.event', {
      seq: 4,
      type: 'turn/end',
      payload: { turn: 2, reason: { kind: 'completed' } },
    }))
    expect(view.turnError).toBeUndefined()
  })

  it('extracts text from an attempt stream only when present', () => {
    const run = (type: string, texts: unknown[]): Record<string, unknown> => ({ type, time0: 0, index: 0, dt: [], texts })
    expect(attemptText({ stream: [run('text-chunks', ['hi', ' there'])] })).toEqual({ text: 'hi there' })
    expect(attemptText({ stream: [run('reasoning-chunks', ['r'])] })).toEqual({ reasoning: 'r' })
    expect(attemptText({ stream: [run('text-chunks', ['a']), run('reasoning-chunks', ['b'])] }))
      .toEqual({ text: 'a', reasoning: 'b' })
    // A run with no string parts contributes nothing rather than an empty key.
    expect(attemptText({ stream: [run('text-chunks', [])] })).toEqual({})
    expect(attemptText({ stream: [run('tool-call-chunks', ['{"a":1}'])] })).toEqual({})
    expect(attemptText({ stream: [] })).toEqual({})
    expect(attemptText({})).toEqual({})
  })

  it('reconstructs a multi-turn transcript from user messages and turn boundaries', () => {
    let view = initialViewModel()
    view = foldEvent(view, frame('session.event', { seq: 0, type: 'turn/start', payload: { turn: 1 } }))
    view = foldEvent(view, frame('session.event', {
      seq: 1,
      type: 'user/message',
      payload: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first question' }] },
    }))
    view = foldEvent(view, frame('session.event', {
      seq: 2,
      type: 'assistant/attempt',
      payload: { turn: 1, step: 1, stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['first answer'] }] },
    }))
    view = foldEvent(view, frame('session.event', { seq: 3, type: 'turn/end', payload: { turn: 1, reason: { kind: 'completed' } } }))
    expect(view.messages).toEqual([{ id: 'user-1', role: 'user', text: 'first question' }])
    expect(view.assistantText).toBe('first answer')

    view = foldEvent(view, frame('session.event', { seq: 4, type: 'turn/start', payload: { turn: 2 } }))
    expect(view.messages).toEqual([
      { id: 'user-1', role: 'user', text: 'first question' },
      { id: 'assistant-1', role: 'assistant', text: 'first answer' },
    ])
    expect(view.assistantText).toBe('')
    view = foldEvent(view, frame('session.event', {
      seq: 5,
      type: 'user/message',
      payload: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'second question' }] },
    }))
    view = foldEvent(view, frame('session.event', {
      seq: 6,
      type: 'user/message',
      payload: { role: 'user', source: { kind: 'plugin', plugin: 'agent-instructions' }, content: [{ type: 'text', text: 'injected context' }] },
    }))
    expect(view.messages.map((message) => message.text)).toEqual(['first question', 'first answer', 'second question'])
  })
})
