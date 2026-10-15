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
      // Every root the workspace declares a package under. A root missing
      // here is not merely unbundled: its packages still publish
      // `exports.default = ./lib/index.js`, so the default condition resolves
      // to a file nothing produces (or to a leftover from the last time it
      // was listed) while `bun run build` still reports success.
      'packages/harness/*',
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
