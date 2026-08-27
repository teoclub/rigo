/**
 * E2E harness (Issues 037/038): boots the official Rigo Work Bundle with a
 * scripted mock LLM, seeds a fixed knowledge set + target documents into the
 * SQLite index, starts the real Vite dev server for the Rigo Work UI with
 * its /api proxy pointing at the harness, and returns a Playwright-ready
 * URL plus the live context for node-side assertions.
 *
 * Every scenario gets a FRESH temp home, workspace, data dir and server —
 * independent, repeatable, cleaned up on dispose.
 *
 * @module rigo-e2e/harness
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer as createViteServer, type ViteDevServer } from 'vite'
import { Context } from '@teoclub/cordis'
import { MockAdapter, textResponse, toolCallResponse, type HangAfter } from '@teoclub/harness-llm-mock'
import { CallId } from '@teoclub/harness-llm'
import { DocumentId } from '@teoclub/work-documents'
import { bootWorkBase } from '@teoclub/work-base'
import { NodeSqliteDriver } from '@teoclub/shared-storage-sqlite-node/node'
import { SqliteFtsKnowledgeProvider } from '@teoclub/shared-knowledge-sqlite-fts'

export interface E2EHarness {
  baseUrl: string
  apiPort: number
  ctx: Context
  facade: import('@teoclub/api-sdk').RuntimeFacade
  workspace: string
  dataDir: string
  sessionId: string
  /** Dispose the UI server, the bundle and every temp directory. */
  dispose(): Promise<void>
}

export interface E2EHarnessOptions {
  /** Mock script entries (consumed per model request). */
  script: (Parameters<typeof MockAdapter>[0])[0][]
  /** Knowledge files seeded into the index (relative path → content). */
  knowledge?: Record<string, string>
  /** Target documents seeded on disk (relative path → content). */
  documents?: Record<string, string>
  /**
   * Run one warm-up turn on the harness session so its `sessions` row
   * materializes (SPEC §3.2 lazy INSERT on the first event batch) BEFORE
   * the test drives actions directly.
   */
  warmUp?: boolean
}

export const E2E_SECRET_MARKER = 'sk-e2e-secret-4242'

/** Extract the per-session write tool name from a request's tool schemas. */
export function writeToolName(request: { tools?: { name: string }[]; sessionId?: string }): string {
  // Every agent sees ALL registered write tools (one per session); the mock
  // must call ITS OWN session's tool so the approval/action land on the
  // session that sent the message.
  const sessionScoped = request.tools?.find((candidate) => candidate.name === `document.write:${request.sessionId}`)
  if (sessionScoped !== undefined) return sessionScoped.name
  const tool = request.tools?.find((candidate) => candidate.name.startsWith('document.write:'))
  if (tool === undefined) throw new Error('no document.write tool in the request')
  return tool.name
}

