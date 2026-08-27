/**
 * Issue 004: minimal domain-agnostic Rigo Core boot (SPEC §2.2 Layer 1).
 *
 * Mounts the per-turn core on a fresh Cordis root:
 *
 *   LLM Registry → Session Event Log → System Prompt → Tool Registry →
 *   Agent API → default Agent Loop
 *
 * and guarantees, before resolving:
 *   - every mounted plugin fiber is ready (Cordis resolves `ctx.plugin()`
 *     only when the fiber activated and its `inject` dependencies resolved);
 *   - every core service key is resolvable through `ctx.get(...)`.
 *
 * `dispose()` releases the whole tree; Cordis disposes plugin fibers in
 * reverse registration order, so side effects unwind exactly once, newest
 * first. When any plugin cannot start (missing inject, apply throw, config
 * rejection), the already-mounted tree is rolled back in the same reverse
 * order before the error propagates.
 *
 * The minimal core deliberately mounts no persistence, actions, approval,
 * knowledge, HTTP/SSE, and no Rigo Work or Rigo Code domain plugin — the
 * public runtime boundary Issue 004 exists to pin down.
 *
 * @module @teoclub/harness-app-boot/core-boot
 */

import { Context, FiberState, type Plugin } from '@teoclub/cordis'
import AgentRegistry from '@teoclub/harness-agent'
import AgentLoop, { type Config as AgentLoopConfig } from '@teoclub/harness-agent-loop'
import LlmRuntime, { type LlmAdapter } from '@teoclub/harness-llm'
import SessionStore from '@teoclub/harness-session'
import SystemPrompt from '@teoclub/harness-system-prompt'
import ToolRuntime from '@teoclub/harness-tools'

/** The minimal core plugin tree, in deterministic registration order. */
export const CORE_PLUGINS = [
  LlmRuntime,
  SessionStore,
  SystemPrompt,
  ToolRuntime,
  AgentRegistry,
  AgentLoop,
] as const

/** Every core service key the minimal boot guarantees to provide. */
export const CORE_SERVICE_KEYS = ['llm', 'sessions', 'systemPrompt', 'tools', 'agents', 'agentLoop'] as const

export interface CoreBootOptions {
  /** Agent-loop configuration; defaults to an empty declarative-agent list. */
  agents?: AgentLoopConfig['agents']
  /** LLM adapters registered after the LLM runtime mounts: provider route → adapter. */
  adapters?: Record<string, LlmAdapter>
  /** Extra plugins mounted after the core tree, before the boot settles. */
  plugins?: Plugin[]
  /** Callback after the core tree mounts (observers, disposers, adapters); awaited. */
  setup?: (ctx: Context) => void | Promise<void>
}

export interface CoreBootHandle {
  /** The booted root context. */
  ctx: Context
  /** Reverse-order teardown of the whole core tree; safe to call twice. */
  dispose(): Promise<void>
}

/** Assert every core service key resolves; otherwise the tree is not usable. */
function assertCoreAvailable(ctx: Context): void {
  for (const key of CORE_SERVICE_KEYS) {
    const service = ctx.get(key)
    if (service === undefined) {
      throw new Error(`core boot: service "${key}" is not available after the plugin tree settled`)
    }
  }
}

/**
 * Mount one plugin and require it to reach the ACTIVE fiber state. Awaiting
 * the plugin fiber alone is not enough: a plugin whose inject dependency is
 * missing settles in PENDING without ever activating.
 */
async function mountActive(ctx: Context, plugin: Plugin, label: string, config?: unknown): Promise<void> {
  const fiber = ctx.plugin(plugin, config) as unknown as { state: FiberState; await(): Promise<unknown> }
  await fiber.await()
  if (fiber.state !== FiberState.ACTIVE) {
    throw new Error(`core boot: plugin "${label}" did not become active (fiber state ${fiber.state}); a required service may be missing`)
  }
}

/**
 * Boot the minimal Rigo Core.
 *
 * @param options - agent-loop config, adapters, extra plugins, setup hook.
 * @returns a handle owning the root context and its reverse-order teardown.
 * @throws the first plugin startup error after rolling back everything that
 *   had already mounted (reverse registration order).
 */
export async function bootCore(options: CoreBootOptions = {}): Promise<CoreBootHandle> {
  const ctx = new Context()
  const dispose = (): Promise<void> => ctx.fiber.dispose()
  try {
    // The LLM runtime mounts first so adapters can register before the
    // agent loop mounts (its declarative agents resolve models at startup).
    await mountActive(ctx, LlmRuntime, 'LlmRuntime')
    if (options.adapters) {
      for (const [route, adapter] of Object.entries(options.adapters)) {
        ctx.llm.registerAdapter([route], adapter)
      }
    }
    for (const plugin of CORE_PLUGINS.slice(1)) {
      // AgentLoop is the only core plugin with required config shape; the
      // rest accept no config (their zod schemas default everything).
      const label = (plugin as { name?: string }).name ?? 'core-plugin'
      await mountActive(ctx, plugin, label, plugin === AgentLoop ? { agents: options.agents ?? [] } : undefined)
    }
    await options.setup?.(ctx)
    for (const plugin of options.plugins ?? []) {
      const label = (plugin as { name?: string }).name ?? 'extra-plugin'
      await mountActive(ctx, plugin, label)
    }
    // The availability assertion runs last, so a plugin that starts but
    // fails to provide its service also fails the boot (and triggers the
    // same reverse-order rollback).
    assertCoreAvailable(ctx)
    return { ctx, dispose }
  } catch (error) {
    // Partial-startup rollback: every mounted fiber is disposed in reverse
    // registration order; swallow teardown errors so the original cause wins.
    await dispose().catch(() => undefined)
    throw error
  }
}
