// Bun polyfills for the vitest APIs `bun:test` lacks (SPEC §9.2 dual-runtime
// requirement): `vi.waitFor`, `vi.stubEnv`, `vi.unstubAllEnvs`,
// `vi.advanceTimersByTimeAsync`, and `expect.poll`. Under vitest the real
// implementations exist, and this module's guards leave them untouched - so
// both runners load the same test file unchanged.
//
// Bun's test runner resolves `vitest` to its own built-in `bun:test`
// regardless of resolver plugins, so the patch must be applied by mutating
// the `vi`/`expect` objects the runner hands out, from a module the test
// imports (the first import in each affected file).

type PatchableVi = {
  waitFor?: unknown
  stubEnv?: unknown
  unstubAllEnvs?: unknown
  advanceTimersByTimeAsync?: unknown
  advanceTimersByTime?: unknown
  getTimerCount?: unknown
  spyOn?: unknown
}

type PatchableExpect = {
  poll?: unknown
}

const g = globalThis as typeof globalThis & { __rigoViPatched?: boolean }

if (g.__rigoViPatched !== true) {
  g.__rigoViPatched = true
  const stubbedEnvs: string[] = []

  const waitFor = async (
    check: () => void | Promise<void>,
    options?: { timeout?: number, interval?: number },
  ): Promise<void> => {
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
  }

  /**
   * `vi.advanceTimersByTimeAsync(ms)` - advance the fake clock and await the
   * promise chains the fired callbacks started. Vitest keeps draining timers
   * that come due mid-window; bun only ships the synchronous
   * `advanceTimersByTime`, and two bun quirks shape this port:
   * `advanceTimersByTime(0)` advances the clock by 1ms, so a zero advance
   * would shift later boundary assertions (write-behind window tests assert
   * exact 200ms edges), and extra zero-advances to flush delay-zero timers
   * corrupt the timeline the same way. So a zero advance skips the clock
   * entirely, and the drain is microtask-only - the async part the ported
   * suites rely on. Each `await Promise.resolve()` is one microtask wave; 50
   * waves settle any realistic promise chain.
   */
  const advanceTimersByTimeAsync = async (ms: number): Promise<void> => {
    if (ms > 0) vi.advanceTimersByTime(ms)
    for (let wave = 0; wave < 50; wave++) await Promise.resolve()
  }

  const stubEnv = (name: string, value: string | undefined): void => {
    if (!stubbedEnvs.includes(name)) stubbedEnvs.push(name)
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  const unstubAllEnvs = (): void => {
    for (const name of stubbedEnvs.splice(0)) delete process.env[name]
  }

  /**
   * `expect.poll(fn)` - returns a jest-like matcher proxy that retries the
   * matcher until it passes or the timeout elapses. Implemented by polling
   * the thunk and re-wrapping its latest value in the real expect().
   */
  const poll = (thunk: () => unknown, options?: { timeout?: number, interval?: number }) => {
    const timeout = options?.timeout ?? 1000
    const interval = options?.interval ?? 10
    const attempt = async (apply: (value: unknown) => unknown): Promise<unknown> => {
      const deadline = Date.now() + timeout
      let lastError: unknown
      while (true) {
        try {
          return apply(thunk())
        } catch (error) {
          lastError = error
          if (Date.now() >= deadline) throw lastError
          await new Promise((resolve) => setTimeout(resolve, interval))
        }
      }
    }
    return new Proxy({} as Record<string, unknown>, {
      get: (_target, matcherName: string) => {
        if (matcherName === 'then') {
          // Awaitable without a matcher: poll until the thunk stops throwing.
          return (resolve: () => void, reject: (error: unknown) => void) => {
            attempt((value) => { void value; return value }).then(resolve, reject)
          }
        }
        return (...args: unknown[]) => attempt(
          (value) => (expect as (v: unknown) => Record<string, (...a: unknown[]) => unknown>)(value)[matcherName](...args),
        )
      },
    })
  }

  /**
   * `vi.spyOn(object, method)` - bun's spyOn installs the mock on the OBJECT
   * ITSELF via defineProperty, which for a Proxy (no defineProperty trap)
   * lands in the proxy's own property table where reads never see it (they
   * forward to the target). Cordis callable services (`ctx.logger`, and
   * every `ctx.*` service) are traceable proxies, so bun's spyOn silently
   * installs nothing and the mock never fires. For those, install the mock
   * directly on the shared target (all views resolve it) with a default
   * implementation that calls through to the original method.
   */
  const spyOn = (object: object, method: string | symbol, accessType?: string): unknown => {
    const target = ((object as Record<PropertyKey, unknown>)[Symbol.for('cordis.original')] as object | undefined)
    if (!target || typeof method !== 'string' || accessType !== undefined) {
      return originalSpyOn.call(vi, object, method, accessType)
    }
    const original = Reflect.get(target, method) as unknown
    if (typeof original !== 'function') {
      return originalSpyOn.call(vi, object, method, accessType)
    }
    const mock = vi.fn(function (this: unknown, ...args: unknown[]) {
      return (original as (...a: unknown[]) => unknown).apply(this, args)
    }) as unknown as { mockRestore?: () => void }
    const restore = (): void => {
      Reflect.defineProperty(target, method, {
        value: original,
        writable: true,
        configurable: true,
      })
    }
    Object.defineProperty(mock, 'mockRestore', { value: restore, configurable: true })
    Reflect.defineProperty(target, method, { value: mock, writable: true, configurable: true })
    return mock
  }

  // Patch lazily: `bun:test`'s bindings are shared, and vitest's `vi`/
  // `expect` already define these members (the typeof guards skip those).
  const { vi, expect } = await import('vitest') as { vi: PatchableVi, expect: PatchableExpect }
  if (typeof vi.waitFor !== 'function') vi.waitFor = waitFor as NonNullable<PatchableVi['waitFor']>
  if (typeof vi.stubEnv !== 'function') vi.stubEnv = stubEnv as NonNullable<PatchableVi['stubEnv']>
  if (typeof vi.unstubAllEnvs !== 'function') vi.unstubAllEnvs = unstubAllEnvs as NonNullable<PatchableVi['unstubAllEnvs']>
  if (typeof vi.advanceTimersByTimeAsync !== 'function' && typeof vi.advanceTimersByTime === 'function' && typeof vi.getTimerCount === 'function') {
    vi.advanceTimersByTimeAsync = advanceTimersByTimeAsync as NonNullable<PatchableVi['advanceTimersByTimeAsync']>
  }
  const originalSpyOn = vi.spyOn as unknown
  // Bun-only: vitest's spyOn handles proxied services fine, and wrapping it
  // would change vitest's mock semantics for every ported suite.
  const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
  if (isBun && typeof originalSpyOn === 'function') {
    // Always wrap: bun ships a spyOn, but it silently fails on cordis
    // callable services, so the pre-install above must run before every call.
    vi.spyOn = ((object: object, method: string | symbol, accessType?: string) =>
      spyOn(object, method, accessType)) as NonNullable<PatchableVi['spyOn']>
  }
  if (typeof expect.poll !== 'function') expect.poll = poll as NonNullable<PatchableExpect['poll']>
}
