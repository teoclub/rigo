/**
 * The product entry point (Issue 039).
 *
 * Two properties matter here and nowhere else in the repository. First, the
 * run plan is decided *before* anything is opened, so a misconfiguration is a
 * startup failure with a named cause rather than a mystery mid-conversation.
 * Second, the boot actually serves: `/api/v1` answers beside the built UI on
 * one origin. Everything below is one of those two.
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { boot, planCli, type CliHandle } from './index.ts'

const cleanup: string[] = []
const running: CliHandle[] = []

afterEach(async () => {
  for (const handle of running.splice(0)) await handle.dispose()
  for (const dir of cleanup.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** An isolated directory plus the run's own scratch space, removed after. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rigo-cli-'))
  cleanup.push(dir)
  return dir
}

/** Run `body` with the named variables replaced, restoring them afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => T | Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(vars).map(name => [name, process.env[name]]))
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return await body()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

describe('run plan', () => {
  it('boots the deterministic mock by default, registering no adapter', () => {
    const plan = planCli({}, '/work')
    expect(plan.provider).toBe('mock')
    expect(plan.model).toBe('mock')
    expect(plan.adapters).toEqual({})
    expect(plan.route).toContain('mock')
    // A relative RIGO_HOME would silently land wherever the process happened
    // to start; the plan always resolves it.
    expect(plan.dataDir).toBe('/work/.rigo')
  })

  it('reads RIGO_HOME, the port and the model from the environment', () => {
    const plan = planCli({ RIGO_HOME: '/data', RIGO_PORT: '4321', RIGO_LLM_MODEL: 'x', RIGO_LLM_MOCK: '1' }, '/work')
    expect(plan.dataDir).toBe('/data')
    expect(plan.port).toBe(4321)
    expect(plan.model).toBe('x')
  })

  it('refuses a port that is not a port', () => {
    // 99999 parses as a number and is not a port: the check has to be a range,
    // not `Number.isNaN`.
    expect(() => planCli({ RIGO_PORT: '99999' }, '/work')).toThrow(/RIGO_PORT/)
    expect(() => planCli({ RIGO_PORT: 'http' }, '/work')).toThrow(/RIGO_PORT/)
  })

  it('refuses a real provider whose API key is not in the environment', async () => {
    await withEnv({ RIGO_LLM_API_KEY: undefined }, () => {
      expect(() => planCli({ RIGO_LLM_BASE_URL: 'https://example.invalid/v1', RIGO_LLM_MODEL: 'm' }, '/work'))
        .toThrow(/\$RIGO_LLM_API_KEY/)
    })
  })

  it('names the variable actually holding the key', async () => {
    await withEnv({ MY_KEY: undefined, RIGO_LLM_API_KEY: undefined }, () => {
      expect(() => planCli({ RIGO_LLM_BASE_URL: 'https://example.invalid/v1', RIGO_LLM_MODEL: 'm', RIGO_LLM_API_KEY_ENV: 'MY_KEY' }, '/work'))
        .toThrow(/\$MY_KEY/)
    })
  })

  it('registers the OpenAI-compatible adapter under the chosen provider route', async () => {
    await withEnv({ RIGO_LLM_API_KEY: 'sk-test' }, () => {
      const plan = planCli({ RIGO_LLM_BASE_URL: 'https://example.invalid/v1', RIGO_LLM_MODEL: 'm' }, '/work')
      expect(plan.provider).toBe('openai')
      expect(Object.keys(plan.adapters)).toEqual(['openai'])
      // The route line is the only place a reader learns which model is in
      // play; it must name the base URL without ever naming the key.
      expect(plan.route).toContain('https://example.invalid/v1')
      expect(plan.route).toContain('$RIGO_LLM_API_KEY')
      expect(plan.route).not.toContain('sk-test')
    })
  })

  it('takes the provider id from RIGO_LLM_PROVIDER', async () => {
    await withEnv({ RIGO_LLM_API_KEY: 'sk-test' }, () => {
      const plan = planCli({ RIGO_LLM_BASE_URL: 'https://example.invalid/v1', RIGO_LLM_MODEL: 'm', RIGO_LLM_PROVIDER: 'local' }, '/work')
      expect(Object.keys(plan.adapters)).toEqual(['local'])
    })
  })

  it('refuses a real provider with no model to send requests to', async () => {
    await withEnv({ RIGO_LLM_API_KEY: 'sk-test' }, () => {
      // There is no model id that means "whatever the endpoint has", so any
      // invented default would surface as the provider's own rejection.
      expect(() => planCli({ RIGO_LLM_BASE_URL: 'https://example.invalid/v1' }, '/work'))
        .toThrow(/RIGO_LLM_MODEL/)
    })
  })
})

describe('static UI discovery', () => {
  it('finds a build beside the package', async () => {
    const dir = await scratch()
    await mkdir(join(dir, 'dist'), { recursive: true })
    await writeFile(join(dir, 'dist/index.html'), '<!doctype html>')
    expect(planCli({}, '/work', join(dir, 'src')).staticDir).toBe(join(dir, 'dist'))
  })

  it('reports no UI rather than a directory that cannot be served', async () => {
    const dir = await scratch()
    // Vite leaves an empty `dist` behind after a failed build; serving it
    // would 404 every asset, so discovery is by the entry document.
    await mkdir(join(dir, 'dist'), { recursive: true })
    expect(planCli({}, '/work', join(dir, 'src')).staticDir).toBeUndefined()
  })

  it('honours RIGO_STATIC_DIR, and ignores it when it has no entry document', async () => {
    const dir = await scratch()
    await mkdir(join(dir, 'ui'), { recursive: true })
    await writeFile(join(dir, 'ui/index.html'), '<!doctype html>')
    expect(planCli({ RIGO_STATIC_DIR: join(dir, 'ui') }, '/work').staticDir).toBe(join(dir, 'ui'))
    expect(planCli({ RIGO_STATIC_DIR: join(dir, 'missing') }, '/work').staticDir).toBeUndefined()
  })
})

describe('boot', () => {
  it('serves /api/v1 on the port it reports, then stops', async () => {
    const dir = await scratch()
    const handle = await boot({ RIGO_HOME: join(dir, 'home'), RIGO_PORT: '0', RIGO_LLM_MOCK: '1' })
    running.push(handle)

    // Port 0 means the requested port is a lie; the reported one is the bound
    // one, and the only proof of that is fetching it.
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    const health = await fetch(new URL('api/v1/health', handle.url))
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok' })

    // The composition endpoint is the browser's whole boot contract: without
    // it the app has nothing to compose.
    const composition = await fetch(new URL('api/v1/client/plugins', handle.url))
    const body = await composition.json() as { plugins: { id: string }[] }
    expect(body.plugins.map(plugin => plugin.id)).toContain('work.settings')
  })

  it('gives a first run a workspace it can actually start a session in', async () => {
    const dir = await scratch()
    const home = join(dir, 'home')
    const handle = await boot({ RIGO_HOME: home, RIGO_PORT: '0', RIGO_LLM_MOCK: '1' })
    running.push(handle)

    // The stored defaults start empty and a session needs an absolute root
    // that exists, so without seeding an untouched install cannot create a
    // session at all.
    const seeded = await (await fetch(new URL('api/v1/settings/session-defaults', handle.url))).json() as
      { values: { workspaceRoot: string; providerId: string } }
    expect(seeded.values.workspaceRoot).toBe(join(home, 'workspace'))
    expect(seeded.values.providerId).toBe('mock')
    await expect(stat(seeded.values.workspaceRoot)).resolves.toBeDefined()

    await handle.dispose()
    running.pop()
  })

  it('never overwrites defaults a person has since edited', async () => {
    const dir = await scratch()
    const home = join(dir, 'home')
    await mkdir(home, { recursive: true })
    const chosen = JSON.stringify({ providerId: 'p', modelId: 'm', workspaceRoot: '/chosen', title: 'T' })
    await writeFile(join(home, 'session-defaults.json'), chosen)

    const handle = await boot({ RIGO_HOME: home, RIGO_PORT: '0', RIGO_LLM_MOCK: '1' })
    running.push(handle)
    // Seeding is a first-run act; after that the settings surface owns the file.
    expect(await readFile(join(home, 'session-defaults.json'), 'utf8')).toBe(chosen)
  })

  it('names the data directory when the boot fails', async () => {
    const dir = await scratch()
    // A file where the data directory should be: the failure is real and its
    // own message ("unable to open database file") names neither the file nor
    // the setting that chose it.
    const blocked = join(dir, 'home')
    await writeFile(blocked, 'not a directory')
    await expect(boot({ RIGO_HOME: blocked, RIGO_PORT: '0', RIGO_LLM_MOCK: '1' }))
      .rejects.toThrow(new RegExp(`RIGO_HOME=${blocked}`))
  })
})
