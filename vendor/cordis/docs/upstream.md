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

### Version authority

`package.json` is the source of truth (PRD §0.2). The `vendor/README.md` manifest table lags
behind every package by one release step; the SPEC-predicted drift (cordis recorded as
`4.0.0-rc.7`, actually `4.0.1`) extends to all nine packages. Audited versions above are
authoritative and feed `teoclub.source.upstreamVersion` in each package manifest.

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

## TEO Club Patches (applied during Phase 3, Bun runtime adaptation)

7. **`timer` public/internal types**: `NodeJS.Timeout` replaced with
   `ReturnType<typeof setTimeout>`; no source names `NodeJS.*` anymore
   (SPEC §10.1-P3).
8. **`loader`/`include`/`hmr` Node type references made structural**:
   `NodeJS.Signals` -> `string` (public `exit` event signature),
   `NodeJS.Timeout` -> `ReturnType<typeof setTimeout>` (include writeTask),
   `NodeJS.ErrnoException` casts -> `{ code?: string }` structural casts.
   Type-only; declarations no longer require `@types/node` to resolve.
9. **`hmr` resolveSync parameter-order fix (behavioral bug)**: the vendored
   v2 path called `resolveSync(parentURL, { specifier, attributes })`, but
   released Node 24 (verified on 24.11.1) expects
   `resolveSync(specifier, parentURL, importAttributes)` - the vendored call
   threw inside `partialReload`, silently degrading every module reload to
   zero (HMR was broken on current Node 24.x). `_resolve` now probes the
   accepted signature once and dispatches accordingly, keeping the
   prerelease shape working. Covered by `tests/node/hmr-node.spec.ts`.
10. **`hmr` Bun engine (D10)**: runtime detection (`engine/shared.ts`) +
    controlled full restart (`engine/bun.ts`): config-file refresh keeps the
    shared chokidar path; module changes under Bun close the watchers,
    unload the root fiber (all disposers awaited), emit `exit`, and call
    `loader.exit()`. Node internals usage split into `engine/node.ts`.
    `bin.js` implements the restart contract (exit code 51 for an outer
    supervisor). Bare `bun --hot` is not used (FR-HMR-004).
