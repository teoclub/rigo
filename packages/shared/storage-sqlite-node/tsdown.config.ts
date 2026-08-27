import { defineConfig } from 'tsdown'

/** Local package build shape: one ESM bundle per public face. */
export default defineConfig([
  {
    entry: ['lib/types/index.js', 'lib/types/definition.js', 'lib/types/node.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
])
