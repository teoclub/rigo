import { describe, expect, it, vi } from 'vitest'
import { Context, Fiber } from '@teoclub/cordis'
import { flush, sleep } from './utils.ts'

describe('events', () => {
  it('emit: synchronous dispatch, return values ignored', () => {
    const ctx = new Context()
    const calls: number[] = []
    ctx.on('evt', (n: number) => { calls.push(n); return 'ignored' })
    ctx.emit('evt', 1)
    ctx.emit('evt', 2)
    expect(calls).toEqual([1, 2])
  })

  it('parallel: all listeners awaited; reports parallel mode on internal/dispatch (G1)', async () => {
    const ctx = new Context()
    const modes: string[] = []
    ctx.on('internal/dispatch', (mode, name) => modes.push(`${mode}:${name}`))
    const calls: number[] = []
    ctx.on('evt', async (n: number) => { await sleep(10); calls.push(n) })
    ctx.on('evt', async (n: number) => { await sleep(5); calls.push(n) })
    const promise = ctx.parallel('evt', 7)
    expect(calls).toEqual([])
    await promise
    expect(calls.sort()).toEqual([7, 7])
    expect(modes).toContain('parallel:evt')
    expect(modes).not.toContain('emit:evt')
  })

  it('serial: listeners run in order, awaiting each until bail', async () => {
    const ctx = new Context()
    const calls: string[] = []
    ctx.on('evt', async () => { await sleep(10); calls.push('a'); return undefined })
    ctx.on('evt', async () => { calls.push('b'); return 'bailed' })
    ctx.on('evt', async () => { calls.push('c') })
    const result = await ctx.serial('evt')
    expect(result).toBe('bailed')
    expect(calls).toEqual(['a', 'b'])
  })

  it('bail: synchronous listeners stop at the first bail value', () => {
    const ctx = new Context()
    const calls: string[] = []
    ctx.on('evt', () => { calls.push('a'); return false })
    ctx.on('evt', () => { calls.push('b'); return 'value' })
    ctx.on('evt', () => { calls.push('c') })
    expect(ctx.bail('evt')).toBe('value')
    expect(calls).toEqual(['a', 'b'])
  })

  it('waterfall: listeners wrap the next continuation; not calling next vetoes', () => {
    const ctx = new Context()
    const calls: string[] = []
    // listeners always receive the fixed dispatch args; a listener transforms
    // the result through its return value, and skipping next() vetoes the rest
    ctx.on('evt', (value: number, next: () => any) => {
      calls.push(`a(${value})`)
      return next()
    })
    ctx.on('evt', (value: number, next: () => any) => {
      calls.push(`b(${value})`)
      return next()
    })
    expect(ctx.waterfall('evt', 1, (v: number) => v + 100)).toBe(101)
    expect(calls).toEqual(['a(1)', 'b(1)'])

    // veto: a listener that never calls next() suppresses the chain
    const ctx2 = new Context()
    ctx2.on('evt', (value: number) => value * 2)
    ctx2.on('evt', () => { throw new Error('must not run') })
    expect(ctx2.waterfall('evt', 5, () => 999)).toBe(10)
  })

  it('prepend: listener runs before existing listeners', () => {
    const ctx = new Context()
    const calls: string[] = []
    ctx.on('evt', () => { calls.push('first-registered') })
    ctx.on('evt', () => { calls.push('prepended') }, { prepend: true })
    ctx.emit('evt')
    expect(calls).toEqual(['prepended', 'first-registered'])
  })

  it('global: bypasses context isolation filtering', () => {
    const ctx = new Context()
    const isolated = ctx.isolate('svc')
    const calls: string[] = []
    isolated.on('evt', () => { calls.push('filtered') })
    isolated.on('evt', () => { calls.push('global') }, { global: true })
    // dispatch from a context whose filter rejects the isolated listener's ctx
    const filtered: any = Object.create(ctx)
    filtered[Context.filter] = (target: any) => false
    ctx.emit(filtered, 'evt')
    expect(calls).toEqual(['global'])
  })

  it('once: listener disposes itself after its first call', () => {
    const ctx = new Context()
    let count = 0
    ctx.once('evt', () => { count++ })
    ctx.emit('evt')
    ctx.emit('evt')
    expect(count).toBe(1)
    expect(ctx.events._hooks['evt']).toHaveLength(0)
  })

  it('isolation filter: listeners are disposed with their owning fiber', async () => {
    const ctx = new Context()
    const calls: number[] = []
    const fiber = ctx.plugin({
      apply(c) { c.on('evt', (n: number) => calls.push(n)) },
    })
    await fiber.await()
    ctx.emit('evt', 1)
    expect(calls).toEqual([1])
    await fiber.dispose()
    ctx.emit('evt', 2)
    expect(calls).toEqual([1])
  })

  it('parallel rejections aggregate into AggregateError', async () => {
    const ctx = new Context()
    const e1 = new Error('one')
    const e2 = new Error('two')
    ctx.on('evt', async () => { throw e1 })
    ctx.on('evt', async () => { throw e2 })
    const promise = ctx.parallel('evt')
    await expect(promise).rejects.toBeInstanceOf(AggregateError)
    await expect(promise).rejects.toMatchObject({ errors: [e1, e2] })
  })

  it('internal/dispatch fires for public events with mode and args', () => {
    const ctx = new Context()
    const seen: Array<[string, string, any[]]> = []
    ctx.on('internal/dispatch', (mode, name, args) => { seen.push([mode, name, args]) })
    ctx.emit('public-evt', 1, 2)
    expect(seen).toEqual([['emit', 'public-evt', [1, 2]]])
    // internal events do not re-report
    ctx.emit('internal/status', null, 0)
    expect(seen).toHaveLength(1)
  })
})
