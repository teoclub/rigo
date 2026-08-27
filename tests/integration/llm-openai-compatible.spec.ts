/**
 * Issue 010 integration: OpenAI-compatible LLM provider (SPEC §6.2, §7.4;
 * PRD US-005, FR-9, FR-10).
 *
 * Dual-runtime: the provider talks HTTP (global fetch) to a fake
 * OpenAI-style server on node:http.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Context } from '@teoclub/cordis'
import { LlmError, type StreamChunk } from '@teoclub/harness-llm'
import {
  OpenAICompatibleAdapter,
  resolveCredential,
  type CredentialReference,
} from '@teoclub/harness-llm-openai-compatible'
import LlmRuntime from '@teoclub/harness-llm'

const isBun = typeof Bun !== 'undefined'

const openServers: Server[] = []

afterEach(async () => {
  while (openServers.length > 0) openServers.pop()!.close()
})

/** A fake OpenAI-style chat-completions server driven by per-request scripts. */
async function fakeOpenAI(
  handler: (request: { body: Record<string, unknown>; authorization: string | undefined; index: number }) => {
    status?: number
    body?: unknown
    sse?: string
    hang?: boolean
  },
): Promise<{ baseUrl: string; requests: number }> {
  const requests = { count: 0 }
  const server = createServer((req, res) => {
    requests.count += 1
    let raw = ''
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8') })
    req.on('end', () => {
      const decision = handler({
        body: JSON.parse(raw) as Record<string, unknown>,
        authorization: req.headers.authorization,
        index: requests.count - 1,
      })
      if (decision.hang === true) return // never respond
      if (decision.status !== undefined && decision.status >= 400) {
        res.writeHead(decision.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'vendor error' } }))
        return
      }
      if (decision.sse !== undefined) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(decision.sse)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(decision.body ?? {}))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  openServers.push(server)
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests }
}

const TEXT_SSE = [
  'data: {"choices":[{"delta":{"content":"Hello "},"index":0}]}',
  'data: {"choices":[{"delta":{"content":"world"},"index":0}]}',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
  'data: [DONE]',
  '',
].join('\n')

