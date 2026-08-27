# API Reference

The authoritative API surface is frozen by the snapshot test
(`tests/package/api-surface.spec.ts`); this page is the human-readable
index. Full JSDoc lives in the source and ships in every package's
`lib/types/*.d.ts`.

## `@teoclub/cordis`

### Context (15 API items, frozen baseline)

| Member | Signature |
|---|---|
| `new Context()` | create the root context with built-in services |
| `Context.is(value)` | brand check (cross-realm, cross-copy) |
| `ctx.extend(meta?)` | child context with own properties |
| `ctx.isolate(name, label?)` | child with an independent service scope |
| `ctx.intercept(name, config)` | child carrying service intercept config |
| `ctx.get(name, strict?)` | read a service without inject |
| `ctx.set(name, value)` | overwrite a service (provider fiber only) |
| `ctx.provide(name, value)` | register a service owned by the current fiber |
| `ctx.accessor(name, { get, set })` | computed context property |
| `ctx.mixin(name, keys)` | expose service members on `ctx` |
| `ctx.plugin(plugin, config?)` | load a plugin; returns its fiber |
| `ctx.inject(deps, callback)` | shorthand for `plugin({ inject, apply })` |
| `ctx.effect(execute, label?)` | register a cleanup-aware effect |
| `ctx.on(name, listener, options?)` | fiber-owned event listener |
| `ctx.once(name, listener, options?)` | self-disposing listener |
| `ctx.logger(name?)` | named logger facade |

### Fiber

`dispose()`, `await()`, `restart()`, `update(config, noSave?)`,
`getEffects()`, `assertActive()`; properties `uid`, `state`, `config`,
`_config`, `inject`, `store`, `inertia`, `name`.

States (`FiberState`, numeric baseline): `PENDING 0`, `LOADING 1`,
`ACTIVE 2`, `FAILED 3`, `DISPOSED 4`, `UNLOADING 5`.

### Events

`emit`, `parallel`, `serial`, `bail`, `waterfall` (+ `prepend`/`global`/
`once` options, context isolation filtering). Built-in framework events:
`internal/plugin`, `internal/status`, `internal/config`, `internal/service`,
`internal/update`, `internal/get`, `internal/set`, `internal/listener`,
`internal/dispatch`.

### Errors

`CordisError` (code `INACTIVE_EFFECT`), `ValidationError` (aggregated
standard-schema issues), `AggregateError` (from `parallel()`).

### Services & utilities

`Service` (base class), `EventsService`, `LoggerService`, `RegistryService`,
`ReflectService` (root-exported), `Logger`, `Inject` decorator,
`isBailed`, `symbols`.

## `@teoclub/schemastery`

`Schema.string/number/boolean/object/array/union/intersect/transform/...`
with Standard Schema v1 `~standard` validation; dual ESM/CJS export.

## `@teoclub/kit`

Continues cosmokit 1.8.2 exports unchanged (`defineProperty`, `isNullable`,
`deepEqual`, `hyphenate`, `valueMap`, `pick`, ...). Zero dependencies, no
`node:*` imports, `sideEffects: false`.

## Plugin packages

| Package | Key APIs |
|---|---|
| `cordis-plugin-loader` | `Loader`, `ctx.loader.create/update/remove/await`, entry tree APIs, `CORDIS_SHARED` |
| `cordis-plugin-include` | `Include`, `applyEntryPatches`, `entryListSchema`, config watching |
| `cordis-plugin-group` | `Group` (stable entry naming + default export thin layer) |
| `cordis-plugin-timer` | `ctx.timer.timeout/interval/throttle/debounce`, `ctx.setTimeout` (deprecated), `ctx.setInterval` (deprecated) |
| `cordis-plugin-hmr` | `ctx.hmr`, `hmr.registerConfig`, events `hmr/change`, `hmr/reload`, `hmr/config-update-failed` |
| `cordis-plugin-logger-console` | `ConsoleLogger` plugin; node + browser entries |

## CLI

```text
cordis     # no arguments: load ./cordis.yml from CWD (baseline behavior)
```

Restart contract: a full HMR restart exits with code **51**.