/** Start one fully isolated E2E harness. */
export async function startHarness(options: E2EHarnessOptions): Promise<E2EHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'rigo-e2e-'))
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  const dataDir = join(dir, 'data')
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const previousHome = process.env.RIGO_HOME
  process.env.RIGO_HOME = home

  // Target documents on disk.
  for (const [relative, content] of Object.entries(options.documents ?? {})) {
    const target = join(workspace, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }

  const handle = await bootWorkBase(
    // A realistic chunk pace keeps a turn longer than the persistence
    // write-behind's 200ms batching window, so the session row materializes
    // before the model's first tool call (otherwise the instant mock races
    // the lazy sessions INSERT and the action FK fails).
    { adapters: { mock: new MockAdapter(
      options.warmUp === true ? [textResponse('warm up'), ...options.script] : options.script,
      undefined,
      undefined,
      5,
    ) } },
    { dataDir, port: 0, provider: 'mock', model: 'mock' },
  )
  const ctx = handle.ctx
  const facade = ctx.get('facade') as import('@teoclub/api-sdk').RuntimeFacade
  const api = ctx.get('httpServer') as { server: { address(): { port: number } | null } }
  const apiPort = api.server.address()!.port

  // Create the session FIRST so the wiring registers the read provider.
  const created = await facade.createSession({ cwd: workspace, providerId: 'mock', modelId: 'mock', title: 'E2E session' })

  // Seed + index the fixed knowledge set (SPEC §9.4 fixed knowledge data).
  for (const [relative, content] of Object.entries(options.knowledge ?? {})) {
    const target = join(workspace, relative)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
    const read = await ctx.documents.read(DocumentId(relative))
    const provider = new SqliteFtsKnowledgeProvider({ driver: new NodeSqliteDriver(join(dataDir, 'documents.sqlite')) })
    await provider.indexDocuments([{ documentId: relative, documentVersion: read.record.version, title: relative, body: read.content }])
  }

  // Warm-up turn: run one real message so the harness session's `sessions`
  // row materializes deterministically before tests act on it.
  if (options.warmUp === true) {
    facade.sendMessage(created.sessionId, 'warm up', 'e2e-warm-up')
    const probe = new NodeSqliteDriver(join(dataDir, 'session.sqlite'))
    try {
      let materialized = false
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (probe.query('SELECT id FROM sessions WHERE id = ?', [created.sessionId]).length > 0) {
          materialized = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (!materialized) {
        throw new Error(`warm-up turn did not materialize the harness session row for "${created.sessionId}"`)
      }
    } finally {
      probe.close()
    }
  }

  // The real Rigo Work UI through Vite, proxying /api to the harness.
  const vite = await createViteServer({
    configFile: join(process.cwd(), 'apps/work-web/vite.config.ts'),
    root: join(process.cwd(), 'apps/work-web'),
    server: {
      host: '127.0.0.1',
      port: 0,
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}` } },
    },
  })
  await vite.listen()
  const viteAddress = vite.httpServer?.address()
  const uiPort = typeof viteAddress === 'object' && viteAddress !== null ? viteAddress.port : 0

  return {
    baseUrl: `http://127.0.0.1:${uiPort}`,
    apiPort,
    ctx,
    facade,
    workspace,
    dataDir,
    sessionId: created.sessionId,
    dispose: async () => {
      // Close the Vite server and force-drop its connections: the proxied
      // SSE/websocket sockets may outlive the closed page, and a graceful
      // close would otherwise wait on them indefinitely.
      await new Promise<void>((resolve) => {
        const server = vite.httpServer
        if (server === undefined) {
          resolve()
          return
        }
        server.close(() => resolve())
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      })
      await handle.dispose()
      if (previousHome === undefined) delete process.env.RIGO_HOME
      else process.env.RIGO_HOME = previousHome
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** The standard two-turn script: knowledge answer, then a write proposal. */
export function happyPathScript(): (Parameters<typeof MockAdapter>[0])[0][] {
  return [
    textResponse('The knowledge base says rockets use fuel for thrust. [s1]'),
    (request: { tools?: { name: string }[]; sessionId?: string }) =>
      toolCallResponse(
        CallId('call-e2e-write'),
        writeToolName(request),
        {
          relativePath: 'docs/plan.md',
          // A first-seen document is at version 1 (documents version from 1).
          expectedVersion: 1,
          content: '# Plan\n\nUpdated by the approved write.\n',
          idempotencyKey: 'e2e-write',
        },
        'I will update the plan document.',
      ),
    // The loop feeds the tool result back to the model for one more step
    // (the write is suspended awaiting approval), so the script must answer.
    textResponse('The plan update is awaiting your approval.'),
  ]
}

/** A script whose second turn fails with a credential-shaped internal error. */
export function failingScript(): (Parameters<typeof MockAdapter>[0])[0][] {
  return [
    textResponse('first answer'),
    () => {
      const error = new Error('provider exploded') as Error & { internal: unknown }
      error.internal = { apiKey: E2E_SECRET_MARKER }
      throw error
    },
  ]
}

export type { HangAfter }
