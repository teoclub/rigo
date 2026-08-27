import { describe, expect, it } from 'vitest'
import { Context, Service, Fiber } from '@teoclub/cordis'
import { flush, S } from './utils.ts'

describe('registry', () => {
  it('provide via ctx.provide: value visible to dependents, removed on unload', async () => {
    const ctx = new Context()
    const provider = ctx.plugin({
      apply(c) { c.provide('svc', { tag: 'p1' }) },
    })
    await provider.await()
    expect(ctx.get('svc')).toEqual({ tag: 'p1' })
    await provider.dispose()
    expect(ctx.get('svc')).toBeUndefined()
  })

  it('replace: disposing the old provider and registering a new one reloads dependents', async () => {
    const ctx = new Context()
    const seen: string[] = []
    const provider1 = ctx.plugin({
      name: 'p1',
      apply(c) { c.provide('svc', 'v1') },
    })
    await provider1.await()
    const dependent = ctx.plugin({
      inject: ['svc'],
      apply(c) { seen.push(c.get('svc') as string) },
    })
    await dependent.await()
    await provider1.dispose()
    await dependent.await()
    expect(dependent.state).toBe(S.PENDING)
    const provider2 = ctx.plugin({
      name: 'p2',
      apply(c) { c.provide('svc', 'v2') },
    })
    await provider2.await()
    await dependent.await()
    expect(seen).toEqual(['v1', 'v2'])
  })

  it('inject array form: dependent stays pending until all services exist', async () => {
    const ctx = new Context()
    const dependent = ctx.plugin({
      inject: ['a', 'b'],
      apply() {},
    })
    await flush()
    expect(dependent.state).toBe(S.PENDING)
    const pa = ctx.plugin({ apply(c) { c.provide('a', 1) } })
    await pa.await()
    await flush()
    expect(dependent.state).toBe(S.PENDING)
    const pb = ctx.plugin({ apply(c) { c.provide('b', 2) } })
    await pb.await()
    await dependent.await()
    expect(dependent.state).toBe(S.ACTIVE)
  })

  it('inject object form: intercept config applied on the dependent context', async () => {
    const ctx = new Context()
    let intercepted: any
    const dependent = ctx.plugin({
      inject: { svc: { x: 1 } },
      apply(c) {
        intercepted = c[Context.intercept]['svc']
        c.get('svc')
      },
    })
    await flush()
    expect(dependent.state).toBe(S.PENDING)
    const provider = ctx.plugin({ apply(c) { c.provide('svc', 'value') } })
    await provider.await()
    await dependent.await()
    expect(intercepted).toEqual({ x: 1 })
    expect(dependent.state).toBe(S.ACTIVE)
  })

  it('epoch: replacing the implementation with a different fiber reloads dependents', async () => {
    const ctx = new Context()
    let loads = 0
    const dependent = ctx.plugin({
      inject: ['svc'],
      apply() { loads++ },
    })
    await flush()
    expect(loads).toBe(0)
    const p1 = ctx.plugin({ name: 'p1', apply(c) { c.provide('svc', {}) } })
    await p1.await()
    await dependent.await()
    expect(loads).toBe(1)
    await p1.dispose()
    await dependent.await()
    const p2 = ctx.plugin({ name: 'p2', apply(c) { c.provide('svc', {}) } })
    await p2.await()
    await dependent.await()
    expect(loads).toBe(2)
  })

  it('Service.check: dependents stay pending while the predicate rejects', async () => {
    const ctx = new Context()
    let ready = false
    class GatedService extends Service {
      constructor(c: any) { super(c, 'gated') }
      protected [Service.check as any]() { return ready }
    }
    const provider = ctx.plugin(GatedService)
    await provider.await()
    const dependent = ctx.plugin({
      inject: ['gated'],
      apply() {},
    })
    await flush()
    // service is provided but check() returns false -> dependent stays pending
    expect(dependent.state).toBe(S.PENDING)
    ready = true
    // a dependency refresh is triggered by a new provide of the same name
    await provider.dispose()
    const provider2 = ctx.plugin(GatedService)
    await provider2.await()
    await dependent.await()
    expect(dependent.state).toBe(S.ACTIVE)
  })

  it('accessor conflict: providing over a declared accessor throws', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({
      apply(c) {
        c.accessor('svc', { get: () => 1 })
        expect(() => c.provide('svc', 2)).toThrow(/already declared/)
      },
    })
    await fiber.await()
  })

  it('provider self-update restriction: only the owning fiber may set', async () => {
    const ctx = new Context()
    const provider = ctx.plugin({
      apply(c) { c.provide('svc', 'initial') },
    })
    await provider.await()
    // a sibling fiber cannot overwrite the service
    const sibling = ctx.plugin({
      apply(c) {
        expect(() => c.set('svc', 'hijack')).toThrow(/multiple fibers/)
      },
    })
    await sibling.await()
    expect(ctx.get('svc')).toBe('initial')
  })

  it('registry map surface: get/has/keys/values/entries/size over plugin runtimes', async () => {
    const ctx = new Context()
    const pluginA = { name: 'a', apply() {} }
    const pluginB = { name: 'b', apply() {} }
    expect(ctx.registry.size).toBe(0)
    const fa = ctx.plugin(pluginA)
    const fb = ctx.plugin(pluginB)
    await Promise.all([fa.await(), fb.await()])
    expect(ctx.registry.has(pluginA)).toBe(true)
    expect(ctx.registry.get(pluginB)?.name).toBe('b')
    expect(ctx.registry.size).toBe(2)
    const names = [...ctx.registry.values()].map((r: any) => r.name).sort()
    expect(names).toEqual(['a', 'b'])
    // delete removes the runtime and disposes its fibers (initiated, not awaited)
    const removed = ctx.registry.delete(pluginA)
    expect(removed?.name).toBe('a')
    expect(ctx.registry.has(pluginA)).toBe(false)
    expect(fa.dispose()).toBeUndefined() // already disposed by delete()
    // invalid plugin shapes are rejected
    expect(() => ctx.plugin(42 as any)).toThrow(/invalid plugin/)
    expect(ctx.registry.resolve({} as any)).toBeUndefined()
  })
})
