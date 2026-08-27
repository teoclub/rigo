import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from './vitest.shared.ts'

// Resolution facade: tsconfig.base.json has no include/files, which
// vite-tsconfig-paths treats as match-all, so its paths map applies to every
// test file. paths must win over package exports so tests and the packages
// under test share one module identity (source), never a second copy from
// built lib/. Package-internal bare imports resolve through the workspace
// node_modules links, which is why the generated manifests also carry a
// "development" exports condition pointing at source (see
// scripts/port-upstream.ts) — a mixed src/lib graph splits module-private
// symbols (e.g. Cordis scope keys, error classes) and breaks
// scope-dependent behavior.
export default defineConfig({
  plugins: [
    tsconfigPaths({ projects: ['./tsconfig.base.json'] }),
    standardDecoratorPlugin(),
  ],
  test: {
    // Only this repo's suites: an unbounded default glob would also pick up
    // vendor/cordis (the sibling checkout's own tests). The Rigo Work Web
    // app's unit/component suites join under apps/work-web (jsdom per-file).
    include: ['tests/**/*.spec.ts', 'apps/work-web/src/**/*.test.ts', 'apps/work-web/src/**/*.vitest.tsx'],
    // The Playwright E2E suites (Issues 037/038) run under their own runner
    // (`bun run e2e`), not vitest or Bun.
    exclude: ['tests/e2e/**'],
    environment: 'node',
    // Every suite forks: the app-boot HMR suites construct the Cordis HMR
    // service, which requires Node's internal module loader
    // (`--expose-internals`, not settable through NODE_OPTIONS). Forks
    // inherit these execArgv; worker threads would not.
    pool: 'forks',
    // The upstream app-boot HMR suites assert fs.watch delivery within
    // deadlines; unlimited fork parallelism starves those events under full
    // load (flaky `HMR did not observe ...` timeouts that pass in
    // isolation). A small fixed pool keeps the suite deterministic.
    maxWorkers: 4,
    minWorkers: 1,
    execArgv: ['--expose-internals'],
  },
})
