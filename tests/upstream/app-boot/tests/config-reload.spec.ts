/**
 * Config replacement through the booted Include and Loader tree.
 *
 * The Loader is eager and non-transactional (upstream reverted PR #932), so
 * these cases pin the containment that still holds: `Include.refresh()` keeps
 * the last good tree through an edit it cannot read or parse, and a failed
 * update leaves its entry where the attempt reached rather than restoring the
 * previous generation.
 *
 * Note what is NOT guaranteed any more: a syntactically valid candidate that
 * fails to activate is still assigned to the entry, and the Include's debounced
 * writer persists it. Only an edit the Include cannot parse leaves the file
 * untouched.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import type { Include } from '@teoclub/cordis-plugin-include'
import { boot } from '@teoclub/harness-app-boot'

/** `FiberState` is a const enum with no runtime object; freeze the values used here. */
const FIBER_ACTIVE = 2
const FIBER_FAILED = 3
const FIBER_DISPOSED = 4

/**
 * Fiber state of a loader entry, or `undefined` when it has none.
 *
 * A stopped entry keeps its disposed fiber: the reverted Loader disposes the
 * fiber in place rather than clearing the entry's reference, so "unloaded" is
 * state 4, not `undefined`.
 */
function fiberState(ctx: Context, id: string): number | undefined {
  return entryById(ctx, id).fiber?.state
}

const NAME = 'dsh-test-bin'

const NOOP_PLUGIN = 'export const name = "noop"\nexport function apply() {}\n'

interface TreeFixture {
  ctx: Context
  dir: string
  include: Include
}

async function bootTree(configBody: string, files: Record<string, string> = {}): Promise<TreeFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-config-reload-'))
  writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  writeFileSync(join(dir, 'cordis.yml'), configBody)
  const ctx = await boot(NAME, join(dir, 'cordis.yml'))
  const entry = [...ctx.loader.entries()].find(candidate => candidate.subtree !== undefined)
  if (entry?.subtree === undefined) throw new Error('booted tree has no include entry')
  return { ctx, dir, include: entry.subtree as Include }
}

function entryConfig(ctx: Context, id: string): unknown {
  return [...ctx.loader.entries()].find(entry => entry.options.id === id)?.options.config
}

function entryById(ctx: Context, id: string) {
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === id)
  if (!entry) throw new Error(`missing loader entry ${id}`)
  return entry
}

function plugin(name: string, body = ''): string {
  return `export default function ${name}(_ctx, config = {}) { ${body} }\n`
}

