import { describe, expect, it, vi } from 'vitest'
import { composeProfileLayers, PROFILE_COMPOSE_PRIORITY } from '@teoclub/harness-app-boot'
import type { Profile } from '@teoclub/harness-app-boot'
import type { PatchOptions } from '@teoclub/cordis-plugin-include'

/**
 * Issue 005: Profile / Bundle / Patch composition (SPEC §2.2, §2.6, §10
 * Phase 2; PRD US-003, FR-6/7/8): fixed low→high layer priority
 * (bundle → profile → home → CLI), deterministic load order, patch-by-id
 * with observable missing-target warnings, normalized plugin-tree output,
 * and failure retention of the last valid composition.
 */

/** Build a loaded-profile fixture without touching the filesystem. */
function profileFixture(
  bundles: { name: string; patches: PatchOptions[] }[],
  patches: PatchOptions[] = [],
): Profile {
  return {
    name: 'demo',
    dir: '/profiles/demo',
    layers: bundles.map((bundle) => ({
      packageName: bundle.name,
      packageDir: `/bundles/${bundle.name}`,
      patchPath: `/bundles/${bundle.name}/cordis.patch.yml`,
      patches: bundle.patches,
    })),
    patchPath: '/profiles/demo/cordis.patch.yml',
    patches,
  }
}

describe('profile composition (Issue 005)', () => {
  it('merges bundle, profile, home and CLI patches at fixed low-to-high priority', () => {
    const composed = composeProfileLayers({
      profile: profileFixture([
        {
          name: 'bundle-a',
          patches: [
            { insert: [{ id: 'shared', name: 'pkg-a', config: { v: 1 } }] },
            { insert: [{ id: 'only-bundle', name: 'pkg-b-only', config: {} }] },
          ],
        },
        { name: 'bundle-b', patches: [{ id: 'shared', config: { v: 2 } }] },
      ], [{ id: 'shared', config: { v: 3 } }]),
      homePatches: [{ id: 'shared', config: { v: 4 } }],
      cliPatches: [{ id: 'shared', config: { v: 5 } }],
    })

    // The layer stack is fixed and labeled; later layers win per stable id.
    expect(composed.layers.map((layer) => layer.label)).toEqual([
      'bundle:bundle-a',
      'bundle:bundle-b',
      'profile',
      'home',
      'cli',
    ])
    expect(PROFILE_COMPOSE_PRIORITY).toEqual(['bundle', 'profile', 'home', 'cli'])
    const shared = composed.entries.find((entry) => entry.id === 'shared')
    expect(shared).toEqual({ id: 'shared', name: 'pkg-a', config: { v: 5 } })
    expect(composed.entries.find((entry) => entry.id === 'only-bundle')).toBeDefined()
  })

  it('keeps the deterministic bundle order and composes identically on every call', () => {
    const profile = profileFixture([
      { name: 'bundle-a', patches: [{ insert: [{ id: 'a', name: 'pkg-a' }] }] },
      { name: 'bundle-b', patches: [{ insert: [{ id: 'b', name: 'pkg-b' }] }] },
    ])
    const first = composeProfileLayers({ profile })
    const second = composeProfileLayers({ profile })
    expect(first.entries.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(second.entries).toEqual(first.entries)
  })

  it('lets a later layer disable a row an earlier layer inserted', () => {
    const composed = composeProfileLayers({
      profile: profileFixture([
        { name: 'bundle-a', patches: [{ insert: [{ id: 'feature', name: 'pkg-f' }] }] },
      ]),
      homePatches: [{ id: 'feature', disabled: true }],
    })
    expect(composed.entries.find((entry) => entry.id === 'feature')?.disabled).toBe(true)
  })

  it('reports a patch whose target row does not exist through the warn sink', () => {
    const warn = vi.fn()
    const composed = composeProfileLayers({
      profile: profileFixture([], []),
      cliPatches: [{ id: 'absent', config: { v: 1 } }],
      warn,
    })
    // The absent-target patch is skipped, not fatal — observable warning only.
    expect(composed.entries).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0]?.[0])).toContain('absent')
    // A missing id on a non-insert patch is also reported.
    const warn2 = vi.fn()
    composeProfileLayers({ profile: profileFixture([]), cliPatches: [{ config: { v: 1 } }], warn: warn2 })
    expect(warn2).toHaveBeenCalledWith(expect.stringContaining('id is required'))
  })

  it('retains the last valid composition when a later patch list is malformed', () => {
    const profile = profileFixture([
      { name: 'bundle-a', patches: [{ insert: [{ id: 'good', name: 'pkg-good' }] }] },
    ])
    const valid = composeProfileLayers({ profile, cliPatches: [{ id: 'good', config: { v: 2 } }] })
    expect(valid.entries).toEqual([{ id: 'good', name: 'pkg-good', config: { v: 2 } }])

    // A null patch entry crashes the include patch algorithm; the pure
    // composition leaves the previous (last valid) tree untouched.
    expect(() => composeProfileLayers({ profile, cliPatches: [null as unknown as PatchOptions] }))
      .toThrow()
    expect(valid.entries).toEqual([{ id: 'good', name: 'pkg-good', config: { v: 2 } }])
  })

  it('composes to the same tree the loader would mount (boot parity)', async () => {
    // The single-pass flattening used here is the exact call boot() makes, so
    // a later layer can target a group child an earlier layer inserted.
    const composed = composeProfileLayers({
      profile: profileFixture([
        {
          name: 'bundle-a',
          patches: [{ insert: [{ id: 'workers', name: 'group-pkg', group: true, config: [] }] }],
        },
      ]),
      cliPatches: [{ id: 'workers', insert: [{ id: 'child', name: 'child-pkg' }] }],
    })
    const workers = composed.entries.find((entry) => entry.id === 'workers')
    expect(workers).toMatchObject({ id: 'workers', group: true })
    expect((workers!.config as { id: string }[]).map((entry) => entry.id)).toEqual(['child'])
  })
})
