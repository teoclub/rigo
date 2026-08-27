# Migrating from `@deepseek-ai/*` to `@teoclub/*`

This distribution is a scope rename plus targeted fixes of the vendored
Cordis framework layer (`@deepseek-ai/cordis@4.0.1` lineage). Public APIs
and behavior are compatible except for the documented breaking changes
below.

## Import mapping

| Old | New |
|---|---|
| `@deepseek-ai/cosmokit` | `@teoclub/kit` (export names unchanged) |
| `@deepseek-ai/schemastery` | `@teoclub/schemastery` |
| `@deepseek-ai/cordis` | `@teoclub/cordis` |
| `@deepseek-ai/cordis-plugin-loader` | `@teoclub/cordis-plugin-loader` |
| `@deepseek-ai/cordis-plugin-include` | `@teoclub/cordis-plugin-include` |
| `@deepseek-ai/cordis-plugin-group` | `@teoclub/cordis-plugin-group` |
| `@deepseek-ai/cordis-plugin-timer` | `@teoclub/cordis-plugin-timer` |
| `@deepseek-ai/cordis-plugin-hmr` | `@teoclub/cordis-plugin-hmr` |
| `@deepseek-ai/cordis-plugin-logger-console` | `@teoclub/cordis-plugin-logger-console` |

Third-party dependencies (`@standard-schema/spec`, `js-yaml`, `chokidar`,
`picomatch`, `@babel/code-frame`, `supports-color`,
`node-addon-require-builtin`) keep their upstream names.

## Breaking changes

| # | Change | Action |
|---|---|---|
| BC-1 | Package scope changed (`@deepseek-ai/*` -> `@teoclub/*`) | rewrite imports per the table above |
| BC-2 | `engines` enforced: Node `^22.19.0 \|\| >=24.0.0` | upgrade Node if below 22.19 |
| BC-3 | `cosmokit` renamed to `@teoclub/kit` | rewrite import specifiers; export names are unchanged |
| BC-4 | `@teoclub/cordis` is `5.0.0` (major version declaration; semantics unchanged beyond BC-1/2/3) | no action beyond the above |
| BC-5 (fix) | `parallel()` now reports `parallel` (not `emit`) on `internal/dispatch` | update diagnostics listeners that pattern-matched the mode |
| BC-6 (fix) | HMR module changes under Bun trigger a safe full restart instead of being unavailable | run under a supervisor that respawns on exit code 51 |

## Config files

`cordis.yml` / `cordis.json` need no change. Entry `name` fields that
reference the old scoped names must be updated to the new ones.

## Behavior fixes carried over the baseline

See [upstream.md](upstream.md) for the complete patch list, including:

- `ReflectService` is now exported from the `@teoclub/cordis` root.
- Logger exporter disposers remove exactly the registered exporter.
- HMR `resolveSync` works on released Node 24 (patch #9).

## Version mapping

| `@teoclub/*` | Continues `@deepseek-ai/*` |
|---|---|
| `@teoclub/cordis@5.0.0` | `@deepseek-ai/cordis@4.0.1` |
| `@teoclub/kit@1.8.2` | `@deepseek-ai/cosmokit@1.8.2` |
| `@teoclub/schemastery@3.18.1` | `@deepseek-ai/schemastery@3.18.1` |
| `@teoclub/cordis-plugin-loader@1.0.2` | `1.0.2` |
| `@teoclub/cordis-plugin-include@1.0.6` | `1.0.6` |
| `@teoclub/cordis-plugin-group@1.0.1` | `1.0.1` |
| `@teoclub/cordis-plugin-timer@1.1.3` | `1.1.3` |
| `@teoclub/cordis-plugin-hmr@1.0.16` | `1.0.16` |
| `@teoclub/cordis-plugin-logger-console@1.0.1` | `1.0.1` |
