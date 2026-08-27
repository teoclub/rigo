/**
 * Rigo OpenAI-compatible LLM provider (Issue 010; SPEC §7.4, §6.2; PRD
 * US-005, FR-9, FR-10).
 *
 * An {@link LlmAdapter} speaking the OpenAI chat-completions streaming
 * protocol:
 *
 *   - the API key arrives as a {@link CredentialReference} (env or
 *     literal); the CONFIG snapshot holds the reference, never the value
 *     (SPEC §7.4), and the value is resolved only at the request boundary;
 *   - vendor stream chunks convert to the unified vocabulary: text deltas,
 *     tool-call deltas (id/name/arguments accumulated), usage and the
 *     finish reason (stop/tool-calls/max-tokens mapping);
 *   - retryable failures (HTTP 429, connection resets, 5xx) retry at most
 *     {@link DEFAULT_MAX_RETRIES} (2) times with capped exponential backoff
 *     and jitter (SPEC §6.2); a user abort stops the request and NEVER
 *     retries;
 *   - failures surface as {@link LlmError} with the stable codes
 *     `MODEL_RATE_LIMITED` / `MODEL_REQUEST_FAILED` / `OPERATION_ABORTED`,
 *     carrying only safe provider facts — never raw response bodies.
 *
 * @module @teoclub/harness-llm-openai-compatible
 */

import {
  CallId,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type StreamChunk,
  type ToolSchema,
} from '@teoclub/harness-llm'

// ---------------------------------------------------------------------------
// Credential references (SPEC §7.4)
// ---------------------------------------------------------------------------

/** One credential position: a reference, never a stored value. */
export type CredentialReference =
  | { kind: 'env'; name: string }
  | { kind: 'literal'; value: string }

/**
 * Resolve a credential reference AT THE PROVIDER BOUNDARY. The resolved
 * value never enters config snapshots, logs or errors.
 */
