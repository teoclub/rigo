/**
 * The static plugin table and the host-composition resolver.
 *
 * Components are bundled statically, so the "table" is just an array. What
 * makes it a *composition* rather than a list is `selectClientPlugins`: the
 * host decides which ids are enabled, and the browser resolves them against
 * this table. That mismatch policy lives here, in one pure function, so it is
 * unit-testable without a DOM.
 *
 * @module @teoclub/work-web/plugins/table
 */

import { staticPluginSource } from '../slots/index.ts'
import { approvalsPlugin } from './approvals.tsx'
import { modelSelectionPlugin } from './model-selection.tsx'
import { settingsPlugin } from './settings.tsx'
import type { WorkClientPlugin } from './types.ts'

/**
 * Every plugin this bundle can render, in composition order.
 *
 * The ids must match what the host declares through `ctx.clientPlugins.declare`;
 * a browser id with no host counterpart is simply never composed, and a host id
 * with no browser counterpart surfaces as a notice rather than a failure.
 */
export const CLIENT_PLUGINS: readonly WorkClientPlugin[] = [
  settingsPlugin,
  modelSelectionPlugin,
  approvalsPlugin,
]

/** The source `createClientApp` composes from. */
export const CLIENT_PLUGIN_SOURCE = staticPluginSource(CLIENT_PLUGINS)

/** Every id this bundle knows, for the "compose everything" default. */
export const ALL_CLIENT_PLUGIN_IDS: readonly string[] = CLIENT_PLUGINS.map(plugin => plugin.id)

export interface ClientPluginSelection {
  /** Plugins to compose, in host order. */
  enabled: readonly WorkClientPlugin[]
  /** Host-listed ids this bundle cannot render. Surfaced, never fatal. */
  unknown: readonly string[]
}

/**
 * Resolve a host composition list against this bundle's table.
 *
 * - Host order wins; a repeated id collapses to its first position.
 * - A host id this bundle cannot render lands in `unknown` rather than failing:
 *   a newer host must not brick an older page.
 * - A table plugin the host did not list is simply absent. That IS the host's
 *   decision, and it is the whole point of host-owned composition.
 * @param hostIds - the ids the host listed, in host order.
 * @returns the plugins to compose and the ids that could not be resolved.
 */
export function selectClientPlugins(hostIds: readonly string[]): ClientPluginSelection {
  const enabled: WorkClientPlugin[] = []
  const unknown: string[] = []
  const seen = new Set<string>()
  for (const id of hostIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const plugin = CLIENT_PLUGIN_SOURCE.resolve(id)
    if (plugin === undefined) {
      unknown.push(id)
      continue
    }
    enabled.push(plugin)
  }
  return { enabled, unknown }
}
