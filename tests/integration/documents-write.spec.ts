/**
 * Issue 025 integration: atomic document write, version protection and
 * crash recovery (SPEC §3.4/§3.5/§5.5/§6.3; PRD US-011, FR-19, FR-21,
 * FR-26, FR-27, NFR-5, NFR-6).
 *
 * Node-only: projections ride SQLite and the writes touch the filesystem.
 */
import { describe, expect, it } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@teoclub/harness-session'

type NodeSqliteDriver = import('@teoclub/shared-storage-sqlite-node/node').NodeSqliteDriver

interface NodeModules {
  DocumentVersionConflictError: typeof import('@teoclub/work-documents').DocumentVersionConflictError
  DocumentId: typeof import('@teoclub/work-documents').DocumentId
  DocumentsService: typeof import('@teoclub/work-documents').DocumentsService
  DOCUMENTS_MIGRATIONS: typeof import('@teoclub/work-documents').DOCUMENTS_MIGRATIONS
  LocalDocumentProvider: typeof import('@teoclub/work-documents-local').LocalDocumentProvider
  createWriteDocumentAction: typeof import('@teoclub/work-documents-write').createWriteDocumentAction
  writeDocumentAtomically: typeof import('@teoclub/work-documents-write').writeDocumentAtomically
  recoverDocumentWrites: typeof import('@teoclub/work-documents-write').recoverDocumentWrites
  DOCUMENT_WRITTEN_EVENT_TYPE: typeof import('@teoclub/work-documents-write').DOCUMENT_WRITTEN_EVENT_TYPE
  WorkspaceBoundaryError: typeof import('@teoclub/work-documents-write').WorkspaceBoundaryError
  sha256: typeof import('@teoclub/work-documents-write').sha256
  ActionsService: typeof import('@teoclub/shared-actions').ActionsService
  ACTION_MIGRATIONS: typeof import('@teoclub/shared-actions').ACTION_MIGRATIONS
  ApprovalsService: typeof import('@teoclub/shared-approvals').ApprovalsService
  APPROVAL_MIGRATIONS: typeof import('@teoclub/shared-approvals').APPROVAL_MIGRATIONS
  NodeSqliteDriver: NodeSqliteDriver
  runMigrations: typeof import('@teoclub/shared-storage-sqlite-node/definition').runMigrations
  SESSION_PERSISTENCE_MIGRATIONS: typeof import('@teoclub/shared-session-persistence-sqlite').SESSION_PERSISTENCE_MIGRATIONS
}

