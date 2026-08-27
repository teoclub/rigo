/**
 * Issue 026 integration: document read/write tools (SPEC §5.4, §9.3;
 * PRD US-009, US-010, US-011).
 *
 * Node-only: the tools ride the SQLite-backed projection + action/approval
 * pipeline and the filesystem.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'
import { CallId } from '@teoclub/harness-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@teoclub/harness-session'

type NodeSqliteDriver = import('@teoclub/shared-storage-sqlite-node/node').NodeSqliteDriver

interface NodeModules {
  DocumentId: typeof import('@teoclub/work-documents').DocumentId
  DocumentsService: typeof import('@teoclub/work-documents').DocumentsService
  DOCUMENTS_MIGRATIONS: typeof import('@teoclub/work-documents').DOCUMENTS_MIGRATIONS
  LocalDocumentProvider: typeof import('@teoclub/work-documents-local').LocalDocumentProvider
  createWriteDocumentAction: typeof import('@teoclub/work-documents-write').createWriteDocumentAction
  registerReadDocumentTool: typeof import('@teoclub/work-tool-document-read').registerReadDocumentTool
  READ_DOCUMENT_TOOL_NAME: typeof import('@teoclub/work-tool-document-read').READ_DOCUMENT_TOOL_NAME
  registerWriteDocumentTool: typeof import('@teoclub/work-tool-document-write').registerWriteDocumentTool
  WRITE_DOCUMENT_TOOL_NAME: typeof import('@teoclub/work-tool-document-write').WRITE_DOCUMENT_TOOL_NAME
  diffText: typeof import('@teoclub/work-tool-document-write').diffText
  diffSummary: typeof import('@teoclub/work-tool-document-write').diffSummary
  ActionsService: typeof import('@teoclub/shared-actions').ActionsService
  ACTION_MIGRATIONS: typeof import('@teoclub/shared-actions').ACTION_MIGRATIONS
  ApprovalsService: typeof import('@teoclub/shared-approvals').ApprovalsService
  APPROVAL_MIGRATIONS: typeof import('@teoclub/shared-approvals').APPROVAL_MIGRATIONS
  modelToolSchemas: typeof import('@teoclub/harness-tools-protocol').modelToolSchemas
  ToolRuntime: typeof import('@teoclub/harness-tools-protocol').ToolRuntime
  SystemPrompt: typeof import('@teoclub/harness-system-prompt').default
  NodeSqliteDriver: NodeSqliteDriver
  runMigrations: typeof import('@teoclub/shared-storage-sqlite-node/definition').runMigrations
  SESSION_PERSISTENCE_MIGRATIONS: typeof import('@teoclub/shared-session-persistence-sqlite').SESSION_PERSISTENCE_MIGRATIONS
}

describe.skipIf(typeof Bun !== 'undefined')('document read/write tools (Node)', async () => {
  const nodeMods = typeof Bun === 'undefined' ? await loadNodeModules() : undefined

  async function loadNodeModules(): Promise<NodeModules> {
    const documents = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const local = await import('@teoclub/work-documents-local') as typeof import('@teoclub/work-documents-local')
    const write = await import('@teoclub/work-documents-write') as typeof import('@teoclub/work-documents-write')
    const readTool = await import('@teoclub/work-tool-document-read') as typeof import('@teoclub/work-tool-document-read')
    const writeTool = await import('@teoclub/work-tool-document-write') as typeof import('@teoclub/work-tool-document-write')
    const actions = await import('@teoclub/shared-actions') as typeof import('@teoclub/shared-actions')
    const approvals = await import('@teoclub/shared-approvals') as typeof import('@teoclub/shared-approvals')
    const protocol = await import('@teoclub/harness-tools-protocol') as typeof import('@teoclub/harness-tools-protocol')
    const storage = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const definition = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const session = await import('@teoclub/shared-session-persistence-sqlite') as typeof import('@teoclub/shared-session-persistence-sqlite')
    return {
      DocumentId: documents.DocumentId,
      DocumentsService: documents.DocumentsService,
      DOCUMENTS_MIGRATIONS: documents.DOCUMENTS_MIGRATIONS,
      LocalDocumentProvider: local.LocalDocumentProvider,
      createWriteDocumentAction: write.createWriteDocumentAction,
      registerReadDocumentTool: readTool.registerReadDocumentTool,
      READ_DOCUMENT_TOOL_NAME: readTool.READ_DOCUMENT_TOOL_NAME,
      registerWriteDocumentTool: writeTool.registerWriteDocumentTool,
      WRITE_DOCUMENT_TOOL_NAME: writeTool.WRITE_DOCUMENT_TOOL_NAME,
      diffText: writeTool.diffText,
      diffSummary: writeTool.diffSummary,
      ActionsService: actions.ActionsService,
      ACTION_MIGRATIONS: actions.ACTION_MIGRATIONS,
      ApprovalsService: approvals.ApprovalsService,
      APPROVAL_MIGRATIONS: approvals.APPROVAL_MIGRATIONS,
      modelToolSchemas: protocol.modelToolSchemas,
      ToolRuntime: protocol.ToolRuntime,
      SystemPrompt: (await import('@teoclub/harness-system-prompt')).default,
      NodeSqliteDriver: storage.NodeSqliteDriver,
      runMigrations: definition.runMigrations,
      SESSION_PERSISTENCE_MIGRATIONS: session.SESSION_PERSISTENCE_MIGRATIONS,
    }
  }

  function mods(): NodeModules {
    if (nodeMods === undefined) throw new Error('node modules unavailable')
    return nodeMods
  }

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rigo-doc-tools-'))
  }

  function makeSession(id = 'session_tools', cwd?: string): Session {
    return Session.create(SessionId(id), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: Date.now(),
      ...(cwd === undefined ? {} : { cwd }),
    })
  }

  interface Harness {
    ctx: Context
    docsDriver: NodeSqliteDriver
    sessionDriver: NodeSqliteDriver
    root: string
    session: Session
    dispose: () => Promise<void>
    dir: string
  }

  async function harness(): Promise<Harness> {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root, { recursive: true })
    const docsDriver = new (mods().NodeSqliteDriver)(join(dir, 'documents.sqlite'))
    mods().runMigrations(docsDriver, { migrations: mods().DOCUMENTS_MIGRATIONS })
    const sessionDriver = new (mods().NodeSqliteDriver)(join(dir, 'session.sqlite'))
    mods().runMigrations(sessionDriver, {
      migrations: [...mods().SESSION_PERSISTENCE_MIGRATIONS, ...mods().ACTION_MIGRATIONS, ...mods().APPROVAL_MIGRATIONS],
    })
    sessionDriver.run(
      "INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES ('session_tools', 'active', '{}', 'now', 'now')",
    )
    const ctx = new Context()
    const session = makeSession('session_tools', root)
    await ctx.plugin(mods().DocumentsService, { driver: docsDriver })
    await ctx.plugin(mods().ActionsService, { driver: sessionDriver })
    await ctx.plugin(mods().ApprovalsService, { driver: sessionDriver })
    await ctx.plugin(mods().SystemPrompt)
    await ctx.plugin(mods().ToolRuntime)
    ctx.documents.registerProvider(new (mods().LocalDocumentProvider)({ session }))
    ctx.actions.registerAction(mods().createWriteDocumentAction({ documents: ctx.documents, session }))
    return {
      ctx,
      docsDriver,
      sessionDriver,
      root,
      session,
      dir,
      dispose: async () => {
        await ctx.fiber.dispose()
        sessionDriver.close()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  }

  async function runTool(ctx: Context, name: string, args: unknown): Promise<{ content: unknown[]; isError: boolean }> {
    const result = await ctx.tools.execute({
      callId: CallId(`call-${Math.random().toString(36).slice(2)}`),
      name,
      arguments: args,
      signal: new AbortController().signal,
    })
    return {
      content: result.content.map((block) => (block as { text?: string }).text ?? block),
      isError: result.isError,
    }
  }

  it('generates deterministic diffs and summaries', () => {
    const oldText = 'alpha\nbeta\ngamma\n'
    const newText = 'alpha\nBETA\ngamma\ndelta\n'
    const first = mods().diffText(oldText, newText)
    const second = mods().diffText(oldText, newText)
    expect(first).toEqual(second) // deterministic
    expect(first.insertions).toBe(2)
    expect(first.deletions).toBe(1)
    expect(first.unchanged).toBe(3)
    expect(first.lines).toContain(' alpha')
    expect(first.lines).toContain('-beta')
    expect(first.lines).toContain('+BETA')
    expect(first.lines).toContain('+delta')
    expect(mods().diffSummary(oldText, newText)).toBe('2 insertion(s), 1 deletion(s), 3 unchanged line(s)')
    // Identical texts produce an empty diff.
    expect(mods().diffText(newText, newText)).toEqual({ lines: [' alpha', ' BETA', ' gamma', ' delta', ' '], insertions: 0, deletions: 0, unchanged: 5 })
  })

  it('reads documents through the tool with content, version and source — no approval', async () => {
    const h = await harness()
    try {
      writeFileSync(join(h.root, 'guide.md'), '# Guide\n\nHello.\n')
      const content = await h.ctx.documents.read(mods().DocumentId('guide.md'))
      expect(content.record.version).toBe(1)
      const dispose = mods().registerReadDocumentTool(h.ctx, { documents: h.ctx.documents })
      try {
        const result = await runTool(h.ctx, mods().READ_DOCUMENT_TOOL_NAME, { relativePath: 'guide.md' })
        expect(result.isError).toBe(false)
        const payload = JSON.parse(String(result.content[0])) as { relativePath: string; content: string; version: number; source: string }
        expect(payload).toMatchObject({ relativePath: 'guide.md', content: '# Guide\n\nHello.\n', version: 1 })
        expect(payload.source).toContain('guide.md')
        // Missing documents surface the unified failure shape.
        const missing = await runTool(h.ctx, mods().READ_DOCUMENT_TOOL_NAME, { relativePath: 'nope.md' })
        expect(missing.isError).toBe(true)
        expect(String(missing.content[0])).toContain('not found')
      } finally {
        dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('creates a write proposal with a diff, then approves and executes once', async () => {
    const h = await harness()
    try {
      writeFileSync(join(h.root, 'doc.md'), 'one\ntwo\n')
      await h.ctx.documents.read(mods().DocumentId('doc.md'))
      const dispose = mods().registerWriteDocumentTool(h.ctx, {
        documents: h.ctx.documents,
        actions: h.ctx.actions,
        approvals: h.ctx.approvals,
        session: h.session,
      })
      try {
        // The tool call only creates the proposal — nothing on disk yet.
        const proposed = await runTool(h.ctx, mods().WRITE_DOCUMENT_TOOL_NAME, {
          relativePath: 'doc.md',
          expectedVersion: 1,
          content: 'one\ntwo\nthree\n',
          idempotencyKey: 'tool-key-1',
        })
        expect(proposed.isError).toBe(false)
        const proposal = JSON.parse(String(proposed.content[0])) as {
          status: string
          executionId: string
          relativePath: string
          diff: string
        }
        expect(proposal.status).toBe('requires-approval')
        expect(proposal.executionId).toMatch(/^action_/)
        expect(proposal.relativePath).toBe('doc.md')
        expect(proposal.diff).toContain('+three')
        expect(readFileSync(join(h.root, 'doc.md'), 'utf8')).toBe('one\ntwo\n') // untouched

        // An approval request was created with the diff summary.
        const pending = h.ctx.approvals.listPending('session_tools')
        expect(pending).toHaveLength(1)
        expect(pending[0]!.actionExecutionId).toBe(proposal.executionId)
        expect(pending[0]!.paramsSummary).toBe('1 insertion(s), 0 deletion(s), 3 unchanged line(s)')

        // Deny first: nothing changes.
        await h.ctx.approvals.decide(pending[0]!.id, { decision: 'denied', expectedVersion: 1 })
        expect(readFileSync(join(h.root, 'doc.md'), 'utf8')).toBe('one\ntwo\n')

        // Propose again and approve: the write completes exactly once.
        const second = await runTool(h.ctx, mods().WRITE_DOCUMENT_TOOL_NAME, {
          relativePath: 'doc.md',
          expectedVersion: 1,
          content: 'one\ntwo\nthree\n',
          idempotencyKey: 'tool-key-2',
        })
        const proposal2 = JSON.parse(String(second.content[0])) as { executionId: string }
        const pending2 = h.ctx.approvals.listPending('session_tools')[0]!
        const resolved = await h.ctx.approvals.decide(pending2.id, { decision: 'approved', expectedVersion: 1 })
        expect(resolved.execution).toMatchObject({ status: 'completed' })
        expect(readFileSync(join(h.root, 'doc.md'), 'utf8')).toBe('one\ntwo\nthree\n')
        expect(h.ctx.documents.getVersion(mods().DocumentId('doc.md'))).toBe(2)
        // The same proposal id can be re-queried for its final outcome.
        expect(proposal2.executionId).toBe(pending2.actionExecutionId)
      } finally {
        dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('reports DOCUMENT_VERSION_CONFLICT when the target moves during approval — no overwrite', async () => {
    const h = await harness()
    try {
      writeFileSync(join(h.root, 'doc.md'), 'v1\n')
      await h.ctx.documents.read(mods().DocumentId('doc.md'))
      const dispose = mods().registerWriteDocumentTool(h.ctx, {
        documents: h.ctx.documents,
        actions: h.ctx.actions,
        approvals: h.ctx.approvals,
        session: h.session,
      })
      try {
        const proposed = await runTool(h.ctx, mods().WRITE_DOCUMENT_TOOL_NAME, {
          relativePath: 'doc.md',
          expectedVersion: 1,
          content: 'v2 from the model\n',
          idempotencyKey: 'conflict-key',
        })
        const proposal = JSON.parse(String(proposed.content[0])) as { executionId: string }
        // The target changes while the request is pending (another writer).
        writeFileSync(join(h.root, 'doc.md'), 'v1 changed by someone else\n')
        await h.ctx.documents.read(mods().DocumentId('doc.md')) // re-project v2
        const pending = h.ctx.approvals.listPending('session_tools')[0]!
        const resolved = await h.ctx.approvals.decide(pending.id, { decision: 'approved', expectedVersion: 1 })
        // The resumed execution fails with the version conflict; the file
        // keeps the other writer's content.
        expect(resolved.execution).toMatchObject({ status: 'failed' })
        expect(readFileSync(join(h.root, 'doc.md'), 'utf8')).toBe('v1 changed by someone else\n')
        // A fresh proposal on the moved target is accepted, but approving it
        // surfaces the conflict when the execution resumes — no overwrite.
        const conflict = await runTool(h.ctx, mods().WRITE_DOCUMENT_TOOL_NAME, {
          relativePath: 'doc.md',
          expectedVersion: 1,
          content: 'v2 from the model\n',
          idempotencyKey: 'conflict-key-2',
        })
        const conflictPayload = JSON.parse(String(conflict.content[0])) as { status: string; executionId: string }
        expect(conflictPayload.status).toBe('requires-approval')
        const pending2 = h.ctx.approvals.listPending('session_tools')[0]!
        const resolved2 = await h.ctx.approvals.decide(pending2.id, { decision: 'approved', expectedVersion: 1 })
        expect(resolved2.execution).toMatchObject({ status: 'failed' })
        const failed = resolved2.execution as { error?: { code?: string; message: string } }
        expect(failed.error?.code).toBe('DOCUMENT_VERSION_CONFLICT')
        expect(readFileSync(join(h.root, 'doc.md'), 'utf8')).toBe('v1 changed by someone else\n')
      } finally {
        dispose()
      }
    } finally {
      await h.dispose()
    }
  })

  it('revokes tool registrations on unload — new requests do not see the schema', async () => {
    const h = await harness()
    try {
      const readDispose = mods().registerReadDocumentTool(h.ctx, { documents: h.ctx.documents })
      const writeDispose = mods().registerWriteDocumentTool(h.ctx, {
        documents: h.ctx.documents,
        actions: h.ctx.actions,
        approvals: h.ctx.approvals,
        session: h.session,
      })
      const names = () => mods().modelToolSchemas(h.ctx).map((tool) => tool.name).sort()
      expect(names()).toEqual(['document.read', 'document.write'])
      writeDispose()
      expect(names()).toEqual(['document.read'])
      readDispose()
      expect(names()).toEqual([])
      // A disposed tool is no longer executable.
      const result = await runTool(h.ctx, mods().WRITE_DOCUMENT_TOOL_NAME, {
        relativePath: 'x.md', expectedVersion: 0, content: 'x', idempotencyKey: 'k',
      })
      expect(result.isError).toBe(true)
    } finally {
      await h.dispose()
    }
  })
})
