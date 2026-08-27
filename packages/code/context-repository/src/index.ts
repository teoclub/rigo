/**
 * Rigo Repository Context Contributor (Issue 032; SPEC §2.5, §5.2; PRD
 * FR-5, FR-38, D-002).
 *
 * The minimal Rigo Code domain context: a CONTROLLED repository summary
 * contributed at the Context Assembly DOMAIN band — the workspace root and
 * a bounded, deterministic listing of the top-level repository entries
 * (names + kinds, sorted, capped). No git, no shell, no deep scans.
 *
 * @module @teoclub/code-context-repository
 */

import { readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@teoclub/cordis'
import { CONTEXT_ORDER, type ContextContribution, type ContextContributor } from '@teoclub/harness-context'
import { type Session } from '@teoclub/harness-session'

/** The stable contributor id. */
export const REPOSITORY_CONTRIBUTOR_ID = 'code.repository'

/** Cap on the number of top-level entries in the summary. */
export const REPOSITORY_SUMMARY_ENTRY_CAP = 100
/** Cap on each entry name in the summary. */
export const REPOSITORY_ENTRY_NAME_CAP = 120

/** The controlled repository summary. */
export interface RepositorySummary {
  root: string
  /** Sorted top-level entries: `name` with a `dir`/`file` kind. */
  entries: { name: string; kind: 'dir' | 'file' }[]
  /** Whether the entry list was truncated by the cap. */
  truncated: boolean
}

/**
 * Build the deterministic, bounded top-level summary of a repository root.
 * @param root - the absolute repository root.
 * @returns the controlled summary.
 */
export function summarizeRepository(root: string): RepositorySummary {
  const names = readdirSync(root).sort()
  const entries: RepositorySummary['entries'] = []
  for (const name of names) {
    if (entries.length >= REPOSITORY_SUMMARY_ENTRY_CAP) break
    const bounded = name.length > REPOSITORY_ENTRY_NAME_CAP
      ? `${name.slice(0, REPOSITORY_ENTRY_NAME_CAP - 1)}…`
      : name
    entries.push({ name: bounded, kind: statSync(resolve(root, name)).isDirectory() ? 'dir' : 'file' })
  }
  return { root, entries, truncated: entries.length < names.length }
}

/** The model-visible summary text (deterministic). */
export function renderRepositorySummary(summary: RepositorySummary): string {
  const lines = [
    `Repository root: ${summary.root}`,
    `Top-level entries (${summary.entries.length}):`,
    ...summary.entries.map((entry) => `- ${entry.kind === 'dir' ? 'dir ' : 'file'} ${entry.name}`),
    ...(summary.truncated ? ['- …(truncated)'] : []),
  ]
  return lines.join('\n')
}

export interface RepositoryContextContributorConfig {
  /** The session whose header cwd is the repository root. */
  session: Session
  /** Contributor id (default {@link REPOSITORY_CONTRIBUTOR_ID}); multi-session hosts use one id per session. */
  id?: string
}

/**
 * The per-session repository context contributor (SPEC §5.2 DOMAIN band).
 */
export class RepositoryContextContributor implements ContextContributor {
  readonly id: string
  readonly order = CONTEXT_ORDER.DOMAIN_CONTEXT
  private readonly session: Session

  constructor(config: RepositoryContextContributorConfig) {
    if (config?.session === undefined) {
      throw new TypeError('repository context contributor requires a session')
    }
    this.id = config.id ?? REPOSITORY_CONTRIBUTOR_ID
    this.session = config.session
  }

  /** The most recent repository summary (for tests/projection). */
  lastSummary: RepositorySummary | undefined

  contribute(ctx: Context, signal?: AbortSignal): ContextContribution {
    signal?.throwIfAborted()
    void ctx
    const root = this.session.header.cwd
    if (typeof root !== 'string' || root.length === 0) {
      return { source: { contributorId: this.id, label: 'Repository Context' }, content: '' }
    }
    const summary = summarizeRepository(root)
    this.lastSummary = summary
    return {
      source: { contributorId: this.id, label: 'Repository Context' },
      content: renderRepositorySummary(summary),
    }
  }
}

/** Register the contributor and return the disposer. */
export function registerRepositoryContextContributor(
  ctx: Context,
  config: RepositoryContextContributorConfig,
): () => void {
  return ctx.context.register(new RepositoryContextContributor(config))
}

export default RepositoryContextContributor
