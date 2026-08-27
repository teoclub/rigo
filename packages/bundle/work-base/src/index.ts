/**
 * Rigo Work Base Bundle (Issue 031; SPEC §2.2, §2.6, §9.3, §10 Phase 6;
 * PRD US-016, FR-6, FR-7, FR-31).
 *
 * The official composition of the local-first Rigo Work application:
 *
 *   - the CORE layer (Session, Context Assembly, LLM, Agent, Agent Loop,
 *     App Boot) — the Issue 004 `bootCore` tree (AC-1);
 *   - the SHARED plugins: SQLite session persistence, Actions, Approvals,
 *     Audit, Knowledge (service + SQLite FTS5 provider), Documents
 *     (definition + local provider), the Work knowledge contributor and
 *     the document read/write tools — the session-scoped surfaces are
 *     wired per session creation (AC-2);
 *   - the API surface: Runtime Facade, HTTP/SSE server and the host plugin
 *     that boots them (AC-3);
 *   - NO shell, git, LSP, sandbox or Rigo Code prompts are mounted (AC-4);
 *   - the plugin TREE is patchable (SPEC §2.6): the `llm` and
 *     `knowledgeProvider` entries can be replaced, and the `toolWrite`
 *     entry can be disabled while reads stay available (AC-5/6);
 *   - {@link workBaseEntryTree} outputs the final plugin tree (AC-7); the
 *     file-based artifact `cordis.patch.yml` mirrors it for the profile
 *     launcher (a parity test pins them together).
 *
 * @module @teoclub/work-base
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Context, type Plugin } from '@teoclub/cordis'
import { bootCore, type CoreBootHandle } from '@teoclub/harness-app-boot'
import { createAgent } from '@teoclub/harness-agent-protocol'
import ContextService from '@teoclub/harness-context'
import { SessionId, type Session } from '@teoclub/harness-session'
import { attachToolSchemasToContext } from '@teoclub/harness-tools-protocol'
import ActionsService, { ACTION_MIGRATIONS } from '@teoclub/shared-actions'
import ApprovalsService, { APPROVAL_MIGRATIONS } from '@teoclub/shared-approvals'
import AuditService from '@teoclub/shared-audit'
import KnowledgeService from '@teoclub/shared-knowledge'
import SqliteFtsKnowledgeProvider, { KNOWLEDGE_MIGRATIONS } from '@teoclub/shared-knowledge-sqlite-fts'
import SqliteSessionPersistence, { SESSION_PERSISTENCE_MIGRATIONS } from '@teoclub/shared-session-persistence-sqlite'
import { NodeSqliteDriver } from '@teoclub/shared-storage-sqlite-node/node'
import { runMigrations } from '@teoclub/shared-storage-sqlite-node/definition'
import { WorkKnowledgeContributor } from '@teoclub/work-context'
import DocumentsService, { DOCUMENTS_MIGRATIONS } from '@teoclub/work-documents'
import { LocalDocumentProvider } from '@teoclub/work-documents-local'
import { createWriteDocumentAction } from '@teoclub/work-documents-write'
import { registerReadDocumentTool } from '@teoclub/work-tool-document-read'
import { registerWriteDocumentTool } from '@teoclub/work-tool-document-write'
import { RuntimeFacade } from '@teoclub/api-sdk'
import { createApiServer } from '@teoclub/api-http'

// ---------------------------------------------------------------------------
// The plugin tree (AC-7)
// ---------------------------------------------------------------------------

/** Stable entry ids in deterministic registration order. */
export const WORK_BASE_ENTRY_IDS = [
  'session',
  'context',
  'systemPrompt',
  'tools',
  'llm',
  'agent',
  'agentLoop',
  'appBoot',
  'sessionPersistence',
  'knowledge',
  'knowledgeProvider',
  'documents',
  'documentsProvider',
  'actions',
  'approvals',
  'audit',
  'workContext',
  'toolRead',
  'toolWrite',
  'facade',
  'http',
  'host',
] as const

