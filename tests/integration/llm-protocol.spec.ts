import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import { bootCore } from '@teoclub/harness-app-boot'
import { LlmError } from '@teoclub/harness-llm'
import {
  collectStream,
  ModelRateLimitedError,
  OperationAbortedError,
  ProviderNotFoundError,
  registerProvider,
  resolveProviderModel,
  mapLlmFailure,
} from '@teoclub/harness-llm-protocol'
import type { StreamChunk } from '@teoclub/harness-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../upstream/agent-loop/tests/mock-adapter.ts'

/**
 * Issue 009: LLM provider registry and unified streaming protocol (SPEC
 * §2.4, §5.1, §6.1, §6.3; PRD US-005, FR-13/14/15): named provider
 * register/unregister, provider+model resolution, the unified
 * Message/ContentBlock/StreamChunk contract, text/tool-call/usage/finish
 * streaming, abort → OPERATION_ABORTED, unknown provider/model →
 * PROVIDER_NOT_FOUND, and unload isolation.
 */

/** An adapter that refuses to resolve any model (unknown-model case). */
class UnknownModelAdapter extends MockAdapter {
  override resolveModel(): Promise<never> {
    return Promise.reject(new LlmError('unknown model "x" for provider "mock"', 'NO_MODEL'))
  }
}

describe('Rigo LLM provider protocol (Issue 009)', () => {
  it('registers named providers and resolves models by provider and model id', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([textResponse('ok')]) } })
    try {
      const resolved = await resolveProviderModel(handle.ctx, 'mock', 'deepseek-v4')
      expect(resolved.provider).toBe('mock')
      expect(resolved.id).toBe('deepseek-v4')
      expect(resolved.name).toBe('deepseek-v4')
    } finally {
      await handle.dispose()
    }
  })

  it('returns structured PROVIDER_NOT_FOUND for an unknown provider or model', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([textResponse('ok')]) } })
    try {
      await expect(resolveProviderModel(handle.ctx, 'absent', 'm')).rejects.toThrowError(ProviderNotFoundError)
      await expect(resolveProviderModel(handle.ctx, 'absent', 'm')).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND', retryable: false })
      // Unknown model on a REGISTERED provider is the same structured error.
      const strict = await bootCore({ adapters: { mock: new UnknownModelAdapter([]) } })
      try {
        await expect(resolveProviderModel(strict.ctx, 'mock', 'missing-model')).rejects.toThrowError(ProviderNotFoundError)
      } finally {
        await strict.dispose()
      }
    } finally {
      await handle.dispose()
    }
  })

  it('streams text, usage and the stop finish reason through the unified protocol', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([textResponse('hello there')]) } })
    try {
      const summary = await collectStream(handle.ctx, {
        provider: 'mock',
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
      })
      expect(summary.text).toBe('hello there')
      expect(summary.toolCalls).toEqual([])
      expect(summary.usage).toEqual({ inputTokens: 10, outputTokens: 11 })
      expect(summary.finishReason).toEqual({ kind: 'stop' })
    } finally {
      await handle.dispose()
    }
  })

  it('streams tool calls with their raw arguments and the tool-calls finish reason', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([toolCallResponse('c1', 'echo', { text: 'ping' }, 'calling')]) } })
    try {
      const summary = await collectStream(handle.ctx, { provider: 'mock', model: 'm', messages: [] })
      expect(summary.text).toBe('calling')
      expect(summary.toolCalls).toEqual([
        { id: 'c1', name: 'echo', arguments: JSON.stringify({ text: 'ping' }) },
      ])
      expect(summary.finishReason).toEqual({ kind: 'tool-calls' })
    } finally {
      await handle.dispose()
    }
  })

  it('aborts a running request with OPERATION_ABORTED and never retries', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter(['hang']) } })
    try {
      const controller = new AbortController()
      const collecting = collectStream(handle.ctx, {
        provider: 'mock',
        model: 'm',
        messages: [],
        signal: controller.signal,
      })
      const outcome = await Promise.race([
        collecting.then(() => 'resolved', (error: unknown) => error),
        new Promise((resolve) => setTimeout(() => resolve('still-running'), 30)),
      ])
      expect(outcome).toBe('still-running')
      controller.abort(new Error('user cancelled'))
      await expect(collecting).rejects.toThrowError(OperationAbortedError)
      await expect(collecting).rejects.toMatchObject({ code: 'OPERATION_ABORTED', retryable: false })
    } finally {
      await handle.dispose()
    }
  })

  it('maps a terminal rate-limit failure to retryable MODEL_RATE_LIMITED', async () => {
    const rateLimited: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: '429 too many requests' } } },
    ]
    // Function script entries re-compute per call, so both assertions below
    // exercise the same terminal failure.
    const handle = await bootCore({ adapters: { mock: new MockAdapter([() => rateLimited, () => rateLimited]) } })
    try {
      await expect(collectStream(handle.ctx, { provider: 'mock', model: 'm', messages: [] }))
        .rejects.toThrowError(ModelRateLimitedError)
      await expect(collectStream(handle.ctx, { provider: 'mock', model: 'm', messages: [] }))
        .rejects.toMatchObject({ code: 'MODEL_RATE_LIMITED', retryable: true })
    } finally {
      await handle.dispose()
    }
  })

  it('maps an unknown-provider stream to PROVIDER_NOT_FOUND', () => {
    expect(mapLlmFailure({ code: 'NO_ADAPTER', message: 'no adapter registered for provider "x"' }))
      .toBeInstanceOf(ProviderNotFoundError)
    expect(mapLlmFailure({ code: 'NO_ADAPTER', message: 'no adapter' })).toMatchObject({ code: 'PROVIDER_NOT_FOUND' })
  })

  it('unloads a provider fiber without affecting other providers', async () => {
    const handle = await bootCore({ adapters: { rootB: new MockAdapter([textResponse('b')]) } })
    try {
      const owner = await handle.ctx.plugin(Object.assign((inner: Context) => {
        registerProvider(inner, ['fiberA'], new MockAdapter([textResponse('a')]))
      }, { inject: ['llm'] }))
      expect((await resolveProviderModel(handle.ctx, 'fiberA', 'm')).provider).toBe('fiberA')
      expect((await resolveProviderModel(handle.ctx, 'rootB', 'm')).provider).toBe('rootB')

      // Unloading the owner fiber removes only ITS provider.
      await owner.dispose()
      await expect(resolveProviderModel(handle.ctx, 'fiberA', 'm')).rejects.toThrowError(ProviderNotFoundError)
      expect((await resolveProviderModel(handle.ctx, 'rootB', 'm')).provider).toBe('rootB')

      // The explicit disposer unregisters the same way.
      const disposer = registerProvider(handle.ctx, ['explicit'], new MockAdapter([textResponse('e')]))
      expect((await resolveProviderModel(handle.ctx, 'explicit', 'm')).provider).toBe('explicit')
      disposer()
      await expect(resolveProviderModel(handle.ctx, 'explicit', 'm')).rejects.toThrowError(ProviderNotFoundError)
    } finally {
      await handle.dispose()
    }
  })
})
