# kora
The Open Ecosystem for Agent Harnesses.

Rigo is a minimal, production-usable agent harness built on
[Cordis](https://github.com/cordiverse/cordis) plugins: a session log, a tool
loop, a context assembly, an approval gate, and a browser UI that composes
itself from whatever the host actually mounted.

## Running it

```sh
bun install
bun run build:web     # builds the browser UI into apps/work-web/dist
bun run start         # serves the UI and /api/v1 on one origin
```

`bun run start` boots the harness with the deterministic **mock** model, so it
answers without any credentials. To use a real model, point it at any
OpenAI-compatible endpoint:

```sh
RIGO_LLM_BASE_URL=https://api.example.com/v1 \
RIGO_LLM_MODEL=your-model \
RIGO_LLM_API_KEY=sk-... \
bun run start
```

It prints where it is listening; open that URL.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RIGO_HOME` | `<cwd>/.rigo` | Data directory: the SQLite databases, the default workspace, and the session-defaults document. Created on first run. |
| `RIGO_PORT` | `3080` | Bound port. `0` picks an ephemeral one; the bound port is what gets printed. |
| `RIGO_LLM_BASE_URL` | *(unset)* | OpenAI-compatible base URL, e.g. `https://api.example.com/v1`. Unset selects the mock model. |
| `RIGO_LLM_MODEL` | `mock` | Model id sent with every request. Required whenever `RIGO_LLM_BASE_URL` is set. |
| `RIGO_LLM_API_KEY` | *(unset)* | The API key. Read at request time; never written to the data directory, a log line, or an error. |
| `RIGO_LLM_API_KEY_ENV` | `RIGO_LLM_API_KEY` | Name of the variable holding the key, when it lives under a different name. |
| `RIGO_LLM_PROVIDER` | `openai` (`mock`) | Provider route id the adapter registers under; `mock` when the mock model is selected. |
| `RIGO_LLM_MOCK` | *(unset)* | Set to `1` to force the mock model even when a base URL is set. |
| `RIGO_STATIC_DIR` | *(discovered)* | Built UI directory to serve. Discovered next to the CLI, or at `apps/work-web/dist`. |

Misconfiguration is refused **at startup**, naming the variable at fault — a
missing key or model is reported before the port opens rather than as a
failure mid-conversation. The chosen model route is printed on every boot, so
which model is answering is never a guess.

## Development

```sh
bun run dev           # API + Vite dev server with HMR, seeded demo workspace
bun run typecheck     # tsc -b across every project
bun run test          # vitest: unit, component and integration suites
bun run e2e           # Playwright: full-product suites against a live stack
bun run verify        # the gate chain (see below)
```

### The gate chain

`bun run verify` runs the checks that keep the port honest:

| Gate | What it protects |
| --- | --- |
| `verify:baseline` | The pinned upstream release tag and commit, and that the local upstream clone sits at the pinned commit. |
| `audit:source` | Every ported file still traces to its upstream path, with its provenance commit. |
| `verify:packages` | Package manifests, licenses and published artifacts. |
| `verify:boundaries` | Import direction between packages and domains. |
| `verify:matrix` | `docs/compatibility-matrix.md` matches the test suites it claims. |
| `verify:compat` | The upstream suites pass on **both** Node and Bun. |

The vendored Cordis family under `vendor/cordis/` carries local patches. Those
divergences are recorded in a ledger (`vendor/cordis/scripts/merge-teo.ts`) and
checked by `verify-teo-patches.ts`; a divergence with no ledger entry fails.

## Layout

```
packages/harness/*   the agent runtime: LLM, sessions, tools, agent loop, approvals
packages/shared/*    storage, migrations, persistence, knowledge, actions
packages/work/*      the Rigo Work domain: documents, tools, context
packages/api/*       the /api/v1 facade, HTTP server, and the wire contract
packages/bundle/*    the composition roots (work-base)
apps/work-web        the browser UI
apps/cli             the runnable entry point (`rigo`)
vendor/cordis        the vendored Cordis fork
```

### Where the architecture comes from

The runtime is ported from the DeepSeek Harness with an explicit,
machine-checked provenance chain (`docs/upstream-baseline.md`,
`docs/harness-upstream-audit.json`). The browser UI is a Rigo-native design that
adopts the upstream *contribution* mechanism rather than its code:

- **Slot registry** — a compile-time `SlotMap` (TypeScript declaration merging)
  plus a runtime ordered ledger, so a plugin's seat is type-checked where it is
  declared and ordered where it is registered. Declaring a slot is claiming it.
- **Host-owned composition** — the host derives the browser's plugin list from
  its own mounted plugin tree (`GET /api/v1/client/plugins`). There is no second
  manifest to keep in sync, so a disabled or unloaded plugin leaves the list
  with its own effect. The browser composes exactly what it is told, and says so
  in the UI when it is told about a plugin this build does not have.
- **One wire contract** — `packages/api/wire` is the single source of the HTTP
  and SSE payload shapes, including the SSE framing both sides must agree on.
