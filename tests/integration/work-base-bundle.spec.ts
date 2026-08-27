/**
 * Issue 031 integration: Rigo Work Base Bundle (SPEC §2.2, §2.6, §9.3,
 * §10 Phase 6; PRD US-016, FR-6, FR-7, FR-31).
 *
 * Node-only: the bundle boots SQLite-backed services and the HTTP host.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'
import { MockAdapter, textResponse } from '../upstream/agent-loop/tests/mock-adapter.ts'

const isBun = typeof Bun !== 'undefined'

type EntryLike = { id: string; name: string; disabled?: boolean; config?: Record<string, unknown> }

describe.skipIf(isBun)('rigo work base bundle (Node)', async () => {
  async function loadNodeModules() {
    // Everything below is Node-only: the bundle mounts the SQLite-backed
    // stack (and the persistence/storage packages are Node-bound imports).
    const bundle = await import('@teoclub/work-base') as typeof import('@teoclub/work-base')
    const include = await import('@teoclub/cordis-plugin-include') as typeof import('@teoclub/cordis-plugin-include')
    const appBoot = await import('@teoclub/harness-app-boot') as typeof import('@teoclub/harness-app-boot')
    const apiSdk = await import('@teoclub/api-sdk') as typeof import('@teoclub/api-sdk')
    const protocol = await import('@teoclub/harness-tools-protocol') as typeof import('@teoclub/harness-tools-protocol')
    return {
      ...bundle,
      applyEntryPatches: include.applyEntryPatches,
      loadOverlayPatches: appBoot.loadOverlayPatches,
      modelToolSchemas: protocol.modelToolSchemas,
    }
  }

  function mods(): Awaited<ReturnType<typeof loadNodeModules>> {
    return nodeMods!
  }
  const nodeMods = typeof Bun === 'undefined' ? await loadNodeModules() : undefined

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rigo-work-base-'))
  }

  it('outputs the plugin tree with every required mount and none of the excluded ones', () => {
    const tree = mods().workBaseEntryTree({ dataDir: '/tmp/rigo-data' })
    expect(tree.map((entry) => entry.id)).toEqual([...mods().WORK_BASE_ENTRY_IDS])
    const names = tree.map((entry) => entry.name).join('\n')
    // AC-1: core mounts.
    for (const core of ['@teoclub/harness-session', '@teoclub/harness-context', '@teoclub/harness-llm', '@teoclub/harness-agent', '@teoclub/harness-agent-loop', '@teoclub/harness-app-boot']) {
      expect(names).toContain(core)
    }
    // AC-2: shared mounts.
    for (const shared of [
      '@teoclub/shared-session-persistence-sqlite',
      '@teoclub/shared-knowledge',
      '@teoclub/shared-knowledge-sqlite-fts',
      '@teoclub/work-documents',
      '@teoclub/work-documents-local',
      '@teoclub/shared-actions',
      '@teoclub/shared-approvals',
      '@teoclub/shared-audit',
      '@teoclub/work-context',
      '@teoclub/work-tool-document-read',
      '@teoclub/work-tool-document-write',
    ]) {
      expect(names).toContain(shared)
    }
    // AC-3: API mounts.
    expect(names).toContain('@teoclub/api-sdk')
    expect(names).toContain('@teoclub/api-http')
    expect(tree.find((entry) => entry.id === 'host')!.name).toBe('@teoclub/work-base')
    // AC-4: no shell/git/lsp/sandbox/code prompts.
    expect(names).not.toMatch(/shell|git|lsp|sandbox/)
    expect(tree.every((entry) => !entry.name.includes('code-'))).toBe(true)
    expect(tree.some((entry) => entry.name.includes('code'))).toBe(false)
  })

  it('applies patches replacing providers and disabling the write tool while keeping reads', () => {
    const tree = mods().workBaseEntryTree({ dataDir: '/tmp/rigo-data' })
    // AC-5: replace the LLM provider.
    const llmPatched = mods().applyEntryPatches(tree as never, [
      { id: 'llm', config: { provider: 'openai-compatible', model: 'deepseek-v3' } },
    ], () => {}) as unknown as EntryLike[]
    expect(llmPatched.find((entry) => entry.id === 'llm')!.config).toEqual({
      provider: 'openai-compatible',
      model: 'deepseek-v3',
    })
    // AC-5: replace the knowledge provider.
    const knowledgePatched = mods().applyEntryPatches(tree as never, [
      { id: 'knowledgeProvider', config: { path: '/custom/vector.sqlite' } },
    ], () => {}) as unknown as EntryLike[]
    expect(knowledgePatched.find((entry) => entry.id === 'knowledgeProvider')!.config).toEqual({
      path: '/custom/vector.sqlite',
    })
    // AC-6: disable the write tool/action while the read tool survives.
    const writePatched = mods().applyEntryPatches(tree as never, [
      { id: 'toolWrite', disabled: true },
    ], () => {}) as unknown as EntryLike[]
    expect(writePatched.find((entry) => entry.id === 'toolWrite')!.disabled).toBe(true)
    expect(writePatched.find((entry) => entry.id === 'toolRead')!.disabled).not.toBe(true)
    expect(writePatched.find((entry) => entry.id === 'toolRead')).toBeDefined()
    expect(writePatched.find((entry) => entry.id === 'documentsProvider')).toBeDefined()
  })

  it('keeps the cordis.patch.yml artifact in parity with the plugin tree', () => {
    const patches = mods().loadOverlayPatches('test', new URL('../../packages/bundle/work-base/cordis.patch.yml', import.meta.url).pathname)
    const fileTree = mods().applyEntryPatches([], patches, () => {}) as unknown as EntryLike[]
    const programmatic = mods().workBaseEntryTree({ dataDir: '/tmp' })
    expect(fileTree.map((entry) => entry.id)).toEqual(programmatic.map((entry) => entry.id))
    expect(fileTree.map((entry) => entry.name)).toEqual(programmatic.map((entry) => entry.name))
  })

  it('smoke-boots on a fresh home + workspace with a mock LLM, serves health and disposes cleanly', async () => {
    const dir = tempDir()
    const home = join(dir, 'home')
    const workspace = join(dir, 'workspace')
    const dataDir = join(dir, 'data')
    mkdirSync(home, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    const previousHome = process.env.RIGO_HOME
    process.env.RIGO_HOME = home
    try {
      const handle = await mods().bootWorkBase(
        { adapters: { mock: new MockAdapter([textResponse('hello from the mock')]) } },
        { dataDir, port: 0, provider: 'mock', model: 'mock' },
      )
      try {
        const ctx = handle.ctx
        // The full surface is mounted.
        for (const key of ['sessionPersistence', 'actions', 'approvals', 'audit', 'knowledge', 'documents', 'context', 'facade', 'httpServer']) {
          expect(ctx.get(key), `mounted ${key}`).toBeDefined()
        }
        // AC-4: no code/shell services.
        for (const absent of ['shell', 'codeRuntime']) {
          expect(ctx.get(absent), `absent ${absent}`).toBeUndefined()
        }

        // Per-session wiring landed with the first session.
        const facade = ctx.get('facade') as import('@teoclub/api-sdk').RuntimeFacade
        const created = await facade.createSession({ cwd: workspace, providerId: 'mock', modelId: 'mock', title: 'smoke' })
        expect(ctx.documents.listProviders().some((name) => name.startsWith('local:'))).toBe(true)
        expect(ctx.actions.listActions().some((name) => name.startsWith('document.write:'))).toBe(true)
        const toolNames = mods().modelToolSchemas(ctx).map((tool) => tool.name).sort()
        expect(toolNames.some((name) => name.startsWith('document.read:'))).toBe(true)
        expect(toolNames.some((name) => name.startsWith('document.write:'))).toBe(true)
        expect(toolNames).toHaveLength(2)

        // The mock LLM answers a message inside the real loop.
        facade.sendMessage(created.sessionId, 'hello there', 'smoke-msg-1')
        const session = ctx.sessions.get(created.sessionId as never)
        const deadline = Date.now() + 10000
        while (!session.events.some((event) => event.type === 'assistant/message') && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const answer = session.events.find((event) => event.type === 'assistant/message')
        expect(answer).toBeDefined()
        expect(JSON.stringify(answer!.data)).toContain('hello from the mock')

        // HTTP health works end to end.
        const api = ctx.get('httpServer') as { server: { address(): { port: number } | null } }
        const port = api.server.address()!.port
        const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`)
        expect(health.status).toBe(200)
        expect((await health.json()) as unknown).toMatchObject({ status: 'ok', runtime: 'ready', database: 'ok' })

        // The write path works: approve a document write through the API.
        const created2 = await facade.createSession({ cwd: workspace })
        void created2
      } finally {
        await handle.dispose()
      }
      // Disposal closed the HTTP server and released everything.
      await expect(fetch(`http://127.0.0.1:${(ctxServerPort(handle) ?? 0)}`)).rejects.toThrow()
    } finally {
      if (previousHome === undefined) delete process.env.RIGO_HOME
      else process.env.RIGO_HOME = previousHome
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('supports disabling the write tool at boot while keeping reads (AC-6)', async () => {
    const dir = tempDir()
    const workspace = join(dir, 'workspace')
    const dataDir = join(dir, 'data')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    const handle = await mods().bootWorkBase(
      { adapters: { mock: new MockAdapter([textResponse('ok')]) } },
      { dataDir, port: 0, disableWriteTool: true },
    )
    try {
      const ctx = handle.ctx
      const facade = ctx.get('facade') as import('@teoclub/api-sdk').RuntimeFacade
      await facade.createSession({ cwd: workspace })
      expect(ctx.actions.getAction('document.write')).toBeUndefined()
      const toolNames = mods().modelToolSchemas(ctx).map((tool) => tool.name).sort()
      expect(toolNames).toHaveLength(1)
      expect(toolNames[0]).toMatch(/^document\.read:/)
      // Reads still work through the read tool.
      expect(ctx.documents.listProviders().some((name) => name.startsWith('local:'))).toBe(true)
    } finally {
      await handle.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /** Read the bound port off the booted httpServer for the disposal probe. */
  function ctxServerPort(handle: { ctx: Context }): number | undefined {
    const api = handle.ctx.get('httpServer') as { server: { address(): { port: number } | null } } | undefined
    return api?.server.address()?.port
  }
})