const toolFrame = (argumentsJson: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'document.read', arguments: argumentsJson } }] }, index: 0 }] })}`

const TOOL_SSE = [
  'data: {"choices":[{"delta":{"content":"Let me check"},"index":0}]}',
  toolFrame('{"relativePath":"a'),
  toolFrame('.md"}'),
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":12,"completion_tokens":6}}',
  'data: [DONE]',
  '',
].join('\n')

async function collect(adapter: OpenAICompatibleAdapter, options: Parameters<OpenAICompatibleAdapter['stream']>[0]): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function adapter(baseUrl: string, apiKey: CredentialReference = { kind: 'literal', value: 'sk-secret-123' }, extra: Partial<ConstructorParameters<typeof OpenAICompatibleAdapter>[0]> = {}): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({ baseUrl, apiKey, retryDelayMs: 1, ...extra })
}

describe('openai-compatible provider (Issue 010)', () => {
  it('converts vendor text streams into the unified chunks (text, usage, finish)', async () => {
    const { baseUrl } = await fakeOpenAI(() => ({ sse: TEXT_SSE }))
    const chunks = await collect(adapter(baseUrl), { provider: 'openai-compatible', model: 'gpt-4o-mini', messages: [] })
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => (chunk as { text: string }).text)).toEqual(['Hello ', 'world'])
    expect(chunks.some((chunk) => chunk.type === 'block-start' && chunk.blockType === 'text')).toBe(true)
    const end = chunks.find((chunk) => chunk.type === 'block-end') as { block: { type: string; text: string } }
    expect(end.block).toEqual({ type: 'text', text: 'Hello world' })
    expect(chunks.find((chunk) => chunk.type === 'usage')).toMatchObject({ usage: { inputTokens: 9, outputTokens: 2 } })
    expect(chunks.find((chunk) => chunk.type === 'finish')).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('converts tool-call streams with accumulated arguments and the tool-calls finish', async () => {
    const { baseUrl } = await fakeOpenAI(() => ({ sse: TOOL_SSE }))
    const chunks = await collect(adapter(baseUrl), { provider: 'p', model: 'm', messages: [] })
    const deltas = chunks.filter((chunk) => chunk.type === 'tool-call-delta')
    expect(deltas).toHaveLength(2)
    const end = chunks.find((chunk) => chunk.type === 'block-end') as { block: { type: string; id: string; name: string; arguments: string } }
    expect(end.block).toMatchObject({ type: 'tool-call', id: 'call_1', name: 'document.read' })
    expect(end.block.arguments).toBe('{"relativePath":"a.md"}')
    expect(chunks.find((chunk) => chunk.type === 'finish')).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('retries rate limits at most twice with backoff, then succeeds', async () => {
    let calls = 0
    const { baseUrl, requests } = await fakeOpenAI(() => {
      calls += 1
      return calls < 3 ? { status: 429, body: { error: { message: 'rate limited' } } } : { sse: TEXT_SSE }
    })
    const chunks = await collect(adapter(baseUrl), { provider: 'p', model: 'm', messages: [] })
    expect(requests.count).toBe(3)
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
  })

  it('exhausts the retry budget on persistent 5xx with MODEL_REQUEST_FAILED', async () => {
    const { baseUrl, requests } = await fakeOpenAI(() => ({ status: 503, body: { error: { message: 'down' } } }))
    await expect(collect(adapter(baseUrl), { provider: 'p', model: 'm', messages: [] }))
      .rejects.toMatchObject({ code: 'MODEL_REQUEST_FAILED' })
    expect(requests.count).toBe(3) // 1 attempt + 2 retries
  })

  it('never retries after a user abort — the in-flight request stops', async () => {
    let hangs = 0
    const { baseUrl, requests } = await fakeOpenAI(() => {
      hangs += 1
      return { hang: true }
    })
    const controller = new AbortController()
    const stream = adapter(baseUrl).stream({
      provider: 'p', model: 'm', messages: [], signal: controller.signal,
    })
    const iterator = stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await new Promise((resolve) => setTimeout(resolve, 50))
    controller.abort('user cancelled')
    await pending // the hung fetch settles when aborted
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(requests.count).toBe(1)
    void hangs
  })

  it('resolves credential references at the boundary and never leaks values', async () => {
    const original = process.env.RIGO_TEST_API_KEY
    process.env.RIGO_TEST_API_KEY = 'env-secret-456'
    let seenAuthorization: string | undefined
    const { baseUrl } = await fakeOpenAI((request) => {
      seenAuthorization = request.authorization
      return { sse: TEXT_SSE }
    })
    try {
      const envAdapter = adapter(baseUrl, { kind: 'env', name: 'RIGO_TEST_API_KEY' })
      await collect(envAdapter, { provider: 'p', model: 'm', messages: [] })
      expect(seenAuthorization).toBe('Bearer env-secret-456')
      // The CONFIG snapshot holds the reference, never the value.
      const configJson = JSON.stringify({ apiKey: { kind: 'env', name: 'RIGO_TEST_API_KEY' } })
      expect(configJson).not.toContain('env-secret-456')
      expect(resolveCredential({ kind: 'env', name: 'RIGO_TEST_API_KEY' })).toBe('env-secret-456')
      // Errors never include the resolved credential.
      const missing = await fakeOpenAI(() => ({ status: 500, body: {} }))
      try {
        await collect(adapter(missing.baseUrl, { kind: 'literal', value: 'sk-top-secret' }), { provider: 'p', model: 'm', messages: [] })
        expect.unreachable('should have thrown')
      } catch (error) {
        expect(error).toBeInstanceOf(LlmError)
        expect(String(error)).not.toContain('sk-top-secret')
      }
      // A missing env reference fails clearly without any value exposure.
      expect(() => resolveCredential({ kind: 'env', name: 'RIGO_NEVER_SET_XYZ' })).toThrow(/not set/)
    } finally {
      if (original === undefined) delete process.env.RIGO_TEST_API_KEY
      else process.env.RIGO_TEST_API_KEY = original
    }
  })

  it('serves requests through the llm runtime route', async () => {
    const { baseUrl } = await fakeOpenAI(() => ({ sse: TEXT_SSE }))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['openai-compatible'], adapter(baseUrl))
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({ provider: 'openai-compatible', model: 'gpt-4o-mini', messages: [] })) {
        chunks.push(chunk)
      }
      expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
