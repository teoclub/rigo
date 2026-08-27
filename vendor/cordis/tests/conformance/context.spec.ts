import { describe, expect, it } from 'vitest'
import { Context, Service, symbols } from '@teoclub/cordis'
import { flush, S } from './utils.ts'

describe('context', () => {
  it('root: ctx.root === ctx, root fiber uid = 0, Context.is brands proxies', () => {
    const ctx = new Context()
    expect(ctx.root).toBe(ctx)
    expect(ctx.fiber.uid).toBe(0)
    expect(ctx.fiber.state).toBe(S.ACTIVE)
    expect(Context.is(ctx)).toBe(true)
    expect(Context.is({})).toBe(false)
    expect(Context.is(null)).toBe(false)
  })

  it('extend: child inherits properties, own meta shadows, parent untouched', () => {
    const ctx = new Context()
    const child = ctx.extend({ custom: 1 })
    expect(child.custom).toBe(1)
    // inherited service properties resolve (each read returns a
    // receiver-bound traceable proxy, so compare behaviorally, not by identity)
    expect(child.events).toBeTypeOf('object')
    expect(Reflect.has(child, 'events')).toBe(true)
    expect((ctx as any).custom).toBeUndefined()
    const grandchild = child.extend({ custom: 2 })
    expect(grandchild.custom).toBe(2)
    expect(child.custom).toBe(1)
  })

  it('isolate: same label joins scopes, different labels stay independent', async () => {
    const ctx = new Context()
    const label = Symbol('test')
    const a = ctx.isolate('svc', label)
    const b = ctx.isolate('svc', label)
    const c = ctx.isolate('svc')

    // the provider is loaded INSIDE the isolated scope
    const f1 = a.plugin({
      apply(cc) { cc.provide('svc', 'one') },
    })
    await f1.await()
    expect(a.get('svc')).toBe('one')
    // same label joins the scope
    expect(b.get('svc')).toBe('one')
    // different label and the parent scope stay independent
    expect(c.get('svc')).toBeUndefined()
    expect(ctx.get('svc')).toBeUndefined()
  })

  it('intercept: config is visible through the intercept map, child shadows parent', () => {
    const ctx = new Context()
    const child = ctx.intercept('svc', { x: 1 })
    expect(ctx[Context.intercept]).not.toHaveProperty('svc')
    expect(child[Context.intercept]['svc']).toEqual({ x: 1 })
    const grandchild = child.intercept('svc', { x: 2 })
    expect(grandchild[Context.intercept]['svc']).toEqual({ x: 2 })
    // prototype chain still exposes the parent's entry
    expect(Object.getPrototypeOf(grandchild[Context.intercept])['svc']).toEqual({ x: 1 })
  })

  it('get: strict mode only returns active providers', async () => {
    const ctx = new Context()
    let strictWhileLoading: unknown = 'unset'
    let looseWhileLoading: unknown = 'unset'
    const f1 = ctx.plugin({
      apply(c) {
        c.provide('svc', 'value')
        // during apply the provider fiber is LOADING, not ACTIVE
        strictWhileLoading = ctx.get('svc')
        looseWhileLoading = ctx.get('svc', false)
      },
    })
    await f1.await()
    expect(strictWhileLoading).toBeUndefined()
    expect(looseWhileLoading).toBe('value')
    // once active, strict resolution works
    expect(ctx.get('svc')).toBe('value')
    expect(ctx.get('missing')).toBeUndefined()
  })

  it('set: only the providing fiber may overwrite', async () => {
    const ctx = new Context()
    let inner = 'old'
    const f1 = ctx.plugin({
      apply(c) {
        c.provide('svc', 'old')
        // set from within the providing fiber succeeds (read back non-strict:
        // the provider is still LOADING during apply)
        c.set('svc', 'inner')
        inner = c.get('svc', false) as string
      },
    })
    await f1.await()
    expect(inner).toBe('inner')
    // the root fiber is not the provider, so it may not overwrite
    expect(() => ctx.set('svc', 'hijack')).toThrow(/multiple fibers/)
    expect(() => ctx.set('missing', 1)).toThrow(/without provide/)
  })

  it('provide: registers, disposer unregisters, duplicate throws', async () => {
    const ctx = new Context()
    let dispose!: () => Promise<void>
    const f1 = ctx.plugin({
      apply(c) {
        dispose = c.provide('svc', 'v1')
      },
    })
    await f1.await()
    expect(ctx.get('svc')).toBe('v1')

    await dispose()
    expect(ctx.get('svc')).toBeUndefined()

    const f2 = ctx.plugin({
      apply(c) { c.provide('svc', 'v2') },
    })
    await f2.await()
    expect(() => ctx.provide('svc', 'v3')).toThrow(/has been registered/)
  })

  it('accessor: computed property with get/set hooks, removed with the fiber', async () => {
    const ctx = new Context()
    let inner = 1
    const f1 = ctx.plugin({
      apply(c) {
        c.accessor('computed', {
          get: () => inner,
          set: (value) => { inner = value; return true },
        })
      },
    })
    await f1.await()
    expect((ctx as any).computed).toBe(1)
    ;(ctx as any).computed = 5
    expect(inner).toBe(5)
    await f1.dispose()
    expect('computed' in ctx).toBe(false)
  })

  it('mixin: core services expose their methods on every context', () => {
    const ctx = new Context()
    expect(ctx.on).toBeTypeOf('function')
    expect(ctx.emit).toBeTypeOf('function')
    expect(ctx.plugin).toBeTypeOf('function')
    // mixed-in methods forward to their owning service
    const dispose = ctx.on('mixin-check', () => {})
    expect(ctx.events._hooks['mixin-check']).toHaveLength(1)
    dispose()
    expect(ctx.events._hooks['mixin-check']).toHaveLength(0)
  })

  it('service base class registers itself and unregisters with its fiber', async () => {
    const ctx = new Context()
    class TestService extends Service {
      constructor(c: any) { super(c, 'test-svc') }
      value = 42
    }
    const f1 = ctx.plugin(TestService)
    await f1.await()
    expect((ctx as any)['test-svc']).toBeInstanceOf(TestService)
    expect((ctx as any)['test-svc'].value).toBe(42)
    await f1.dispose()
    expect(ctx.get('test-svc')).toBeUndefined()
  })
})
