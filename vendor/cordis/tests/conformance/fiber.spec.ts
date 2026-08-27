import { describe, expect, it, vi } from 'vitest'
import { Context, CordisError, ValidationError, Fiber } from '@teoclub/cordis'
import { flush, S, schema, sleep } from './utils.ts'

describe('fiber', () => {
  it('PENDING -> LOADING -> ACTIVE on load without dependencies', async () => {
    const ctx = new Context()
    const states: number[] = []
    const fiber = ctx.plugin({
      name: 'plain',
      apply() {},
    })
    ctx.on('internal/status', (f: Fiber) => states.push(f.state))
    expect(fiber.state).toBe(S.LOADING)
    await fiber.await()
    expect(fiber.state).toBe(S.ACTIVE)
    expect(states).toContain(S.ACTIVE)
    expect(fiber.name).toBe('plain')
    expect(fiber.uid).toBeGreaterThan(0)
  })

  it('LOADING failure -> FAILED; await() rethrows; state stays FAILED', async () => {
    const ctx = new Context()
    const boom = new Error('boom')
    const fiber = ctx.plugin({
      apply() { throw boom },
    })
    await expect(fiber.await()).rejects.toBe(boom)
    expect(fiber.state).toBe(S.FAILED)
    await expect(fiber.await()).rejects.toBe(boom)
    // disposing a FAILED fiber settles without error
    await fiber.dispose()
    expect(fiber.state).toBe(S.DISPOSED)
  })

  it('config validation failure -> FAILED with ValidationError', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({
      Config: schema((value) => {
        if (typeof value !== 'number') {
          return { issues: [{ message: 'expected number', path: [] }] }
        }
        return { value }
      }),
      apply() {},
    } as any, 'not-a-number')
    await expect(fiber.await()).rejects.toBeInstanceOf(ValidationError)
    expect(fiber.state).toBe(S.FAILED)
  })

  it('async Config validation -> TypeError at startup (FR-SCHEMA-004)', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({
      Config: {
        '~standard': {
          version: 1,
          vendor: 'test',
          validate: async (value: any) => ({ value }),
        },
      },
      apply() {},
    } as any, 1)
    await expect(fiber.await()).rejects.toThrow('Async config validation is not supported')
    expect(fiber.state).toBe(S.FAILED)
  })

  it('missing dependency -> PENDING; provided -> LOADING -> ACTIVE', async () => {
    const ctx = new Context()
    const dependent = ctx.plugin({
      inject: ['dep'],
      apply() {},
    })
    await flush()
    expect(dependent.state).toBe(S.PENDING)

    const provider = ctx.plugin({
      apply(c) { c.provide('dep', {}) },
    })
    await provider.await()
    await dependent.await()
    expect(dependent.state).toBe(S.ACTIVE)
  })

  it('dependency lost -> UNLOADING -> PENDING; disposal of dependents settles', async () => {
    const ctx = new Context()
    let disposed = false
    const provider = ctx.plugin({
      apply(c) { c.provide('dep', {}) },
    })
    await provider.await()
    const dependent = ctx.plugin({
      inject: ['dep'],
      apply(c) { c.effect(() => { disposed = true }) },
    })
    await dependent.await()
    expect(dependent.state).toBe(S.ACTIVE)

    await provider.dispose()
    await dependent.await()
    expect(disposed).toBe(true)
    expect(dependent.state).toBe(S.PENDING)
  })

  it('dependency replaced -> UNLOADING -> LOADING with the new implementation', async () => {
    const ctx = new Context()
    const seen: string[] = []
    const provider1 = ctx.plugin({
      name: 'provider1',
      apply(c) { c.provide('dep', 'v1') },
    })
    await provider1.await()
    const dependent = ctx.plugin({
      inject: ['dep'],
      apply(c) { seen.push(c.get('dep') as string) },
    })
    await dependent.await()

    await provider1.dispose()
    const provider2 = ctx.plugin({
      name: 'provider2',
      apply(c) { c.provide('dep', 'v2') },
    })
    await provider2.await()
    await dependent.await()
    expect(seen).toEqual(['v1', 'v2'])
    expect(dependent.state).toBe(S.ACTIVE)
  })

  it('restart: dispose + reload with the current config', async () => {
    const ctx = new Context()
    let runs = 0
    const fiber = ctx.plugin({
      apply() { runs++ },
    })
    await fiber.await()
    expect(runs).toBe(1)
    await fiber.restart()
    expect(runs).toBe(2)
    expect(fiber.state).toBe(S.ACTIVE)
  })

  it('update: config re-validated and applied via internal/update waterfall', async () => {
    const ctx = new Context()
    const configs: any[] = []
    let vetoed = false
    let disposeVeto!: () => boolean
    const fiber = ctx.plugin({
      Config: schema((value) => {
        if (typeof value !== 'object' || value === null) {
          return { issues: [{ message: 'expected object', path: [] }] }
        }
        return { value: { ...value, validated: true } }
      }),
      apply(c, config) {
        configs.push(config)
        // internal/update listeners are scoped to the updating fiber
        disposeVeto = c.on('internal/update', function (this: Fiber, config, noSave, next) {
          if (config?.a === 2) { vetoed = true; return }
          return next()
        } as any)
      },
    } as any, { a: 1 })
    await fiber.await()
    expect(configs).toEqual([{ a: 1, validated: true }])

    await (fiber.update({ a: 2 }) as any)
    expect(vetoed).toBe(true)
    expect(configs).toHaveLength(1)

    disposeVeto()
    await fiber.update({ a: 3 })
    expect(configs[1]).toEqual({ a: 3, validated: true })

    // invalid config fails validation
    expect(() => fiber.update('bad')).toThrow(ValidationError)
  })

  it('root fiber: uid = 0, dispose() unloads children, never DISPOSED', async () => {
    const ctx = new Context()
    let disposed = false
    const plugin = ctx.plugin({
      apply(c) { c.effect(() => () => { disposed = true }) },
    })
    await plugin.await()
    expect(disposed).toBe(false)
    await ctx.fiber.dispose()
    // child fibers are unloaded with the root
    expect(disposed).toBe(true)
    await plugin.await().catch(() => {}) // may have settled FAILED after parent unload
    // the root itself is never permanently disposed
    expect(ctx.fiber.uid).toBe(0)
    expect(ctx.fiber.state).toBe(S.ACTIVE)
    expect(Context.is(ctx)).toBe(true)
  })

  it('dispose: terminal DISPOSED; assertActive throws; re-dispose is a no-op', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ apply() {} })
    await fiber.await()
    await fiber.dispose()
    expect(fiber.state).toBe(S.DISPOSED)
    expect(fiber.uid).toBeNull()
    expect(() => fiber.assertActive()).toThrow(CordisError)
    expect(() => ctx.effect(() => {})).not.toThrow()
    // disposing an already-disposed fiber is a synchronous no-op
    expect(fiber.dispose()).toBeUndefined()
    // restart on a disposed fiber rejects with INACTIVE_EFFECT
    await expect(fiber.restart()).rejects.toBeInstanceOf(CordisError)
  })

  it('effect creation rejected while UNLOADING (INACTIVE_EFFECT)', async () => {
    const ctx = new Context()
    let caught: any
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fiber = ctx.plugin({
      apply(c) {
        c.effect(() => async () => {
          // during unload the fiber is UNLOADING: new effects are rejected
          try {
            c.effect(() => {})
          } catch (error) {
            caught = error
          }
          release()
        })
      },
    })
    await fiber.await()
    const disposing = fiber.dispose()
    await gate
    expect(caught).toBeInstanceOf(CordisError)
    expect((caught as CordisError).code).toBe('INACTIVE_EFFECT')
    await disposing
    expect(fiber.state).toBe(S.DISPOSED)
  })

  it('getEffects exposes labeled effect metadata', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({
      apply(c) {
        c.effect(() => () => {}, 'my-effect')
      },
    })
    await fiber.await()
    const effects = fiber.getEffects()
    expect(effects.map((e) => e.label)).toContain('my-effect')
    await fiber.dispose()
    expect(fiber.getEffects()).toHaveLength(0)
  })
})
