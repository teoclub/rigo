/**
 * Rigo Agent public API (Issue 013; SPEC §2.4, §2.5, §5.6; PRD US-007,
 * FR-9).
 *
 * The loop-agnostic control surface UI, HTTP and the in-process SDK program
 * against — this package imports the agent registry types but NEVER the
 * default loop implementation:
 *
 *   - {@link PublicAgent}: `send` / `steer` / `inject` / `abort`, public
 *     status restricted to `idle` | `running` (detailed phases arrive as
 *     events), and the stable Session ID linking the Session Event Log;
 *   - {@link createAgent} / {@link getAgent} / {@link resumeAgent} /
 *     {@link disposeAgent}: the create / get / resume / dispose control
 *     plane over `ctx.agents`;
 *   - {@link replaceLoopFactory}: the Agent extension point — swapping the
 *     loop factory never changes this public interface.
 *
 * @module @teoclub/harness-agent-protocol
 */

import { Context } from '@teoclub/cordis'
import { AgentRegistry, type Agent, type AgentFactory } from '@teoclub/harness-agent'
import { createUserMessage } from '@teoclub/harness-llm'
import { SessionId, type AgentCancelCause } from '@teoclub/harness-session'

// The ported public types, pinned at this surface.
export type { Agent, AgentFactory, AgentHandle } from '@teoclub/harness-agent'
export type { AgentCancelCause } from '@teoclub/harness-session'

/** Public status vocabulary: only `idle` | `running` (SPEC §5.6). */
export type PublicAgentStatus = 'idle' | 'running'

/** The loop-agnostic public agent surface. */
export interface PublicAgent {
  /** The single identity shared with the session. */
  readonly id: SessionId
  /** The stable Session ID associating this agent's Session Event Log. */
  readonly sessionId: SessionId
  /** Current public status (`idle` | `running`; phases arrive as events). */
  readonly status: PublicAgentStatus
  /** Send an ordinary user message (opens its own turn). */
  send(text: string): void
  /** Submit steering for the nearest step (idle starts a turn). */
  steer(text: string): void
  /** Queue model-facing context for the next pre-step without waking. */
  inject(text: string): void
  /** Abort the active turn (default cause: user cancellation). */
  abort(cause?: AgentCancelCause): void
  /** Resolve after the whole-agent activity reaches quiescence. */
  whenIdle(): Promise<void>
}

function userMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * Derive the loop-agnostic public surface from a ported agent.
 * @param agent - a live agent from the registry.
 * @returns the public surface; status stays live.
 */
export function agentPublicApi(agent: Agent): PublicAgent {
  return {
    id: agent.id,
    sessionId: agent.session.id,
    get status() {
      return agent.status
    },
    send: (text) => { agent.followup(userMessage(text)) },
    steer: (text) => { agent.steer(userMessage(text)) },
    inject: (text) => { agent.inject(userMessage(text)) },
    abort: (cause: AgentCancelCause = { kind: 'user' }) => { agent.cancel(cause) },
    whenIdle: () => agent.whenIdle(),
  }
}

/** Create options for {@link createAgent}. */
export interface CreateAgentInput {
  /** The live agent/session identity. */
  sessionId: SessionId
  /** Provider route and model id. */
  agentOptions: { provider: string; model: string }
  /** Optional session creation metadata (cwd, fork lineage). */
  meta?: { cwd?: string }
}

/** Resume options for {@link resumeAgent}. */
export interface ResumeAgentInput {
  /** The persisted session identity to resume. */
  resumeSessionId: SessionId
  /** Provider route and model id. */
  agentOptions: { provider: string; model: string }
}

/**
 * Create an agent through the registered loop factory and return its public
 * surface.
 * @param ctx - a context with the agent registry mounted.
 * @param input - identity and agent options.
 * @returns the public surface plus the owned handle (dispose capability).
 */
export async function createAgent(ctx: Context, input: CreateAgentInput): Promise<{ agent: PublicAgent; dispose(): Promise<void> }> {
  const handle = await ctx.agents.create({
    sessionId: input.sessionId,
    ...(input.meta === undefined ? {} : { meta: input.meta }),
    agentOptions: input.agentOptions,
  })
  return { agent: agentPublicApi(handle.agent), dispose: () => handle.dispose() }
}

/**
 * Get a live agent's public surface by its stable Session ID.
 * @param ctx - a context with the agent registry mounted.
 * @param id - the session/agent identity.
 * @returns the public surface, or `undefined` when absent.
 */
export function getAgent(ctx: Context, id: SessionId): PublicAgent | undefined {
  const agent = ctx.agents.get(id)
  return agent === undefined ? undefined : agentPublicApi(agent)
}

/**
 * Resume an agent on a persisted session through the registered loop factory.
 * @param ctx - a context with the agent registry AND session persistence.
 * @param input - persisted identity and agent options.
 * @returns the public surface plus the owned handle.
 */
export async function resumeAgent(ctx: Context, input: ResumeAgentInput): Promise<{ agent: PublicAgent; dispose(): Promise<void> }> {
  const handle = await ctx.agents.resume({
    resumeSessionId: input.resumeSessionId,
    agentOptions: input.agentOptions,
  })
  return { agent: agentPublicApi(handle.agent), dispose: () => handle.dispose() }
}

/**
 * Dispose an agent handle exactly once; repeated calls are no-ops (no
 * resource leak, no repeated side effects).
 * @param dispose - the handle's disposer.
 */
export async function disposeAgent(dispose: () => Promise<void>): Promise<void> {
  await dispose()
}

/**
 * Replace the loop factory (the Agent extension point). The public surface
 * never changes; new create/resume calls route through the replacement.
 * @param ctx - a context with the agent registry mounted.
 * @param factory - the replacement factory.
 * @returns the disposer restoring the previous factory.
 */
export function replaceLoopFactory(ctx: Context, factory: AgentFactory): () => void {
  return ctx.agents.setFactory(factory)
}

// Re-export the registry service so consumers mount one import surface.
export { AgentRegistry }
