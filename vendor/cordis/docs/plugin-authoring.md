# Plugin Authoring

A Cordis plugin is trusted code that augments a context. Three entrypoint
shapes are supported:

```ts
// function plugin
const plugin = (ctx: Context, config: Config) => { /* ... */ }

// class plugin
class Plugin {
  constructor(private ctx: Context, private config: Config) {}
  [Service.init]() { /* runs after construction */ }
}

// object plugin
const plugin = {
  name: 'my-plugin',
  apply(ctx: Context, config: Config) { /* ... */ },
}
```

## Metadata

| Field | Purpose |
|---|---|
| `name` | display name for fiber diagnostics and logger names |
| `Config` | Standard Schema (must be **synchronous**); config is validated before the plugin starts |
| `inject` | required services: `['a', 'b']` or `{ a: { intercept: 'config' } }` |
| `provide` | service name(s) the plugin provides (read by `Service` and loaders) |
| `intercept` | service names whose intercept config the plugin declares it consumes |

## Lifecycle

1. `ctx.plugin(plugin, config)` creates a fiber (`PENDING`).
2. Dependencies from `inject` resolve; while any is missing the fiber stays
   `PENDING` and no plugin code runs.
3. All dependencies present -> `LOADING`: config is resolved through the
   `internal/config` waterfall, validated against `Config`, then `apply`
   runs. Failure -> `FAILED`; `fiber.await()` rethrows.
4. `ACTIVE` - the plugin provides services and receives events.
5. On dependency loss or `restart()`: `UNLOADING` - disposers run in
   reverse order, awaited - then back to `PENDING`/`LOADING`.
6. `fiber.dispose()` -> `DISPOSED` (terminal).

## Effects and cleanup

```ts
ctx.plugin({
  apply(c) {
    // sync disposer
    c.effect(() => () => stopSomething())
    // promise of a disposer
    c.effect(() => acquire().then(handle => () => handle.release()))
    // generator: each yielded disposer registers as produced
    c.effect(function* () {
      for (const item of items) yield () => item.close()
    })
    // fiber-owned event listener (removed on unload)
    c.on('event', handler)
  },
})
```

Eight cleanup guarantees hold: sync/async disposers are
awaited; disposal order is reverse registration; a failing setup rolls back
already-collected cleanup; a failing disposer is isolated and does not
block siblings; repeated disposer calls are single-shot; effect creation
during `UNLOADING` throws `CordisError('INACTIVE_EFFECT')`.

## Inject and services

```ts
import { Service, Context } from '@teoclub/cordis'

class Database extends Service {
  constructor(ctx: Context) { super(ctx, 'database') }
  query(sql: string) { /* ... */ }
}

// consuming: stays PENDING until 'database' exists, reloads when it is replaced
ctx.plugin({
  inject: ['database'],
  apply(c) {
    c.database.query('select 1')
  },
})
```

The `@Inject` decorator works on classes and class methods:

```ts
class MyPlugin {
  @Inject('database')
  run(ctx: Context) { /* delayed until 'database' is available */ }
}
```

## Error contract

| Exception | Thrown when |
|---|---|
| `Error` | invalid plugin shape |
| `ValidationError` | config validation fails (aggregated issues + field paths) |
| `TypeError` | an effect returns an invalid shape, or a `Config` schema validates asynchronously |
| `CordisError('INACTIVE_EFFECT')` | effect created on a disposed/unloading fiber |
| `AggregateError` | a `parallel()` listener rejects |

Error message strings are not part of the compatibility contract; exception
types and throw sites are.
