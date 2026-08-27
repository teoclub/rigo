/**
 * Rigo LLM provider protocol (Issue 009; SPEC §2.4, §5.1, §6.1, §6.3; PRD
 * US-005, FR-13/14/15).
 *
 * The stable, provider-neutral face over the ported LLM registry:
 *
 *   - the unified protocol types (`Message`, `ContentBlock`, `StreamChunk`,
 *     `TokenUsage`, `FinishReason`) are re-exported from the registry so one
 *     import surface pins the whole contract;
 *   - providers register and unregister by name with the fiber (an unloaded
 *     provider cannot be selected by new requests, and unloading one never
 *     touches the others);
 *   - SPEC §6.1 structured errors: `PROVIDER_NOT_FOUND` for unknown provider
 *     or model, `OPERATION_ABORTED` for caller cancellation, and the
 *     `MODEL_RATE_LIMITED` / `MODEL_REQUEST_FAILED` mapping for terminal
 *     stream failures;
 *   - `collectStream` reduces one stream to `{ text, toolCalls, usage,
 *     finishReason }` and surfaces aborted/error finishes as the structured
 *     errors above.
 *
 * @module @teoclub/harness-llm-protocol
 */

import type { Context } from '@teoclub/cordis'
import {
  LlmError,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmAdapter,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
  type TokenUsage,
} from '@teoclub/harness-llm'

// The unified protocol contract, pinned at one import surface.
export type { ContentBlock, FinishReason, GenerateOptions, LlmResolvedModelInfo, Message, StreamChunk, TokenUsage }

/** SPEC §6.1: unknown provider or model (HTTP 422, not retryable). */
export class ProviderNotFoundError extends Error {
  readonly code = 'PROVIDER_NOT_FOUND'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProviderNotFoundError'
  }
}

/** SPEC §6.1: caller cancellation (HTTP 409, not retryable). */
export class OperationAbortedError extends Error {
  readonly code = 'OPERATION_ABORTED'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OperationAbortedError'
  }
}

/** SPEC §6.1: provider rate limit (HTTP 503, retryable). */
export class ModelRateLimitedError extends Error {
  readonly code = 'MODEL_RATE_LIMITED'
  readonly retryable = true

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelRateLimitedError'
  }
}

/** SPEC §6.1: provider request failure (HTTP 502, conditionally retryable). */
export class ModelRequestFailedError extends Error {
  readonly code = 'MODEL_REQUEST_FAILED'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelRequestFailedError'
  }
}

/** A model failure surfaced by the ported stream terminal. */
export interface LlmProtocolFailure {
  code?: string
  message?: string
}

const UNKNOWN_MODEL = /unknown model|model .* not (?:found|supported)|no model/i

/** Map a terminal stream failure (or adapter error) to the Rigo error taxonomy. */
export function mapLlmFailure(failure: LlmProtocolFailure | unknown, signal?: AbortSignal): Error {
  const candidate = failure as { code?: string; message?: string } | null | undefined
  if (signal?.aborted === true) {
    return new OperationAbortedError('the model request was aborted', { cause: failure })
  }
  const code = candidate?.code ?? ''
  const message = candidate?.message ?? String(failure ?? 'model request failed')
  if (code === 'NO_ADAPTER' || UNKNOWN_MODEL.test(message)) {
    return new ProviderNotFoundError(`model request failed: ${message}`, { cause: failure })
  }
  if (code === 'RATE_LIMIT' || code === 'RATE_LIMITED' || /rate\s*limit/i.test(message)) {
    return new ModelRateLimitedError(`model request was rate limited: ${message}`, { cause: failure })
  }
  if (code === 'ABORTED' || /aborted/i.test(message)) {
    return new OperationAbortedError(`model request was aborted: ${message}`, { cause: failure })
  }
  return new ModelRequestFailedError(`model request failed: ${message}`, { cause: failure })
}

