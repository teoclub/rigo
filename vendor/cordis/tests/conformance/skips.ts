/**
 * Explicit registry for conformance cases skipped on one runtime
 * (SPEC §9.1). Every entry needs a reason. The suite currently has
 * zero skips: Node and Bun results are fully identical.
 */
export interface SkipEntry {
  test: string
  runtime: 'node' | 'bun'
  reason: string
}

export const skips: SkipEntry[] = []
