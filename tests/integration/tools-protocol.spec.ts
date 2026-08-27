import { describe, expect, it, vi } from 'vitest'
import { Context } from '@teoclub/cordis'
import SessionStore, { SessionId } from '@teoclub/harness-session'
import ContextService, { CONTEXT_ORDER } from '@teoclub/harness-context'
import ToolRuntime from '@teoclub/harness-tools'
import SystemPrompt from '@teoclub/harness-system-prompt'
import { bootCore } from '@teoclub/harness-app-boot'
import { createUserMessage } from '@teoclub/harness-llm'
import {
  attachToolSchemasToContext,
  listToolActionDelegates,
  modelToolSchemas,
  registerModelTool,
  registerToolActionDelegate,
  toolFailureResult,
  TOOL_SCHEMAS_CONTRIBUTOR_ID,
  type ModelToolDefinition,
  type ToolActionDelegate,
} from '@teoclub/harness-tools-protocol'
import { MockAdapter, textResponse, toolCallResponse } from '../upstream/agent-loop/tests/mock-adapter.ts'

/**
 * Issue 012: system-prompt and tool-registry lifecycle protocol (SPEC §2.4,
 * §5.1, §9.2; PRD US-006, US-010, FR-16/17/35). The upstream prompt-assembly
 * and tool-lifecycle suites pass unmodified (dual runtime, AC-7); this suite
 * pins the Rigo-facing surface: normalized model-visible tools feeding the
 * Context Assembly TOOL_SCHEMAS band, unified success/failure results with
 * no raw provider exceptions, unload revocation, and the inert Tool→Action
 * delegation seam.
 */

function echoTool(): ModelToolDefinition {
  return {
    name: 'echo',
    description: 'echo back',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    execute: (args) => ({ echoed: (args as { text: string }).text }),
  }
}

async function contextHarness(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ContextService)
  await ctx.plugin(ToolRuntime)
  return { ctx, dispose: () => ctx.fiber.dispose() }
}

