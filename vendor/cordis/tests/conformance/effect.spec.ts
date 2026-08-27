import { describe, expect, it } from 'vitest'
import { Context, CordisError } from '@teoclub/cordis'
import { flush, sleep } from './utils.ts'

describe('effect', () => {
  it('sync disposer runs on fiber unload', async () => {
    const ctx = new Context()
    let disposed = false
    const fiber = ctx.plugin({
      apply(c) { c.effect(() => () => { disposed = true }) },
    })
    await fiber.await()
    expect(disposed).toBe(false)
    await fiber.dispose()
    expect(disposed).toBe(true)
  })

  it('async disposer is awaited before unload settles', async () => {
    const ctx = new Context()
    const order: string[] = []
    const fiber = ctx.plugin({
      apply(c) {
        c.effect(() => async () => {
          order.push('start')
          await sleep(20)
          order.push('end')
        })
      },
    })
    await fiber.await()
    const disposing = fiber.dispose()
    await disposing
    expect(order).toEqual(['start', 'end'])
  })

  it('Promise<disposer> is collected and awaited', async () => {
    const ctx = new Context()
    let disposed = false
    const fiber = ctx.plugin({
      apply(c) {
        c.effect(() => sleep(10).then(() => () => { disposed = true }))
      },
    })
    await fiber.await()
    expect(disposed).toBe(false)
    await fiber.dispose()
    expect(disposed).toBe(true)
  })

  it('iterable effect: each yielded disposer registers as produced', async () => {
    const ctx = new Context()
    const order: number[] = []
    const fiber = ctx.plugin({
      apply(c) {
        c.effect(function* () {
          for (const i of [1, 2, 3]) {
            yield () => { order.push(i) }
          }
        })
      },
    })
    await fiber.await()
    expect(order).toEqual([])
    await fiber.dispose()
    expect(order).toEqual([3, 2, 1])
  })

  it('async iterable effect: disposers stream and stop at epoch change', async () => {
    const ctx = new Context()
    const collected: number[] = []
    let disposed = 0
    const fiber = ctx.plugin({
      apply(c) {
        c.effect(async function* () {
          for (const i of [1, 2, 3]) {
            await sleep(5)
            collected.push(i)
            yield () => { disposed++ }
          }
        })
      },
    })
    await fiber.await()
    // the async iteration continues as a background task
    await sleep(40)
    expect(collected).toEqual([1, 2, 3])
    await fiber.dispose()
    await flush()
    expect(disposed).toBe(3)
  })

  it('disposers run in reverse registration order', async () => {
    const ctx = new Context()
    const order: string[] = []
    const fiber = ctx.plugin({
      apply(c) {
        c.effect(() => () => { order.push('a') })
        c.effect(() => () => { order.push('b') })
        c.effect(() => () => { order.push('c') })
      },
    })
    await fiber.await()
    await fiber.dispose()
    expect(order).toEqual(['c', 'b', 'a'])
  })

  it('setup failure rolls back already-collected cleanup and rethrows', async () => {
    const ctx = new Context()
    const order: string[] = []
    const boom = new Error('setup failed')
    const fiber = ctx.plugin({
      apply(c) {
        c.effect(() => () => { order.push('first') })
        c.effect(() => { throw boom })
        c.effect(() => () => { order.push('never') })
      },
    })
    await expect(fiber.await()).rejects.toBe(boom)
    // the first effect's disposer ran as rollback; the third never registered
    expect(order).toEqual(['first'])
    expect(fiber.state).toBe(3 /* FAILED */)
  })

  it('reentrant dispose: disposing another effect from inside a disposer joins the same cleanup', async () => {
    const ctx = new Context()
    const order: string[] = []
    const fiber = ctx.plugin({
      apply(c) {
        const d = c.effect(() => () => { order.push('outer') })
        c.effect(() => () => {
          order.push('inner')
          // joining an already-running cleanup runs the outer disposer
          // inline, exactly once
          d()
        })
      },
    })
    await fiber.await()
    await fiber.dispose()
    await flush()
    expect(order).toEqual(['inner', 'outer'])
    // the fiber settles cleanly despite the reentrant call
    expect(fiber.state).toBe(4 /* DISPOSED */)
  })

  it('repeated dispose calls retain the single-shot result', async () => {
    const ctx = new Context()
    let count = 0
    let dispose!: () => any
    const fiber = ctx.plugin({
      apply(c) {
        dispose = c.effect(() => () => { count++ })
      },
    })
    await fiber.await()
    await dispose()
    expect(count).toBe(1)
    await dispose()
    await dispose()
    expect(count).toBe(1)
    await fiber.dispose()
    expect(count).toBe(1)
  })

  it('INACTIVE_EFFECT: effect rejected on disposed fiber and during unload', async () => {
    const ctx = new Context()
    const disposed = ctx.plugin({ apply() {} })
    await disposed.dispose()
    expect(() => disposed.ctx.effect(() => {})).toThrow(CordisError)

    const caught: any[] = []
    const fiber = ctx.plugin({
      apply(c) {
        c.effect(() => () => {
          try {
            c.effect(() => {})
          } catch (error) {
            caught.push(error)
          }
        })
      },
    })
    await fiber.await()
    await fiber.dispose()
    expect(caught).toHaveLength(1)
    expect(caught[0]).toBeInstanceOf(CordisError)
    expect(caught[0].code).toBe('INACTIVE_EFFECT')
  })

  it('invalid effect shapes throw TypeError', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({
      apply(c) {
        expect(() => c.effect(() => 42 as any)).toThrow(TypeError)
        expect(() => c.effect(() => 'bad' as any)).toThrow(TypeError)
      },
    })
    await fiber.await()
    // returning null/undefined is a legal no-op
    const f2 = ctx.plugin({
      apply(c) { c.effect(() => undefined) },
    })
    await f2.await()
  })
})
