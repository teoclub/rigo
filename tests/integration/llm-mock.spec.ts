/**
 * Issue 010 integration: Rigo Mock LLM provider (SPEC §9.3; PRD US-005).
 *
 * The shipped scripted adapter: deterministic text/tool streams, errors,
 * dropped streams, unknown tools and aborts — through the llm runtime.
 * Dual-runtime.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import { LlmError, type StreamChunk } from '@teoclub/harness-llm'
import { MockAdapter, textResponse, toolCallResponse } from '@teoclub/harness-llm-mock'

async function collect(ctx: Context, options: Parameters<typeof ctx.llm.stream>[0]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream(options)) chunks.push(chunk)
  return chunks
}

describe('mock llm provider (Issue 010)', () => {
  it('runs scripted text, tool and error scenarios through the runtime', async () => {
    const ctx = new Context()
    const { default: LlmRuntime } = await import('@teoclub/harness-llm') as typeof import('@teoclub/harness-llm')
    try {
      await ctx.plugin(LlmRuntime)
      const adapter = new MockAdapter([textResponse('hello mock')])
      ctx.llm.registerAdapter(['mock'], adapter)

      // Text script.
      const text = await collect(ctx, { provider: 'mock', model: 'mock', messages: [] })
      expect(text.find((chunk) => chunk.type === 'block-end')).toMatchObject({ block: { type: 'text', text: 'hello mock' } })
      expect(text.find((chunk) => chunk.type === 'finish')).toEqual({ type: 'finish', reason: { kind: 'stop' } })
      expect(text.find((chunk) => chunk.type === 'usage')).toMatchObject({ usage: { outputTokens: 10 } })

      // Tool script: a multi-tool stream with accumulated arguments.
      const toolAdapter = new MockAdapter([toolCallResponse('call-1', 'document.read', { relativePath: 'a.md' }, 'reading')])
      ctx.llm.registerAdapter(['mock-tool'], toolAdapter)
      const tool = await collect(ctx, { provider: 'mock-tool', model: 'mock', messages: [] })
      expect(tool.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toMatchObject({
        block: { type: 'tool-call', id: 'call-1', name: 'document.read', arguments: '{"relativePath":"a.md"}' },
      })
      expect(tool.find((chunk) => chunk.type === 'finish')).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })

      // Error script: a provider failure surfaces as an error finish chunk
      // carrying only the safe failure record (SPEC §7.4).
      const errorAdapter = new MockAdapter([() => {
        throw new Error('vendor exploded')
      }])
      ctx.llm.registerAdapter(['mock-error'], errorAdapter)
      const error = await collect(ctx, { provider: 'mock-error', model: 'mock', messages: [] })
      const finish = error.at(-1)!
      expect(finish.type).toBe('finish')
      expect((finish as { reason: { failure: { message: string } } }).reason.failure.message).toBe('vendor exploded')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('hangs until aborted without retrying, and never leaks credentials', async () => {
    const { default: LlmRuntime } = await import('@teoclub/harness-llm') as typeof import('@teoclub/harness-llm')
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      const adapter = new MockAdapter(['hang'])
      ctx.llm.registerAdapter(['mock-hang'], adapter)
      const controller = new AbortController()
      const stream = ctx.llm.stream({ provider: 'mock-hang', model: 'mock', messages: [], signal: controller.signal })
      const iterator = stream[Symbol.asyncIterator]()
      const first = await iterator.next() // the hang streams its chunks first
      expect(first.done).toBe(false)
      controller.abort('user stopped')
      // After the abort the stream ends with an error finish — no retry.
      const deadline = Date.now() + 3000
      const chunks: StreamChunk[] = []
      while (Date.now() < deadline) {
        const next = await iterator.next()
        if (next.done === true) break
        chunks.push(next.value)
      }
      // The hang's remaining chunk (text-delta) plus the abort's error finish.
      expect(chunks).toHaveLength(2)
      const abortFinish = chunks.at(-1)!
      expect(abortFinish.type).toBe('finish')
      expect(String(JSON.stringify(abortFinish))).not.toContain('sk-leak')
      // Errors carry no credential-shaped values.
      const errorAdapter = new MockAdapter([() => {
        throw Object.assign(new Error('boom'), { internal: { apiKey: 'sk-leak' } })
      }])
      ctx.llm.registerAdapter(['mock-leak'], errorAdapter)
      try {
        await collect(ctx, { provider: 'mock-leak', model: 'mock', messages: [] })
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(String(error)).not.toContain('sk-leak')
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
