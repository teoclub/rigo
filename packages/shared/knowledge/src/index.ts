/**
 * Rigo Knowledge Service Definition (Issue 018; SPEC §2.4, §5.3; PRD US-008,
 * FR-23, FR-24).
 *
 * The domain-agnostic `ctx.knowledge` retrieval contract, fully decoupled
 * from SQLite or any vector database (the FTS5 provider lands separately):
 *
 *   - named {@link KnowledgeProvider}s register and unload through the
 *     service; an unloaded provider is never called by a new retrieval;
 *   - one retrieval request carries a `query`, an optional `topK` (default
 *     {@link DEFAULT_TOP_K} = 8) and optional {@link KnowledgeFilter}s;
 *     invalid input raises the structured {@link KnowledgeQueryError}
 *     (SPEC §6.1 `INVALID_REQUEST`);
 *   - the query is normalized (trimmed) and capped at
 *     {@link MAX_QUERY_BYTES} = 8 KiB (SPEC §5.3);
 *   - every result carries a stable source id, title, snippet, the indexed
 *     document's monotonic version, and a locator into the source
 *     (SPEC §5.3/§5.8: results also surface the index version that produced
 *     them, so stale index data is visible, never silent);
 *   - ordering is a stable contract: each provider returns rows in its own
 *     rank order, the service preserves that order and concatenates
 *     providers in registration order, then applies the global Top-K cap;
 *     empty provider results yield an empty collection — no fabricated
 *     sources (SPEC §5.3);
 *   - provider failures reject the retrieval with a structured
 *     {@link KnowledgeProviderError} naming the provider (no silent
 *     omission — same policy as the Context Assembly service), and a
 *     retrieval with no registered provider raises
 *     {@link KnowledgeProviderNotFoundError} (SPEC §6.1 `PROVIDER_NOT_FOUND`).
 *
 * @module @teoclub/shared-knowledge
 */

import { Context, Service } from '@teoclub/cordis'

/** Branded stable knowledge source identity. */
export type SourceId = string & { readonly __sourceId: unique symbol }

/** Brand a string as a {@link SourceId}. */
export function SourceId(id: string): SourceId {
  return id as SourceId
}

/** Query byte budget (SPEC §5.3: max 8 KiB). */
export const MAX_QUERY_BYTES = 8 * 1024

/** Default Top-K (SPEC §5.3). */
export const DEFAULT_TOP_K = 8

/** Defensive ceiling for an explicit topK (validated as invalid above it). */
export const MAX_TOP_K = 100

/** Optional retrieval filters (MVP: document-level selection). */
export interface KnowledgeFilter {
  /** Only results whose source document matches this workspace-relative path. */
  documentPath?: string
  /** Only results indexed from documents at or above this monotonic version. */
  minDocumentVersion?: number
  /** Only results from the given source media types. */
  mediaTypes?: readonly string[]
}

/** One retrieval request (SPEC §5.3). */
export interface KnowledgeRequest {
  /** Free-form search text. */
  query: string
  /** Result count ceiling; defaults to {@link DEFAULT_TOP_K}. */
  topK?: number
  /** Optional filters. */
  filter?: KnowledgeFilter
}

/** One ranked retrieval result (SPEC §5.3 result contract). */
export interface KnowledgeResult {
  /** Stable source identity (e.g. `documents/<path>#<locator>`). */
  sourceId: SourceId
  /** Human-readable source title. */
  title: string
  /** Text snippet around the match. */
  snippet: string
  /** The source document's monotonic version at index time. */
  documentVersion: number
  /** Provider-specific locator into the source (e.g. chunk/offset range). */
  locator: string
  /** Index version that produced this row (SPEC §5.8 staleness marker). */
  indexedVersion?: number
  /** Media type of the source document. */
  mediaType?: string
  /**
   * The provider that produced this row, stamped by the service during
   * retrieval (never trusted from the provider itself) — every snippet is
   * traceable back to its provider (SPEC §5.2 contributor output carries
   * source information).
   */
  provider?: string
}

