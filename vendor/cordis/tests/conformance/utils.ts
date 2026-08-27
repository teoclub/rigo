/**
 * Shared helpers for the cross-runtime conformance suite.
 *
 * The suite must not import any runtime-specific API (SPEC §9.1): everything
 * here runs identically under Node and Bun.
 */

/**
 * FiberState is a const enum (erased at build time), so its numeric values
 * are frozen as the compatibility baseline (SPEC §5.3).
 */
export const S = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

/** Wait for the microtask queue (and one macrotask tick) to drain. */
export async function flush(ticks = 4) {
  for (let i = 0; i < ticks; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

/** A minimal synchronous Standard Schema (v1) wrapping a predicate. */
export function schema(validate: (value: any) => any) {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate,
    },
  }
}
