import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import { bootCore } from '@teoclub/harness-app-boot'
import { SessionId } from '@teoclub/harness-session'
import AgentRegistry from '@teoclub/harness-agent'
import AgentLoop from '@teoclub/harness-agent-loop'
import LlmRuntime from '@teoclub/harness-llm'
import SessionStore from '@teoclub/harness-session'
import SystemPrompt from '@teoclub/harness-system-prompt'
import ToolRuntime from '@teoclub/harness-tools'
import {
  agentPublicApi,
  createAgent,
  disposeAgent,
  getAgent,
  replaceLoopFactory,
  resumeAgent,
} from '@teoclub/harness-agent-protocol'
import type { PublicAgentStatus } from '@teoclub/harness-agent-protocol'
import { MockAdapter, textResponse } from '../upstream/agent-loop/tests/mock-adapter.ts'

/**
 * Issue 013: Agent Registry and the stable public API (SPEC §2.4, §2.5,
 * §5.6; PRD US-007, FR-9): create/get/resume/dispose through `ctx.agents`,
 * the loop-agnostic send/steer/inject/abort surface, `idle`|`running` public
 * status, stable Session ID association, idempotent disposal, and the
 * replaceable loop factory.
 */

const isBun = typeof Bun !== 'undefined'

describe('Rigo agent public API (Issue 013)', () => {
  it('creates, gets and disposes agents through the registry; double dispose is idempotent', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([textResponse('ok')]) } })
    try {
      const sessionId = SessionId('session_agent_api')
      const created = await createAgent(handle.ctx, {
        sessionId,
        agentOptions: { provider: 'mock', model: 'mock' },
      })
      expect(created.agent.id).toBe(sessionId)
      expect(created.agent.sessionId).toBe(sessionId)
      expect(created.agent.status).toBe('idle')

      const fetched = getAgent(handle.ctx, sessionId)
      expect(fetched).toBeDefined()
      expect(fetched!.id).toBe(sessionId)

      await created.dispose()
      expect(getAgent(handle.ctx, sessionId)).toBeUndefined()
      // Repeated disposal releases nothing twice and never throws.
      await disposeAgent(created.dispose)
      await disposeAgent(created.dispose)
    } finally {
      await handle.dispose()
    }
  })

  describe.skipIf(isBun)('resume (node:sqlite-backed)', () => {
    it('resumes an agent on a persisted session with its event log intact', async () => {
      const { default: SqliteSessionPersistence } = await import('@teoclub/shared-session-persistence-sqlite')
      const dir = mkdtempSync(join(tmpdir(), 'rigo-agent-resume-'))
      const mount = async (root: string): Promise<{ ctx: Context; dispose: () => Promise<void> }> => {
        const ctx = new Context()
        await ctx.plugin(LlmRuntime)
        await ctx.plugin(SessionStore)
        await ctx.plugin(SystemPrompt)
        await ctx.plugin(ToolRuntime)
        await ctx.plugin(AgentRegistry)
        await ctx.plugin(AgentLoop, { agents: [] })
        await ctx.plugin(SqliteSessionPersistence as never, { path: join(root, 'rigo.sqlite') })
        ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('resumed')]))
        return { ctx, dispose: () => ctx.fiber.dispose() }
      }
      try {
        const first = await mount(dir)
        const sessionId = SessionId('session_agent_resume')
        const created = await createAgent(first.ctx, { sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
        created.agent.send('before restart')
        await created.agent.whenIdle()
        await first.ctx.sessions.flush(first.ctx.agents.get(sessionId)!.session)
        await created.dispose()
        await first.dispose()

        const second = await mount(dir)
        try {
          const resumed = await resumeAgent(second.ctx, {
            resumeSessionId: sessionId,
            agentOptions: { provider: 'mock', model: 'mock' },
          })
          expect(resumed.agent.sessionId).toBe(sessionId)
          expect(resumed.agent.status).toBe('idle')
          // The event log survived the restart with the pre-restart turn.
          const types = second.ctx.agents.get(sessionId)!.session.events.map((event) => event.type)
          expect(types).toContain('user/message')
          expect(types).toContain('assistant/message')
          await resumed.dispose()
        } finally {
          await second.dispose()
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  it('exposes only idle|running status publicly; phases arrive as events', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([textResponse('ok')]) } })
    try {
      const sessionId = SessionId('session_agent_status')
      const created = await createAgent(handle.ctx, { sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
      const seen = new Set<PublicAgentStatus>()
      handle.ctx.on('agent/status', ({ agent, status }) => {
        if (agent.id === sessionId) seen.add(status)
      })
      created.agent.send('go')
      await created.agent.whenIdle()
      expect(created.agent.status).toBe('idle')
      expect([...seen].every((status) => status === 'idle' || status === 'running')).toBe(true)
      expect(seen.has('running')).toBe(true)
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('routes send, steer, inject and abort through the public surface', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter([textResponse('a'), textResponse('b')]) } })
    try {
      const sessionId = SessionId('session_agent_controls')
      const created = await createAgent(handle.ctx, { sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
      const session = handle.ctx.agents.get(sessionId)!.session

      created.agent.send('first turn')
      await created.agent.whenIdle()
      expect(session.events.filter((event) => event.type === 'user/message')).toHaveLength(1)

      // steer opens a turn from idle.
      created.agent.steer('steering input')
      await created.agent.whenIdle()
      expect(session.events.filter((event) => event.type === 'user/message')).toHaveLength(2)

      // inject stages context without opening a turn.
      const before = session.events.length
      created.agent.inject('injected context')
      expect(session.events.length).toBe(before + 1)
      expect(session.events.at(-1)!.type).toBe('agent/inbox/spliced')

      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('aborts an active turn with the public abort() and converges to idle', async () => {
    const handle = await bootCore({ adapters: { mock: new MockAdapter(['hang']) } })
    try {
      const sessionId = SessionId('session_agent_abort')
      const created = await createAgent(handle.ctx, { sessionId, agentOptions: { provider: 'mock', model: 'mock' } })
      created.agent.send('hang forever')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(created.agent.status).toBe('running')
      created.agent.abort()
      await created.agent.whenIdle()
      expect(created.agent.status).toBe('idle')
      await created.dispose()
    } finally {
      await handle.dispose()
    }
  })

  it('replaces the loop factory without changing the public interface', async () => {
    // The factory slot is single-occupancy and registry-owned: on a bare
    // registry (no loop mounted) a custom factory can register, serve, and
    // be replaced — and the public surface never changes.
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    try {
      const sessionId = SessionId('session_agent_factory')
      const throwingFactory = {
        createAgent: async () => { throw new Error('custom-factory-hit') },
        resume: async () => { throw new Error('custom-factory-hit') },
      }
      const restore = replaceLoopFactory(ctx, throwingFactory)
      // Create routes through the replacement factory.
      await expect(createAgent(ctx, { sessionId, agentOptions: { provider: 'mock', model: 'mock' } }))
        .rejects.toThrow('custom-factory-hit')
      restore()
      // Slot cleared: no factory means a loud, structured rejection.
      await expect(createAgent(ctx, { sessionId, agentOptions: { provider: 'mock', model: 'mock' } }))
        .rejects.toThrow(/no agent factory registered/)
      // The slot re-opens for a new factory after the previous one cleared.
      const restore2 = replaceLoopFactory(ctx, throwingFactory)
      await expect(createAgent(ctx, { sessionId, agentOptions: { provider: 'mock', model: 'mock' } }))
        .rejects.toThrow('custom-factory-hit')
      restore2()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the public API loop-agnostic (no default-loop import or dependency)', () => {
    const source = readFileSync(new URL('../../packages/harness/agent-protocol/src/index.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('harness-agent-loop')
    const manifest = JSON.parse(readFileSync(new URL('../../packages/harness/agent-protocol/package.json', import.meta.url), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const names = { ...manifest.dependencies, ...manifest.peerDependencies }
    expect(Object.keys(names)).not.toContain('@teoclub/harness-agent-loop')
    // The surface derives from a ported agent without the loop.
    const agent = { id: SessionId('x'), session: { id: SessionId('x') }, status: 'idle' as const,
      followup: () => undefined, steer: () => undefined, inject: () => undefined,
      cancel: () => undefined, whenIdle: async () => undefined }
    const api = agentPublicApi(agent as never)
    expect(api.sessionId).toBe('x')
  })
})
