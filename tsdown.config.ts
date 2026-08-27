import { defineConfig } from 'tsdown'

/**
 * Workspace build: every package's TypeScript intermediates are emitted by
 * `tsc -b` under `lib/types`, then tsdown bundles each package's runtime
 * entries into `lib/` (ESM, es2024 - matching the upstream
 * @deepseek-ai/dsh-* published shape). Packages needing a different build
 * shape keep their own package-local tsdown.config.ts, which takes
 * precedence over this workspace default.
 */
export default defineConfig({
  workspace: {
    include: [
      // Issue 003: minimal empty-package closure lives under these roots;
      // each later phase adds its packages here.
      'packages/harness/*',
      'packages/shared/*',
    ],
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
