import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import { flush } from './utils.ts'

/** LoggerLevel is a const enum (erased at build): frozen numeric baseline. */
const L = { ERROR: 0, INFO: 1, WARN: 2, DEBUG: 3 } as const

/** Collecting exporter used across the logger suite. */
function collector() {
  const messages: any[] = []
  return {
    messages,
    exporter: { export: (message: any) => messages.push(message) },
  }
}

describe('logger', () => {
  it('level: messages above the exporter threshold are dropped', async () => {
    const ctx = new Context()
    const { messages, exporter } = collector()
    // threshold N exports severities 0..N (ERROR=0, INFO=1, WARN=2, DEBUG=3)
    exporter.levels = { default: L.ERROR }
    await ctx.plugin({
      apply(c) { c.logger.exporter(exporter) },
    })
    const logger = ctx.logger('app')
    logger.error('error-msg')
    logger.warn('warn-msg')
    logger.info('info-msg')
    logger.debug('debug-msg')
    expect(messages.map((m) => m.type)).toEqual(['error'])
  })

  it('level: per-name thresholds override the default', async () => {
    const ctx = new Context()
    const { messages, exporter } = collector()
    exporter.levels = { default: L.ERROR, app: L.DEBUG }
    await ctx.plugin({
      apply(c) { c.logger.exporter(exporter) },
    })
    ctx.logger('app').debug('debug-msg')
    ctx.logger('other').debug('debug-msg')
    expect(messages.map((m) => m.name)).toEqual(['app'])
  })

  it('buffer: the built-in buffer exporter keeps at most 1000 messages', async () => {
    const ctx = new Context()
    const logger = ctx.logger('flood')
    for (let i = 0; i < 1050; i++) {
      logger.info('message', i)
    }
    expect(ctx.logger.buffer).toHaveLength(1000)
    expect(ctx.logger.buffer[0].args).toEqual(['message', 50])
    expect(ctx.logger.buffer[999].args).toEqual(['message', 1049])
  })

  it('exporter: registered exporters receive every routed message', async () => {
    const ctx = new Context()
    const a = collector()
    const b = collector()
    await ctx.plugin({
      apply(c) {
        c.logger.exporter(a.exporter)
        c.logger.exporter(b.exporter)
      },
    })
    ctx.logger('app').info('hello', { x: 1 })
    expect(a.messages).toHaveLength(1)
    expect(b.messages).toHaveLength(1)
    expect(a.messages[0].name).toBe('app')
    expect(a.messages[0].args).toEqual(['hello', { x: 1 }])
    expect(a.messages[0].type).toBe('info')
    expect(typeof a.messages[0].sn).toBe('number')
    expect(typeof a.messages[0].ts).toBe('number')
  })

  it('exporter disposer: removes exactly the registered exporter (G3 regression)', async () => {
    const ctx = new Context()
    const a = collector()
    const b = collector()
    const c = collector()
    let disposeA!: () => any
    let disposeB!: () => any
    await ctx.plugin({
      apply(cc) {
        disposeA = cc.logger.exporter(a.exporter)
        disposeB = cc.logger.exporter(b.exporter)
        cc.logger.exporter(c.exporter)
      },
    })
    // dispose the FIRST exporter; the later-registered ones must survive
    await disposeA()
    ctx.logger('app').info('after-a')
    expect(a.messages).toHaveLength(0)
    expect(b.messages).toHaveLength(1)
    expect(c.messages).toHaveLength(1)
    // dispose the second; the third still survives
    await disposeB()
    ctx.logger('app').info('after-b')
    expect(b.messages).toHaveLength(1)
    expect(c.messages).toHaveLength(2)
  })

  it('fiber metadata: messages carry a WeakRef to the owning fiber', async () => {
    const ctx = new Context()
    const { messages, exporter } = collector()
    const fiber = ctx.plugin({
      name: 'meta-plugin',
      apply(c) {
        c.logger.exporter(exporter)
        // a logger created inside the plugin derives its fiber from it
        c.logger('app').info('tagged')
      },
    })
    await fiber.await()
    expect(messages).toHaveLength(1)
    expect(messages[0].fiber).toBeInstanceOf(WeakRef)
    expect((messages[0].fiber as WeakRef<any>).deref()?.name).toBe('meta-plugin')
  })

  it('error isolation: AggregateErrors expand into one message per cause', async () => {
    const ctx = new Context()
    const { messages, exporter } = collector()
    await ctx.plugin({
      apply(c) { c.logger.exporter(exporter) },
    })
    const logger = ctx.logger('app')
    logger.error(new AggregateError([new Error('one'), new Error('two')]))
    expect(messages).toHaveLength(2)
    expect(messages[0].args[0]).toBeInstanceOf(Error)
    expect((messages[0].args[0] as Error).message).toBe('one')
    expect((messages[1].args[0] as Error).message).toBe('two')
    // chained causes are logged before the wrapping error
    const cause = new Error('cause')
    const wrapped = new Error('wrapped', { cause })
    messages.length = 0
    logger.error(wrapped)
    expect(messages.map((m) => (m.args[0] as Error).message)).toEqual(['cause', 'wrapped'])
  })

  it('default logger name derives from the owning fiber', async () => {
    const ctx = new Context()
    const { messages, exporter } = collector()
    const fiber = ctx.plugin({
      name: 'My-Plugin',
      apply(c) {
        c.logger.exporter(exporter)
        // hyphenate(My-Plugin) -> my-plugin
        c.logger().info('anonymous')
      },
    })
    await fiber.await()
    expect(messages[0].name).toBe('my-plugin')
  })
})