/** A replaceable retrieval backend. */
export interface KnowledgeProvider {
  /** Stable provider name (registry key). */
  readonly name: string
  /**
   * Rank one query. Contract: returns rows in this provider's OWN stable
   * rank order (the service never re-sorts within a provider) and returns
   * an empty array rather than fabricated sources when nothing matches.
   * @param request - the validated request (query normalized, topK filled).
   * @param signal - optional cancellation.
   */
  retrieve(request: KnowledgeRequest, signal?: AbortSignal): Promise<readonly KnowledgeResult[]>
}

/** Structured request validation failure (SPEC §6.1 `INVALID_REQUEST`). */
export class KnowledgeQueryError extends Error {
  readonly code = 'INVALID_REQUEST'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeQueryError'
  }
}

/** Structured "no provider registered" failure (SPEC §6.1 `PROVIDER_NOT_FOUND`). */
export class KnowledgeProviderNotFoundError extends Error {
  readonly code = 'PROVIDER_NOT_FOUND'
  readonly retryable = false

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeProviderNotFoundError'
  }
}

/** Structured provider failure or contract violation (SPEC §6.1 `INTERNAL_ERROR`). */
export class KnowledgeProviderError extends Error {
  readonly code = 'INTERNAL_ERROR'
  readonly retryable = false
  /** The failing provider's name. */
  readonly provider: string

  constructor(provider: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'KnowledgeProviderError'
    this.provider = provider
  }
}

/** Normalize (trim) and validate one request; returns the validated copy. */
export function validateKnowledgeRequest(request: KnowledgeRequest): KnowledgeRequest {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new KnowledgeQueryError('knowledge request must be a plain object')
  }
  if (typeof request.query !== 'string') {
    throw new KnowledgeQueryError('knowledge query must be a string')
  }
  // SPEC §5.3 flow: normalize the query before validating its length.
  const query = request.query.trim()
  if (query.length === 0) {
    throw new KnowledgeQueryError('knowledge query must not be empty')
  }
  if (new TextEncoder().encode(query).length > MAX_QUERY_BYTES) {
    throw new KnowledgeQueryError(`knowledge query exceeds the ${MAX_QUERY_BYTES}-byte (8 KiB) limit`)
  }
  const topK = request.topK ?? DEFAULT_TOP_K
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > MAX_TOP_K) {
    throw new KnowledgeQueryError(`topK must be an integer between 1 and ${MAX_TOP_K}, got ${String(request.topK)}`)
  }
  const filter = request.filter === undefined ? undefined : validateKnowledgeFilter(request.filter)
  return {
    query,
    topK,
    ...(filter === undefined ? {} : { filter }),
  }
}

function validateKnowledgeFilter(filter: KnowledgeFilter): KnowledgeFilter {
  if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) {
    throw new KnowledgeQueryError('knowledge filter must be a plain object')
  }
  if (filter.documentPath !== undefined
    && (typeof filter.documentPath !== 'string' || filter.documentPath.length === 0)) {
    throw new KnowledgeQueryError('filter documentPath must be a non-empty string')
  }
  if (filter.minDocumentVersion !== undefined
    && (!Number.isSafeInteger(filter.minDocumentVersion) || filter.minDocumentVersion < 0)) {
    throw new KnowledgeQueryError('filter minDocumentVersion must be a non-negative integer')
  }
  if (filter.mediaTypes !== undefined
    && (!Array.isArray(filter.mediaTypes)
      || filter.mediaTypes.length === 0
      || !filter.mediaTypes.every((media) => typeof media === 'string' && media.length > 0))) {
    throw new KnowledgeQueryError('filter mediaTypes must be a non-empty array of non-empty strings')
  }
  return filter
}

