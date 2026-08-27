/**
 * Rigo Work Knowledge Context Contributor (Issue 020; SPEC §2.4, §3.7,
 * §5.2, §5.3; PRD US-008, FR-23, FR-24).
 *
 * Wires Knowledge Retrieval into the Issue 011 Context Assembly:
 *
 *   - one contributor per session (the host registers it on the session's
 *     fiber); its query derives from the session's LAST user message, or
 *     from a caller-supplied query function;
 *   - retrieval goes through `ctx.knowledge` (Issue 018), so results arrive
 *     in the service's stable order and every row carries its provider;
 *   - the contribution renders each snippet with a `[sN]` reference that is
 *     traceable to Provider, Document, Version, Chunk and Location
 *     (SPEC §5.2: contributor output carries source information) — the
 *     structured mapping lives in {@link WorkKnowledgeContributor.projection},
 *     the locatable Source Reference data for the UI (SPEC §3.7/§5.3);
 *   - every retrieval appends the `knowledge/retrieved` session event with
 *     the bounded query summary and the source ids in rank order
 *     (SPEC §3.7 audit model; §5.3 flow);
 *   - no-match retrievals construct NO fabricated sources: the contribution
 *     stays empty and the projection reports an explicit `empty` status;
 *     a session with no user query reports `skipped`, a failing retrieval
 *     reports `failed` with the error — the model text is never polluted
 *     with invented content.
 *
 * @module @teoclub/work-context
 */

import { Context } from '@teoclub/cordis'
import { boundContextSummary } from '@teoclub/harness-llm'
import { CONTEXT_ORDER, type ContextContribution, type ContextContributor } from '@teoclub/harness-context'
import { KNOWN_SESSION_EVENT_TYPES, type Session } from '@teoclub/harness-session'
import type { KnowledgeFilter, KnowledgeResult, KnowledgeService } from '@teoclub/shared-knowledge'

/** The session event type appended for every completed retrieval. */
export const KNOWLEDGE_RETRIEVED_EVENT_TYPE = 'knowledge/retrieved'

// Ordinary event types join the known vocabulary without a format bump (the
// documented growth mechanism — see SESSION_FORMAT_VERSION). Persistence
// refuses unknown REQUIRED events on load, so a live-appended retrieval
// event must be a known type; the cast is the extension seam.
{
  const known = KNOWN_SESSION_EVENT_TYPES as Set<string>
  known.add(KNOWLEDGE_RETRIEVED_EVENT_TYPE)
}

/** Data shape of the {@link KNOWLEDGE_RETRIEVED_EVENT_TYPE} session event. */
export interface KnowledgeRetrievedEvent {
  /** Bounded summary of the normalized query (SPEC §3.7: query summary). */
  querySummary: string
  /** Byte length of the full normalized query. */
  queryBytes: number
  /** Retrieval outcome; only completed retrievals append the event. */
  status: 'found' | 'empty'
  /** Source ids in rank order: `<provider>#<documentId>#<chunk>`. */
  sourceIds: string[]
  /** Top-K requested. */
  topK: number
}

// Augment the ported session event map so `session.append(KNOWLEDGE_RETRIEVED_EVENT_TYPE, …)`
// typechecks and the event travels through the ported log/persistence.
declare module '@teoclub/harness-session' {
  interface SessionEventMap {
    'knowledge/retrieved': KnowledgeRetrievedEvent
  }
}

/** One locatable source reference (SPEC §3.7 UI projection / §5.3). */
export interface KnowledgeSourceReference {
  /** Stable reference id used in the rendered model text (e.g. `s1`). */
  refId: string
  /** Provider that produced the row. */
  provider: string
  /** Source document identity (workspace-relative path). */
  documentId: string
  /** Document version at index time. */
  documentVersion: number
  /** Chunk ordinal, when the provider's locator carries one. */
  chunk: number | undefined
  /** Code-point offsets into the source document, when known. */
  location: { start: number; end: number } | undefined
  /** The provider's raw locator string. */
  locator: string
  /** Human-readable source title. */
  title: string
  /** Index version that produced the row (SPEC §5.8 staleness marker). */
  indexedVersion?: number
}

