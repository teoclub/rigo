import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import SessionStore, { SessionId } from '@teoclub/harness-session'
import ContextService, {
  CONTEXT_EVENT_TYPE,
  CONTEXT_ORDER,
  ContextContributorError,
  type ContextContributor,
  type ContextContribution,
} from '@teoclub/harness-context'

/**
 * Issue 011: Context Contributor registration and assembly (SPEC §2.4, §5.2,
 * §6.3; PRD US-006, FR-16): unique ids per scope, deterministic (order, id)
 * sorting over the full assembly order, source-tracked contributions written
 * to the session log before model entry, unload stops participation, and
 * structured failure propagation.
 */

function contributor(id: string, order: number | undefined, text: string): ContextContributor {
  return {
    id,
    order,
    contribute: (): ContextContribution => ({
      source: { contributorId: id, label: `source:${id}` },
      content: text,
    }),
  }
}

async function harness(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ContextService)
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

describe('Rigo context assembly (Issue 011)', () => {
  it('sorts contributors by order, then by id, deterministically', async () => {
    const { ctx, dispose } = await harness()
    try {
      ctx.context.register(contributor('z-late', 400, 'z'))
      ctx.context.register(contributor('a-early', -100, 'a'))
      ctx.context.register(contributor('b-same', 100, 'b'))
      ctx.context.register(contributor('a-same', 100, 'a2'))
      expect(ctx.context.list().map((entry) => entry.id)).toEqual(['a-early', 'a-same', 'b-same', 'z-late'])
      // Repeated listing is identical (deterministic).
      expect(ctx.context.list().map((entry) => entry.id)).toEqual(['a-early', 'a-same', 'b-same', 'z-late'])
    } finally {
      await dispose()
    }
  })

  it('pins the full assembly order bands: identity → persona → domain → history → knowledge → runtime → tools', () => {
    const orders = [
      CONTEXT_ORDER.HARNESS_IDENTITY,
      CONTEXT_ORDER.PRODUCT_PERSONA,
      CONTEXT_ORDER.DOMAIN_CONTEXT,
      CONTEXT_ORDER.SESSION_HISTORY,
      CONTEXT_ORDER.KNOWLEDGE,
      CONTEXT_ORDER.RUNTIME_INJECTION,
      CONTEXT_ORDER.TOOL_SCHEMAS,
    ]
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
    expect(orders[0]).toBeLessThan(orders[1]!)
  })

  it('assembles contributions in deterministic order with joined text', async () => {
    const { ctx, dispose } = await harness()
    try {
      ctx.context.register(contributor('domain', CONTEXT_ORDER.DOMAIN_CONTEXT, 'domain context'))
      ctx.context.register(contributor('identity', CONTEXT_ORDER.HARNESS_IDENTITY, 'identity'))
      ctx.context.register(contributor('knowledge', CONTEXT_ORDER.KNOWLEDGE, 'knowledge'))
      const result = await ctx.context.assemble(undefined)
      expect(result.contributions.map((entry) => entry.source.contributorId))
        .toEqual(['identity', 'domain', 'knowledge'])
      expect(result.text).toBe('identity\n\ndomain context\n\nknowledge')
    } finally {
      await dispose()
    }
  })

  it('rejects a duplicate contributor id within the scope', async () => {
    const { ctx, dispose } = await harness()
    try {
      ctx.context.register(contributor('dup', 0, 'first'))
      expect(() => ctx.context.register(contributor('dup', 10, 'second')))
        .toThrow(/already registered/)
      // The failed registration did not replace the original.
      const result = await ctx.context.assemble(undefined)
      expect(result.text).toBe('first')
    } finally {
      await dispose()
    }
  })

  it('writes source-tracked session events before the model sees the content', async () => {
    const { ctx, dispose } = await harness()
    try {
      ctx.context.register(contributor('history', CONTEXT_ORDER.SESSION_HISTORY, 'session history'))
      ctx.context.register(contributor('injection', CONTEXT_ORDER.RUNTIME_INJECTION, 'runtime injection'))
      const session = ctx.sessions.create(SessionId('session_ctx_events'))
      const result = await ctx.context.assemble(session)

      const events = session.events.filter((event) => event.type === CONTEXT_EVENT_TYPE)
      expect(events.map((event) => (event.data as { contributorId: string }).contributorId))
        .toEqual(['history', 'injection'])
      expect(events.map((event) => (event.data as { order: number }).order))
        .toEqual([CONTEXT_ORDER.SESSION_HISTORY, CONTEXT_ORDER.RUNTIME_INJECTION])
      expect(events[0]).toMatchObject({
        type: CONTEXT_EVENT_TYPE,
        data: { label: 'source:history', textLength: 'session history'.length },
      })
      // The events precede the assembled text (written before model entry).
      expect(result.text).toBe('session history\n\nruntime injection')
    } finally {
      await dispose()
    }
  })

  it('stops an unloaded contributor from participating in new assemblies', async () => {
    const { ctx, dispose } = await harness()
    try {
      const disposer = ctx.context.register(contributor('volatile', 100, 'volatile'))
      ctx.context.register(contributor('stable', 200, 'stable'))
      expect((await ctx.context.assemble(undefined)).text).toBe('volatile\n\nstable')

      disposer()
      expect((await ctx.context.assemble(undefined)).text).toBe('stable')

      // Fiber unload removes the contributor the same way.
      const owner = await ctx.plugin(Object.assign((inner: Context) => {
        // Register through the CALLER's view so the disposer binds to the
        // plugin fiber, not the root.
        inner.context.register(contributor('in-fiber', 300, 'in-fiber'))
      }, { inject: ['context'] }))
      expect((await ctx.context.assemble(undefined)).text).toBe('stable\n\nin-fiber')
      await owner.dispose()
      expect((await ctx.context.assemble(undefined)).text).toBe('stable')
    } finally {
      await dispose()
    }
  })

  it('propagates a failing contributor as a structured error, omitting nothing silently', async () => {
    const { ctx, dispose } = await harness()
    try {
      ctx.context.register(contributor('ok-first', 0, 'fine'))
      ctx.context.register({
        id: 'exploding',
        order: 100,
        contribute: () => { throw new Error('contributor blew up') },
      })
      ctx.context.register(contributor('ok-last', 200, 'also fine'))
      const session = ctx.sessions.create(SessionId('session_ctx_failure'))

      const failure = ctx.context.assemble(session)
      await expect(failure).rejects.toThrowError(ContextContributorError)
      await expect(failure).rejects.toMatchObject({ code: 'CONTRIBUTOR_FAILED', retryable: false })
      await expect(failure).rejects.toThrow(/contributor "exploding" failed/)
      // No contribution event for the failed contributor; the assembly
      // rejected as a whole instead of returning a partial context.
      expect(session.events.filter((event) => event.type === CONTEXT_EVENT_TYPE).length).toBe(1)
      expect((session.events.at(-1)!.data as { contributorId: string }).contributorId).toBe('ok-first')
    } finally {
      await dispose()
    }
  })

  it('rejects a contribution without a traceable source', async () => {
    const { ctx, dispose } = await harness()
    try {
      ctx.context.register({
        id: 'unattributed',
        contribute: () => ({ content: 'no source here' }) as unknown as ContextContribution,
      })
      await expect(ctx.context.assemble(undefined)).rejects.toThrow(/missing traceable source/)
    } finally {
      await dispose()
    }
  })
})
