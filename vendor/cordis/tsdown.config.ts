import { defineConfig } from 'tsdown'

/**
 * Workspace build: every package's TypeScript intermediates are emitted by
 * `tsc -b` under `lib/types`, then tsdown bundles each package's runtime
 * entry into `lib/` (ESM, es2024 - matching the @deepseek-ai/* 4.0.1
 * published shape; SPEC D2). Packages with a build-shape override keep their
 * own package-local tsdown.config.ts (schemastery: dual ESM+CJS;
 * logger-console: node+browser entries).
 *
 * `packages/plugins` is a plain grouping directory (not a package) and is
 * excluded from workspace discovery.
 */
export default defineConfig({
  workspace: {
    // explicit top-level packages (a bare `packages/*` would also match the
    // `packages/plugins` grouping directory, which is not a package)
    include: ['packages/{kit,schemastery,cordis}', 'packages/plugins/*'],
  },
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