/** The static part of one plugin-tree row (AC-7 output shape). */
export interface WorkBaseEntry {
  id: string
  name: string
  config?: Record<string, unknown>
}

/**
 * The Rigo Work Base plugin tree (AC-7). The `llm`, `knowledgeProvider` and
 * `toolWrite` entries are the documented patch targets (AC-5/6).
 */
export function workBaseEntryTree(config: WorkBaseEntryConfig): WorkBaseEntry[] {
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
    { id: 'knowledge', name: '@teoclub/shared-knowledge' },
    { id: 'knowledgeProvider', name: '@teoclub/shared-knowledge-sqlite-fts', config: { path: join(config.dataDir, 'documents.sqlite') } },
    { id: 'documents', name: '@teoclub/work-documents', config: { path: join(config.dataDir, 'documents.sqlite') } },
    { id: 'documentsProvider', name: '@teoclub/work-documents-local' },
    { id: 'actions', name: '@teoclub/shared-actions', config: { path: join(config.dataDir, 'session.sqlite') } },
    { id: 'approvals', name: '@teoclub/shared-approvals', config: { path: join(config.dataDir, 'session.sqlite') } },
    { id: 'audit', name: '@teoclub/shared-audit' },
    { id: 'workContext', name: '@teoclub/work-context' },
    { id: 'toolRead', name: '@teoclub/work-tool-document-read' },
    { id: 'toolWrite', name: '@teoclub/work-tool-document-write' },
    { id: 'facade', name: '@teoclub/api-sdk' },
    { id: 'http', name: '@teoclub/api-http' },
    { id: 'host', name: '@teoclub/work-base', config: { port: config.port ?? 0, provider, model } },
  ]
}

export interface WorkBaseEntryConfig {
  /** Data directory for the SQLite databases. */
  dataDir: string
  /** The LLM provider route (patchable via the `llm` entry). */
  provider?: string
  /** The model id (patchable via the `llm` entry). */
  model?: string
  /** HTTP port (0 = ephemeral). */
  port?: number
}

// ---------------------------------------------------------------------------
// Programmatic composition (the smoke-testable path)
// ---------------------------------------------------------------------------

export interface WorkBaseConfig {
  /** Data directory for the SQLite databases. */
  dataDir: string
  /** The LLM provider route (default `mock`). */
  provider?: string
  /** The model id (default `mock`). */
  model?: string
  /** HTTP port (default 0 = ephemeral). */
  port?: number
  /** Disable the document write tool + action while keeping reads (AC-6). */
  disableWriteTool?: boolean
}

/** The session-database migration set (v1 sessions + v2 actions + v3 approvals). */
export function composedSessionMigrations() {
  return [...SESSION_PERSISTENCE_MIGRATIONS, ...ACTION_MIGRATIONS, ...APPROVAL_MIGRATIONS]
}

/** The documents-database migration set (v1 documents + v2 knowledge). */
export function composedDocumentsMigrations() {
  return [...DOCUMENTS_MIGRATIONS, ...KNOWLEDGE_MIGRATIONS]
}

/**
 * The Rigo Work plugin list mounted AFTER the Issue 004 core tree
 * (AC-1/2/3). Every driver opens the shared SQLite files (WAL allows
 * multiple connections); migrations run once per file (idempotent,
 * checksummed) and each plugin owns its driver lifecycle.
 */