describe.skipIf(typeof Bun !== 'undefined')('atomic document write (Node)', async () => {
  async function loadNodeModules(): Promise<NodeModules> {
    const documents = await import('@teoclub/work-documents') as typeof import('@teoclub/work-documents')
    const local = await import('@teoclub/work-documents-local') as typeof import('@teoclub/work-documents-local')
    const write = await import('@teoclub/work-documents-write') as typeof import('@teoclub/work-documents-write')
    const actions = await import('@teoclub/shared-actions') as typeof import('@teoclub/shared-actions')
    const approvals = await import('@teoclub/shared-approvals') as typeof import('@teoclub/shared-approvals')
    const storage = await import('@teoclub/shared-storage-sqlite-node/node') as typeof import('@teoclub/shared-storage-sqlite-node/node')
    const definition = await import('@teoclub/shared-storage-sqlite-node/definition') as typeof import('@teoclub/shared-storage-sqlite-node/definition')
    const session = await import('@teoclub/shared-session-persistence-sqlite') as typeof import('@teoclub/shared-session-persistence-sqlite')
    return {
      DocumentVersionConflictError: documents.DocumentVersionConflictError,
      DocumentId: documents.DocumentId,
      DocumentsService: documents.DocumentsService,
      DOCUMENTS_MIGRATIONS: documents.DOCUMENTS_MIGRATIONS,
      LocalDocumentProvider: local.LocalDocumentProvider,
      createWriteDocumentAction: write.createWriteDocumentAction,
      writeDocumentAtomically: write.writeDocumentAtomically,
      recoverDocumentWrites: write.recoverDocumentWrites,
      DOCUMENT_WRITTEN_EVENT_TYPE: write.DOCUMENT_WRITTEN_EVENT_TYPE,
      WorkspaceBoundaryError: write.WorkspaceBoundaryError,
      sha256: write.sha256,
      ActionsService: actions.ActionsService,
      ACTION_MIGRATIONS: actions.ACTION_MIGRATIONS,
      ApprovalsService: approvals.ApprovalsService,
      APPROVAL_MIGRATIONS: approvals.APPROVAL_MIGRATIONS,
      NodeSqliteDriver: storage.NodeSqliteDriver,
      runMigrations: definition.runMigrations,
      SESSION_PERSISTENCE_MIGRATIONS: session.SESSION_PERSISTENCE_MIGRATIONS,
    }
  }

  // Bun evaluates describe callbacks even for skipped suites, so the
  // node:sqlite imports must never execute under Bun: gate the loader.
  const nodeMods = typeof Bun === 'undefined' ? await loadNodeModules() : undefined

  function mods(): NodeModules {
    if (nodeMods === undefined) throw new Error('node modules unavailable')
    return nodeMods
  }

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rigo-doc-write-'))
  }

  function makeSession(id = 'session_write', cwd?: string): Session {
    return Session.create(SessionId(id), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId(id),
      createdAt: Date.now(),
      ...(cwd === undefined ? {} : { cwd }),
    })
  }

  function writeInput(relativePath: string, content: string, expectedVersion = 0, idempotencyKey = 'key-1'): {
    relativePath: string
    expectedVersion: number
    content: string
    idempotencyKey: string
  } {
    return { relativePath, expectedVersion, content, idempotencyKey }
  }

  it('writes atomically, bumps the version and emits the session event', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(join(root, 'docs'), { recursive: true })
    const docsDriver = new (mods().NodeSqliteDriver)(join(dir, 'documents.sqlite'))
    mods().runMigrations(docsDriver, { migrations: mods().DOCUMENTS_MIGRATIONS })
    const ctx = new Context()
    const session = makeSession('session_write', root)
    try {
      await ctx.plugin(mods().DocumentsService, { driver: docsDriver })
      ctx.documents.registerProvider(new (mods().LocalDocumentProvider)({ session }))
      const first = await mods().writeDocumentAtomically(
        ctx.documents,
        writeInput('docs/plan.md', '# Plan\n\nFirst version.\n'),
        session,
      )
      expect(first.version).toBe(1)
      expect(first.contentHash).toBe(mods().sha256('# Plan\n\nFirst version.\n'))
      expect(readFileSync(join(root, 'docs/plan.md'), 'utf8')).toBe('# Plan\n\nFirst version.\n')
      expect(ctx.documents.getVersion(mods().DocumentId('docs/plan.md'))).toBe(1)
      const written = session.events.filter((event) => event.type === mods().DOCUMENT_WRITTEN_EVENT_TYPE).at(-1)!
      expect(written.data).toMatchObject({ documentId: 'docs/plan.md', version: 1 })

      // A second write with the correct expected version bumps to 2.
      const second = await mods().writeDocumentAtomically(
        ctx.documents,
        writeInput('docs/plan.md', '# Plan\n\nSecond version.\n', 1),
        session,
      )
      expect(second.version).toBe(2)
      expect(ctx.documents.getVersion(mods().DocumentId('docs/plan.md'))).toBe(2)
      expect(readFileSync(join(root, 'docs/plan.md'), 'utf8')).toBe('# Plan\n\nSecond version.\n')

      // Writing the same content keeps the version (monotonic hash rule).
      const same = await mods().writeDocumentAtomically(
        ctx.documents,
        writeInput('docs/plan.md', '# Plan\n\nSecond version.\n', 2),
        session,
      )
      expect(same.version).toBe(2)

      // The provider can read the written document back with the new version.
      const content = await ctx.documents.read(mods().DocumentId('docs/plan.md'))
      expect(content.record.version).toBe(2)
      expect(content.content).toBe('# Plan\n\nSecond version.\n')
    } finally {
      await ctx.fiber.dispose() // DocumentsService owns (and closes) the driver
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects version mismatches with DOCUMENT_VERSION_CONFLICT and leaves the file untouched', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root, { recursive: true })
    const docsDriver = new (mods().NodeSqliteDriver)(join(dir, 'documents.sqlite'))
    mods().runMigrations(docsDriver, { migrations: mods().DOCUMENTS_MIGRATIONS })
    const ctx = new Context()
    const session = makeSession('session_conflict', root)
    try {
      await ctx.plugin(mods().DocumentsService, { driver: docsDriver })
      await mods().writeDocumentAtomically(ctx.documents, writeInput('doc.md', 'v1 content', 0), session)
      await expect(mods().writeDocumentAtomically(ctx.documents, writeInput('doc.md', 'v2 content', 0), session))
        .rejects.toThrowError(mods().DocumentVersionConflictError)
      await expect(mods().writeDocumentAtomically(ctx.documents, writeInput('doc.md', 'v2 content', 0), session))
        .rejects.toMatchObject({ code: 'DOCUMENT_VERSION_CONFLICT', retryable: false })
      // The target file and projection are untouched.
      expect(readFileSync(join(root, 'doc.md'), 'utf8')).toBe('v1 content')
      expect(ctx.documents.getVersion(mods().DocumentId('doc.md'))).toBe(1)
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects workspace escapes and leaves the filesystem untouched', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    const outside = join(dir, 'outside')
    mkdirSync(root, { recursive: true })
    mkdirSync(outside)
    symlinkSync(outside, join(root, 'link'))
    const docsDriver = new (mods().NodeSqliteDriver)(join(dir, 'documents.sqlite'))
    mods().runMigrations(docsDriver, { migrations: mods().DOCUMENTS_MIGRATIONS })
    const ctx = new Context()
    const session = makeSession('session_boundary', root)
    try {
      await ctx.plugin(mods().DocumentsService, { driver: docsDriver })
      for (const relativePath of ['../escape.md', '/etc/hosts', '', 'link/secret.md']) {
        await expect(mods().writeDocumentAtomically(
          ctx.documents,
          writeInput(relativePath, 'x'),
          session,
        )).rejects.toThrowError(mods().WorkspaceBoundaryError)
      }
      expect(existsSync(join(outside, 'secret.md'))).toBe(false)
      expect(readdirSync(root)).not.toContain('.escape.md.tmp')
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails cleanly on disk errors without partial targets or temp leftovers', async () => {
    const dir = tempDir()
    const root = join(dir, 'workspace')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(root, 'existing-dir'))
    const docsDriver = new (mods().NodeSqliteDriver)(join(dir, 'documents.sqlite'))
    mods().runMigrations(docsDriver, { migrations: mods().DOCUMENTS_MIGRATIONS })
    const ctx = new Context()
    const session = makeSession('session_disk', root)
    try {
      await ctx.plugin(mods().DocumentsService, { driver: docsDriver })
      // Renaming over an existing DIRECTORY fails; the dir stays intact.
      await expect(mods().writeDocumentAtomically(
        ctx.documents,
        writeInput('existing-dir', 'content'),
        session,
      )).rejects.toThrow()
      expect(readdirSync(join(root, 'existing-dir'))).toEqual([])
      // No temp files remain anywhere in the workspace.
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
      // A missing parent directory fails before any file is created.
      await expect(mods().writeDocumentAtomically(
        ctx.documents,
        writeInput('ghost/sub/doc.md', 'content'),
        session,
      )).rejects.toThrow()
      expect(existsSync(join(root, 'ghost'))).toBe(false)
    } finally {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('never modifies files for unapproved, denied or expired requests', async () => {
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
      "INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES ('session_write', 'active', '{}', 'now', 'now')",
    )
    const ctx = new Context()
    const session = makeSession('session_write', root)
    try {
      await ctx.plugin(mods().DocumentsService, { driver: docsDriver })
      await ctx.plugin(mods().ActionsService, { driver: sessionDriver })
      await ctx.plugin(mods().ApprovalsService, { driver: sessionDriver })
      ctx.actions.registerAction(mods().createWriteDocumentAction({ documents: ctx.documents, session }))

      // The write is suspended before any filesystem touch.
      const suspended = await ctx.actions.execute({
        action: 'document.write',
        input: writeInput('approved.md', 'new content'),
        idempotencyKey: 'key-approve',
        sessionId: 'session_write',
      })
      expect(suspended.status).toBe('requires-approval')
      expect(existsSync(join(root, 'approved.md'))).toBe(false)

      // Denied: still nothing on disk.
      const denied = await ctx.approvals.create({
        sessionId: 'session_write',
        actionExecutionId: (suspended as { executionId: string }).executionId,
        actionName: 'document.write',
        target: 'approved.md',
        paramsSummary: 'write approved.md',
        expectedImpact: 'creates approved.md',
      })
      await ctx.approvals.decide(denied.id, { decision: 'denied', expectedVersion: 1 })
      expect(existsSync(join(root, 'approved.md'))).toBe(false)

      // Expired: still nothing on disk.
      const expiredExec = await ctx.actions.execute({
        action: 'document.write',
        input: writeInput('approved.md', 'new content', 0, 'key-expire'),
        idempotencyKey: 'key-expire',
        sessionId: 'session_write',
      })
      if (expiredExec.status !== 'requires-approval') throw new Error('unreachable')
      const expired = await ctx.approvals.create({
        sessionId: 'session_write',
        actionExecutionId: expiredExec.executionId,
        actionName: 'document.write',
        target: 'approved.md',
        paramsSummary: 'write approved.md',
        expectedImpact: 'creates approved.md',
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      })
      await expect(ctx.approvals.decide(expired.id, { decision: 'approved', expectedVersion: 1 }))
        .rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' })
      expect(existsSync(join(root, 'approved.md'))).toBe(false)

      // Approved: the file is written exactly once.
      const fresh = await ctx.actions.execute({
        action: 'document.write',
        input: writeInput('approved.md', 'new content', 0, 'key-approve-2'),
        idempotencyKey: 'key-approve-2',
        sessionId: 'session_write',
      })
      if (fresh.status !== 'requires-approval') throw new Error('unreachable')
      const approve = await ctx.approvals.create({
        sessionId: 'session_write',
        actionExecutionId: fresh.executionId,
        actionName: 'document.write',
        target: 'approved.md',
        paramsSummary: 'write approved.md',
        expectedImpact: 'creates approved.md',
      })
      const resolved = await ctx.approvals.decide(approve.id, { decision: 'approved', expectedVersion: 1 })
      expect(resolved.execution).toMatchObject({ status: 'completed' })
      expect(readFileSync(join(root, 'approved.md'), 'utf8')).toBe('new content')
      expect(ctx.documents.getVersion(mods().DocumentId('approved.md'))).toBe(1)
    } finally {
      await ctx.fiber.dispose()
      sessionDriver.close() // ActionsService/ApprovalsService do not own the driver
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('produces a single file side effect per idempotency key', async () => {
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
      "INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES ('session_write', 'active', '{}', 'now', 'now')",
    )
    const ctx = new Context()
    const session = makeSession('session_write', root)
    try {
      await ctx.plugin(mods().DocumentsService, { driver: docsDriver })
      await ctx.plugin(mods().ActionsService, { driver: sessionDriver })
      await ctx.plugin(mods().ApprovalsService, { driver: sessionDriver })
      ctx.actions.registerAction(mods().createWriteDocumentAction({ documents: ctx.documents, session }))
      ctx.actions.beforePolicy(() => ({ decision: 'allow', reason: 'test policy', policy: 'test-policy' }))

      const first = await ctx.actions.execute({
        action: 'document.write',
        input: writeInput('once.md', 'once', 0, 'key-once'),
        idempotencyKey: 'key-once',
        sessionId: 'session_write',
      })
      expect(first.status).toBe('completed')
      if (first.status !== 'completed') throw new Error('unreachable')
      const second = await ctx.actions.execute({
        action: 'document.write',
        input: writeInput('once.md', 'once', 0, 'key-once'),
        idempotencyKey: 'key-once',
        sessionId: 'session_write',
      })
      expect(second.status).toBe('completed')
      if (second.status !== 'completed') throw new Error('unreachable')
      // The replay returns the SAME execution and never re-runs the write.
      expect(second.executionId).toBe(first.executionId)
      expect(second.replayed).toBe(true)
      expect(readFileSync(join(root, 'once.md'), 'utf8')).toBe('once')
      expect(ctx.documents.getVersion(mods().DocumentId('once.md'))).toBe(1)
      expect(session.events.filter((event) => event.type === mods().DOCUMENT_WRITTEN_EVENT_TYPE)).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      sessionDriver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovers crash-orphaned writes by target-hash verification without re-writing', async () => {
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
      "INSERT INTO sessions (id, status, metadata_json, created_at, updated_at) VALUES ('session_write', 'active', '{}', 'now', 'now')",
    )
    const ctx = new Context()
    const session = makeSession('session_write', root)
    const journal = (id: string, relativePath: string, content: string, state: string) => sessionDriver.run(
      `INSERT INTO action_executions
         (id, session_id, action_name, side_effect, state, idempotency_key, request_json, created_at)
       VALUES (?, 'session_write', 'document.write', 'local-write', ?, ?, ?, 'now')`,
      [id, state, `key-${id}`, JSON.stringify({ relativePath, expectedVersion: 0, content, idempotencyKey: `key-${id}` })],
    )
    try {
      await ctx.plugin(mods().DocumentsService, { driver: docsDriver })
      // Crash AFTER the rename (target hash matches the journaled output).
      writeFileSync(join(root, 'renamed.md'), 'recovered content')
      journal('exec-renamed', 'renamed.md', 'recovered content', 'running')
      // Crash BEFORE the rename (target hash differs from the output).
      writeFileSync(join(root, 'stale.md'), 'old bytes')
      journal('exec-stale', 'stale.md', 'expected new bytes', 'running')

      const outcome = await mods().recoverDocumentWrites({
        driver: sessionDriver,
        documents: ctx.documents,
        sessionResolver: (id) => (id === 'session_write' ? session : undefined),
      })
      expect(outcome).toEqual({ replayed: 1, recoveryRequired: 1 })

      // The rename happened: success replayed (projection + journal + event).
      const replayed = sessionDriver.query<{ state: string; result_json: string }>(
        "SELECT state, result_json FROM action_executions WHERE id = 'exec-renamed'",
      )[0]!
      expect(replayed.state).toBe('succeeded')
      expect(JSON.parse(replayed.result_json)).toMatchObject({ version: 1, relativePath: 'renamed.md' })
      expect(ctx.documents.getVersion(mods().DocumentId('renamed.md'))).toBe(1)
      const event = session.events.filter((entry) => entry.type === mods().DOCUMENT_WRITTEN_EVENT_TYPE).at(-1)!
      expect(event.data).toMatchObject({ documentId: 'renamed.md', version: 1 })

      // The rename did not provably happen: recovery-required, file untouched.
      const stale = sessionDriver.query<{ state: string }>(
        "SELECT state FROM action_executions WHERE id = 'exec-stale'",
      )[0]!
      expect(stale.state).toBe('recovery-required')
      expect(readFileSync(join(root, 'stale.md'), 'utf8')).toBe('old bytes')

      // A second recovery pass is a no-op (idempotent).
      const again = await mods().recoverDocumentWrites({
        driver: sessionDriver,
        documents: ctx.documents,
        sessionResolver: (id) => (id === 'session_write' ? session : undefined),
      })
      expect(again).toEqual({ replayed: 0, recoveryRequired: 0 })
    } finally {
      await ctx.fiber.dispose()
      sessionDriver.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