/** The response projection for one retrieval (SPEC §3.7 / §5.3). */
export interface KnowledgeRetrievalProjection {
  /**
   * `found` — snippets entered the model; `empty` — no matches, no
   * fabricated sources; `skipped` — no query available (or no knowledge
   * service wired); `failed` — the retrieval threw.
   */
  status: 'found' | 'empty' | 'skipped' | 'failed'
  /** The normalized query (empty when skipped). */
  query: string
  /** Top-K requested. */
  topK: number
  /** Per-snippet source references, in rank order. */
  sources: KnowledgeSourceReference[]
  /** Failure detail when status is `failed`. */
  error?: string
}

export interface WorkKnowledgeContributorConfig {
  /** The session whose log records retrievals and whose history supplies the query. */
  session: Session
  /** The Knowledge service (optional: without it the contributor reports `skipped`). */
  knowledge?: KnowledgeService
  /** Top-K ceiling (default: the knowledge service default of 8). */
  topK?: number
  /** Optional retrieval filters. */
  filter?: KnowledgeFilter
  /** Query source override; defaults to the session's last user message. */
  query?: (ctx: Context) => string | undefined
  /** Contributor id (default `work.knowledge`); multi-session hosts use one id per session. */
  id?: string
}

/** The last user-role, user-sourced message's visible text, or `undefined`. */
export function lastUserQuery(session: Session): string | undefined {
  for (const message of [...session.deriveMessages()].reverse()) {
    if (message.role === 'user' && message.source?.kind === 'user') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('')
      if (text.trim().length > 0) return text
    }
  }
  return undefined
}

/** A pending (unclaimed) user-sourced message's visible text, or `undefined`. */
export function lastPendingUserQuery(session: Session): string | undefined {
  for (const event of [...session.events].reverse()) {
    // `agent/inbox/spliced` is an agent-package event; read it structurally
    // so this package does not need the harness-agent type augmentation.
    const candidate = event as unknown as {
      type?: string
      data?: { inserted?: readonly { role?: string; source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] }[] }
    }
    if (candidate.type !== 'agent/inbox/spliced' || candidate.data === undefined) continue
    const inserted = candidate.data.inserted
    if (inserted === undefined || inserted.length === 0) continue
    for (const message of [...inserted].reverse()) {
      if (message.role !== 'user' || message.source?.kind !== 'user') continue
      const text = (message.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('')
      if (text.trim().length > 0) return text
    }
  }
  return undefined
}

/** Parse an FTS-style locator JSON (`{"ordinal":N,"start":S,"end":E}`), best-effort. */
export function parseChunkLocator(locator: string): {
  chunk: number | undefined
  location: { start: number; end: number } | undefined
} {
  try {
    const parsed = JSON.parse(locator) as { ordinal?: unknown; start?: unknown; end?: unknown }
    const chunk = Number.isSafeInteger(parsed.ordinal) ? Number(parsed.ordinal) : undefined
    const location = Number.isSafeInteger(parsed.start) && Number.isSafeInteger(parsed.end)
      ? { start: Number(parsed.start), end: Number(parsed.end) }
      : undefined
    return { chunk, location }
  } catch {
    return { chunk: undefined, location: undefined }
  }
}

const CONTRIBUTION_SOURCE: ContextContribution['source'] = Object.freeze({
  contributorId: 'work.knowledge',
  label: 'Knowledge Retrieval',
})

/**
 * The per-session Knowledge Retrieval contributor. Register on the Issue 011
 * service via `ctx.context.register(contributor)` (hosts scope the
 * registration to the session's fiber so unloading stops participation).
 */
export class WorkKnowledgeContributor implements ContextContributor {
  readonly id: string
  readonly order = CONTEXT_ORDER.KNOWLEDGE
  readonly sessionId: string

