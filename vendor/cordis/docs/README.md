# Documentation

## Start here

- [Cordis tutorial](cordis-tutorial/index.md) ([中文](cordis-tutorial/index.zh.md))
  — a seven-chapter walkthrough adapted from DeepSeek Harness.
- [Architecture](architecture.md) — Context, Fiber, Service, Effect, events,
  and the module graph.
- [Plugin authoring](plugin-authoring.md) — plugin shapes, lifecycle,
  dependency injection, effects, and errors.
- [Configuration](configuration.md) — loader entries, include patches,
  write-back, and `CORDIS_SHARED`.
- [Hot reload](hmr.md) — Node partial reload and Bun safe restart behavior.

## Reference

- [Detailed Cordis API](cordis-api/context.md)
  ([中文](cordis-api/context.zh.md)) — Context, Events, Fiber, Registry,
  and Service references derived from source.
- [Package API index](api.md) — compact public surface by package.
- [Compatibility matrix](compatibility.md) — supported Node and Bun runtimes
  and their known differences.
- [Migration guide](migration.md) — moving from `@deepseek-ai/*` to
  `@teoclub/*`.

## Project records

- [Upstream sources and modifications](upstream.md) — human-reviewed
  provenance, inherited changes, and TEO Club patches.
- [Generated upstream manifest](upstream.manifest.md) — reproducible summary
  emitted by `scripts/audit-source.ts`.
- [`upstream-audit.json`](upstream-audit.json) — machine-readable output of
  the same source audit.

Product requirements and implementation specifications are maintained in
[`tasks/`](../tasks/) rather than mixed with end-user documentation.
