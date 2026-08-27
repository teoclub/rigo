# @teoclub/cordis

Cordis is a TypeScript plugin framework for applications that need explicit
dependency injection, scoped services, lifecycle-managed cleanup, and optional
configuration-driven loading. The core package is published as
`@teoclub/cordis`; the
official packages in this repository add a loader, config-file includes, HMR,
console logging, and timers.

## Install

```sh
npm install @teoclub/cordis
```

Cordis is ESM-first and supports Node `^22.19.0 || >=24.0.0` and Bun.

## Quick Start

```ts
import { Context, Service } from '@teoclub/cordis'

declare module '@teoclub/cordis' {
  interface Context {
    counter: Counter
  }

  interface Events {
    'app/ready'(message: string): void
  }
}

class Counter extends Service {
  value = 0

  constructor(ctx: Context) {
    super(ctx, 'counter')
  }

  next() {
    return ++this.value
  }
}

const greeter = Object.assign((ctx: Context) => {
  ctx.on('app/ready', (message) => {
    ctx.logger.info('%s #%d', message, ctx.counter.next())
  })
}, {
  inject: ['counter'],
})

const root = new Context()
await root.plugin(Counter)
await root.plugin(greeter)

root.emit('app/ready', 'started')
await root.fiber.dispose()
```

The important pieces are:

- `new Context()` creates the root dependency container.
- `ctx.plugin()` starts a plugin and returns a `Fiber`.
- `inject` tells Cordis which services must exist before the plugin runs.
- Effects, event listeners, and services are removed when their owning fiber is
  disposed.

## Documentation

- [Documentation index](../../docs/README.md)
- [Tutorial](../../docs/cordis-tutorial/index.md)
- [Plugin authoring and lifecycle](../../docs/plugin-authoring.md)
- [Loader configuration](../../docs/configuration.md)
- [Detailed core API](../../docs/cordis-api/context.md)
- [Package API index](../../docs/api.md)

## Packages

| Package | Purpose |
| --- | --- |
| `@teoclub/cordis` | Core context, plugin registry, fiber lifecycle, events, services, and logger. |
| `@teoclub/cordis-plugin-loader` | Runtime plugin tree and loader service. |
| `@teoclub/cordis-plugin-include` | YAML/JSON config-file include support for the loader. |
| `@teoclub/cordis-plugin-group` | Nested plugin groups for loader configs. |
| `@teoclub/cordis-plugin-hmr` | Hot module replacement for loader-managed plugins. |
| `@teoclub/cordis-plugin-logger-console` | Console exporter for the built-in logger. |
| `@teoclub/cordis-plugin-timer` | Disposal-aware timeout, interval, throttle, and debounce helpers. |

## Development

```sh
bun install
bun run build
bun run test:node
bun run test:bun
```

The monorepo uses Bun workspaces, TypeScript project references, and tsdown.
Most examples in the docs use public APIs from `@teoclub/cordis`; loader
examples additionally use `@teoclub/cordis-plugin-loader` and
`@teoclub/cordis-plugin-include`.

## Security / Trust Model

Cordis **does not sandbox plugins**. Plugins are trusted code: loading a
plugin executes it with full host permissions, and service isolation is a
scoping mechanism for dependency injection, **not** a security boundary.
Only load plugins (including npm packages referenced by name in loader
config) from sources you trust. Configuration files (`cordis.yml` and any
files consumed by `@teoclub/cordis-plugin-include`) must likewise come from
trusted sources - see that package's README for the `!!js` expression
dialect's implications.

This distribution is maintained by TEO Club and is not affiliated with
cordiverse or the upstream Cordis authors.