  private readonly session: Session
  private readonly knowledge: KnowledgeService | undefined
  private readonly topK: number | undefined
  private readonly filter: KnowledgeFilter | undefined
  private readonly queryProvider: ((ctx: Context) => string | undefined) | undefined
  private lastProjection: KnowledgeRetrievalProjection | undefined

  constructor(config: WorkKnowledgeContributorConfig) {
    if (config?.session === undefined) {
      throw new TypeError('work knowledge contributor requires a session')
    }
    this.id = config.id ?? 'work.knowledge'
    this.session = config.session
    this.sessionId = config.session.id
    this.knowledge = config.knowledge
    this.topK = config.topK
    this.filter = config.filter
    this.queryProvider = config.query
  }

  /** The most recent retrieval projection (undefined before the first request). */
  get projection(): KnowledgeRetrievalProjection | undefined {
    return this.lastProjection
  }

  /**
   * Retrieve for the current request and render the knowledge band.
   * @param ctx - the assembling context.
   * @param signal - optional cancellation.
   * @returns the model-visible contribution (empty when nothing was found).
   */
  async contribute(ctx: Context, signal?: AbortSignal): Promise<ContextContribution> {
    const topK = this.topK
    if (this.knowledge === undefined) {
      return this.record({ status: 'skipped', query: '', topK: topK ?? 8, sources: [] })
    }
    const rawQuery = (this.queryProvider
      ?? (() => lastUserQuery(this.session) ?? lastPendingUserQuery(this.session)))(ctx)
    const query = rawQuery?.trim() ?? ''
    if (query.length === 0) {
      return this.record({ status: 'skipped', query: '', topK: topK ?? 8, sources: [] })
    }

    let results: KnowledgeResult[]
    try {
      results = await this.knowledge.retrieve(
        { query, ...(topK === undefined ? {} : { topK }), ...(this.filter === undefined ? {} : { filter: this.filter }) },
        signal,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return this.record({
        status: 'failed',
        query,
        topK: topK ?? 8,
        sources: [],
        error: message,
      })
    }

    const requestedTopK = topK ?? 8
    if (results.length === 0) {
      this.session.append(KNOWLEDGE_RETRIEVED_EVENT_TYPE, {
        querySummary: boundContextSummary(query),
        queryBytes: new TextEncoder().encode(query).length,
        status: 'empty',
        sourceIds: [],
        topK: requestedTopK,
      })
      return this.record({ status: 'empty', query, topK: requestedTopK, sources: [] })
    }

    const sources: KnowledgeSourceReference[] = results.map((result, index) => {
      const parsed = parseChunkLocator(result.locator)
      return {
        refId: `s${index + 1}`,
        provider: result.provider ?? 'unknown',
        documentId: String(result.sourceId),
        documentVersion: result.documentVersion,
        chunk: parsed.chunk,
        location: parsed.location,
        locator: result.locator,
        title: result.title,
        ...(result.indexedVersion === undefined ? {} : { indexedVersion: result.indexedVersion }),
      }
    })

    this.session.append(KNOWLEDGE_RETRIEVED_EVENT_TYPE, {
      querySummary: boundContextSummary(query),
      queryBytes: new TextEncoder().encode(query).length,
      status: 'found',
      sourceIds: sources.map((source) => `${source.provider}#${source.documentId}#${source.chunk ?? '?'}`),
      topK: requestedTopK,
    })

    const text = [
      'Knowledge sources:',
      '',
      ...sources.map((source, index) => {
        const result = results[index]!
        return `[${source.refId}] ${result.title} (${source.documentId} · v${source.documentVersion} · chunk ${source.chunk ?? '?'} · ${source.provider})\n${result.snippet}`
      }),
    ].join('\n')
    return this.record({ status: 'found', query, topK: requestedTopK, sources }, text)
  }

  private record(projection: KnowledgeRetrievalProjection, text = ''): ContextContribution {
    this.lastProjection = projection
    return { source: CONTRIBUTION_SOURCE, content: text }
  }
}

export default WorkKnowledgeContributor
