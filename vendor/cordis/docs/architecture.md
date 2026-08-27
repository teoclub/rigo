# Architecture

Cordis is a composable plugin framework. This document describes the four
core concepts - Context, Fiber, Service, Effect - and how they interact.
These entity contracts form the compatibility baseline.

## Context

The `Context` (`packages/cordis/src/context.ts`) is a dependency-injection
container and the object every plugin receives. It is implemented as a
Proxy: property reads resolve through the reflection layer (service lookup,
accessors, mixins), while `extend()`, `isolate()`, and `intercept()`
create scoped child contexts without mutating their parent.

- `ctx.root` - the root context shared by every child
- `ctx.extend(meta)` - child context with extra own properties
- `ctx.isolate(name, label?)` - child with an independent service scope for
  `name`; the same `label` joins scopes
- `ctx.intercept(name, config)` - child carrying additional service config
- `Context.is(value)` - cross-realm brand check via a global symbol

## Fiber

A `Fiber` (`packages/cordis/src/fiber.ts`) is one plugin application
instance: dependency state, validated config, lifecycle effects, and
cleanup. Its state machine is:

```text
PENDING ──deps ready──> LOADING ──ok──> ACTIVE
                         └─fail──> FAILED
ACTIVE ──dep lost/restart──> UNLOADING
UNLOADING ──deps restored──> LOADING     ──deps missing──> PENDING
any live state ──dispose──> UNLOADING ──> DISPOSED (terminal)
root fiber: uid = 0, restart() is a no-op; dispose() unloads children, never DISPOSED
```

Key APIs: `dispose()`, `await()` (settles and rethrows startup errors),
`restart()`, `update(config)` (validated, runs the `internal/update`
waterfall which can veto), `getEffects()`, `assertActive()`.

Configuration is resolved lazily (inherited patch from
[cordiverse/cordis#41](https://github.com/cordiverse/cordis/pull/41)): raw
config is kept and resolved through the `internal/config` waterfall only
after declared injections become active.

## Service

`Service` (`packages/cordis/src/service.ts`) is the base class for named
APIs on `ctx`. Subclasses call `super(ctx, name)`; registration is
immediate and the service unregisters with its owning fiber. An optional
availability predicate (`[Service.check]`) keeps dependents pending until
the service is ready. `[symbols.resolveConfig]` merges intercept config
from ancestor contexts (ancestor entries first).

## Effect

`ctx.effect(execute)` registers cleanup-aware work (`packages/cordis/src/fiber.ts`).
`execute` may return a disposer, a promise of one, or a (async) iterable of
them; disposers run in **reverse registration order** when the fiber
unloads. Calling the returned disposer twice is a no-op. Effect creation is
rejected with `CordisError('INACTIVE_EFFECT')` once the fiber is disposed
or unloading. The vendored baseline additionally hardens reentrant
disposal: an owner-list wrapper is registered before the setup body runs,
synchronous setup failure rolls back collected cleanup, and async cleanup
stays owner-visible until quiescence.

## Events

One event bus (`EventsService`) with five dispatch modes: `emit`
(synchronous, fire-and-forget), `parallel` (all listeners awaited;
rejections aggregate into `AggregateError`), `serial` (await in order
until bail), `bail` (sync first-bail), `waterfall` (listeners wrap a final
`next`; not calling `next` vetoes). Listeners are fiber-owned: they are
removed automatically when the owning fiber unloads. `internal/dispatch`
reports every public dispatch with its mode.

## Registry and reflection

`RegistryService` normalizes the three plugin shapes (function, class,
`{ apply }` object), keeps one runtime record per plugin callback, and
starts fibers. `ReflectService` backs the context proxy: service storage
keyed by isolation label, computed accessors, and mixins (how `ctx.on`
forwards to `ctx.events.on`).

## Module graph

```text
@teoclub/kit  ──>  @teoclub/schemastery  ──>  @teoclub/cordis
                        └──────────────────────┐
   loader ──> include ──> group ──> timer ──> hmr ──> logger-console
```

`cordis` core `src/` contains zero `node:*` imports; Node-specific behavior
lives in plugin packages and `bin.js`. The vendored lineage and every
TEO Club patch are recorded in [upstream.md](upstream.md).