/** Longer than one debounce window: the eager restart lands on a later tick. */
function settle(ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const isNode = typeof (process.versions as { bun?: string }).bun === 'undefined'

/**
 * Runtime-diff: the cases below make a plugin throw during a config-driven
 * restart, which the reverted `Fiber.update()` can no longer report to its
 * caller. Node routes that through `unhandledRejection`, which the test
 * captures; Bun's test runner attributes such a rejection to the running test
 * and fails it outright, with no hook to consume it.
 */
const _it = isNode ? it : it.skip

/**
 * Run `body` while capturing rejections that escaped the Loader.
 *
 * Reverted `Fiber.update()` no longer returns the restart promise, so a plugin
 * that throws during a config-driven restart reports through
 * `unhandledRejection` rather than to the update caller. Capturing here pins
 * that contract and keeps it from being reported as a test-runner failure.
 * @param body - the steps whose escaped rejections to collect.
 * @returns every rejection observed while `body` ran.
 */
async function withEscapedRejections(body: () => Promise<void>): Promise<Error[]> {
  const rejections: Error[] = []
  const capture = (reason: unknown) => { rejections.push(reason as Error) }
  process.on('unhandledRejection', capture)
  try {
    await body()
  } finally {
    process.off('unhandledRejection', capture)
  }
  return rejections
}

describe('include refresh with an invalid file', () => {
  it('keeps the last good tree through invalid edits, then applies the next valid one', async () => {
    const { ctx, dir, include } = await bootTree('- id: noop\n  name: ./noop.mjs\n  config:\n    value: 1\n')
    try {
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      // `refresh()` logs and keeps the running tree instead of throwing: a
      // hot-reload of a live app must never take the process down, and the
      // last good generation stays mounted.
      writeFileSync(join(dir, 'cordis.yml'), 'invalid: [unclosed\n')
      await include.refresh()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      // An empty file parses to `undefined` without a YAML error; it must be
      // rejected as a non-array the same way, not crash the entry walk.
      writeFileSync(join(dir, 'cordis.yml'), '')
      await include.refresh()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 1 })

      writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: 2\n')
      await include.refresh()
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 2 })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('loader entry update', () => {
  it('records a changed name without re-importing the running plugin', async () => {
    const { ctx } = await bootTree('- id: target\n  name: ./old.mjs\n', {
      'old.mjs': plugin('oldPlugin'),
      'new.mjs': plugin('newPlugin'),
    })
    try {
      const entry = entryById(ctx, 'target')
      await entry.update({ name: './new.mjs' })
      // The revert dropped the Loader's replace branch: a `name` edit is
      // recorded and written back, but the running fiber keeps its plugin
      // until the entry is recreated (a later refresh or a restart).
      expect(entry.options.name).toBe('./new.mjs')
      expect(entry.parent.data.find(options => options.id === 'target')).toBe(entry.options)
      expect(entry.fiber?.runtime?.callback.name).toBe('oldPlugin')
      expect(entry.options.disabled).toBeUndefined()
      await entry.fiber?.await()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('accepts a name pointing at an unimportable module, keeping the running plugin', async () => {
    const { ctx } = await bootTree('- id: target\n  name: ./old.mjs\n', {
      'old.mjs': plugin('oldPlugin'),
    })
    try {
      const entry = entryById(ctx, 'target')
      const fiber = entry.fiber
      await entry.update({ name: './missing.mjs' })
      expect(entry.options.name).toBe('./missing.mjs')
      expect(entry.fiber === fiber).toBe(true)
      expect(entry.fiber?.runtime?.callback.name).toBe('oldPlugin')
      await fiber?.await()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  _it('keeps the attempted config and fails the fiber when an in-place restart fails', async () => {
    const { ctx } = await bootTree('- id: target\n  name: ./configurable.mjs\n  config:\n    fail: false\n', {
      'configurable.mjs': plugin('configurablePlugin', 'if (config.fail) throw new Error("candidate config failed")'),
    })
    try {
      const entry = entryById(ctx, 'target')
      const rejections = await withEscapedRejections(async () => {
        await entry.update({ config: { fail: true } })
        await settle()
      })
      // No rollback: the entry carries the attempted config, its fiber has
      // failed, and the failure surfaced rather than being swallowed - which
      // is what the boot audit turns into a diagnostic on the next start.
      expect(entry.options.config).toEqual({ fail: true })
      expect(entry.fiber?.state).toBe(FIBER_FAILED)
      expect(rejections.map(error => error.message)).toContain('candidate config failed')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  _it('writes a direct fiber update through to the entry even when the restart fails', async () => {
    const { ctx } = await bootTree('- id: target\n  name: ./configurable.mjs\n  config:\n    fail: false\n', {
      'configurable.mjs': plugin('configurablePlugin', 'if (config.fail) throw new Error("candidate config failed")'),
    })
    try {
      const entry = entryById(ctx, 'target')
      const fiber = entry.fiber
      if (!fiber) throw new Error('target entry has no fiber')
      const rejections = await withEscapedRejections(async () => {
        // `update()` returns nothing now: the restart runs behind the
        // `internal/update` waterfall and the caller cannot await it.
        expect(fiber.update({ fail: true })).toBeUndefined()
        await settle()
      })
      expect(rejections.map(error => error.message)).toContain('candidate config failed')
      // The Loader's `internal/update` listener writes the raw config through
      // to the entry before the restart runs, so the failed config is what the
      // entry now carries; the tree's own row object is the one updated.
      expect((entry.options.config as { fail?: boolean }).fail).toBe(true)
      expect(entry.parent.data.find(options => options.id === 'target') === entry.options).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('loader tree replacement', () => {
  it('applies what it can and contains the row that fails', async () => {
    const { ctx, dir, include } = await bootTree([
      '- id: existing',
      '  name: ./configurable.mjs',
      '  config:',
      '    value: old',
      '',
    ].join('\n'), {
      'configurable.mjs': plugin('configurablePlugin'),
      'bad.mjs': plugin('badPlugin', 'throw new Error("candidate apply failed")'),
    })
    try {
      writeFileSync(join(dir, 'cordis.yml'), [
        '- id: existing',
        '  name: ./configurable.mjs',
        '  config:',
        '    value: candidate',
        '- id: added',
        '  name: ./noop.mjs',
        '- id: bad',
        '  name: ./bad.mjs',
        '',
      ].join('\n'))
      // No rollback: the update is eager, so the earlier row and the addition
      // both land and only the failing row is left unloaded. Creating a row
      // with an unimportable/throwing plugin is caught and logged by the
      // group, so nothing escapes to the caller.
      await include.refresh()
      await ctx.loader.await()
      await settle()
      // Narrow assertions: comparing a whole entry or fiber makes vitest's
      // serializer walk Cordis internals and mask the real failure.
      expect((entryConfig(ctx, 'existing') as { value?: string } | undefined)?.value).toBe('candidate')
      expect(fiberState(ctx, 'added')).toBe(FIBER_ACTIVE)
      expect(fiberState(ctx, 'bad')).toBe(FIBER_FAILED)

      writeFileSync(join(dir, 'cordis.yml'), [
        '- id: existing',
        '  name: ./configurable.mjs',
        '  config:',
        '    value: committed',
        '- id: added',
        '  name: ./noop.mjs',
        '',
      ].join('\n'))
      await include.refresh()
      await ctx.loader.await()
      expect((entryConfig(ctx, 'existing') as { value?: string } | undefined)?.value).toBe('committed')
      expect(fiberState(ctx, 'added')).toBe(FIBER_ACTIVE)
      // the recovered tree no longer carries the row that failed
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'bad')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops and restores descendants when an ancestor group is disabled and re-enabled', async () => {
    // No manual builtin registration: `boot()` supplies `cordis:group` beside
    // `cordis:include`, which is what lets a composition give one `isolate`
    // realm to a provider and its consumers together.
    const { ctx, dir, include } = await bootTree('- id: noop\n  name: ./noop.mjs\n')
    try {
      const config = (disabled: boolean) => [
        '- id: parent',
        '  name: cordis:group',
        '  group: true',
        `  disabled: ${disabled}`,
        '  config:',
        '    - id: child',
        '      name: ./noop.mjs',
        '',
      ].join('\n')

      writeFileSync(join(dir, 'cordis.yml'), config(false))
      await include.refresh()
      await settle()
      expect(fiberState(ctx, 'child')).toBe(FIBER_ACTIVE)

      writeFileSync(join(dir, 'cordis.yml'), config(true))
      await include.refresh()
      await settle()
      expect(fiberState(ctx, 'child')).toBe(FIBER_DISPOSED)

      writeFileSync(join(dir, 'cordis.yml'), config(false))
      await include.refresh()
      await settle()
      expect(fiberState(ctx, 'child')).toBe(FIBER_ACTIVE)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  _it('keeps a programmatic entry move that then fails to update', async () => {
    const { ctx } = await bootTree('- id: noop\n  name: ./noop.mjs\n', {
      'movable.mjs': plugin('movablePlugin', 'if (config.fail) throw new Error("candidate config failed")'),
    })
    try {
      const groupId = await ctx.loader.create({ name: 'cordis:group', group: true, config: [] })
      const targetId = await ctx.loader.create({ name: './movable.mjs', config: { fail: false } })
      const target = entryById(ctx, targetId)
      const source = target.parent
      const destination = entryById(ctx, groupId).subgroup
      if (!destination) throw new Error('created loader group has no subgroup')

      const rejections = await withEscapedRejections(async () => {
        await ctx.loader.update(targetId, { config: { fail: true } }, groupId)
        await settle()
      })

      // The move happens before the update, and the revert removed the
      // rollback, so the entry stays in its destination carrying the config
      // the attempt reached - only the failure is reported.
      expect(target.parent).toBe(destination)
      expect(Object.getPrototypeOf(target.ctx)).toBe(destination.ctx)
      expect(destination.data).toContain(target.options)
      expect(source.data).not.toContain(target.options)
      expect(target.options.config).toEqual({ fail: true })
      expect(rejections.map(error => error.message)).toContain('candidate config failed')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('include refresh with overlay patches', () => {
  it('re-applies entry patches and inserted entries on every re-read (parity with initial load)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-config-reload-overlay-'))
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'base.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: base\n')
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: base',
      "  name: 'cordis:include'",
      '  config:',
      '    path: ./base.yml',
      '    patches:',
      '      - id: noop',
      '        name: ./noop.mjs',
      '        config:',
      '          value: patched',
      '      - insert:',
      '          - id: extra',
      '            name: ./noop.mjs',
      '',
    ].join('\n'))
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'base')
      if (entry?.subtree === undefined) throw new Error('overlay tree has no base include entry')
      const include = entry.subtree as Include
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched' })
      expect(entryConfig(ctx, 'extra')).toBeUndefined()
      expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'extra')).toBe(true)

      writeFileSync(join(dir, 'base.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: edited\n')
      await include.refresh()
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched' })
      expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'extra')).toBe(true)

      // Hot-update of the include entry's own config (the `internal/update`
      // path): the new patches must apply now AND stick for later re-reads —
      // the listener vetoes the fiber restart, so it must persist the new
      // config itself or the next refresh() re-applies the old overlay.
      await entry.update({ config: { path: './base.yml', patches: [{ id: 'noop', name: './noop.mjs', config: { value: 'patched-v2' } }] } })
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched-v2' })
      expect([...ctx.loader.entries()].some(candidate => candidate.options.id === 'extra')).toBe(false)

      writeFileSync(join(dir, 'base.yml'), '- id: noop\n  name: ./noop.mjs\n  config:\n    value: edited-2\n')
      await include.refresh()
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'patched-v2' })

      // Omitting the patch list must remove the overlay rather than reuse the
      // Include's previous config through a default parameter.
      await entry.update({ config: { path: './base.yml' } })
      await ctx.loader.await()
      expect(entryConfig(ctx, 'noop')).toEqual({ value: 'edited-2' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('include patches layered over one base', () => {
  it('lets a later patch configure or disable a row an earlier patch inserted', async () => {
    // The bundle/user-layer/`--patch` composition: `dsh` includes one root
    // and applies each source as its own patch list at the SAME include
    // level, because patches never cross an include boundary. A later layer
    // must therefore be able to reach a row an earlier layer inserted, or
    // bundle-only rows would be invisible to the user's patch layer.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-config-layered-'))
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'base.yml'), '- id: shared\n  name: ./noop.mjs\n  config:\n    value: base\n')
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: base',
      "  name: 'cordis:include'",
      '  config:',
      '    path: ./base.yml',
      '    patches:',
      // Layer 1 (a bundle layer): patch a base row and add two of its own.
      '      - id: shared',
      '        config:',
      '          value: bundle',
      '      - insert:',
      '          - id: bundle-kept',
      '            name: ./noop.mjs',
      '            config:',
      '              value: bundle-default',
      '          - id: bundle-dropped',
      '            name: ./noop.mjs',
      // Layer 2 (the user): reconfigure one inserted row and disable the other.
      '      - id: bundle-kept',
      '        config:',
      '          value: user',
      '      - id: bundle-dropped',
      '        disabled: true',
      '',
    ].join('\n'))
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      expect(entryConfig(ctx, 'shared')).toEqual({ value: 'bundle' })
      expect(entryConfig(ctx, 'bundle-kept')).toEqual({ value: 'user' })
      const dropped = [...ctx.loader.entries()].find(entry => entry.options.id === 'bundle-dropped')
      expect(dropped?.options.disabled).toBe(true)
      expect(dropped?.fiber).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('shipped builtins', () => {
  it('lets a booted composition share one isolate realm across a group of rows', async () => {
    // The reason `boot()` registers `cordis:group`: a composition — notably an
    // agent preset living outside this workspace, which cannot resolve
    // `@deepseek-ai/cordis-plugin-group` by name — gives a provider and its consumer one
    // named realm so the service stays out of the root realm while remaining
    // visible to the rows that need it.
    const { ctx } = await bootTree([
      '- id: realm',
      '  name: cordis:group',
      '  isolate:',
      '    demoRealmSvc: true',
      '  config:',
      '    - id: provider',
      '      name: ./provider.mjs',
      '    - id: consumer',
      '      name: ./consumer.mjs',
      '',
    ].join('\n'), {
      'provider.mjs': 'export const name = "provider"\n'
        + 'export function apply(ctx) { ctx.effect(() => ctx.reflect.provide("demoRealmSvc", { tag: "realm" })) }\n',
      'consumer.mjs': 'export const name = "consumer"\n'
        + 'export const inject = ["demoRealmSvc"]\n'
        + 'export function apply(ctx) { globalThis.__REALM_SEEN__ = ctx.get("demoRealmSvc").tag }\n',
    })
    try {
      expect((globalThis as { __REALM_SEEN__?: string }).__REALM_SEEN__).toBe('realm')
      // `provide` mints the root symbol unconditionally (cordis `reflect.ts`),
      // so the name IS in the root realm — pinned here because it is the half
      // that looks like the claim and is not. The claim is the other half: no
      // implementation is stored under that symbol, so the root realm cannot
      // resolve the service and a second composition mounting the same rows
      // cannot collide with this one.
      const rootKey = ctx.root[Context.isolate].demoRealmSvc
      expect(rootKey).toBeDefined()
      expect(ctx.reflect.store[rootKey!]).toBeUndefined()
    } finally {
      delete (globalThis as { __REALM_SEEN__?: string }).__REALM_SEEN__
      await ctx.fiber.dispose()
    }
  })
})
