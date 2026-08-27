/**
 * Rigo Minimal Code Bundle (Issue 032; SPEC §2.2, §2.5, §9.3, §10 Phase 6;
 * PRD FR-5, FR-38, D-002).
 *
 * The confirmed minimal Rigo Code composition, proving the CORE serves the
 * coding domain without any Rigo Work implementation:
 *
 *   - the SAME Issue 004 core tree as every domain bundle (AC-6: the core
 *     is not modified to switch profiles);
 *   - Repository Context (controlled top-level summary at the DOMAIN band)
 *     + `file.read` and the approval-gated `file.write` actions (AC-1/2),
 *     reusing the Workspace Boundary + symlink-escape rules (AC-3);
 *   - NO shell, git, LSP, terminal or sandbox (AC-4);
 *   - `packages/code/*` import NO `@teoclub/work-*` package, and
 *     {@link codeMinimalEntryTree} contains no work names while
 *     {@link workBaseEntryTree} contains no code names — the cross-mounting
 *     proof (AC-5/7);
 *   - the session-scoped surfaces (contributor + actions) are wired per
 *     session creation.
 *
 * @module @teoclub/code-minimal
 */

import { join } from 'node:path'
import { Context, type Plugin } from '@teoclub/cordis'
import { bootCore, type CoreBootHandle } from '@teoclub/harness-app-boot'
import ContextService from '@teoclub/harness-context'
import { type Session } from '@teoclub/harness-session'
import ActionsService, { ACTION_MIGRATIONS } from '@teoclub/shared-actions'
import ApprovalsService, { APPROVAL_MIGRATIONS } from '@teoclub/shared-approvals'
import AuditService from '@teoclub/shared-audit'
import SqliteSessionPersistence, { SESSION_PERSISTENCE_MIGRATIONS } from '@teoclub/shared-session-persistence-sqlite'
import { NodeSqliteDriver } from '@teoclub/shared-storage-sqlite-node/node'
import { runMigrations } from '@teoclub/shared-storage-sqlite-node/definition'
import { registerRepositoryContextContributor } from '@teoclub/code-context-repository'
import { createReadFileAction, createWriteFileAction, READ_FILE_ACTION_NAME, WRITE_FILE_ACTION_NAME } from '@teoclub/code-file-actions'

/** Stable entry ids in deterministic registration order. */
export const CODE_MINIMAL_ENTRY_IDS = [
  'session',
  'context',
  'systemPrompt',
  'tools',
  'llm',
  'agent',
  'agentLoop',
  'appBoot',
  'sessionPersistence',
  'actions',
  'approvals',
  'audit',
  'repositoryContext',
  'fileActions',
] as const

export interface CodeMinimalEntryConfig {
  /** Data directory for the SQLite databases. */
  dataDir: string
  /** The LLM provider route (patchable via the `llm` entry). */
  provider?: string
  /** The model id. */
  model?: string
}

/** The Minimal Rigo Code plugin tree (AC-7). */
export function codeMinimalEntryTree(config: CodeMinimalEntryConfig): { id: string; name: string; config?: Record<string, unknown> }[] {
  const provider = config.provider ?? 'mock'
  const model = config.model ?? 'mock'
  return [
    { id: 'session', name: '@teoclub/harness-session' },
    { id: 'context', name: '@teoclub/harness-context' },
    { id: 'systemPrompt', name: '@teoclub/harness-system-prompt' },
    { id: 'tools', name: '@teoclub/harness-tools' },
    { id: 'llm', name: '@teoclub/harness-llm', config: { provider, model } },
    { id: 'agent', name: '@teoclub/harness-agent' },
    { id: 'agentLoop', name: '@teoclub/harness-agent-loop' },
    { id: 'appBoot', name: '@teoclub/harness-app-boot' },
    { id: 'sessionPersistence', name: '@teoclub/shared-session-persistence-sqlite', config: { path: join(config.dataDir, 'session.sqlite') } },
    { id: 'actions', name: '@teoclub/shared-actions', config: { path: join(config.dataDir, 'session.sqlite') } },
    { id: 'approvals', name: '@teoclub/shared-approvals', config: { path: join(config.dataDir, 'session.sqlite') } },
    { id: 'audit', name: '@teoclub/shared-audit' },
    { id: 'repositoryContext', name: '@teoclub/code-context-repository' },
    { id: 'fileActions', name: '@teoclub/code-file-actions' },
  ]
}

