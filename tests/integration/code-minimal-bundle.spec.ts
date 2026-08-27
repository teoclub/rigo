/**
 * Issue 032 integration: Minimal Rigo Code Bundle (SPEC §2.2, §2.5, §9.3,
 * §10 Phase 6; PRD FR-5, FR-38, D-002).
 *
 * Node-only: the code bundle mounts SQLite-backed services.
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@teoclub/cordis'
import { SessionId } from '@teoclub/harness-session'
import { MockAdapter, textResponse } from '../upstream/agent-loop/tests/mock-adapter.ts'

const isBun = typeof Bun !== 'undefined'

describe.skipIf(isBun)('minimal rigo code bundle (Node)', async () => {
  async function loadNodeModules() {
    const bundle = await import('@teoclub/code-minimal') as typeof import('@teoclub/code-minimal')
    const include = await import('@teoclub/cordis-plugin-include') as typeof import('@teoclub/cordis-plugin-include')
    const appBoot = await import('@teoclub/harness-app-boot') as typeof import('@teoclub/harness-app-boot')
    const context = await import('@teoclub/harness-context') as typeof import('@teoclub/harness-context')
    const workBase = await import('@teoclub/work-base') as typeof import('@teoclub/work-base')
    return {
      ...bundle,
      applyEntryPatches: include.applyEntryPatches,
      loadOverlayPatches: appBoot.loadOverlayPatches,
      ContextService: context.ContextService,
      workBaseEntryTree: workBase.workBaseEntryTree,
    }
  }

  function mods(): Awaited<ReturnType<typeof loadNodeModules>> {
    return nodeMods!
  }
  const nodeMods = typeof Bun === 'undefined' ? await loadNodeModules() : undefined

  function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'rigo-code-minimal-'))
  }

  it('outputs the code plugin tree with no shell/git/lsp/work mounts (AC-4/7)', () => {
    const tree = mods().codeMinimalEntryTree({ dataDir: '/tmp/rigo-code' })
    expect(tree.map((entry) => entry.id)).toEqual([...mods().CODE_MINIMAL_ENTRY_IDS])
    const names = tree.map((entry) => entry.name).join('\n')
    // The core tree is mounted unchanged.
    for (const core of ['@teoclub/harness-session', '@teoclub/harness-context', '@teoclub/harness-agent-loop', '@teoclub/harness-app-boot']) {
      expect(names).toContain(core)
    }
    for (const code of ['@teoclub/code-context-repository', '@teoclub/code-file-actions']) {
      expect(names).toContain(code)
    }
    // AC-4: no shell/git/lsp/terminal/sandbox.
    expect(names).not.toMatch(/shell|git|lsp|terminal|sandbox/)
    // AC-7: the code tree contains NO work names, and the work tree contains
    // NO code names — providers never cross-mount.
    expect(names).not.toContain('@teoclub/work-')
    const workNames = mods().workBaseEntryTree({ dataDir: '/tmp' }).map((entry) => entry.name).join('\n')
    expect(workNames).not.toMatch(/@teoclub\/code-/)
    // AC-5: the code packages' sources import no @teoclub/work-*.
    for (const file of [
      'packages/code/context-repository/src/index.ts',
      'packages/code/file-actions/src/index.ts',
      'packages/bundle/code-minimal/src/index.ts',
    ]) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url).pathname, 'utf8')
      // Only IMPORT specifiers count — prose may name the boundary.
      expect(source, file).not.toMatch(/(?:from|import\()['"]@teoclub\/work-/)
    }
  })

  it('keeps the code bundle cordis.patch.yml in parity with the tree', () => {
    const patches = mods().loadOverlayPatches('test', new URL('../../packages/bundle/code-minimal/cordis.patch.yml', import.meta.url).pathname)
    const fileTree = mods().applyEntryPatches([], patches, () => {}) as unknown as { id: string; name: string }[]
    const programmatic = mods().codeMinimalEntryTree({ dataDir: '/tmp' })
    expect(fileTree.map((entry) => entry.id)).toEqual(programmatic.map((entry) => entry.id))
    expect(fileTree.map((entry) => entry.name)).toEqual(programmatic.map((entry) => entry.name))
  })

  it('boots over the unchanged core, contributes the repository summary and reads files', async () => {
    const dir = tempDir()
    const repo = join(dir, 'repo')
    const dataDir = join(dir, 'data')
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'README.md'), '# Repo\n')
    writeFileSync(join(repo, 'src', 'main.ts'), 'export const answer = 42\n')
    mkdirSync(dataDir, { recursive: true })
    const handle = await mods().bootCodeMinimal(
      { adapters: { mock: new MockAdapter([textResponse('ok')]) } },
      { dataDir, provider: 'mock', model: 'mock' },
    )
    try {
      const ctx = handle.ctx
      // AC-6: the core is unchanged — the same bootCore surface.
      for (const key of ['sessions', 'llm', 'agents', 'agentLoop', 'sessionPersistence', 'actions', 'approvals', 'audit', 'context']) {
        expect(ctx.get(key), `core service ${key}`).toBeDefined()
      }
      // The session wiring registers the repository contributor + actions.
      const session = ctx.sessions.create(SessionId('code-session-1'), { meta: { cwd: repo } })
      // Persist the sessions row (created by the first event flush) so the
      // action journal FK resolves.
      session.append('turn/start', { turn: 1 })
      await ctx.sessions.flush(session)
      expect(ctx.context.list().some((contributor) => contributor.id === 'code.repository:code-session-1')).toBe(true)
      expect(ctx.actions.getAction('file.read:code-session-1')).toBeDefined()
      expect(ctx.actions.getAction('file.write:code-session-1')).toBeDefined()

      // AC-1: the repository context contributes the controlled summary.
      const assembly = await ctx.context.assemble(session)
      expect(assembly.text).toContain('Repository root:')
      expect(assembly.text).toContain('docs')
      expect(assembly.text).toContain('README.md')
      expect(assembly.text).toContain('src')
      expect(assembly.text).not.toMatch(/git|branch|commit/)

      // AC-2/3: file.read works and enforces the boundary.
      const read = await ctx.actions.execute({
        action: 'file.read:code-session-1',
        input: { relativePath: 'src/main.ts' },
        idempotencyKey: 'read-1',
        sessionId: 'code-session-1',
      })
      expect(read.status).toBe('completed')
      if (read.status !== 'completed') throw new Error('unreachable')
      expect(read.result).toMatchObject({ relativePath: 'src/main.ts', content: 'export const answer = 42\n' })
      const escaped = await ctx.actions.execute({
        action: 'file.read:code-session-1',
        input: { relativePath: '../outside.md' },
        idempotencyKey: 'read-2',
        sessionId: 'code-session-1',
      })
      expect(escaped.status).toBe('failed')
      if (escaped.status !== 'failed') throw new Error('unreachable')
      expect(escaped.error.code).toBe('PATH_OUTSIDE_WORKSPACE')
      // Symlink escape is rejected the same way.
      const outside = join(dir, 'outside')
      mkdirSync(outside)
      writeFileSync(join(outside, 'secret.txt'), 'secret')
      symlinkSync(outside, join(repo, 'link'))
      const symlinkEscape = await ctx.actions.execute({
        action: 'file.read:code-session-1',
        input: { relativePath: 'link/secret.txt' },
        idempotencyKey: 'read-3',
        sessionId: 'code-session-1',
      })
      expect(symlinkEscape.status).toBe('failed')
      if (symlinkEscape.status !== 'failed') throw new Error('unreachable')
      expect(symlinkEscape.error.code).toBe('PATH_OUTSIDE_WORKSPACE')
    } finally {
      await handle.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('approves the file write exactly once and denies without touching the disk', async () => {
    const dir = tempDir()
    const repo = join(dir, 'repo')
    const dataDir = join(dir, 'data')
    mkdirSync(repo, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    const handle = await mods().bootCodeMinimal(
      { adapters: { mock: new MockAdapter([textResponse('ok')]) } },
      { dataDir, provider: 'mock', model: 'mock' },
    )
    try {
      const ctx = handle.ctx
      const session = ctx.sessions.create(SessionId('code-session-2'), { meta: { cwd: repo } })
      session.append('turn/start', { turn: 1 })
      await ctx.sessions.flush(session)

      // The write is suspended before touching the disk.
      const suspended = await ctx.actions.execute({
        action: 'file.write:code-session-2',
        input: { relativePath: 'todo.md', content: '# TODO\n', idempotencyKey: 'write-1' },
        idempotencyKey: 'write-1',
        sessionId: 'code-session-2',
      })
      expect(suspended.status).toBe('requires-approval')
      expect(readdirSync(repo)).toEqual([])

      // Denied: still nothing on disk.
      const deniedApproval = await ctx.approvals.create({
        sessionId: 'code-session-2',
        actionExecutionId: (suspended as { executionId: string }).executionId,
        actionName: 'file.write:code-session-2',
        target: 'todo.md',
        paramsSummary: 'write todo.md',
        expectedImpact: 'creates todo.md',
      })
      await ctx.approvals.decide(deniedApproval.id, { decision: 'denied', expectedVersion: 1 })
      expect(readdirSync(repo)).toEqual([])

      // Approved: written exactly once.
      const fresh = await ctx.actions.execute({
        action: 'file.write:code-session-2',
        input: { relativePath: 'todo.md', content: '# TODO\n', idempotencyKey: 'write-2' },
        idempotencyKey: 'write-2',
        sessionId: 'code-session-2',
      })
      if (fresh.status !== 'requires-approval') throw new Error('unreachable')
      const approval = await ctx.approvals.create({
        sessionId: 'code-session-2',
        actionExecutionId: fresh.executionId,
        actionName: 'file.write:code-session-2',
        target: 'todo.md',
        paramsSummary: 'write todo.md',
        expectedImpact: 'creates todo.md',
      })
      const resolved = await ctx.approvals.decide(approval.id, { decision: 'approved', expectedVersion: 1 })
      expect(resolved.execution).toMatchObject({ status: 'completed' })
      expect(readFileSync(join(repo, 'todo.md'), 'utf8')).toBe('# TODO\n')
      // A duplicate idempotency key never re-writes.
      const duplicate = await ctx.actions.execute({
        action: 'file.write:code-session-2',
        input: { relativePath: 'todo.md', content: '# TODO\n', idempotencyKey: 'write-2' },
        idempotencyKey: 'write-2',
        sessionId: 'code-session-2',
      })
      expect(duplicate.status).toBe('completed')
      if (duplicate.status !== 'completed') throw new Error('unreachable')
      expect(duplicate.replayed).toBe(true)
      expect(readFileSync(join(repo, 'todo.md'), 'utf8')).toBe('# TODO\n')
    } finally {
      await handle.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps per-session registrations isolated (no cross-session collisions)', async () => {
    const dir = tempDir()
    const repoA = join(dir, 'repo-a')
    const repoB = join(dir, 'repo-b')
    const dataDir = join(dir, 'data')
    mkdirSync(repoA, { recursive: true })
    mkdirSync(repoB, { recursive: true })
    mkdirSync(dataDir, { recursive: true })
    const handle = await mods().bootCodeMinimal(
      { adapters: { mock: new MockAdapter([textResponse('ok')]) } },
      { dataDir, provider: 'mock', model: 'mock' },
    )
    try {
      const ctx = handle.ctx
      const sessionA = ctx.sessions.create(SessionId('code-session-a'), { meta: { cwd: repoA } })
      const sessionB = ctx.sessions.create(SessionId('code-session-b'), { meta: { cwd: repoB } })
      sessionA.append('turn/start', { turn: 1 })
      sessionB.append('turn/start', { turn: 1 })
      await ctx.sessions.flush(sessionA)
      await ctx.sessions.flush(sessionB)
      const actions = ctx.actions.listActions().sort()
      expect(actions).toEqual([
        'file.read:code-session-a',
        'file.read:code-session-b',
        'file.write:code-session-a',
        'file.write:code-session-b',
      ])
      const contributorIds = ctx.context.list().map((contributor) => contributor.id).sort()
      expect(contributorIds).toEqual(['code.repository:code-session-a', 'code.repository:code-session-b'])
      // Each session's read action serves its own root only.
      writeFileSync(join(repoA, 'a.txt'), 'from A')
      const readA = await ctx.actions.execute({
        action: 'file.read:code-session-a',
        input: { relativePath: 'a.txt' },
        idempotencyKey: 'iso-1',
        sessionId: 'code-session-a',
      })
      expect(readA.status).toBe('completed')
      if (readA.status !== 'completed') throw new Error('unreachable')
      expect(readA.result).toMatchObject({ content: 'from A' })
    } finally {
      await handle.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