describe('Rigo system-prompt/tools protocol (Issue 012)', () => {
  it('normalizes the input schema at registration and exposes it model-visibly', async () => {
    const { ctx, dispose } = await contextHarness()
    try {
      registerModelTool(ctx, echoTool())
      const schemas = modelToolSchemas(ctx)
      expect(schemas).toEqual([{
        name: 'echo',
        description: 'echo back',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }])
      // An unsupported schema rejects the registration outright.
      expect(() => registerModelTool(ctx, {
        name: 'bad',
        description: 'bad schema',
        parameters: { type: 'definitely-not-supported' },
        execute: () => undefined,
      })).toThrow()
      // Duplicate names are rejected, leaving the original intact.
      expect(() => registerModelTool(ctx, echoTool())).toThrow(/already registered/)
      expect(modelToolSchemas(ctx)).toHaveLength(1)
    } finally {
      await dispose()
    }
  })

  it('references the normalized tool schemas at the TOOL_SCHEMAS context band', async () => {
    const { ctx, dispose } = await contextHarness()
    try {
      const detach = attachToolSchemasToContext(ctx)
      registerModelTool(ctx, echoTool())
      registerModelTool(ctx, {
        name: 'read',
        description: 'read a file',
        parameters: { type: 'object' },
        execute: () => undefined,
      })
      const result = await ctx.context.assemble(undefined)
      const toolSection = result.contributions.find((entry) => entry.source.contributorId === TOOL_SCHEMAS_CONTRIBUTOR_ID)
      expect(toolSection).toBeDefined()
      expect(toolSection!.source.label).toBe('Tool Schemas')
      expect(toolSection!.content).toContain('echo: echo back')
      expect(toolSection!.content).toContain('read: read a file')
      expect(result.contributions.map((entry) => entry.source.contributorId)).toContain(TOOL_SCHEMAS_CONTRIBUTOR_ID)
      void CONTEXT_ORDER
      detach()
      expect((await ctx.context.assemble(undefined)).contributions).toHaveLength(0)
    } finally {
      await dispose()
    }
  })

  it('removes an unloaded tool from the registry and the schema mirror immediately', async () => {
    const { ctx, dispose } = await contextHarness()
    try {
      const revoke = registerModelTool(ctx, echoTool())
      expect(modelToolSchemas(ctx)).toHaveLength(1)
      revoke()
      expect(modelToolSchemas(ctx)).toHaveLength(0)
      // The ported registry no longer knows the tool: re-registration works.
      registerModelTool(ctx, echoTool())
      expect(modelToolSchemas(ctx)).toHaveLength(1)

      // Fiber unload revokes the same way.
      const owner = await ctx.plugin(Object.assign((inner: Context) => {
        registerModelTool(inner, {
          name: 'in-fiber',
          description: 'fiber tool',
          parameters: { type: 'object' },
          execute: () => undefined,
        })
      }, { inject: ['tools'] }))
      expect(modelToolSchemas(ctx).map((schema) => schema.name)).toEqual(['echo', 'in-fiber'])
      await owner.dispose()
      expect(modelToolSchemas(ctx).map((schema) => schema.name)).toEqual(['echo'])
    } finally {
      await dispose()
    }
  })

  it('executes tools with unified success/failure results, never leaking raw exceptions', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'ping' }, 'calling'),
      toolCallResponse('c2', 'boom', {}, ''),
      textResponse('done'),
    ])
    const handle = await bootCore({ adapters: { mock: adapter } })
    try {
      handle.ctx.tools.register({
        name: 'echo',
        description: 'echo',
        parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: (args) => ({ echoed: (args as { text: string }).text }),
      })
      handle.ctx.tools.register({
        name: 'boom',
        description: 'boom',
        parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
        execute: () => {
          // A provider-flavored failure carrying an internal object.
          const internal = { secret: 'provider-internal' }
          throw Object.assign(new Error('provider exploded'), { internal })
        },
      })
      const agent = handle.ctx.agentLoop.create(SessionId('session_tools_protocol'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run tools' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      const results = agent.session.events.filter((event) => event.type === 'tool/result')
      expect(results).toHaveLength(2)
      const success = results[0]!
      expect(success.type === 'tool/result' && success.data.message.content[0]?.isError).toBe(false)
      const failure = results[1]!
      if (failure.type !== 'tool/result') throw new Error('expected tool/result')
      expect(failure.data.message.content[0]?.isError).toBe(true)
      // The unified failure carries only safe text — never the raw exception
      // object with its provider-internal payload.
      const serialized = JSON.stringify(failure.data)
      expect(serialized).toContain('provider exploded')
      expect(serialized).not.toContain('provider-internal')
    } finally {
      await handle.dispose()
    }
  })

  it('converts any thrown value into the unified failure result', () => {
    const raw = Object.assign(new Error('backend blew up'), { internal: { token: 'x' } })
    const result = toolFailureResult(raw)
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('backend blew up')
    expect(JSON.stringify(result)).not.toContain('token')
    // Non-Error throws are stringified safely too.
    expect(toolFailureResult(42).content[0]!.text).toContain('42')
  })

  it('records Tool→Action delegates as an inert seam without executing side effects', async () => {
    const { ctx, dispose } = await contextHarness()
    try {
      const executed = vi.fn()
      const delegate: ToolActionDelegate = {
        accepts: (request) => request.toolName === 'write-file',
        execute: async (request) => {
          executed(request)
          return { content: [{ type: 'text', text: 'ok' }], isError: false }
        },
      }
      const revoke = registerToolActionDelegate(ctx, delegate)
      expect(listToolActionDelegates(ctx)).toHaveLength(1)
      // The seam is inert in this issue: registration never runs side effects.
      expect(executed).not.toHaveBeenCalled()
      revoke()
      expect(listToolActionDelegates(ctx)).toHaveLength(0)
    } finally {
      await dispose()
    }
  })
})
