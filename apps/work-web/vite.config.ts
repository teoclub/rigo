import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  // Pinned to this directory rather than left to `process.cwd()`: the build
  // resolves `index.html` against the root, so a `vite build` run from the
  // repository root would otherwise fail with "cannot resolve entry module
  // index.html". `scripts/dev.ts` passes the same value inline.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), tsconfigPaths({ projects: ['./tsconfig.json'] })],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: 'http://127.0.0.1:3081', changeOrigin: false },
    },
  },
})
