/**
 * Issue 021 integration: Action Service (SPEC §5.4, §6.1; PRD US-010,
 * FR-17, FR-18, FR-35).
 *
 * The whole pipeline is runtime-agnostic, so the suite is dual-runtime.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import {
  ActionNotFoundError,
  ActionValidationError,
  ActionsService,
  SIDE_EFFECT_CLASSES,
  type ActionDefinition,
  type ActionPolicyResult,
} from '@teoclub/shared-actions'

const isBun = typeof Bun !== 'undefined'

interface CallLog {
  executed: number
  lastInput: unknown
  lastSignal?: AbortSignal
}

function definition(name: string, sideEffect: ActionDefinition['sideEffect'] = 'none', log?: CallLog): ActionDefinition {
  return {
    name,
    description: `${name} does something`,
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' }, count: { type: 'integer' } },
      required: ['value'],
    },
    sideEffect,
    execute(input, signal) {
      if (log !== undefined) {
        log.executed += 1
        log.lastInput = input
        log.lastSignal = signal
      }
      return { echoed: (input as { value: string }).value }
    },
  }
}

function policy(decision: ActionPolicyResult['decision'], name: string): { hook: NonNullable<Parameters<ActionsService['beforePolicy']>[0]> } {
  return {
    hook: () => ({ decision, reason: `${name} decided ${decision}`, policy: name }),
  }
}

describe('action service (Issue 021)', () => {
  it('registers, looks up, lists and rejects duplicate definitions', async () => {
    const ctx = new Context()
    await ctx.plugin(ActionsService)
    try {
      expect(ctx.actions.listActions()).toEqual([])
      const disposer = ctx.actions.registerAction(definition('sum'))
      ctx.actions.registerAction(definition('diff'))
      expect(ctx.actions.listActions()).toEqual(['sum', 'diff'])
      expect(ctx.actions.getAction('sum')!.description).toBe('sum does something')
      expect(ctx.actions.getAction('missing')).toBeUndefined()
      expect(() => ctx.actions.registerAction(definition('sum'))).toThrow(/already registered/)
      // Registration validates the definition up front.
      expect(() => ctx.actions.registerAction({ ...definition('bad'), name: '' })).toThrow(TypeError)
      expect(() => ctx.actions.registerAction({ ...definition('bad'), sideEffect: 'remote-write' as never })).toThrow(TypeError)
      expect(() => ctx.actions.registerAction({ ...definition('bad'), execute: undefined as never })).toThrow(TypeError)
      expect(() => ctx.actions.registerAction({ ...definition('bad'), inputSchema: { type: 'nonsense' } as never })).toThrow()
      // The disposer removes the definition.
      disposer()
      expect(ctx.actions.listActions()).toEqual(['diff'])
      // Unload via fiber removes the rest.
      const owner = await ctx.plugin(Object.assign((inner: Context) => {
        inner.actions.registerAction(definition('in-fiber'))
      }, { inject: ['actions'] }))
      expect(ctx.actions.listActions()).toEqual(['diff', 'in-fiber'])
      await owner.dispose()
      expect(ctx.actions.listActions()).toEqual(['diff'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects unknown actions with ACTION_NOT_FOUND', async () => {
    const ctx = new Context()
    await ctx.plugin(ActionsService)
    try {
      await expect(ctx.actions.execute({ action: 'ghost', input: {} })).rejects.toThrowError(ActionNotFoundError)
      await expect(ctx.actions.execute({ action: 'ghost', input: {} })).rejects.toMatchObject({
        code: 'ACTION_NOT_FOUND',
        retryable: false,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('validates input against the schema BEFORE any policy or side effect', async () => {
    const ctx = new Context()
    await ctx.plugin(ActionsService)
    const log: CallLog = { executed: 0, lastInput: undefined }
    let policyRuns = 0
    try {
      ctx.actions.registerAction(definition('guarded', 'local-write', log))
      ctx.actions.beforePolicy(async () => {
        policyRuns += 1
        return { decision: 'allow', reason: 'ok', policy: 'spy' }
      })
      // Invalid input: rejected before the hook and the executor see it.
      await expect(ctx.actions.execute({ action: 'guarded', input: { count: 1 } })).rejects.toThrowError(ActionValidationError)
      await expect(ctx.actions.execute({ action: 'guarded', input: { value: 42 } })).rejects.toMatchObject({
        code: 'ACTION_VALIDATION_FAILED',
        retryable: false,
      })
      expect(policyRuns).toBe(0)
      expect(log.executed).toBe(0)
      // Valid input reaches the pipeline.
      const result = await ctx.actions.execute({ action: 'guarded', input: { value: 'ok' } })
      expect(result.status).toBe('completed')
      // Only the valid call reached the hook (invalid input is rejected first).
      expect(policyRuns).toBe(1)
      expect(log.executed).toBe(1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('assigns a unique execution id per request', async () => {
    const ctx = new Context()
    await ctx.plugin(ActionsService)
    try {
      ctx.actions.registerAction(definition('echo'))
      const first = await ctx.actions.execute({ action: 'echo', input: { value: 'a' } })
      const second = await ctx.actions.execute({ action: 'echo', input: { value: 'b' } })
      expect(first.status).toBe('completed')
      expect(second.status).toBe('completed')
      if (first.status !== 'completed' || second.status !== 'completed') throw new Error('unreachable')
      expect(first.executionId).toMatch(/^action_[0-9a-f-]{36}$/)
      expect(first.executionId).not.toBe(second.executionId)
      // Parallel calls get distinct ids too.
      const parallel = await Promise.all([
        ctx.actions.execute({ action: 'echo', input: { value: 'x' } }),
        ctx.actions.execute({ action: 'echo', input: { value: 'y' } }),
      ])
      const ids = parallel.map((result) => (result as { executionId: string }).executionId)
      expect(new Set(ids).size).toBe(2)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies the default approval policy by side-effect class', async () => {
    const ctx = new Context()
    await ctx.plugin(ActionsService)
    try {
      expect(SIDE_EFFECT_CLASSES).toEqual(['none', 'local-read', 'local-write', 'external-write'])
      for (const sideEffect of ['none', 'local-read'] as const) {
        const log: CallLog = { executed: 0, lastInput: undefined }
        ctx.actions.registerAction(definition(`safe-${sideEffect}`, sideEffect, log))
        const result = await ctx.actions.execute({ action: `safe-${sideEffect}`, input: { value: 'x' } })
        expect(result.status).toBe('completed')
        expect(log.executed).toBe(1)
      }
      for (const sideEffect of ['local-write', 'external-write'] as const) {
        const log: CallLog = { executed: 0, lastInput: undefined }
        ctx.actions.registerAction(definition(`write-${sideEffect}`, sideEffect, log))
        const result = await ctx.actions.execute({ action: `write-${sideEffect}`, input: { value: 'x' } })
        expect(result.status).toBe('requires-approval')
        expect(result.policy).toBe('default')
        expect(result.reason).toContain(sideEffect)
        expect(log.executed).toBe(0) // never executed without approval
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('resolves the pre-policy stage to structured deny/allow/require-approval results', async () => {
    const ctx = new Context()
    await ctx.plugin(ActionsService)
    try {
      const log: CallLog = { executed: 0, lastInput: undefined }
      ctx.actions.registerAction(definition('policy-target', 'none', log))

      // A hook can DENY even a no-side-effect action; nothing executes.
      const disposeDeny = ctx.actions.beforePolicy(policy('deny', 'guard-1').hook)
      const denied = await ctx.actions.execute({ action: 'policy-target', input: { value: 'x' } })
      expect(denied.status).toBe('denied')
      if (denied.status !== 'denied') throw new Error('unreachable')
      expect(denied.reason).toBe('guard-1 decided deny')
      expect(denied.policy).toBe('guard-1')
      expect(log.executed).toBe(0)
      disposeDeny()

      // A hook can REQUIRE approval on a no-side-effect action.
      const disposeApproval = ctx.actions.beforePolicy(policy('require-approval', 'guard-2').hook)
      const approval = await ctx.actions.execute({ action: 'policy-target', input: { value: 'x' } })
      expect(approval.status).toBe('requires-approval')
      if (approval.status !== 'requires-approval') throw new Error('unreachable')
      expect(approval.policy).toBe('guard-2')
      expect(log.executed).toBe(0)
      disposeApproval()

      // A hook can ALLOW a write that would otherwise default to approval.
      const writeLog: CallLog = { executed: 0, lastInput: undefined }
      ctx.actions.registerAction(definition('writable', 'local-write', writeLog))
      const disposeAllow = ctx.actions.beforePolicy(policy('allow', 'trusted-writer').hook)
      const allowed = await ctx.actions.execute({ action: 'writable', input: { value: 'y' } })
      expect(allowed.status).toBe('completed')
      expect(writeLog.executed).toBe(1)
      disposeAllow()
      // Without the allow hook the same write defaults back to approval.
      const writeAgain = await ctx.actions.execute({ action: 'writable', input: { value: 'y' } })
      expect(writeAgain.status).toBe('requires-approval')
      expect(writeAgain.policy).toBe('default')
      expect(writeLog.executed).toBe(1)

      // deny beats require-approval regardless of order.
      const denyLog: CallLog = { executed: 0, lastInput: undefined }
      ctx.actions.registerAction(definition('contested', 'none', denyLog))
      const disposeFirst = ctx.actions.beforePolicy(policy('require-approval', 'first').hook)
      const disposeVeto = ctx.actions.beforePolicy(policy('deny', 'veto').hook)
      const contested = await ctx.actions.execute({ action: 'contested', input: { value: 'z' } })
      expect(contested.status).toBe('denied')
      if (contested.status !== 'denied') throw new Error('unreachable')
      expect(contested.policy).toBe('veto')
      expect(denyLog.executed).toBe(0)
      disposeFirst()
      disposeVeto()

      // expectedVersion travels through a require-approval decision.
      const disposeVersion = ctx.actions.beforePolicy(() => ({
        decision: 'require-approval' as const,
        reason: 'revalidate doc',
        policy: 'version-guard',
        expectedVersion: 4,
      }))
      const versioned = await ctx.actions.execute({ action: 'policy-target', input: { value: 'x' } })
      expect(versioned.status).toBe('requires-approval')
      if (versioned.status !== 'requires-approval') throw new Error('unreachable')
      expect(versioned.expectedVersion).toBe(4)
      disposeVersion()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('normalizes execution failures and cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(ActionsService)
    try {
      ctx.actions.registerAction({
        name: 'exploder',
        description: 'fails',
        inputSchema: { type: 'object', properties: {}, required: [] },
        sideEffect: 'none',
        execute: () => {
          throw new Error('boom with sensitive payload')
        },
      })
      const failed = await ctx.actions.execute({ action: 'exploder', input: {} })
      expect(failed.status).toBe('failed')
      if (failed.status !== 'failed') throw new Error('unreachable')
      expect(failed.error).toEqual({ message: 'boom with sensitive payload' })
      expect(failed.durationMs).toBeGreaterThanOrEqual(0)

      // Caller cancellation routes the execution to the cancellation flow.
      let attached!: () => void
      const attachedPromise = new Promise<void>((resolve) => {
        attached = resolve
      })
      ctx.actions.registerAction({
        name: 'hanging',
        description: 'waits',
        inputSchema: { type: 'object', properties: {}, required: [] },
        sideEffect: 'none',
        execute: async (_input, signal) => {
          await new Promise<void>((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
            attached()
          })
          return 'never'
        },
      })
      const controller = new AbortController()
      const pending = ctx.actions.execute({ action: 'hanging', input: {} }, controller.signal)
      expect(ctx.actions.listInFlight()).toHaveLength(1)
      await attachedPromise // the executor is listening before we abort
      controller.abort('caller changed their mind')
      const cancelled = await pending
      expect(cancelled.status).toBe('cancelled')
      if (cancelled.status !== 'cancelled') throw new Error('unreachable')
      expect(cancelled.reason).toBe('caller changed their mind')
      expect(ctx.actions.listInFlight()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects new calls after unload and cancels in-flight executions', async () => {
    const ctx = new Context()
    await ctx.plugin(ActionsService)
    try {
      // The test needs the write actions to actually run: allow them.
      ctx.actions.beforePolicy(() => ({ decision: 'allow', reason: 'test policy', policy: 'test-policy' }))
      const startedResolvers: (() => void)[] = []
      const waiting = async (_input: unknown, signal?: AbortSignal): Promise<string> => {
        await new Promise<void>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          startedResolvers.pop()?.()
        })
        return 'done'
      }
      // A long-running action owned by a plugin fiber.
      const slowDisposer = ctx.actions.registerAction({
        name: 'slow',
        description: 'slow write',
        inputSchema: { type: 'object', properties: {}, required: [] },
        sideEffect: 'external-write',
        execute: waiting,
      })
      const pending = ctx.actions.execute({ action: 'slow', input: {} })
      expect(ctx.actions.listInFlight()).toHaveLength(1)
      await new Promise<void>((resolve) => startedResolvers.push(resolve)) // executor listening

      // Fiber unload: the definition disappears and its in-flight execution
      // enters the cancellation flow.
      const owner = await ctx.plugin(Object.assign((inner: Context) => {
        inner.actions.registerAction({
          name: 'fiber-action',
          description: 'owned by the fiber',
          inputSchema: { type: 'object', properties: {}, required: [] },
          sideEffect: 'local-write',
          execute: waiting,
        })
      }, { inject: ['actions'] }))
      expect(ctx.actions.getAction('fiber-action')).toBeDefined()
      const fiberPending = ctx.actions.execute({ action: 'fiber-action', input: {} })
      expect(ctx.actions.listInFlight()).toHaveLength(2)
      await new Promise<void>((resolve) => startedResolvers.push(resolve)) // executor listening
      await owner.dispose()
      // New calls are rejected…
      await expect(ctx.actions.execute({ action: 'fiber-action', input: {} }))
        .rejects.toMatchObject({ code: 'ACTION_NOT_FOUND' })
      // …and the in-flight execution was cancelled with the unload reason.
      const cancelled = await fiberPending
      expect(cancelled.status).toBe('cancelled')
      if (cancelled.status !== 'cancelled') throw new Error('unreachable')
      expect(cancelled.reason).toContain('fiber-action')
      // The other action's execution is unaffected.
      expect(ctx.actions.listInFlight()).toHaveLength(1)

      // Disposer unload behaves the same way.
      slowDisposer()
      expect(ctx.actions.getAction('slow')).toBeUndefined()
      await expect(ctx.actions.execute({ action: 'slow', input: {} })).rejects.toThrowError(ActionNotFoundError)
      const cancelledSlow = await pending
      expect(cancelledSlow.status).toBe('cancelled')
      if (cancelledSlow.status !== 'cancelled') throw new Error('unreachable')
      expect(cancelledSlow.reason).toContain('slow')
      expect(ctx.actions.listInFlight()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
