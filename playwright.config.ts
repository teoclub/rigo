import { defineConfig } from '@playwright/test'

/**
 * Rigo Work E2E (Issues 037/038): each spec boots its own isolated harness
 * (bundle + SQLite + knowledge index + Vite UI server) inside the test.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  // The `.e2e.ts` suffix keeps the suites out of Bun's default test glob
  // (only `*.test.*`/`*.spec.*` match) while Playwright runs them here.
  testMatch: '**/*.e2e.ts',
  // Pin the single repo tsconfig for the loader: without it, Playwright walks
  // up from files inside vendor/cordis/... and applies the vendored
  // tsconfig.base.json, whose paths map @teoclub/* to *directories*
  // (e.g. ./packages/cordis/src). Directory mapping then resolves `src/index`
  // preferring the built `.js` over the `.ts` source, and the built js dropped
  // `const enum FiberState`. The repo tsconfig (extends tsconfig.paths.json)
  // maps to the .ts entries.
  tsconfig: 'tsconfig.json',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
})
