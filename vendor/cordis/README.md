# Cordis by TEO Club

A composable plugin framework for Node.js and Bun.

> Cordis by TEO Club is an independent Node.js and Bun-compatible
> distribution based on the Cordis framework layer used by DeepSeek Harness.
> It is not affiliated with the cordiverse organization.

## Packages

| Package | Purpose |
|---|---|
| [`@teoclub/kit`](packages/kit) | Runtime-agnostic TypeScript utilities (continues cosmokit) |
| [`@teoclub/schemastery`](packages/schemastery) | Type-driven schema builder and validator |
| [`@teoclub/cordis`](packages/cordis) | Core: Context, Fiber, services, effects, events, logger |
| [`@teoclub/cordis-plugin-loader`](packages/plugins/loader) | Runtime plugin tree and loader service |
| [`@teoclub/cordis-plugin-include`](packages/plugins/include) | YAML/JSON config-file include support for the loader |
| [`@teoclub/cordis-plugin-group`](packages/plugins/group) | Nested plugin groups for loader configs |
| [`@teoclub/cordis-plugin-timer`](packages/plugins/timer) | Disposal-aware timeout, interval, throttle, debounce |
| [`@teoclub/cordis-plugin-hmr`](packages/plugins/hmr) | Hot reload: module-graph (Node), config refresh + safe restart (Bun) |
| [`@teoclub/cordis-plugin-logger-console`](packages/plugins/logger-console) | Console exporter for the built-in logger |

## Installation

```sh
npm install @teoclub/cordis
```

Requires Node `^22.19.0 || >=24.0.0` or Bun (current stable). Every package
declares the same `engines` constraint.

## Minimal example

```ts
import { Context } from '@teoclub/cordis'

const ctx = new Context()

const fiber = ctx.plugin({
  name: 'greeter',
  apply(c) {
    c.on('some-event', () => console.log('seen'))
    c.effect(() => () => console.log('cleaned up'))
  },
})

await fiber.await()   // wait until loaded
await fiber.dispose() // unload, running disposers in reverse order
```

Config-driven startup via `cordis.yml`:

```sh
npx cordis   # loads ./cordis.yml through the loader + include plugins
```

```yaml
# cordis.yml
- id: timer
  name: '@teoclub/cordis-plugin-timer'
- id: app
  name: ./plugins/app
  config:
    message: hello
```

## Documentation

- [Documentation index](docs/README.md)
- [Tutorial](docs/cordis-tutorial/index.md) - build plugins step by step
- [Detailed core API](docs/cordis-api/context.md) - Context, Fiber, Registry, Service
- [Architecture](docs/architecture.md) - Context, Fiber, Service, Effect
- [Plugin authoring](docs/plugin-authoring.md) - plugin contract and lifecycle
- [Configuration](docs/configuration.md) - Loader, Include, patches
- [Hot reload](docs/hmr.md) - Node vs Bun engine differences
- [Compatibility matrix](docs/compatibility.md) - Node/Bun support
- [Migrating from `@deepseek-ai/*`](docs/migration.md)
- [API reference](docs/api.md)
- [Upstream sources & modifications](docs/upstream.md)

## Security / trust model

Cordis does **not** sandbox plugins: loading a plugin executes trusted code
with full host permissions, and `cordis.yml` must come from a trusted
source (see [the security notes](packages/cordis/README.md#security--trust-model)).

## Development

```sh
bun install        # install workspace dependencies
bun run build      # tsc -b (type intermediates) + tsdown (runtime bundles)
bun run test:node  # conformance + integration + package + node suites (vitest)
bun run test:bun   # the same conformance codebase under bun test
bun run verify:packages      # AC-001 structure gate
bun run verify:old-scopes    # AC-002 zero-residue gate
```

## License

MIT. This distribution continues the Cordis framework layer (originally by
Shigma and cordiverse contributors, as vendored by DeepSeek Harness) under
the TEO Club scope. Upstream provenance is recorded in
[docs/upstream.md](docs/upstream.md), and every redistributed package retains
its upstream MIT `LICENSE` file. Adapted documentation is covered by
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
