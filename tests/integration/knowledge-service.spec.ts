/**
 * Issue 018 integration: Knowledge Service Definition (SPEC §2.4, §5.3,
 * §6.1; PRD US-008, FR-23, FR-24).
 *
 * The definition is runtime-agnostic (no SQLite, no vector database), so the
 * whole suite is dual-runtime (Node + Bun).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import {
  DEFAULT_TOP_K,
  KnowledgeProviderError,
  KnowledgeProviderNotFoundError,
  KnowledgeQueryError,
  KnowledgeService,
  MAX_QUERY_BYTES,
  SourceId,
  validateKnowledgeRequest,
  type KnowledgeProvider,
  type KnowledgeRequest,
  type KnowledgeResult,
} from '@teoclub/shared-knowledge'

function row(sourceId: string, overrides: Partial<KnowledgeResult> = {}): KnowledgeResult {
  return {
    sourceId: SourceId(sourceId),
    title: `Title of ${sourceId}`,
    snippet: `snippet of ${sourceId}`,
    documentVersion: 1,
    locator: 'chunk 0',
    ...overrides,
  }
}

function fakeProvider(name: string, rows: readonly KnowledgeResult[] | ((request: KnowledgeRequest) => readonly KnowledgeResult[])): {
  provider: KnowledgeProvider
  calls: KnowledgeRequest[]
} {
  const calls: KnowledgeRequest[] = []
  const makeRows = typeof rows === 'function' ? rows : () => rows
  return {
    provider: {
      name,
      async retrieve(request, signal) {
        calls.push({ ...request, filter: request.filter ? { ...request.filter } : undefined })
        signal?.throwIfAborted()
        return makeRows(request)
      },
    },
    calls,
  }
}

describe('knowledge service definition (Issue 018)', () => {
  it('registers and unloads named providers through ctx.knowledge', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      expect(ctx.knowledge.listProviders()).toEqual([])
      const a = fakeProvider('alpha', [])
      const b = fakeProvider('beta', [])
      const disposeA = ctx.knowledge.registerProvider(a.provider)
      ctx.knowledge.registerProvider(b.provider)
      expect(ctx.knowledge.listProviders()).toEqual(['alpha', 'beta'])
      // The disposer removes the provider immediately.
      disposeA()
      expect(ctx.knowledge.listProviders()).toEqual(['beta'])
      // Unloading the registering fiber removes the rest.
      const owner = await ctx.plugin(Object.assign((inner: Context) => {
        // Register through the CALLER's view so the disposer binds to the
        // plugin fiber, not the root.
        inner.knowledge.registerProvider(fakeProvider('gamma', []).provider)
      }, { inject: ['knowledge'] }))
      expect(ctx.knowledge.listProviders()).toEqual(['beta', 'gamma'])
      await owner.dispose()
      expect(ctx.knowledge.listProviders()).toEqual(['beta'])
      // Duplicate names are rejected.
      expect(() => ctx.knowledge.registerProvider(b.provider)).toThrow(/already registered/)
      expect(() => ctx.knowledge.registerProvider({ name: '', retrieve: async () => [] })).toThrow(TypeError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('retrieves ranked results preserving provider order and registration order', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      const first = fakeProvider('first', [row('a1'), row('a2')])
      const second = fakeProvider('second', [row('b1'), row('b2')])
      ctx.knowledge.registerProvider(first.provider)
      ctx.knowledge.registerProvider(second.provider)
      const results = await ctx.knowledge.retrieve({ query: '  rocket science  ' })
      expect(results.map((result) => result.sourceId)).toEqual(['a1', 'a2', 'b1', 'b2'])
      // The request the providers saw is normalized and topK-filled.
      expect(first.calls[0]).toEqual({ query: 'rocket science', topK: DEFAULT_TOP_K })
      expect(second.calls[0]).toEqual({ query: 'rocket science', topK: DEFAULT_TOP_K })
      // Full result contract: source id, title, snippet, document version, locator.
      expect(results[0]).toMatchObject({
        sourceId: 'a1',
        title: 'Title of a1',
        snippet: 'snippet of a1',
        documentVersion: 1,
        locator: 'chunk 0',
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('caps the merged results at the global topK', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      ctx.knowledge.registerProvider(fakeProvider('first', [row('a1'), row('a2')]).provider)
      ctx.knowledge.registerProvider(fakeProvider('second', [row('b1'), row('b2')]).provider)
      const results = await ctx.knowledge.retrieve({ query: 'x', topK: 3 })
      expect(results.map((result) => result.sourceId)).toEqual(['a1', 'a2', 'b1'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('returns an empty collection for empty provider results — no fabricated sources', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      ctx.knowledge.registerProvider(fakeProvider('empty-a', []).provider)
      ctx.knowledge.registerProvider(fakeProvider('empty-b', []).provider)
      const results = await ctx.knowledge.retrieve({ query: 'nothing matches' })
      expect(results).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects invalid queries and topK values with a structured error', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      ctx.knowledge.registerProvider(fakeProvider('p', []).provider)
      const overlong = 'x'.repeat(MAX_QUERY_BYTES + 1)
      const cases: KnowledgeRequest[] = [
        { query: '' },
        { query: '   ' },
        { query: overlong },
        { query: 'ok', topK: 0 },
        { query: 'ok', topK: -3 },
        { query: 'ok', topK: 1.5 },
        { query: 'ok', topK: Number.NaN },
        { query: 'ok', topK: 101 },
        { query: 'ok', filter: { documentPath: '' } },
        { query: 'ok', filter: { minDocumentVersion: -1 } },
        { query: 'ok', filter: { mediaTypes: [] } },
        { query: 'ok', filter: { mediaTypes: ['text/markdown', ''] } },
      ]
      for (const request of cases) {
        await expect(ctx.knowledge.retrieve(request)).rejects.toMatchObject({
          code: 'INVALID_REQUEST',
          retryable: false,
        })
      }
      // 8 KiB exactly is accepted.
      const boundary = 'x'.repeat(MAX_QUERY_BYTES)
      await expect(ctx.knowledge.retrieve({ query: boundary, topK: 8 })).resolves.toEqual([])
      // The pure validator exposes the same rules.
      expect(validateKnowledgeRequest({ query: '  ok  ' })).toEqual({ query: 'ok', topK: DEFAULT_TOP_K })
      expect(() => validateKnowledgeRequest({ query: '' })).toThrowError(KnowledgeQueryError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('raises PROVIDER_NOT_FOUND when no provider is registered', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      await expect(ctx.knowledge.retrieve({ query: 'anything' })).rejects.toThrowError(KnowledgeProviderNotFoundError)
      await expect(ctx.knowledge.retrieve({ query: 'anything' })).rejects.toMatchObject({
        code: 'PROVIDER_NOT_FOUND',
        retryable: false,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('never calls an unloaded provider for new retrievals', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      const a = fakeProvider('alpha', [row('a1')])
      const b = fakeProvider('beta', [row('b1')])
      const disposeA = ctx.knowledge.registerProvider(a.provider)
      ctx.knowledge.registerProvider(b.provider)
      await ctx.knowledge.retrieve({ query: 'x' })
      expect(a.calls).toHaveLength(1)
      expect(b.calls).toHaveLength(1)
      disposeA()
      await ctx.knowledge.retrieve({ query: 'x' })
      // Alpha was not called again after unloading; beta served the retrieval.
      expect(a.calls).toHaveLength(1)
      expect(b.calls).toHaveLength(2)
      // Unloading the registering fiber removes the provider too.
      const owner = await ctx.plugin(Object.assign((inner: Context) => {
        inner.knowledge.registerProvider(fakeProvider('gamma', [row('g1')]).provider)
      }, { inject: ['knowledge'] }))
      expect(ctx.knowledge.listProviders()).toEqual(['beta', 'gamma'])
      await owner.dispose()
      expect(ctx.knowledge.listProviders()).toEqual(['beta'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects the whole retrieval when a provider fails — no silent omission', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      ctx.knowledge.registerProvider(fakeProvider('good', [row('g1')]).provider)
      const failing: KnowledgeProvider = {
        name: 'failing',
        async retrieve() {
          throw new Error('index offline')
        },
      }
      ctx.knowledge.registerProvider(failing)
      await expect(ctx.knowledge.retrieve({ query: 'x' })).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        provider: 'failing',
        retryable: false,
      })
      await expect(ctx.knowledge.retrieve({ query: 'x' })).rejects.toThrow(/index offline/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects contract-violating result rows with a structured error naming the provider', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      const bad: KnowledgeProvider = {
        name: 'sloppy',
        async retrieve() {
          return [row('ok'), { ...row('bad'), locator: '' }]
        },
      }
      const disposeSloppy = ctx.knowledge.registerProvider(bad)
      await expect(ctx.knowledge.retrieve({ query: 'x' })).rejects.toThrowError(KnowledgeProviderError)
      await expect(ctx.knowledge.retrieve({ query: 'x' })).rejects.toMatchObject({
        code: 'INTERNAL_ERROR',
        provider: 'sloppy',
      })
      // A second contract violator is named the same way once the first is gone.
      disposeSloppy()
      const badVersion: KnowledgeProvider = {
        name: 'sloppy-version',
        async retrieve() {
          return [{ ...row('v'), documentVersion: -2 }]
        },
      }
      ctx.knowledge.registerProvider(badVersion)
      await expect(ctx.knowledge.retrieve({ query: 'x' })).rejects.toMatchObject({ provider: 'sloppy-version' })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('forwards filters to providers and honours cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(KnowledgeService)
    try {
      const filtered = fakeProvider('filtered', [row('f1')])
      ctx.knowledge.registerProvider(filtered.provider)
      await ctx.knowledge.retrieve({
        query: 'x',
        topK: 5,
        filter: { documentPath: 'docs/plan.md', minDocumentVersion: 2, mediaTypes: ['text/markdown'] },
      })
      expect(filtered.calls[0]).toEqual({
        query: 'x',
        topK: 5,
        filter: { documentPath: 'docs/plan.md', minDocumentVersion: 2, mediaTypes: ['text/markdown'] },
      })
      // Aborted signal stops the retrieval.
      const aborted = new AbortController()
      aborted.abort()
      await expect(ctx.knowledge.retrieve({ query: 'x' }, aborted.signal)).rejects.toThrow()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