export function createWorkBasePlugins(config: WorkBaseConfig): Plugin[] {
  const provider = config.provider ?? 'mock'
  const model = config.model ?? 'mock'
  const sessionPath = join(config.dataDir, 'session.sqlite')
  const documentsPath = join(config.dataDir, 'documents.sqlite')

  return [
    // Service mounts. Each service registers its provider SYNCHRONOUSLY in
    // the apply (Cordis `provide` lands during construction), so sibling
    // plugins with `inject` resolve it deterministically in registration
    // order.
    {
      name: 'rigo.sessionPersistence',
      apply: (ctx) => {
        void ctx.plugin(SqliteSessionPersistence, {
          path: sessionPath,
          migrations: composedSessionMigrations(),
        })
      },
    },
    {
      name: 'rigo.audit',
      apply: (ctx) => {
        void ctx.plugin(AuditService)
      },
    },
    {
      name: 'rigo.actions',
      apply: (ctx) => {
        const driver = new NodeSqliteDriver(sessionPath)
        runMigrations(driver, { migrations: composedSessionMigrations() })
        void ctx.plugin(ActionsService, {
          driver,
          // SPEC §6.3 audit gate: record every execution lifecycle fact as a
          // redacted `action/executed` session event on the owning session
          // (the running record lands BEFORE the executor runs).
          recordExecution: (entry) => {
            const session = ctx.sessions.get(SessionId(entry.sessionId))
            if (session === undefined) return
            ctx.audit.recordActionExecution(session, entry)
          },
        })
        ctx.effect(() => () => driver.close(), 'rigo.actions.close()')
      },
      inject: ['sessions', 'audit'],
    },
    {
      name: 'rigo.approvals',
      apply: (ctx) => {
        const driver = new NodeSqliteDriver(sessionPath)
        runMigrations(driver, { migrations: composedSessionMigrations() })
        void ctx.plugin(ApprovalsService, { driver })
        ctx.effect(() => () => driver.close(), 'rigo.approvals.close()')
      },
    },
    {
      name: 'rigo.knowledgeService',
      apply: (ctx) => {
        void ctx.plugin(KnowledgeService)
      },
    },
    {
      name: 'rigo.knowledge',
      apply: (ctx) => {
        const driver = new NodeSqliteDriver(documentsPath)
        runMigrations(driver, { migrations: composedDocumentsMigrations() })
        ctx.knowledge.registerProvider(new SqliteFtsKnowledgeProvider({ driver }))
        ctx.effect(() => () => driver.close(), 'rigo.knowledge.close()')
      },
      inject: ['knowledge'],
    },
    {
      name: 'rigo.documents',
      apply: (ctx) => {
        const driver = new NodeSqliteDriver(documentsPath)
        runMigrations(driver, { migrations: composedDocumentsMigrations() })
        void ctx.plugin(DocumentsService, { driver, migrations: composedDocumentsMigrations() })
        ctx.effect(() => () => driver.close(), 'rigo.documents.close()')
      },
    },
    {
      name: 'rigo.contextService',
      apply: (ctx) => {
        void ctx.plugin(ContextService)
      },
    },
    {
      name: 'rigo.context',
      apply: (ctx) => {
        attachToolSchemasToContext(ctx)
        // SPEC §5.1 "assemble context contributors": the ported agent loop
        // only assembles prompt sections/tool schemas, so fold the Rigo
        // Context Assembly (knowledge band etc.) into every model request
        // through the system-prompt assemble expert. The agent resolves the
        // session; bare assemblies (tests, diagnostics) pass through.
        ctx.on('system-prompt/assemble', async (_assembly, assembleContext, next) => {
          const agent = assembleContext.agent
          const base = await next()
          if (agent === undefined) return base
          const result = await ctx.context.assemble(agent.session, {
            ...(assembleContext.signal === undefined ? {} : { signal: assembleContext.signal }),
          })
          if (result.text.length === 0) return base
          return {
            ...base,
            contexts: [...base.contexts, { name: 'context-assembly', text: result.text }],
          }
        })
      },
      inject: ['context'],
    },
    {
      // Per-session wiring: on every session creation, register the local
      // document provider, the write action, the read/write tools and the
      // knowledge contributor (each scoped to that session's workspace root).
      name: 'rigo.sessionWiring',
      apply: (ctx) => {
        ctx.on('session/created', (session: Session) => {
          wireSession(ctx, config, session)
        })
      },
      inject: ['documents', 'actions', 'approvals', 'knowledge', 'context', 'tools'],
    },
    {
      // The API surface (AC-3): Runtime Facade + HTTP/SSE server. The facade
      // is rooted so every mounted service resolves from its ctx.
      name: 'rigo.host',
      apply: async (ctx) => {
        const root = ctx.root
        const facade = new RuntimeFacade(root, {
          agentFactory: async (input) => createAgent(root, {
            sessionId: SessionId(`session_${randomUUID()}`),
            agentOptions: { provider, model },
            ...(input.cwd === undefined ? {} : { meta: { cwd: input.cwd } }),
          }),
          loadSession: async (id) => {
            const loaded = await root.sessionPersistence.load(SessionId(id))
            return { events: [...loaded.events] }
          },
          checkDatabase: () => {
            const probe = new NodeSqliteDriver(sessionPath)
            try {
              probe.query('SELECT 1')
              return true
            } catch {
              return false
            } finally {
              probe.close()
            }
          },
          modelValidator: (candidateProvider) => candidateProvider === provider,
        })
        root.reflect.provide('facade', facade)
        const api = createApiServer({ facade })
        // The boot only settles once the server listens (the smoke test
        // reads the bound port right after).
        await api.listen(config.port ?? 0)
        root.reflect.provide('httpServer', api)
        ctx.effect(() => () => {
          void api.close()
        }, 'rigo.host.close()')
      },
    },
  ]
}

