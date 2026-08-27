/**
 * Issue 005: Rigo Profile → Bundle → Patch composition (SPEC §2.2, §2.6,
 * §10 Phase 2; PRD US-003, FR-6/7/8).
 *
 * Composes the full fixed-priority layer stack of one loaded Rigo profile
 * into the final normalized plugin tree:
 *
 *   1. bundle layers  (`profile.layers`, in `dsh.profile.bundles` order)  [low]
 *   2. profile patch  (`profile.patches`, the profile's own layer)
 *   3. home patches   (harness-home patch files)
 *   4. CLI patches    (launcher-provided patches)                         [high]
 *
 * Later layers win for the same stable entry id; inserts, config
 * replacements, disables and group markers all flow through the include
 * plugin's single-pass patch algorithm — the same call `boot()` makes — so
 * the composed tree equals what the Loader would mount. A patch whose target
 * row does not exist is reported through the warn sink (observable, never
 * silent). The composition is pure: a malformed patch list throws without
 * mutating any input, so callers keep the last valid tree; retaining the
 * last good tree across failed live reloads is the Loader's transactional
 * behavior (covered by the upstream config-reload suite).
 *
 * @module @teoclub/harness-app-boot/profile-compose
 */

import type { EntryOptions } from '@teoclub/cordis-plugin-loader'
import type { PatchOptions } from '@teoclub/cordis-plugin-include'
import { composeEntries, type Profile } from './profile.ts'

/** Fixed low→high priority of the four composition stages. */
export const PROFILE_COMPOSE_PRIORITY = ['bundle', 'profile', 'home', 'cli'] as const

export interface ProfileComposeOptions {
  /** Loaded profile (see `loadProfile`). */
  profile: Profile
  /** Harness-home patch layer (applied after the profile's own patch). */
  homePatches?: PatchOptions[]
  /** CLI patch layer (highest priority). */
  cliPatches?: PatchOptions[]
  /** Sink for skipped-patch diagnostics (absent target rows). */
  warn?: (message: string) => void
}

export interface ComposedProfileLayer {
  /** `bundle:<package>` for bundle layers, otherwise the stage name. */
  label: string
  /** The layer's patches, in file order. */
  patches: PatchOptions[]
}

export interface ComposedProfile {
  /** Every layer in fixed low→high priority order. */
  layers: ComposedProfileLayer[]
  /** The final normalized plugin tree (canonical loader entry list). */
  entries: EntryOptions[]
}

/**
 * Compose one loaded profile into its final normalized plugin tree.
 *
 * @param options - the loaded profile plus the home and CLI patch layers.
 * @returns the ordered layer stack and the composed entry list.
 */
export function composeProfileLayers(options: ProfileComposeOptions): ComposedProfile {
  const layers: ComposedProfileLayer[] = [
    ...options.profile.layers.map((layer) => ({ label: `bundle:${layer.packageName}`, patches: layer.patches })),
    { label: 'profile', patches: options.profile.patches },
    ...(options.homePatches?.length ? [{ label: 'home', patches: options.homePatches }] : []),
    ...(options.cliPatches?.length ? [{ label: 'cli', patches: options.cliPatches }] : []),
  ]
  const entries = composeEntries(layers.map((layer) => layer.patches), options.warn)
  return { layers, entries }
}
