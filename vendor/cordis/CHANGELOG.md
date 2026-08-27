# Changelog

All notable changes to the `@teoclub/*` Cordis distribution. Entries follow
the three categories used by this project: **Breaking**, **Fix**,
**Runtime-diff** (documented behavioral differences between the Node and
Bun engines). This file is managed in the Changesets style; automated
releases use the `cordis-v5` release-train tag.

## 2026-08-25 - Initial dual-runtime release (P0)

### `@teoclub/cordis` 5.0.0

First release of the TEO Club scope. Baseline: `@deepseek-ai/cordis@4.0.1`
(vendored at deepseek-harness `b150a55`), repackaged with the full P0
toolchain (Bun workspace + tsdown, cross-runtime conformance, package
gates).

**Breaking**

- Scope rename `@deepseek-ai/*` -> `@teoclub/*` (BC-1); migration table in
  `docs/migration.md`.
- `engines` now enforced: Node `^22.19.0 || >=24.0.0` (BC-2).
- Major version 5.0.0 declares the distribution change (BC-4); semantics
  beyond BC-1/2/3 are unchanged.
- `parallel()` now reports its true mode (`parallel`) on
  `internal/dispatch` instead of `emit` (G1 breaking-fix, BC-5).

**Fix**

- Logger exporter disposers remove exactly the exporter they registered
  instead of whichever registered last (G3).
- `ReflectService`, `Property`, and `Impl` are exported from the root
  barrel (G5, additive).
- `internal/listener` event type now declares the runtime `EventOptions`
  object (G2, type-only).
- `RegistryService.delete()` documents (and types) its
  initiate-without-awaiting disposal semantics (G4).

### `@teoclub/kit` 1.8.2

- Continues `cosmokit` 1.8.2 under the TEO Club scope with unchanged public
  exports (BC-3). `sideEffects: false` declared.

### `@teoclub/schemastery` 3.18.1

- Continues `@deepseek-ai/schemastery` 3.18.1. Dual ESM/CJS export shape
  preserved.

### `@teoclub/cordis-plugin-loader` 1.0.2

- Type-only: `NodeJS.*` references removed from public declarations
  (`exit` event signal is now `string`).

### `@teoclub/cordis-plugin-include` 1.0.6

- Type-only: `NodeJS.*` references removed from declarations.

### `@teoclub/cordis-plugin-group` 1.0.1

- Scope rename only.

### `@teoclub/cordis-plugin-timer` 1.0.1 → 1.1.3

- Continues 1.1.3. Type-only: the internal scheduler handle no longer
  names `NodeJS.Timeout`.

### `@teoclub/cordis-plugin-hmr` 1.0.16

**Fix**

- `resolveSync` parameter order is feature-detected at runtime: the
  vendored v2 call shape throws on released Node 24 (verified 24.11.1) and
  silently disabled every partial reload; HMR now works on current
  Node 24.x (patch #9 in `docs/upstream.md`).

**Runtime-diff**

- New Bun engine (PRD D10): config-file refresh runs the shared chokidar
  path; module-code changes trigger a controlled full restart (watchers
  closed, root fiber unloaded and awaited, `exit` event, `loader.exit()`).
  The `cordis` CLI implements the restart contract with exit code 51.
  Bare `bun --hot` is not used (FR-HMR-004).

### `@teoclub/cordis-plugin-logger-console` 1.0.1

- Scope rename only. Verified format-contract parity between Node and Bun.
