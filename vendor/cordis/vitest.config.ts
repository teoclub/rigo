import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'tests/conformance/**/*.spec.ts',
      'tests/integration/**/*.spec.ts',
      'tests/package/**/*.spec.ts',
      'tests/node/**/*.spec.ts',
    ],
    environment: 'node',
    testTimeout: 10_000,
  },
})
