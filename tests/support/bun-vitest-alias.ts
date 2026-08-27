// Redirects `vitest` imports to the local shim so the ported upstream suites
// run unmodified in Bun's test runner (dual-runtime requirement, SPEC §9.2).
// Bun's runtime already reserves `bun:test`; the resolver hook fires first
// for ordinary specifiers, so the shim wins.
import { plugin } from 'bun'

await plugin({
  name: 'vitest-alias',
  setup(build) {
    build.onResolve({ filter: /^vitest$/ }, (args) => {
      void args
      return { path: new URL('./vitest-shim.ts', import.meta.url).pathname }
    })
  },
})
