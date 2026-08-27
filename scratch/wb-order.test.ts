import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@teoclub/harness-session'
import { SessionWriteBehind } from '@teoclub/harness-session-persistence/src/write-behind.ts'

function event(seq: number): SessionEvent<'turn/start'> {
  return { type: 'turn/start', seq, time: seq, data: { turn: seq + 1 } }
}

afterEach(() => { vi.useRealTimers() })

describe('debug', () => {
  it('first (leaves nothing pending)', async () => {
    vi.useFakeTimers()
    const batches: number[][] = []
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async (events) => { batches.push(events.map(item => item.seq)) },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue(event(0))
    await vi.advanceTimersByTimeAsync(200)
    expect(batches).toEqual([[0]])
    await controller.flush()
  })

  it('keeps a tail deadline', async () => {
    vi.useFakeTimers()
    const gate = Promise.withResolvers<boolean>()
    const batches: number[][] = []
    const controller = new SessionWriteBehind({
      maxDelayMs: 200,
      write: async (events) => {
        console.log('write called, clock =', Date.now() % 100000, 'seqs:', events.map(e => e.seq))
        batches.push(events.map(item => item.seq))
        if (batches.length === 1) await gate.promise
      },
      reportBackgroundFailure: vi.fn(),
    })
    controller.enqueue(event(0))
    await vi.advanceTimersByTimeAsync(200)
    controller.enqueue(event(1))
    await vi.advanceTimersByTimeAsync(50)
    gate.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    console.log('after gate+advance(0):', JSON.stringify(batches))
    expect(batches).toEqual([[0]])
  })
})