export function resolveCredential(reference: CredentialReference): string {
  if (reference.kind === 'literal') return reference.value
  const value = process.env[reference.name]
  if (value === undefined || value.length === 0) {
    throw new LlmError(
      `credential environment variable "${reference.name}" is not set`,
      'PROVIDER_NOT_FOUND',
    )
  }
  return value
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface OpenAICompatibleConfig {
  /** Base URL of the OpenAI-compatible API, e.g. `https://api.openai.com/v1`. */
  baseUrl: string
  /** Credential reference for the API key (SPEC §7.4). */
  apiKey: CredentialReference
  /** Additional request headers (never the credential — use apiKey). */
  headers?: Record<string, string>
  /** Retry budget for retryable failures (default {@link DEFAULT_MAX_RETRIES}). */
  maxRetries?: number
  /** Base backoff delay in ms (default {@link DEFAULT_RETRY_BASE_MS}). */
  retryDelayMs?: number
}

export const DEFAULT_MAX_RETRIES = 2
export const DEFAULT_RETRY_BASE_MS = 250
const BACKOFF_CAP_MS = 8000
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

function backoffDelay(baseMs: number, attempt: number): number {
  const exponential = baseMs * 2 ** attempt
  const jitter = Math.floor(Math.random() * baseMs)
  return Math.min(exponential + jitter, BACKOFF_CAP_MS)
}

/** Abort probe that TS cannot narrow away across awaits. */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** The unified OpenAI-compatible adapter. */
export class OpenAICompatibleAdapter extends LlmAdapter {
  private readonly config: OpenAICompatibleConfig
  private readonly maxRetries: number
  private readonly retryDelayMs: number

  constructor(config: OpenAICompatibleConfig) {
    super()
    if (config?.baseUrl === undefined || config.baseUrl.length === 0) {
      throw new TypeError('openai-compatible adapter requires a baseUrl')
    }
    if (config?.apiKey === undefined) {
      throw new TypeError('openai-compatible adapter requires an apiKey credential reference')
    }
    this.config = config
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES
    this.retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_BASE_MS
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'openai-compatible' }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const apiKey = resolveCredential(this.config.apiKey)
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`
    const body = buildRequestBody(options)
    let attempt = 0
    while (true) {
      if (isAborted(options.signal)) return
      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
            ...this.config.headers,
          },
          body: JSON.stringify(body),
          signal: options.signal ?? null,
        })
      } catch (error) {
        if (isAborted(options.signal)) return
        if (attempt < this.maxRetries && isRetryableNetworkError(error)) {
          attempt += 1
          await wait(backoffDelay(this.retryDelayMs, attempt), options.signal)
          continue
        }
        throw new LlmError(
          `openai-compatible request failed: ${error instanceof Error ? error.message : String(error)}`,
          'MODEL_REQUEST_FAILED',
          { cause: error },
        )
      }
      if (!response.ok) {
        if (response.status === 429 && attempt < this.maxRetries) {
          attempt += 1
          await wait(backoffDelay(this.retryDelayMs, attempt), options.signal)
          continue
        }
        if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
          attempt += 1
          await wait(backoffDelay(this.retryDelayMs, attempt), options.signal)
          continue
        }
        throw new LlmError(
          `openai-compatible request failed with HTTP ${response.status}`,
          response.status === 429 ? 'MODEL_RATE_LIMITED' : 'MODEL_REQUEST_FAILED',
        )
      }
      // Unified stream conversion (no raw provider payloads are re-emitted).
      for await (const chunk of convertStream(response.body!, options)) {
        yield chunk
      }
      return
    }
  }
}

function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false
  const code = (error as { code?: unknown } | null)?.code
  // Connection resets and similar transport failures.
  return typeof code === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT'].includes(code)
}

function buildRequestBody(options: GenerateOptions): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    const content = message.content.map((block) => {
      switch (block.type) {
        case 'text': return { type: 'text', text: block.text }
        case 'tool-result': return { type: 'text', text: String((block as { content?: unknown }).content) }
        default: return { type: 'text', text: '' }
      }
    })
    messages.push({ role: message.role, content })
  }
  const tools: Record<string, unknown>[] | undefined = options.tools?.map((tool: ToolSchema) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  return {
    model: options.model,
    messages,
    stream: true,
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(options.stop === undefined || options.stop.length === 0 ? {} : { stop: options.stop }),
  }
}

/**
 * Convert the OpenAI chat-completions SSE body into the unified chunk
 * stream. The signal stops the conversion and cancels the fetch — a user
 * abort never retries.
 */
async function* convertStream(body: ReadableStream<Uint8Array> | null, options: GenerateOptions): AsyncIterable<StreamChunk> {
  if (body === null) return
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let index = 0
  let openBlock: { type: 'text' | 'tool-call'; text?: string; id?: string; name?: string; arguments?: string } | undefined
  try {
    while (true) {
      if (isAborted(options.signal)) {
        await reader.cancel()
        return
      }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary: number
      while ((boundary = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, boundary).trim()
        buffer = buffer.slice(boundary + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') break
        let frame: {
          choices?: { delta?: Record<string, unknown>; finish_reason?: string | null }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number } | null
        }
        try {
          frame = JSON.parse(payload) as typeof frame
        } catch {
          continue // a malformed vendor frame never reaches the model
        }
        const delta = frame.choices?.[0]?.delta
        if (delta !== undefined) {
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (openBlock === undefined) {
              openBlock = { type: 'text', text: '' }
              yield { type: 'block-start', index, blockType: 'text' }
            }
            openBlock.text = (openBlock.text ?? '') + delta.content
            yield { type: 'text-delta', index, text: delta.content }
          }
          const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : []
          for (const call of toolCalls as { id?: string; function?: { name?: string; arguments?: string } }[]) {
            const id = call.id ?? ''
            const name = call.function?.name ?? ''
            const argumentsDelta = call.function?.arguments ?? ''
            if (openBlock === undefined || openBlock.type !== 'tool-call') {
              openBlock = { type: 'tool-call', id, name, arguments: '' }
              yield { type: 'block-start', index, blockType: 'tool-call' }
            }
            openBlock.arguments = (openBlock.arguments ?? '') + argumentsDelta
            yield { type: 'tool-call-delta', index, id: CallId(id), name, argumentsDelta }
          }
        }
        const finishReason = frame.choices?.[0]?.finish_reason
        if (finishReason !== undefined && finishReason !== null) {
          if (openBlock !== undefined) {
            if (openBlock.type === 'text') {
              yield { type: 'block-end', index, block: { type: 'text', text: openBlock.text ?? '' } }
            } else {
              yield {
                type: 'block-end',
                index,
                block: {
                  type: 'tool-call',
                  id: CallId(openBlock.id ?? ''),
                  name: openBlock.name ?? '',
                  arguments: openBlock.arguments ?? '',
                },
              }
            }
            openBlock = undefined
            index += 1
          }
          yield { type: 'finish', reason: mapFinishReason(finishReason) }
        }
        if (frame.usage !== undefined && frame.usage !== null) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: frame.usage.prompt_tokens ?? 0,
              outputTokens: frame.usage.completion_tokens ?? 0,
            },
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
  // A stream that ends without an explicit finish closes any open block.
  if (openBlock !== undefined) {
    if (openBlock.type === 'text') {
      yield { type: 'block-end', index, block: { type: 'text', text: openBlock.text ?? '' } }
    } else {
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id: CallId(openBlock.id ?? ''), name: openBlock.name ?? '', arguments: openBlock.arguments ?? '' },
      }
    }
  }
}

function mapFinishReason(reason: string): { kind: 'stop' } | { kind: 'tool-calls' } | { kind: 'max-tokens' } {
  switch (reason) {
    case 'tool_calls': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default: return { kind: 'stop' }
  }
}

export default OpenAICompatibleAdapter
