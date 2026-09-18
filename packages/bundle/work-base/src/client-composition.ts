/**
 * Host-owned client composition.
 *
 * The browser is not allowed to decide which features it runs. Each plugin
 * declares its browser half here, from inside its own `apply`, through
 * `ctx.effect` — so the list is **derived from what is actually mounted**: a
 * plugin that is disabled or unloaded contributes nothing, and its id leaves
 * the list with it. The browser fetches that list and composes exactly it.
 *
 * This is the whole of "the host owns composition". There is no manifest to
 * keep in sync, because the manifest is an observation of the running tree
 * rather than a second description of it.
 *
 * @module @teoclub/work-base/client-composition
 */

import { Service, type Context } from '@teoclub/cordis'
import type { ApiRoute } from '@teoclub/api-http'
import type { ClientPluginRow } from '@teoclub/api-wire'

/** `work.settings`, `work.model-selection`, … — one dot-separated id per feature. */
const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/

/** The path the browser reads its composition from. */
export const CLIENT_PLUGINS_ROUTE = '/client/plugins'

declare module '@teoclub/cordis' {
  interface Context {
    clientPlugins: ClientPluginRegistry
  }
}

/**
 * The registry of mounted browser-side plugins.
 *
 * `declare` is a **prototype method**, never an instance arrow property: the
 * Cordis service proxy rebinds `this.ctx` to the *caller's* context at call
 * time, and that rebinding is exactly what routes the `ctx.effect` into the
 * caller's fiber. An arrow property would freeze `this` to this service's own
 * root context, so the declaration would outlive the plugin that made it and
 * silently break per-plugin unload.
 */
export class ClientPluginRegistry extends Service {
  private readonly labels = new Map<string, string>()
  private readonly declaredBy = new Map<string, string>()
  private rev = 0

  constructor(ctx: Context) {
    super(ctx, 'clientPlugins')
  }

  /**
   * Declare the browser half of a feature. Call this from the plugin's own `apply`.
   * @param id - the feature id; must equal the browser plugin's `id`.
   * @param options - an optional display label (defaults to the id).
   * @returns a disposer, owned by the calling plugin's fiber.
   * @throws when the id is malformed or already declared by another plugin.
   */
  declare(id: string, options: { label?: string } = {}): () => void {
    if (!ID_PATTERN.test(id)) {
      throw new Error(`client plugin id ${JSON.stringify(id)} must match ${String(ID_PATTERN)}`)
    }
    const existing = this.declaredBy.get(id)
    if (existing !== undefined) {
      throw new Error(`client plugin id ${JSON.stringify(id)} is already declared by ${existing}`)
    }
    // The declaring entry's id when the loader can supply it, else the fiber
    // uid — enough to name the offender in the duplicate message without
    // depending on an augmentation this package does not import.
    const entryId = (this.ctx.fiber as unknown as { entry?: { options?: { id?: string } } }).entry?.options?.id
    const owner = entryId ?? `fiber#${String(this.ctx.fiber.uid)}`
    return this.ctx.effect(() => {
      this.labels.set(id, options.label ?? id)
      this.declaredBy.set(id, owner)
      this.rev += 1
      return () => {
        this.labels.delete(id)
        this.declaredBy.delete(id)
        this.rev += 1
      }
    }, `clientPlugins.declare(${JSON.stringify(id)})`)
  }

  /** The composed plugins, in declaration order (= Cordis mount order). */
  list(): ClientPluginRow[] {
    return [...this.labels].map(([id, label]) => ({ id, label }))
  }

  /**
   * Monotonic composition revision.
   *
   * Nothing consumes it yet. It is on the wire from the start so the payload
   * shape does not have to change when on-demand plugin loading arrives and a
   * cache-buster becomes necessary.
   */
  revision(): number {
    return this.rev
  }
}

/**
 * Routes plugins contribute to the HTTP surface.
 *
 * Deliberately a plain object rather than a service: routes are looked up
 * lazily on every request, so contribution order relative to server creation
 * does not matter.
 */
export class ApiRouteRegistry {
  private readonly routes: ApiRoute[] = []

  /**
   * Contribute a route.
   * @param route - the method, `/api/v1`-relative path, and handler.
   * @returns a disposer removing the route.
   */
  add(route: ApiRoute): () => void {
    this.routes.push(route)
    return () => {
      const index = this.routes.indexOf(route)
      if (index !== -1) this.routes.splice(index, 1)
    }
  }

  /** The current routes, in contribution order. */
  list(): readonly ApiRoute[] {
    return [...this.routes]
  }
}

/**
 * Mount the composition registries and publish the browser's composition
 * endpoint. Must run before `rigo.host` so `apiRoutes` exists by the time the
 * server is created — though because the server reads routes lazily, a later
 * mount would still work.
 */
/**
 * The browser features this host ships.
 *
 * Each id must match a client plugin in `apps/work-web`'s table. They are
 * declared here rather than by separate host packages because the whole web
 * surface is one product: there is no host-side plugin whose mount could stand
 * in for "the approvals feature is available". A future split into real
 * per-feature host packages would move each `declare` into that package's own
 * `apply`, and nothing else about this mechanism would change.
 */
export const CLIENT_FEATURE_IDS = ['work.settings', 'work.model-selection', 'work.approvals'] as const

/**
 * Mount the composition registries and publish the browser's composition
 * endpoint. Must run before `rigo.host` so `apiRoutes` exists by the time the
 * server is created — though because the server reads routes lazily, a later
 * mount would still work.
 */
export const compositionPlugin = {
  name: 'rigo.composition',
  apply: (ctx: Context): void => {
    const root = ctx.root
    root.plugin(ClientPluginRegistry)
    const routes = new ApiRouteRegistry()
    root.reflect.provide('apiRoutes', routes)
    ctx.effect(() => routes.add({
      method: 'GET',
      path: CLIENT_PLUGINS_ROUTE,
      handle: ({ json }) => {
        json(200, { rev: root.clientPlugins.revision(), plugins: root.clientPlugins.list() })
      },
    }), 'rigo.clientPlugins.endpoint()')
  },
}

/**
 * Declare the browser features this host ships.
 *
 * Separate from {@link compositionPlugin} because a plugin cannot inject the
 * service it creates: `ctx.clientPlugins` requires `inject: ['clientPlugins']`,
 * and this plugin is the first thing that needs it.
 */
export const clientFeaturesPlugin = {
  name: 'rigo.clientFeatures',
  inject: ['clientPlugins'],
  apply: (ctx: Context): void => {
    for (const id of CLIENT_FEATURE_IDS) ctx.clientPlugins.declare(id)
  },
}
