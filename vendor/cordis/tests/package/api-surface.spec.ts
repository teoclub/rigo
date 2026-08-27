import { describe, expect, it } from 'vitest'
// Check the production entry explicitly. This vendored package also exposes a
// TypeScript source entry under the `development` condition, whose transpiled
// const enums are not part of the published runtime API.
import * as cordis from '../../packages/cordis/lib/index.js'

/**
 * API surface snapshot (SPEC §4.1): the root entry's exported symbol names
 * are frozen as the compatibility baseline. Any addition or removal must go
 * through the Breaking Changes process (SPEC §5.6).
 */
describe('api surface', () => {
  it('root exports match the frozen baseline', () => {
    expect(Object.keys(cordis).sort()).toEqual([
      'Context',
      'CordisError',
      'DisposableList',
      'EventsService',
      'Fiber',
      'Inject',
      'Logger',
      'LoggerService',
      'ReflectService',
      'RegistryService',
      'Service',
      'ValidationError',
      'buildOuterStack',
      'c16',
      'c256',
      'composeError',
      'createCallable',
      'defaultFormatters',
      'getPropertyDescriptor',
      'getTraceable',
      'isBailed',
      'isConstructor',
      'isObject',
      'joinPrototype',
      'resolveConfig',
      'symbols',
      'withProps',
    ])
  })

  it('the SPEC §4.1 public API surface is fully present', () => {
    // Context API
    expect(cordis.Context).toBeTypeOf('function')
    expect(cordis.Context.is).toBeTypeOf('function')
    expect(cordis.Context.is[Symbol.toPrimitive]).toBeTypeOf('function')

    // Fiber API
    expect(cordis.Fiber).toBeTypeOf('function')

    // plugin contract
    expect(cordis.Inject).toBeTypeOf('function')

    // services
    expect(cordis.Service).toBeTypeOf('function')
    expect(cordis.EventsService).toBeTypeOf('function')
    expect(cordis.LoggerService).toBeTypeOf('function')
    expect(cordis.RegistryService).toBeTypeOf('function')
    // G5: ReflectService is exported from the root barrel
    expect(cordis.ReflectService).toBeTypeOf('function')

    // errors
    expect(cordis.CordisError).toBeTypeOf('function')
    expect(cordis.ValidationError).toBeTypeOf('function')

    // event helpers
    expect(cordis.isBailed).toBeTypeOf('function')

    // runtime prototype surface used by plugin authors
    const ctx = new cordis.Context()
    for (const method of [
      'extend', 'isolate', 'intercept', 'get', 'set', 'provide', 'accessor',
      'mixin', 'plugin', 'inject', 'effect', 'on', 'once', 'emit', 'parallel',
      'serial', 'bail', 'waterfall', 'logger',
    ]) {
      expect((ctx as any)[method], `ctx.${method}`).toBeTypeOf('function')
    }
    for (const method of ['dispose', 'await', 'restart', 'update', 'getEffects', 'assertActive']) {
      expect((ctx.fiber as any)[method], `fiber.${method}`).toBeTypeOf('function')
    }
  })

  it('schemastery and kit expose their public surfaces', async () => {
    const Schema = (await import('@teoclub/schemastery')).default
    expect(Schema).toBeTypeOf('function')
    for (const method of ['string', 'number', 'boolean', 'object', 'array', 'union', 'intersect', 'transform', 'extend']) {
      expect((Schema as any)[method], `Schema.${method}`).toBeTypeOf('function')
    }
    const kit = await import('@teoclub/kit')
    for (const name of ['defineProperty', 'isNullable', 'deepEqual', 'hyphenate', 'valueMap', 'pick']) {
      expect((kit as any)[name], `kit.${name}`).toBeTypeOf('function')
    }
  })
})
