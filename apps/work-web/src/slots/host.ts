/**
 * The composition host: one ordered ledger, the plugins composed into it, and
 * the teardown that removes them.
 *
 * The composition is **synchronous by construction**, and that is load-bearing
 * rather than incidental. The component tests render `<App/>` and immediately
 * fire events on it; anything that awaited a fiber between render and
 * interaction would put an async gap in the middle of every one of them. So
 * everything that needs to be asynchronous — fetching the host's composition
 * list, and later downloading a plugin bundle — happens in `main.tsx` *before*
 * `createClientApp` is called. The dynamic-loader upgrade therefore lands in
 * the caller, not in here.
 *
 * `client` is a type parameter rather than a concrete API client so this
 * module (and `core.ts` beside it) can be lifted into its own package
 * unchanged; the app instantiates `createClientApp<WorkApiClient>`.
 *
 * @module @teoclub/work-web/slots/host
 */

import { SlotCore, type SlotKey, type SlotKind, type StoredEntry } from './core.ts'

/** The React-facing read face of the ledger. Every read is cheap and stable between mutations. */
export interface SlotHost {
  readonly core: SlotCore
  subscribe(key: SlotKey, fn: () => void): () => void
  getVersion(key: SlotKey): number
  entriesOfSlot(key: SlotKey): readonly StoredEntry[]
  specOf(key: SlotKey): { kind: SlotKind } | undefined
  reportEntryError(key: SlotKey, entry: StoredEntry, error: unknown): void
}

/** What a plugin is handed when it is composed. A strict subset of the cordis `Context` shape. */
export interface ClientContext<C = unknown> {
  /** The ordered ledger; `register` returns the entry's disposer. */
  readonly slots: SlotCore
  /** The same-origin API client, also reachable from components via `useWorkClient()`. */
  readonly client: C
  /** Register a teardown for this plugin; runs at `ClientApp.dispose()`, newest first. */
  effect(disposer: () => void): void
}

/** One browser-side plugin. Its `id` must equal the id the host declares for the same feature. */
export interface ClientPlugin<C = unknown> {
  id: string
  label: string
  apply(ctx: ClientContext<C>): void
}

/**
 * Where composed plugins come from.
 *
 * This indirection is the one seam that keeps on-demand loading a mechanical
 * change rather than a redesign: today the source is a static table, and a
 * dynamic loader would resolve the same ids to asynchronously-arrived bundles
 * without `createClientApp` changing at all.
 */
export interface ClientPluginSource<C = unknown> {
  /** Every plugin this bundle can render, in table order. */
  list(): readonly ClientPlugin<C>[]
  /** Resolve one host-declared id; `undefined` when this bundle cannot render it. */
  resolve(id: string): ClientPlugin<C> | undefined
}

/** A `ClientPluginSource` over a static module table. */
export function staticPluginSource<C>(plugins: readonly ClientPlugin<C>[]): ClientPluginSource<C> {
  const byId = new Map(plugins.map(plugin => [plugin.id, plugin]))
  return { list: () => plugins, resolve: id => byId.get(id) }
}

export interface ClientApp<C = unknown> {
  readonly host: SlotHost
  readonly client: C
  /** Ids actually composed, in composition order. */
  readonly composed: readonly string[]
  /** Host-listed ids this bundle does not know how to render. Surfaced, never fatal. */
  readonly unknown: readonly string[]
  dispose(): void
}

export interface CreateClientAppOptions<C> {
  client: C
  source: ClientPluginSource<C>
  /**
   * Declare the shell's seats. Runs before any plugin is composed, so no
   * contribution can ever race a declaration and `slots.inject`-style
   * declaration waiting is unnecessary.
   * @returns a disposer releasing the declaration.
   */
  declare(core: SlotCore): () => void
  /** Host-decided enable list, in host order. Omitted means "every plugin in the source". */
  plugins?: readonly string[]
}

/**
 * Compose the ledger: declare the shell, then apply the host's plugin list in host order.
 * @param options - the client, the plugin source, the shell declaration, and the optional host list.
 * @returns the composed app; `dispose()` runs every teardown in reverse.
 */
export function createClientApp<C>(options: CreateClientAppOptions<C>): ClientApp<C> {
  const core = new SlotCore()
  const disposers: (() => void)[] = []
  const ctx: ClientContext<C> = {
    slots: core,
    client: options.client,
    effect: (disposer) => { disposers.push(disposer) },
  }

  disposers.push(options.declare(core))

  const hostIds = options.plugins
  const composed: string[] = []
  const unknown: string[] = []
  if (hostIds === undefined) {
    for (const plugin of options.source.list()) {
      plugin.apply(ctx)
      composed.push(plugin.id)
    }
  } else {
    const seen = new Set<string>()
    for (const id of hostIds) {
      // A duplicate collapses to its first position: the host's order wins,
      // and composing the same plugin twice would double every contribution.
      if (seen.has(id)) continue
      seen.add(id)
      const plugin = options.source.resolve(id)
      if (plugin === undefined) {
        unknown.push(id)
        continue
      }
      plugin.apply(ctx)
      composed.push(plugin.id)
    }
  }

  return {
    host: {
      core,
      subscribe: (key, fn) => core.subscribe(key, fn),
      getVersion: key => core.getVersion(key),
      entriesOfSlot: key => core.entriesOfSlot(key),
      specOf: key => core.specDynamic(key),
      reportEntryError: (key, entry, error) => {
        // Only shadowing kinds abdicate. A `single` or `keyed` cell has a
        // successor to fall through to, so retiring the crashed entry is an
        // improvement; a `list` row IS its own cell, so abdicating would erase
        // the crash face the reader needs. `chain` never abdicates either.
        const kind = core.specDynamic(key)?.kind
        core.reportEntryError(key, entry, error, { abdicate: kind === 'single' || kind === 'keyed' })
      },
    },
    client: options.client,
    composed,
    unknown,
    dispose: () => {
      for (const dispose of [...disposers].reverse()) dispose()
      disposers.length = 0
    },
  }
}
