/**
 * Worker bootstrap installs only the generation inherited from its parent.
 *
 * Hand-maintained: both the import under test and the mocked module are named
 * by the package's public `src/*` export. The mirrored layout under
 * tests/upstream/app-boot/tests/ has no sibling `src/`, so a relative
 * `../src/...` specifier would name a path that does not exist and the mock
 * would silently fail to intercept the real resolver.
 */

import { beforeEach, expect, it, vi } from 'vitest'
import type { ProfileResolutionGeneration } from '@teoclub/harness-app-boot/src/profile.ts'

const harness = vi.hoisted(() => ({
  data: undefined as {
    generation: ProfileResolutionGeneration
    behavior: 'enforce' | 'verify'
  } | undefined,
  install: vi.fn(),
}))

vi.mock('node:worker_threads', () => ({
  getEnvironmentData: () => harness.data,
}))

vi.mock('@teoclub/harness-app-boot/src/profile-resolution/resolver.ts', () => ({
  installProfileResolution: harness.install,
}))

beforeEach(() => {
  harness.data = undefined
  harness.install.mockReset()
  vi.resetModules()
})

it('does nothing without inherited profile resolution data', async () => {
  await import('@teoclub/harness-app-boot/src/profile-resolution/worker-bootstrap.ts')
  expect(harness.install).not.toHaveBeenCalled()
})

it('installs the inherited generation and behavior', async () => {
  const generation: ProfileResolutionGeneration = {
    profilesDir: '/profiles',
    profileDir: '/profiles/test',
    localPackageNames: [],
    entries: [],
  }
  harness.data = { generation, behavior: 'verify' }
  await import('@teoclub/harness-app-boot/src/profile-resolution/worker-bootstrap.ts')
  expect(harness.install).toHaveBeenCalledWith(generation, 'verify')
})
