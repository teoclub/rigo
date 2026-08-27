# Compatibility Matrix

## Runtime support

| Runtime | Support | Verified |
|---|---|---|
| Node 24.x | ✅ full (HMR partial reload requires `--expose-internals` or `node-addon-require-builtin`) | 24.11.1 |
| Node 22.19+ | ✅ full (same HMR note) | CI-pinned |
| Bun (current stable) | ✅ core + plugins; HMR = config refresh + safe restart | 1.4.0, 1.3.12 |
| Bun (previous stable) | ✅ same as current stable | CI-pinned (1.3.14) |

Every package declares `engines: { node: "^22.19.0 || >=24.0.0" }`.

## Test evidence

The same conformance codebase (62 tests: context, fiber, effect, events,
registry, logger) runs under both runtimes and must produce identical
results:

| Suite | Node (vitest) | Bun (bun test) |
|---|---|---|
| conformance (62) | ✅ | ✅ |
| integration loader/include (5) | ✅ | ✅ |
| package/API surface (3) | ✅ | ✅ |
| runtime-specific HMR | node (partial reload, subprocess) | bun (config refresh + safe restart) |

Runtime differences are confined to `tests/node/` and `tests/bun/`; any
skipped case must be registered in `tests/conformance/skips.ts` with a
reason (currently empty - no skips).

## Node-specific APIs used

| Package | APIs | Bun compatibility |
|---|---|---|
| cordis (bin.js only) | `node:url` | ✅ |
| loader | `node:module` (internals; optional) | not used on Bun (Bun engine) |
| include | `node:fs/promises`, `node:path`, `node:timers/promises`, `node:url` | ✅ |
| hmr | `node:fs`, `node:fs/promises`, `node:module`, `node:path`, `node:url` | ✅ (fs watching via chokidar) |
| logger-console | `node:util` (`inspect`) | ✅ |

Core `@teoclub/cordis` `src/` uses **no** `node:*` imports; no source
references `Bun.*`.

## Known runtime differences

| Area | Node | Bun |
|---|---|---|
| HMR module change | partial reload (module graph) | safe full restart (exit 51 + supervisor) |
| Logger formatting | `util.inspect` | `node:util` compat layer (contract fields identical: level, name, timestamp, fiber name, error stack, single-line cap) |
| Loader internals | optional deep integration (`--expose-internals`) | standard module resolution |

## Migration from `@deepseek-ai/*`

See [migration.md](migration.md).