export interface ResolvedProviderModel extends LlmResolvedModelInfo {
  provider: string
  id: string
}

/**
 * Resolve a model through the provider registry by provider and model id.
 * @param ctx - a context with the LLM registry mounted.
 * @param provider - the named provider route.
 * @param model - the model id.
 * @param signal - optional cancellation.
 * @returns the validated resolved model metadata.
 * @throws {@link ProviderNotFoundError} when the provider has no adapter or
 *   the adapter cannot resolve the model; {@link OperationAbortedError} when
 *   the signal fired first.
 */
export async function resolveProviderModel(
  ctx: Context,
  provider: string,
  model: string,
  signal?: AbortSignal,
): Promise<ResolvedProviderModel> {
  signal?.throwIfAborted()
  try {
    return await ctx.llm.resolveModelInfo(provider, model, signal) as ResolvedProviderModel
  } catch (error) {
    if (signal?.aborted === true) throw new OperationAbortedError('the model request was aborted', { cause: error })
    if (error instanceof LlmError && error.code === 'NO_ADAPTER') {
      throw new ProviderNotFoundError(`no adapter registered for provider "${provider}"`, { cause: error })
    }
    if (error instanceof ProviderNotFoundError) throw error
    if (error instanceof OperationAbortedError) throw error
    throw mapLlmFailure(error)
  }
}

export interface ToolCallRecord {
  id: string
  name: string
  arguments: string
}

export interface StreamSummary {
  /** Assembled assistant text (all text blocks, in order). */
  text: string
  /** Tool calls requested by the model (in order). */
  toolCalls: ToolCallRecord[]
  /** Token accounting reported by the adapter, when any. */
  usage: TokenUsage | undefined
  /** The terminal finish reason. */
  finishReason: FinishReason
}

/**
 * Collect one model stream through the unified protocol.
 *
 * @param ctx - a context with the LLM registry mounted.
 * @param options - the full model request (provider, model, messages, …).
 * @returns the assembled summary.
 * @throws {@link OperationAbortedError} when the request was cancelled,
 *   {@link ProviderNotFoundError} / {@link ModelRateLimitedError} /
 *   {@link ModelRequestFailedError} for the mapped terminal failure.
 */
export async function collectStream(ctx: Context, options: GenerateOptions): Promise<StreamSummary> {
  const textBlocks: string[] = []
  const toolCalls: ToolCallRecord[] = []
  let usage: TokenUsage | undefined
  let finishReason: FinishReason | undefined
  let failure: unknown

  for await (const chunk of ctx.llm.stream(options)) {
    switch (chunk.type) {
      case 'text-delta':
        textBlocks.push(chunk.text)
        break
      case 'block-end':
        if (chunk.block.type === 'tool-call') {
          toolCalls.push({
            id: chunk.block.id,
            name: chunk.block.name,
            arguments: chunk.block.arguments,
          })
        }
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finishReason = chunk.reason
        if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
          failure = chunk.reason.failure
        }
        break
      default:
        break
    }
  }

  if (options.signal?.aborted === true) {
    throw new OperationAbortedError('the model request was aborted', { cause: failure })
  }
  if (failure !== undefined) {
    throw mapLlmFailure(failure, options.signal)
  }
  if (finishReason === undefined) {
    throw new ModelRequestFailedError('the model stream ended without a finish reason')
  }
  return { text: textBlocks.join(''), toolCalls, usage, finishReason }
}

/**
 * Register one named provider with the fiber. The registration is released
 * when the calling fiber unloads, so an unloaded provider can never be
 * selected by new requests.
 * @param ctx - a context with the LLM registry mounted.
 * @param providers - the provider routes this adapter serves.
 * @param adapter - the streaming adapter.
 * @returns a disposer for the registration.
 */
export function registerProvider(ctx: Context, providers: string[], adapter: LlmAdapter): () => void {
  return ctx.llm.registerAdapter(providers, adapter)
}
