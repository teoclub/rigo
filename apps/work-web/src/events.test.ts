/**
 * Rigo Work Web event derivation tests (Issue 033): the SSE stream folds
 * into the UI state — incremental output, phases, sources, empty retrieval.
 */
import { describe, expect, it } from 'vitest'
import { actionStateLabel, chunkText, foldEvent, initialViewModel, phaseLabel, sourcesFromRetrieval } from './events.ts'

function frame(event: string, data: Record<string, unknown>): import('./api.ts').SseFrame {
  return { id: 0, event, data }
}

describe('work web event derivation (Issue 033)', () => {
  it('accumulates assistant chunks incrementally, never from a raw provider stream', () => {
    let view = initialViewModel()
    view = foldEvent(view, frame('session.event', { seq: 0, type: 'turn/start', payload: { turn: 1 } }))
    expect(view.agentStatus).toBe('running')
    expect(view.phase).toBe('context')
    view = foldEvent(view, frame('session.event', {
      seq: 1,
      type: 'assistant/chunk',
      payload: { turn: 1, step: 1, chunk: { type: 'text', text: 'Hello' } },
    }))
    expect(view.assistantText).toBe('Hello')
    expect(view.phase).toBe('llm')
    view = foldEvent(view, frame('session.event', {
      seq: 2,
      type: 'assistant/chunk',
      payload: { turn: 1, step: 1, chunk: { type: 'text', text: ' world' } },
    }))
    expect(view.assistantText).toBe('Hello world')
    view = foldEvent(view, frame('session.event', {
      seq: 3,
      type: 'assistant/chunk',
      payload: { turn: 1, step: 1, chunk: { type: 'reasoning', text: 'thinking…' } },
    }))
    expect(view.reasoningText).toBe('thinking…')
    expect(view.assistantText).toBe('Hello world')
    view = foldEvent(view, frame('session.event', { seq: 4, type: 'turn/end', payload: { turn: 1, reason: { kind: 'completed' } } }))
    expect(view.agentStatus).toBe('idle')
    expect(view.lastSeq).toBe(4)
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

  it('extracts text from chunk payloads only when present', () => {
    expect(chunkText({ chunk: { type: 'text', text: 'hi' } })).toEqual({ text: 'hi' })
    expect(chunkText({ chunk: { type: 'reasoning', text: 'r' } })).toEqual({ reasoning: 'r' })
    expect(chunkText({ chunk: {} })).toEqual({})
    expect(chunkText({})).toEqual({})
  })
})