/** Enforce the result-row contract (source id, title, snippet, version, locator). */
function assertKnowledgeResult(row: unknown, provider: string): asserts row is KnowledgeResult {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new KnowledgeProviderError(provider, `knowledge provider "${provider}" returned a non-object result row`)
  }
  const record = row as Record<string, unknown>
  const bad = (field: string): never => {
    throw new KnowledgeProviderError(
      provider,
      `knowledge provider "${provider}" returned a result row with an invalid ${field}`,
    )
  }
  if (typeof record.sourceId !== 'string' || record.sourceId.length === 0) bad('sourceId')
  if (typeof record.title !== 'string') bad('title')
  if (typeof record.snippet !== 'string') bad('snippet')
  if (!Number.isSafeInteger(record.documentVersion) || (record.documentVersion as number) < 0) bad('documentVersion')
  if (typeof record.locator !== 'string' || record.locator.length === 0) bad('locator')
  if (record.indexedVersion !== undefined
    && (!Number.isSafeInteger(record.indexedVersion) || (record.indexedVersion as number) < 0)) bad('indexedVersion')
  if (record.mediaType !== undefined && typeof record.mediaType !== 'string') bad('mediaType')
  if (record.provider !== undefined && typeof record.provider !== 'string') bad('provider')
}

/** The Knowledge service. Mount via `ctx.plugin(KnowledgeService)`. */
export class KnowledgeService extends Service {
  private readonly providers = new Map<string, KnowledgeProvider>()

  constructor(ctx: Context) {
    super(ctx, 'knowledge')
  }

  /**
   * Register one retrieval provider. Unload (or the disposer) removes it;
   * an unloaded provider is never called by a new retrieval.
   * @param provider - the provider to register.
   * @returns the disposer.
   */
  registerProvider(provider: KnowledgeProvider): () => void {
    if (typeof provider?.name !== 'string' || provider.name.length === 0) {
      throw new TypeError('knowledge provider name must be a non-empty string')
    }
    if (this.providers.has(provider.name)) {
      throw new Error(`knowledge provider "${provider.name}" is already registered`)
    }
    this.providers.set(provider.name, provider)
    return this.ctx.effect(() => () => {
      this.providers.delete(provider.name)
    }, `knowledge.registerProvider(${provider.name})`)
  }

  /** Registered providers (stable names). */
  listProviders(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * Retrieve across all registered providers in registration order,
   * preserving each provider's own stable rank order, then applying the
   * global Top-K cap. Empty provider results yield an empty collection.
   * @param request - the retrieval request (validated).
   * @param signal - optional cancellation.
   * @returns the ranked results, at most `topK` rows.
   * @throws {@link KnowledgeQueryError} for invalid input.
   * @throws {@link KnowledgeProviderNotFoundError} when no provider is registered.
   * @throws {@link KnowledgeProviderError} when a provider fails or violates the row contract.
   */
  async retrieve(request: KnowledgeRequest, signal?: AbortSignal): Promise<KnowledgeResult[]> {
    signal?.throwIfAborted()
    const validated = validateKnowledgeRequest(request)
    if (this.providers.size === 0) {
      throw new KnowledgeProviderNotFoundError('no knowledge provider is registered')
    }
    const results: KnowledgeResult[] = []
    for (const provider of this.providers.values()) {
      signal?.throwIfAborted()
      let rows: readonly KnowledgeResult[]
      try {
        rows = await provider.retrieve(validated, signal)
      } catch (error) {
        throw new KnowledgeProviderError(
          provider.name,
          `knowledge provider "${provider.name}" failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      if (!Array.isArray(rows)) {
        throw new KnowledgeProviderError(
          provider.name,
          `knowledge provider "${provider.name}" returned a non-array result set`,
        )
      }
      for (const row of rows) assertKnowledgeResult(row, provider.name)
      // Stamp the provider name authoritatively (SPEC §5.2: contributor
      // output carries source information; the provider field is not
      // trusted from the row itself).
      results.push(...rows.map((row) => ({ ...row, provider: provider.name })))
    }
    return results.slice(0, validated.topK)
  }
}

declare module '@teoclub/cordis' {
  interface Context {
    /** The Knowledge service (Issue 018). */
    knowledge: KnowledgeService
  }
}

export default KnowledgeService
