import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import { bootCore, CORE_PLUGINS, CORE_SERVICE_KEYS } from '@teoclub/harness-app-boot'
import { SessionId } from '@teoclub/harness-session'
import { MockAdapter, textResponse } from '../upstream/agent-loop/tests/mock-adapter.ts'

/**
 * Issue 004: minimal domain-agnostic Rigo Core boot (SPEC §2.2 Layer 1,
 * §9.3; PRD US-002, FR-4/FR-5/FR-35).
 */

function mockAdapter(): MockAdapter {
  return new MockAdapter([textResponse('ok')])
}

/** Plugin-shaped function recording an effect disposer under a label. */
function observedPlugin(label: string, log: string[]): (ctx: Context) => void {
  return (ctx) => {
    ctx.effect(() => () => { log.push(`dispose:${label}`) })
  }
}

describe('minimal Rigo Core boot (Issue 004)', () => {
  it('mounts the core plugin tree in deterministic order', () => {
    expect(CORE_PLUGINS.map((plugin) => plugin.name)).toEqual([
      'LlmRuntime',
      'SessionStore',
      'SystemPrompt',
      'ToolRuntime',
      'AgentRegistry',
      'AgentLoop',
    ])
  })

  it('boots and exposes every core service, with no layer-2/3 services', async () => {
    const handle = await bootCore()
    try {
      for (const key of CORE_SERVICE_KEYS) {
        expect(handle.ctx.get(key), `core service ${key}`).toBeDefined()
      }
      // The public runtime boundary: persistence, actions, approval, audit,
      // knowledge, documents, HTTP and the domain bundles are NOT mounted.
      for (const absent of ['sessionPersistence', 'actions', 'approvals', 'audit', 'knowledge', 'documents', 'http']) {
        expect(handle.ctx.get(absent), `layer-2/3 service ${absent}`).toBeUndefined()
      }
      // The agent loop is immediately usable.
      const agent = handle.ctx.agentLoop.create(SessionId('fresh'), { provider: 'mock', model: 'mock' })
      expect(agent.status).toBe('idle')
      await agent.whenIdle()
    } finally {
      await handle.dispose()
    }
  })

  it('waits for every necessary plugin to become available before resolving', async () => {
    const order: string[] = []
    const gate = Promise.withResolvers<void>()
    let bootSettled = false
    const handlePromise = bootCore({
      plugins: [
        {
          name: 'slow-plugin',
          apply: async (ctx: Context) => {
            order.push('apply:slow-start')
            await gate.promise
            order.push('apply:slow-ready')
            ctx.effect(() => () => { order.push('dispose:slow') })
          },
        },
      ],
    })
    const settledProbe = handlePromise.then(() => { bootSettled = true })

    // The boot must not resolve while the slow plugin is still applying.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(bootSettled).toBe(false)
    expect(order).toEqual(['apply:slow-start'])

    gate.resolve()
    await settledProbe
    expect(bootSettled).toBe(true)
    expect(order).toEqual(['apply:slow-start', 'apply:slow-ready'])
    const handle = await handlePromise
    await handle.dispose()
    expect(order).toEqual(['apply:slow-start', 'apply:slow-ready', 'dispose:slow'])
  })

  it('registers adapters and declarative agents before the boot settles', async () => {
    const sessionId = SessionId('booted-agent-session')
    const handle = await bootCore({
      adapters: { mock: mockAdapter() },
      agents: [{ id: 'booted-agent', sessionId, provider: 'mock', model: 'mock' }],
    })
    try {
      const agent = handle.ctx.agents.get(sessionId)
      expect(agent).toBeDefined()
      expect(agent!.status).toBe('idle')
      // A follow-up message resolves through the registered adapter.
      agent!.followup({
        role: 'user',
        content: [{ type: 'text', text: 'ping' }],
        source: { kind: 'user' },
      })
      await agent!.whenIdle()
      expect(agent!.status).toBe('idle')
    } finally {
      await handle.dispose()
    }
  })

  it('disposes plugins and side effects in reverse registration order', async () => {
    const order: string[] = []
    const handle = await bootCore({
      setup: (ctx) => { ctx.effect(() => () => { order.push('dispose:setup') }) },
      plugins: [
        observedPlugin('first', order),
        observedPlugin('second', order),
      ],
    })
    expect(order).toEqual([])
    await handle.dispose()
    // Deterministic unwind: the root's own effects run first, then plugin
    // child fibers newest-first (Cordis fiber semantics).
    expect(order).toEqual(['dispose:setup', 'dispose:second', 'dispose:first'])
    // Core services are unregistered after teardown (FR-35).
    expect(handle.ctx.get('llm')).toBeUndefined()
    // Dispose is idempotent: a second call releases nothing twice.
    await handle.dispose()
    expect(order).toEqual(['dispose:setup', 'dispose:second', 'dispose:first'])
  })

  it('rejects a plugin whose inject dependency the minimal core does not provide', async () => {
    const order: string[] = []
    // sessionPersistence is a Layer-2 service; the minimal core never mounts
    // it, so a dependent plugin cannot activate and the boot must roll back
    // everything that did mount (the setup effect and the earlier plugin).
    const boot = bootCore({
      setup: (ctx) => { ctx.effect(() => () => { order.push('dispose:setup') }) },
      plugins: [
        observedPlugin('ok', order),
        Object.assign(observedPlugin('persistence-dependent', order), { inject: ['sessionPersistence'] }),
      ],
    })
    await expect(boot).rejects.toThrow(/did not become active/)
    expect(order).toEqual(['dispose:setup', 'dispose:ok'])
  })

  it('rolls back already-mounted plugins in reverse order when a later plugin fails', async () => {
    const order: string[] = []
    const failure = new Error('apply exploded')
    const boot = bootCore({
      setup: (ctx) => { ctx.effect(() => () => { order.push('dispose:setup') }) },
      plugins: [
        observedPlugin('first', order),
        () => { throw failure },
      ],
    })
    await expect(boot).rejects.toThrow('apply exploded')
    // 'first' mounted before the failing plugin and must be released; the
    // root setup effect unwinds before the plugin child fibers.
    expect(order).toEqual(['dispose:setup', 'dispose:first'])
  })

  it('keeps the minimal core free of Rigo Work and Rigo Code runtime dependencies', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../packages/harness/app-boot/package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const names = { ...manifest.dependencies, ...manifest.peerDependencies }
    for (const name of Object.keys(names)) {
      expect(name.startsWith('@teoclub/work-') || name.startsWith('@teoclub/code-'),
        `runtime dependency ${name}`).toBe(false)
    }
    // The boot path pulls the per-turn core: the loop plugin must be present.
    expect(Object.keys(names)).toContain('@teoclub/harness-agent-loop')
  })
})
