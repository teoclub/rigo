/**
 * Rigo Context Assembly (Issue 011; SPEC §2.4, §5.2, §6.3; PRD US-006,
 * FR-16).
 *
 * `ctx.context` registers and executes domain-agnostic context contributors
 * for every model request:
 *
 *   - contributor ids are unique within the service scope; the assembly is
 *     deterministic — sorted by `order`, ties broken by id;
 *   - the reserved {@link CONTEXT_ORDER} bands pin the full assembly order:
 *     Harness Identity → Product Persona → Domain Context → Session History
 *     → Knowledge → Runtime Injection → Tool Schemas;
 *   - every contribution carries a traceable source and is written to the
 *     session event log (`context/contributed`, `ignorable`) BEFORE the
 *     model sees the content;
 *   - unregistering (or unloading the registering fiber) immediately
 *     removes the contributor from new assemblies;
 *   - a failing contributor rejects the whole assembly with a structured
 *     `ContextContributorError` — context is never silently omitted.
 *
 * @module @teoclub/harness-context
 */

import { Context, Service } from '@teoclub/cordis'
import { KNOWN_SESSION_EVENT_TYPES, type Session } from '@teoclub/harness-session'

declare module '@teoclub/cordis' {
  interface Context {
    /** The Context Assembly service (Issue 011). */
    context: ContextService
  }
}

/** The session event type written for every contribution before model entry. */
export const CONTEXT_EVENT_TYPE = 'context/contributed'

// Ordinary event types join the known vocabulary without a format bump (the
// documented growth mechanism — see SESSION_FORMAT_VERSION). Persistence
// refuses unknown REQUIRED events on load, so a live-appended context event
// must be a known type; the underlying set is never frozen by the ported
// package, and the cast is the extension seam.
{
  const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
  known.add(CONTEXT_EVENT_TYPE)
}

/** Data shape of the {@link CONTEXT_EVENT_TYPE} session event. */
export interface ContextContributedEvent {
  /** The stable contributor id. */
  contributorId: string
  /** Human-readable source label. */
  label: string
  /** The contributor's assembly order (0 when unset). */
  order: number
  /** Rendered content length in characters. */
  textLength: number
}

// Augment the ported session event map so `session.append(CONTEXT_EVENT_TYPE,
// …)` typechecks and the event travels through the ported log/persistence
// (the `ignorable` marker keeps unknown-type refusal off it).
declare module '@teoclub/harness-session' {
  interface SessionEventMap {
    'context/contributed': ContextContributedEvent
  }
}

/** Reserved assembly order bands (SPEC §5.2 full assembly order). */
export const CONTEXT_ORDER = {
  HARNESS_IDENTITY: -100,
  PRODUCT_PERSONA: 0,
  DOMAIN_CONTEXT: 100,
  SESSION_HISTORY: 200,
  KNOWLEDGE: 300,
  RUNTIME_INJECTION: 400,
  TOOL_SCHEMAS: 500,
} as const

/** Traceable origin of one contribution. */
export interface ContextSource {
  /** The stable contributor id. */
  contributorId: string
  /** Human-readable source label (shown in audit/UI attribution). */
  label: string
}

/** One contribution's model-visible content. */
export type ContributionContent = string | readonly { type: 'text'; text: string }[]

export interface ContextContribution {
  source: ContextSource
  content: ContributionContent
}

export interface ContextContributor {
  /** Unique id within the service scope (ties in ordering are broken by id). */
  id: string
  /** Assembly order; ties sort by id. Use the {@link CONTEXT_ORDER} bands. */
  order?: number
  /**
   * Optional session binding: when set, `assemble(session)` only runs this
   * contributor for that session (multi-session hosts keep per-session
   * contributors in one service; `undefined` means global — every session).
   */
  sessionId?: string
  /** Produce this contributor's context for one model request. */
  contribute(ctx: Context, signal?: AbortSignal): ContextContribution | Promise<ContextContribution>
}

/** Structured contributor failure (SPEC §6.3: never silently omit context). */
export class ContextContributorError extends Error {
  readonly code = 'CONTRIBUTOR_FAILED'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ContextContributorError'
  }
}

export interface ContextAssemblyResult {
  /** Every contribution in deterministic (order, id) order. */
  contributions: readonly ContextContribution[]
  /** The assembled model-visible text (sections joined in order). */
  text: string
}

function contentLength(content: ContributionContent): number {
  if (typeof content === 'string') return content.length
  return content.reduce((total, block) => total + block.text.length, 0)
}

function contentText(content: ContributionContent): string {
  return typeof content === 'string' ? content : content.map((block) => block.text).join('')
}

/** The Context Assembly service. Mount via `ctx.plugin(ContextService)`. */
export class ContextService extends Service {
  private readonly contributors = new Map<string, ContextContributor>()

  constructor(ctx: Context) {
    super(ctx, 'context')
  }

  /**
   * Register one contributor. Duplicate ids are rejected; the registration
   * is released when the calling fiber unloads.
   * @param contributor - the contributor to register.
   * @returns the disposer (also removes the contributor immediately).
   */
  register(contributor: ContextContributor): () => void {
    if (typeof contributor?.id !== 'string' || contributor.id.length === 0) {
      throw new TypeError('context contributor id must be a non-empty string')
    }
    if (this.contributors.has(contributor.id)) {
      throw new Error(`context contributor "${contributor.id}" is already registered`)
    }
    this.contributors.set(contributor.id, contributor)
    return this.ctx.effect(() => () => {
      this.contributors.delete(contributor.id)
    }, `context.register(${contributor.id})`)
  }

  /** All registered contributors in deterministic (order, id) order. */
  list(): ContextContributor[] {
    return [...this.contributors.values()].sort((left, right) => {
      const orderDiff = (left.order ?? 0) - (right.order ?? 0)
      return orderDiff !== 0 ? orderDiff : left.id.localeCompare(right.id)
    })
  }

  /**
   * Assemble the model-visible context for one request. Every contribution
   * is written to the session log (when a session is given) BEFORE the
   * model sees it; a failing contributor rejects the whole assembly.
   * @param session - the session to record contributions into (optional).
   * @param options - cancellation.
   * @returns the ordered contributions and their joined text.
   * @throws {@link ContextContributorError} when a contributor fails.
   */
  async assemble(
    session: Session | undefined,
    options: { signal?: AbortSignal } = {},
  ): Promise<ContextAssemblyResult> {
    const contributions: ContextContribution[] = []
    for (const contributor of this.list()) {
      // Session-bound contributors only participate in their own session's
      // assembly; a bare assemble (no session) runs only global contributors.
      if (contributor.sessionId !== undefined
        && (session === undefined || contributor.sessionId !== session.id)) {
        continue
      }
      options.signal?.throwIfAborted()
      let contribution: ContextContribution
      try {
        contribution = await contributor.contribute(this.ctx, options.signal)
      } catch (error) {
        throw new ContextContributorError(
          `context contributor "${contributor.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      if (contribution === null || typeof contribution !== 'object'
        || typeof contribution.source?.contributorId !== 'string') {
        throw new ContextContributorError(
          `context contributor "${contributor.id}" returned an invalid contribution (missing traceable source)`,
        )
      }
      const order = contributor.order ?? 0
      if (session !== undefined) {
        session.append(CONTEXT_EVENT_TYPE, {
          contributorId: contributor.id,
          label: contribution.source.label,
          order,
          textLength: contentLength(contribution.content),
        })
      }
      contributions.push(contribution)
    }
    return {
      contributions,
      text: contributions.map((contribution) => contentText(contribution.content)).join('\n\n'),
    }
  }
}

export default ContextService