/** Per-session write action/tool registry key prefix. */
export const WRITE_ACTION_PREFIX = 'document.write:'

/** Register one session's work surface (provider, action, tools, contributor). */
function wireSession(ctx: Context, config: WorkBaseConfig, session: Session): void {
  const disposers: (() => void)[] = []
  // Documents: the local read provider scoped to the session's workspace root.
  disposers.push(ctx.documents.registerProvider(new LocalDocumentProvider({ session, name: `local:${session.id}` })))
  // Actions: the atomic write action (AC-6: skipped when disabled).
  if (!config.disableWriteTool) {
    disposers.push(ctx.actions.registerAction(createWriteDocumentAction({
      documents: ctx.documents,
      session,
      name: `${WRITE_ACTION_PREFIX}${session.id}`,
    })))
  }
  // Tools: read always; write only when enabled.
  disposers.push(registerReadDocumentTool(ctx, { documents: ctx.documents, name: `document.read:${session.id}` }))
  if (!config.disableWriteTool) {
    disposers.push(registerWriteDocumentTool(ctx, {
      documents: ctx.documents,
      actions: ctx.actions,
      approvals: ctx.approvals,
      session,
      name: `document.write:${session.id}`,
      actionName: `${WRITE_ACTION_PREFIX}${session.id}`,
    }))
  }
  // Knowledge retrieval into the Context Assembly (KNOWLEDGE band).
  disposers.push(ctx.context.register(new WorkKnowledgeContributor({
    session,
    knowledge: ctx.knowledge,
    id: `work.knowledge:${session.id}`,
  })))
  // Release the registrations when the session is disposed.
  ctx.on('session/disposed', (disposed: Session) => {
    if (disposed.id !== session.id) return
    for (const dispose of disposers) dispose()
  })
}

/**
 * Boot the full Rigo Work application: the Issue 004 core tree + the work
 * base plugins.
 * @param options - core boot options (LLM adapters, extra plugins).
 * @param config - the work base configuration.
 * @returns the boot handle (ctx + dispose).
 */
export async function bootWorkBase(
  options: { adapters?: Record<string, unknown>; plugins?: Plugin[] } = {},
  config: WorkBaseConfig,
): Promise<CoreBootHandle> {
  return bootCore({
    adapters: options.adapters as never,
    plugins: [...createWorkBasePlugins(config), ...(options.plugins ?? [])],
  })
}

/** Convenience: the facade service key provided by the host plugin. */
export const FACADE_SERVICE_KEY = 'facade'
/** Convenience: the HTTP server service key provided by the host plugin. */
export const HTTP_SERVER_SERVICE_KEY = 'httpServer'

export default createWorkBasePlugins
