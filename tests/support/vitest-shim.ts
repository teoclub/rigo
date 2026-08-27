// `vitest` -> `bun:test` facade for the ported upstream suites (SPEC §9.2
// dual-runtime requirement). Bun's `bun:test` implements most of the vitest
// surface (describe/it/expect/expectTypeOf, `vi` mock fns and fake timers);
// this module fills the few gaps: vi.waitFor, vi.stubEnv/unstubAllEnvs.
import { vi as bunVi } from 'bun:test'

export {
  afterEach, afterAll, beforeAll, beforeEach,
  describe, expect, expectTypeOf, it, test,
} from 'bun:test'

type BunVi = typeof bunVi & {
  waitFor?: unknown
  stubEnv?: unknown
  unstubAllEnvs?: unknown
}

const bun = bunVi as unknown as BunVi
const stubbedEnvs: string[] = []

export const vi = {
  ...bunVi,
  /** Poll-until assertion helper (vitest's vi.waitFor). */
  waitFor: async (check: () => void | Promise<void>, options?: { timeout?: number, interval?: number }) => {
    const deadline = Date.now() + (options?.timeout ?? 1000)
    let lastError: unknown
    while (Date.now() < deadline) {
      try {
        await check()
        return
      } catch (error) { lastError = error }
      await new Promise((resolve) => setTimeout(resolve, options?.interval ?? 10))
    }
    throw lastError instanceof Error ? lastError : new Error('vi.waitFor timed out')
  },
  /** Record and apply an env override (vitest's vi.stubEnv). */
  stubEnv: (name: string, value: string | undefined) => {
    if (!(name in stubbedEnvs)) stubbedEnvs.push(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  },
  /** Restore every env var touched by stubEnv (vitest's vi.unstubAllEnvs). */
  unstubAllEnvs: () => {
    for (const name of stubbedEnvs.splice(0)) delete process.env[name]
  },
} satisfies typeof import('vitest')['vi']
