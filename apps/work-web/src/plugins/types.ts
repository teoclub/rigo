/**
 * The app's plugin types: the kit's generic shapes bound to this app's client.
 *
 * A plugin's `id` is the whole contract between the two halves of a feature.
 * The host declares the same string (through `ctx.clientPlugins.declare`) when
 * the feature's host side is mounted, and the browser only composes the ids
 * the host lists — so a feature is genuinely one thing with two sides rather
 * than two things that happen to share a name.
 *
 * @module @teoclub/work-web/plugins/types
 */

import type { WorkApiClient } from '../api.ts'
import type { ClientContext, ClientPlugin } from '../slots/index.ts'

/** A plugin receiving this app's API client. */
export type WorkClientPlugin = ClientPlugin<WorkApiClient>

/** What a plugin's `apply` is handed. */
export type WorkClientContext = ClientContext<WorkApiClient>