export interface CodeMinimalConfig {
  /** Data directory for the SQLite databases. */
  dataDir: string
  /** The LLM provider route (default `mock`). */
  provider?: string
  /** The model id (default `mock`). */
  model?: string
}

/** The session-database migration set (v1 sessions + v2 actions + v3 approvals). */
export function composedSessionMigrations() {
  return [...SESSION_PERSISTENCE_MIGRATIONS, ...ACTION_MIGRATIONS, ...APPROVAL_MIGRATIONS]
}

/** The Minimal Rigo Code plugin list mounted AFTER the Issue 004 core tree. */
export function createCodeMinimalPlugins(config: CodeMinimalConfig): Plugin[] {
  const sessionPath = join(config.dataDir, 'session.sqlite')
  return [
    {
      name: 'rigoCode.sessionPersistence',
      apply: (ctx) => {
        void ctx.plugin(SqliteSessionPersistence, {
          path: sessionPath,
          migrations: composedSessionMigrations(),
        })
      },
    },
    {
      name: 'rigoCode.actions',
      apply: (ctx) => {
        const driver = new NodeSqliteDriver(sessionPath)
        runMigrations(driver, { migrations: composedSessionMigrations() })
        void ctx.plugin(ActionsService, { driver })
        ctx.effect(() => () => driver.close(), 'rigoCode.actions.close()')
      },
    },
    {
      name: 'rigoCode.approvals',
      apply: (ctx) => {
        const driver = new NodeSqliteDriver(sessionPath)
        runMigrations(driver, { migrations: composedSessionMigrations() })
        void ctx.plugin(ApprovalsService, { driver })
        ctx.effect(() => () => driver.close(), 'rigoCode.approvals.close()')
      },
    },
    {
      name: 'rigoCode.audit',
      apply: (ctx) => {
        void ctx.plugin(AuditService)
      },
    },
    {
      name: 'rigoCode.contextService',
      apply: (ctx) => {
        void ctx.plugin(ContextService)
      },
    },
    {
      // Per-session wiring: repository context + file read/write actions.
      name: 'rigoCode.sessionWiring',
      apply: (ctx) => {
        ctx.on('session/created', (session: Session) => {
          wireCodeSession(ctx, session)
        })
      },
      inject: ['context', 'actions', 'approvals'],
    },
  ]
}

/** Register one session's code surface (contributor + file actions). */
function wireCodeSession(ctx: Context, session: Session): void {
  const disposers: (() => void)[] = []
  disposers.push(registerRepositoryContextContributor(ctx, {
    session,
    id: `code.repository:${session.id}`,
  }))
  disposers.push(ctx.actions.registerAction(createReadFileAction({
    session,
    name: `${READ_FILE_ACTION_NAME}:${session.id}`,
  })))
  disposers.push(ctx.actions.registerAction(createWriteFileAction({
    session,
    name: `${WRITE_FILE_ACTION_NAME}:${session.id}`,
  })))
  ctx.on('session/disposed', (disposed: Session) => {
    if (disposed.id !== session.id) return
    for (const dispose of disposers) dispose()
  })
}

/**
 * Boot the Minimal Rigo Code application: the unchanged Issue 004 core tree
 * + the code plugins (AC-6: the core is domain-agnostic).
 * @param options - core boot options (LLM adapters, extra plugins).
 * @param config - the code bundle configuration.
 * @returns the boot handle.
 */
export async function bootCodeMinimal(
  options: { adapters?: Record<string, unknown>; plugins?: Plugin[] } = {},
  config: CodeMinimalConfig,
): Promise<CoreBootHandle> {
  return bootCore({
    adapters: options.adapters as never,
    plugins: [...createCodeMinimalPlugins(config), ...(options.plugins ?? [])],
  })
}

export default createCodeMinimalPlugins
