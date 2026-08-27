# Hot Reload (HMR)

The `@teoclub/cordis-plugin-hmr` package ships two engines behind one
config type and one event surface (`hmr/change`, `hmr/reload`,
`hmr/config-update-failed`).

## Shared behavior (Node and Bun)

- Config-file watching: `hmr.registerConfig(filename, refresh)` watches one
  exact path (including a path under missing parent directories), serializes
  and coalesces refreshes, and returns an async disposer that closes the
  watcher and drains active work.
- Config refresh failures are normalized to `Error`, logged, and broadcast
  through the parallel `hmr/config-update-failed` event; the running plugin
  tree is left intact.
- Change events are debounced (default 100 ms, configurable): rapid
  consecutive saves merge into one reload round.

## Node engine: module-graph partial reload

Under Node (with `--expose-internals` or the `node-addon-require-builtin`
companion addon), the HMR service builds the dependency graph of loaded
modules from the ESM load cache:

- A change to a module reachable from a plugin entry reloads exactly that
  plugin: its module cache entries (ESM load cache and CJS `require`
  cache) are cleared, the entry is re-imported, the old fiber is disposed,
  and the new one is mounted with the previous config.
- If re-import fails, the caches are restored and the old plugins are
  re-registered (rollback). A rollback failure escalates to a full restart.
- Changes to framework-external files (the CLI entry's dependency tree)
  request a full process restart via `loader.exit()`.

Supported Node versions: `^22.19.0 || >=24.0.0`. Note that
`resolveSync`'s parameter order flipped between Node 24 prereleases and the
released 24.x line; this distribution feature-detects the signature at
runtime (TEO Club patch #9 in [upstream.md](upstream.md)).

## Bun engine: config refresh + safe restart

Bun has no equivalent of Node's `--expose-internals` ESM loader, so
module-graph partial reload is not available:

- Config-file changes run the **same** refresh path as Node (re-read,
  validate, loader update with rollback).
- A **module code change** triggers a controlled full restart:
  1. the HMR watchers close (no new fiber work is accepted),
  2. the root fiber unloads - every disposer runs and is awaited,
  3. the `exit` event fires (signal handling, exporter flush),
  4. `loader.exit()` exits the process so an outer supervisor can respawn
     it. The `cordis` CLI uses **exit code 51** for this restart contract.
- Bare `bun --hot` is deliberately **not** used: it bypasses fiber cleanup
  and would leak listeners, timers, and service registrations
  across reloads.

### Restart invariants

After a safe restart no duplicate listeners, timers, or services remain:
the restart path unloads the root fiber and the plugin tree exits clean
(covered by `tests/bun/hmr-bun.spec.ts`).

## Running under a supervisor

```sh
# example: restart on exit code 51 (shell supervisor)
while true; do
  npx cordis; [ $? -ne 51 ] && break
done
```
