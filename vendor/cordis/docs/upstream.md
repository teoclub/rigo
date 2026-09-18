# Upstream Sources and Modifications

This record documents the source baseline and the changes inherited or made
by TEO Club. The planning context is preserved in the
[PRD](../tasks/prd_cordis_v1.0.md) and
[P0 specification](../tasks/spec_cordis_v1.0.md).

The source audit also produces a
[generated manifest](upstream.manifest.md) and
[machine-readable report](upstream-audit.json).

The detailed API reference and tutorial under `docs/cordis-api/` and
`docs/cordis-tutorial/` are adapted from the same pinned commit. Standalone
examples use the `@teoclub/*` package scope; the Harness-only tutorial chapter
retains its upstream package names and execution context. See
[third-party notices](../THIRD_PARTY_NOTICES.md).

## Audit Conclusions (Phase 0, human-reviewed)

### Pinned revisions

The distribution and the harness mirror are pinned separately, and they no longer share a
commit:

| Surface | Revision | Recorded in |
| --- | --- | --- |
| `vendor/cordis` (this monorepo) | `ddefc45fbc7f8e46dd73185e68295696d1297887` (`dsh-v0.1.6-alpha.2`) | each vendored `package.json` `teoclub.source.commit`; `docs/upstream.manifest.md` |
| Harness mirror (`packages/harness/*`, `tests/upstream/*`) | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`) | `../../docs/upstream-baseline.md`, `scripts/lib/baseline.ts` |

The skew is deliberate: re-syncing the framework did not re-port the harness packages. It is
bridged by TEO patch 11 below, which keeps `watchUserPatches()` working against the reverted
HMR service.

`scripts/upstream-tree.ts` materializes every upstream read from the pinned **commit**, never
from a clone's working tree: a clone sits at whatever the user last checked out, and a
working-tree read silently mixes revisions (the `dsh-v0.1.6-alpha.2` sync pulled
`loader/src/config/entry.ts` and `cordis/src/logger.ts` from the clone's HEAD while every
other file came from the tag).

### Version authority

`package.json` is the source of truth (PRD §0.2). The `vendor/README.md` manifest table lags
behind every package by one release step; the SPEC-predicted drift (cordis recorded as
`4.0.0-rc.7`, actually `4.0.2` at this pin) extends to all nine packages. Audited versions
above are authoritative and feed `teoclub.source.upstreamVersion` in each package manifest.

### Upstream lineage

The vendored code is **not pristine cordiverse source**: deepseek-harness has already applied
a series of local modifications to the vendored copies before rescoping them into the
`@deepseek-ai` scope. TEO Club inherits this patched state as its compatibility baseline.
Inherited patches (full list in `vendor/README.md` "Local modifications" at the pinned commit):

1. `hmr/src/index.ts` - i18n locale imports removed (no runtime YAML loader vendored).
2. All `package.json` regenerated: `private: true`, precise `files`, `./src/*` export, `lib/types` declarations, upstream devDeps/scripts/repository removed.
3. All `tsconfig.json` regenerated to extend repo-root base config with project references.
4. Internal relative specifiers rewritten to explicit `.ts` (NodeNext-safe).
5. `schemastery/tsdown.config.ts` and `logger-console/tsdown.config.ts` are harness-authored build-shape overrides (dual ESM+CJS / node+browser entries).
6. `cordis/src/fiber.ts` lifecycle hardening: three reentrant disposal gaps closed (owner-list wrapper registered before setup, effect creation rejected while UNLOADING, child fiber disposer registered before `internal/plugin` publication, epoch-checked plugin execution, per-observer teardown failure containment; `Fiber.update()` returns the `internal/update` waterfall result).
7. `cordis/src/*.ts` JSDoc enrichment (comment-only, no code changes).
8. Transactional Loader/Include config reconciliation (import-before-dispose, rollback on failure, group concurrent-start containment, Include detached-candidate validation).
9. `hmr/src/index.ts` exact config watching (realpath handling, serialized/coalesced refreshes, `hmr/config-update-failed` broadcast).
10. Erased-import markers for Node native TypeScript transform across five packages.
11. `include/src/index.ts`: `applyEntryPatches` / `entryListSchema` exports; inserted entries indexed during the patch loop so later patches can hit them.
12. Include child-tree mutation serialized through one per-Include queue; HMR main watcher `ignoreInitial: true`.
13. `include/src/index.ts` `writeTask?: NodeJS.Timeout | undefined` (type-only).
14. Include durable debounced writes: bounded EACCES/EBUSY/EPERM rename retry, tracked queue, teardown drain.
15. Lazy Loader config resolution ported from cordiverse/cordis#41 (raw fiber config resolved through `internal/config` after injections are active).
16. `cordis/package.json` publishes `src`.
17. `@deepseek-ai` rescope itself (upstream identifiers like `Symbol.for('schemastery')` kept).
18. `loader/src/config/entry.ts` `disabled` `!!js` interpolation.

### License

All nine packages carry upstream MIT `LICENSE` files (Copyright (c) 2021-present Shigma).
MIT permits rename-and-republish with attribution. Each redistributed package
retains that notice, and the root README carries the not-affiliated statement.

### Node-specific API surface

- `@teoclub/cordis` core `src/` contains **zero** `node:*` imports - the only Node import is
  `node:url` in `bin.js` (SPEC §2.2 requirement already satisfied by the baseline).
- Plugin packages use `node:fs/promises`, `node:path`, `node:timers/promises`, `node:url`,
  `node:module`, `node:fs`, `node:util` - all covered by Bun's Node compatibility layer
  (Phase 3 validates behaviorally).
- **No `Bun.*` references anywhere** - nothing to strip for Node compatibility.

### Rescope workload

47 old-scope references across 25 files (breakdown in the machine tables above). All are
`@deepseek-ai/*` import specifiers, dependency entries, and `declare module` names;
**zero** `@cordisjs/*` references (the harness rescope already eliminated them). The rename
`@deepseek-ai/cosmokit` -> `@teoclub/kit` additionally affects every `cosmokit` import
specifier. `workspace:^` dependency protocol must be rewritten to the TEO Club semver ranges
during rescope (SPEC §3.1).

### Dependency graph (post-rescope)

```
@teoclub/kit            (no deps)
@teoclub/schemastery    -> kit, @standard-schema/spec
@teoclub/cordis         -> kit, @standard-schema/spec; optional peers: loader, include
  loader                -> kit; peers: cordis, node-addon-require-builtin (optional)
  include               -> kit, js-yaml; peers: cordis, loader
  group                 -> peers: cordis, loader
  timer                 -> kit; peers: cordis
  hmr                   -> kit, schemastery, @babel/code-frame, chokidar, picomatch; peers: cordis, timer
  logger-console        -> kit, schemastery, supports-color; peers: cordis
```

### Third-party dependencies kept as-is (PRD §6.2)

`@standard-schema/spec`, `js-yaml`, `chokidar`, `picomatch`, `@babel/code-frame`,
`supports-color`, `node-addon-require-builtin` (optional peer of loader).

### G1 audit note (SPEC §11.1-6)

The `parallel()` -> `internal/dispatch` mode question: within the audited harness tree,
`internal/dispatch` is emitted from `cordis/src/events.ts` only, and no vendored package or
harness code distinguishes the reported mode. G1 fix (report `parallel`) proceeds in Phase 2.

## TEO Club Patches (applied during Phase 1 rescope)

Relative to the vendored baseline, the only changes are (SPEC §3.4 diff-review
rules - import/package-name/engines/provenance only, no behavior changes):

1. **Rescope**: every `@deepseek-ai/*` module specifier, dependency entry, and
   `declare module` name rewritten to `@teoclub/*` (43 AST edits + 32 text
   edits across the nine packages). `@deepseek-ai/cosmokit` additionally
   renamed to `@teoclub/kit`.
2. **package.json regenerated** per SPEC §3.1: `engines.node` added (D6),
   `teoclub.source` provenance block added (FR-DIST-004), `workspace:^`
   protocol converted to concrete semver ranges, `bin` exposed as
   `cordis`, repository pointed at `teoclub/cordis`.
3. **tsconfig.json regenerated**: `extends`/project-reference paths adjusted
   for the `packages/` + `packages/plugins/` layout (same options otherwise).
4. **README rescoped**: upstream `@cordisjs/plugin-*` names in examples
   rewritten to `@teoclub/cordis-plugin-*`; kit README rewritten for the
   `@teoclub/kit` identity incl. the not-affiliated statement (SPEC §7).
5. **Exports `types` path decision**: all packages point `exports.types` at
   `./lib/types/index.d.ts` (not `./lib/index.d.ts` as in the SPEC §4.2
   default template). Rationale: this is the exact published shape of
   `@deepseek-ai/cordis@4.0.1` on npm, preserving D2's
   compatibility-first decision and enabling the §11.2 structure-diff
   verification. The SPEC's schemastery template is honored as written.
6. **Root toolchain** (not part of any package): Bun workspaces + root
   tsdown workspace config (entry `lib/types/index.js`, ESM, es2024,
   node platform) mirroring the harness build; `packages/plugins` grouping
   directory excluded from workspace discovery.

Versions: `@teoclub/cordis` fixed at `5.0.0` (D5); the other eight packages
continue their upstream version lines from the audited versions (independent
SemVer, PRD §16.4).

## TEO Club Patches (current)

The authoritative ledger is `scripts/merge-teo.ts`' TEO_PATCHES table:
`scripts/verify-teo-patches.ts` re-derives the divergence set from the pinned
commit and fails when a file diverges without an entry, or when a `PROTECTED`
path has gone missing. The prose below explains each entry; the table is what
the build enforces.

7. **`timer` public/internal types**: `NodeJS.Timeout` replaced with
   `ReturnType<typeof setTimeout>`; no source names `NodeJS.*` anymore
   (SPEC §10.1-P3).
8. **`loader`/`include`/`hmr` Node type references made structural**:
   `NodeJS.Signals` -> `string` (public `exit` event signature),
   `NodeJS.Timeout` -> `ReturnType<typeof setTimeout>` (include writeTask),
   `NodeJS.ErrnoException` casts -> `{ code?: string }` structural casts.
   Type-only; declarations no longer require `@types/node` to resolve.
9. **DROPPED — `hmr` resolveSync parameter-order probe.** Rigo previously
   worked around Node 24.0-24.11.1 reporting major 24 while still carrying the
   v1 module loader. Upstream has since fixed this at the root: `loader/src/internal.ts`
   `ModuleLoader.fromInternal()` classifies the loader by which module-job API
   it owns (`getOrCreateModuleJob` = v2, `getModuleJobForImport` = v1) instead
   of by Node major. The probe was deleted and `_resolve()` now dispatches on
   `internal.version`. Verified on Node 24.14 by `tests/node/hmr-node.spec.ts`.
10. **`hmr` Bun engine (D10)**: runtime detection (`engine/shared.ts`) +
    controlled full restart (`engine/bun.ts`): config-file refresh keeps the
    shared chokidar path; module changes under Bun close the watchers,
    unload the root fiber (all disposers awaited), emit `exit`, and call
    `loader.exit()`. Node internals usage split into `engine/node.ts`.
    `bin.js` implements the restart contract (exit code 51 for an outer
    supervisor). Bare `bun --hot` is not used (FR-HMR-004).
11. **`hmr` config-watch precedence (behavioral)**: the watcher matches a
    booted Include's config path **before** the module-reload branches.
    Upstream's post-revert handler checks `externals`/`loadCache` first and
    only then looks for an Include, which misroutes config edits two ways -
    under Bun `!this.internal` turns every `cordis.yml` edit into a full
    process restart instead of an in-place refresh (SPEC §5.4 / D10), and in
    Node a TypeScript config reached through `import()` sits in `loadCache`
    and would be partially reloaded rather than refreshed. The handler also
    keeps `add`/`unlink` listeners so creating or removing a config file
    refreshes it. Covered by `tests/bun/hmr-bun.spec.ts` and
    `tests/upstream/app-boot/tests/watch-config.spec.ts`.
12. **`kit` README identity**: the `@teoclub/kit` title, npm badge, install
    command, and the "continues cosmokit / not affiliated with cordiverse"
    statement, re-applied over each new upstream README. `verify-old-scopes.ts`
    gates it.

## Re-sync record

### 2026-09-18 — `dsh-v0.1.6-alpha.2` (`b150a55` -> `ddefc45`)

Upstream's **revert of PR #932** ("transactional Cordis reload") dominates this
sync. Adopted in full, by explicit decision:

- **Loader/Group/Entry updates are eager and non-transactional again.** A
  failed update no longer restores the previous plugin or config; the entry
  keeps whatever the attempt reached, and the failure is reported rather than
  rolled back. **This removes a capability the PRD required**: FR-LOADER-003
  and SPEC §5.1.4 ("安全更新与回滚") are amended accordingly. What survives:
  an edit the Include cannot read or parse leaves the running tree alone. What
  does not: a syntactically valid candidate that fails to activate is still
  assigned to the entry and persisted by the Include's debounced writer, so a
  bad value can reach the config file.
- **`Fiber.update()` returns nothing.** It no longer hands back the
  `internal/update` waterfall result, so a plugin that throws during a
  config-driven restart escapes as an unhandled rejection instead of reaching
  the update caller. **Runtime-diff**: Node routes that through
  `unhandledRejection`; Bun's test runner attributes it to the running test and
  offers no hook to consume it, so the affected cases are Node-only.
- **`Entry.update()` no longer re-imports on a `name` change.** The replace
  branch is gone: a `name` edit is recorded and written back, but the running
  fiber keeps its plugin until the entry is recreated.
- **`Hmr.registerConfig()` and the `hmr/config-update-failed` event are
  deleted.** Their only consumer moved: `packages/harness/app-boot/src/watch-config.ts`
  now owns exact-path watching (TEO patch 11 keeps the precedence correct).
- Adopted from upstream: the `loader/src/internal.ts` loader-shape fix (patch
  9 dropped), the `cordis/src/logger.ts` exporter-disposer fix (the local G3
  patch converged and its ledger entry was removed), and all nine version
  bumps.
- `@teoclub/cordis` moves 5.0.0 -> **6.0.0**: the revert removes public API
  (`Hmr.registerConfig`, `Fiber.update()`'s return value), which is the BC-4
  criterion the 5.0.0 line was declared under. Other packages continue their
  upstream version lines.
