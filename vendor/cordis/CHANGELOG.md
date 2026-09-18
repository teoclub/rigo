# Changelog

All notable changes to the `@teoclub/*` Cordis distribution. Entries follow
the three categories used by this project: **Breaking**, **Fix**,
**Runtime-diff** (documented behavioral differences between the Node and
Bun engines). This file is managed in the Changesets style; automated
releases use the `cordis-v5` release-train tag.

## 2026-09-18 - Upstream re-sync: the transactional reload revert

Re-synced from upstream `dsh-v0.1.6-alpha.2` (`ddefc45`). Upstream reverted its
transactional Cordis reload work (PR #932); this release adopts that revert in
full. See `docs/upstream.md` for the complete record.

### `@teoclub/cordis` 6.0.0

**Breaking**

- `Fiber.update()` returns nothing again and `internal/update` is synchronous
  again: the restart runs behind the waterfall, so a caller can no longer await
  it or receive its failure. A plugin that throws during a config-driven
  restart now escapes as an unhandled rejection.
- The `Fiber`-level rollback guarantees are gone with the transactional Loader.
  Refer to PRD FR-LOADER-003 / SPEC §5.1.4, which are amended: a failed entry
  update leaves the entry where the attempt reached instead of restoring the
  previous plugin or config.
- Major version 6.0.0 declares that removal (BC-4), continuing the 5.0.0
  distribution line's convention.

**Runtime-diff**

- The unhandled rejection above reaches the Node `unhandledRejection` hook;
  under Bun the runtime reports it itself and never calls that hook.

### `@teoclub/kit` 1.8.3

- Continues cosmokit 1.8.3. README re-applied over the new upstream text
  (TEO Club identity, install command, not-affiliated statement).

### `@teoclub/schemastery` 3.18.2

- Continues `@deepseek-ai/schemastery` 3.18.2.

### `@teoclub/cordis-plugin-loader` 1.0.3

**Breaking**

- Entry/group/tree mutations are eager and non-transactional: `Entry.update()`,
  `EntryGroup.update()`, and `EntryTree.update()` no longer restore previous
  state when a step fails.
- `Entry.update()` no longer re-imports when `name` changes; the running fiber
  keeps its plugin until the entry is recreated.

**Fix**

- `ModuleLoader.fromInternal()` classifies the internal loader by which
  module-job API it owns instead of by Node major. Node 24.0-24.11.1 report
  major 24 while still carrying the v1 loader, so the previous test made
  consumers call `resolveSync` with reversed parameters on every call.

### `@teoclub/cordis-plugin-include` 1.0.7

**Breaking**

- `refresh()` no longer throws: it logs and keeps the running tree, and the
  child-tree mutation queue is gone.
- `applyEntryPatches()` only clones its input when a patch list is present.

### `@teoclub/cordis-plugin-hmr` 1.0.17

**Breaking**

- `Hmr.registerConfig()` and the `hmr/config-update-failed` event are deleted.
  Exact-path watching now lives in the app that owns the config file (for this
  repo, `@teoclub/harness-app-boot`'s `watchConfig`).

**Fix**

- The `resolveSync` parameter-order probe is gone: the loader now reports its
  own shape, so `_resolve()` dispatches on `internal.version` (patch 9
  retired).

**Runtime-diff** (patch 11)

- The watcher matches a booted Include's config path before the module-reload
  branches. Upstream checks `externals`/`loadCache` first, which under Bun
  turns every config edit into a full process restart instead of an in-place
  refresh. `add`/`unlink` listeners are retained so creating or removing a
  config file refreshes it; the Bun engine is unchanged.

### `@teoclub/cordis-plugin-group` 1.0.2

**Breaking**

- Concise as upstream: group updates are eager, sibling-start failures are
  contained rather than rolled back.

### `@teoclub/cordis-plugin-timer` 1.1.4

- Continues 1.1.4. Type-only: the internal scheduler handle still avoids
  naming `NodeJS.Timeout`.

### `@teoclub/cordis-plugin-logger-console` 1.0.2

- Scope rename only.

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
