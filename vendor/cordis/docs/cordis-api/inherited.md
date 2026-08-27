# Inherited Cordis API

The framework `ctx` members and events available to every plugin are
summarized here. The source baseline and adaptation policy are recorded in
[upstream.md](../upstream.md). Detailed Context, Fiber, Registry, and Service
APIs live in [context.md](context.md), [fiber.md](fiber.md),
[registry.md](registry.md), and [service.md](service.md); event-dispatch methods
live in [events.md](events.md).

This reference was imported from DeepSeek Harness at the pinned upstream
commit and its source links were adapted to this repository.

## Inherited `ctx` members (cordis core + loader/hmr/timer)

- `ctx.on / ctx.once` — Register an event listener (disposable). ([`packages/cordis/src/events.ts:34`](../../packages/cordis/src/events.ts))
- `ctx.emit / ctx.parallel / ctx.serial / ctx.bail / ctx.waterfall` — Dispatch an event (sync / awaited / first-bail / short-circuit chain). ([`packages/cordis/src/events.ts:34`](../../packages/cordis/src/events.ts))
- `ctx.plugin / ctx.inject` — Load a plugin / declare required services. ([`packages/cordis/src/registry.ts:164`](../../packages/cordis/src/registry.ts))
- `ctx.effect` — Register a disposable side effect tied to the fiber. ([`packages/cordis/src/fiber.ts:9`](../../packages/cordis/src/fiber.ts))
- `ctx.get / ctx.set / ctx.provide / ctx.accessor / ctx.mixin` — Low-level service-store access and binding. ([`packages/cordis/src/reflect.ts:7`](../../packages/cordis/src/reflect.ts))
- `ctx.extend / ctx.isolate / ctx.intercept` — Derive a child context (scoped services / isolation / interception). ([`packages/cordis/src/context.ts:42`](../../packages/cordis/src/context.ts))
- `ctx.root / ctx.scope / ctx.fiber / ctx.registry / ctx.reflect / ctx.events / ctx.logger` — Ambient handles onto the running context graph. ([`packages/cordis/src/context.ts:16`](../../packages/cordis/src/context.ts))
- `ctx.timer (+ interval / timeout / throttle / debounce)` — Disposable timer helpers. The `timer` key is provided at runtime; the four supported helpers are mixed onto ctx directly (declared via Pick). ([`packages/plugins/timer/src/index.ts:4`](../../packages/plugins/timer/src/index.ts))
- `ctx.loader` — The config Loader that booted the app (present under the loader). ([`packages/plugins/loader/src/index.ts:30`](../../packages/plugins/loader/src/index.ts))
- `ctx.hmr` — The hot-module-reload watcher (present under the hmr plugin). ([`packages/plugins/hmr/src/index.ts:15`](../../packages/plugins/hmr/src/index.ts))

## Inherited events (cordis core + loader/hmr/timer)

- `internal/plugin` — A plugin fiber was created. ([`packages/cordis/src/events.ts:328`](../../packages/cordis/src/events.ts))
- `internal/status` — A fiber changed lifecycle state. ([`packages/cordis/src/events.ts:330`](../../packages/cordis/src/events.ts))
- `internal/service` — Interception hook for a service binding (no core producer). ([`packages/cordis/src/events.ts:332`](../../packages/cordis/src/events.ts))
- `internal/update` — Waterfall: a fiber config update is being applied. ([`packages/cordis/src/events.ts:334`](../../packages/cordis/src/events.ts))
- `internal/get` — Waterfall: a service is being read from the store. ([`packages/cordis/src/events.ts:336`](../../packages/cordis/src/events.ts))
- `internal/set` — Waterfall: a service is being written to the store. ([`packages/cordis/src/events.ts:338`](../../packages/cordis/src/events.ts))
- `internal/listener` — A listener was registered. ([`packages/cordis/src/events.ts:340`](../../packages/cordis/src/events.ts))
- `internal/dispatch` — An event is being dispatched to listeners. ([`packages/cordis/src/events.ts:342`](../../packages/cordis/src/events.ts))
- `hmr/change` — A watched source file changed on disk. ([`packages/plugins/hmr/src/index.ts:20`](../../packages/plugins/hmr/src/index.ts))
- `hmr/reload` — Plugins are being reloaded after a change. ([`packages/plugins/hmr/src/index.ts:21`](../../packages/plugins/hmr/src/index.ts))
- `exit` — The process is exiting on a signal. ([`packages/plugins/loader/src/index.ts:23`](../../packages/plugins/loader/src/index.ts))
- `loader/config-update` — The loader config tree changed. ([`packages/plugins/loader/src/index.ts:24`](../../packages/plugins/loader/src/index.ts))
- `loader/entry-init` — A config entry is being initialized. ([`packages/plugins/loader/src/index.ts:25`](../../packages/plugins/loader/src/index.ts))
- `loader/partial-dispose` — An entry is being partially disposed on reload. ([`packages/plugins/loader/src/index.ts:26`](../../packages/plugins/loader/src/index.ts))
- `loader/patch-context` — A context is being patched during a reload. ([`packages/plugins/loader/src/index.ts:27`](../../packages/plugins/loader/src/index.ts))
