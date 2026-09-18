/**
 * Rigo agent harness — the runnable product entry.
 *
 * One process, one origin. It boots the harness, serves the built web UI as a
 * static fallback, and exposes `/api/v1` beside it. Same-origin is not a
 * convenience here: the CSRF token is readable only by a same-origin page, so
 * serving the UI from anywhere else would defeat the guard that protects every
 * state-modifying route.
 *
 * Model selection is environment-driven and **fails loud**. A harness that
 * silently fell back to the mock model would look healthy while answering
 * nothing real, so `RIGO_LLM_BASE_URL` selects the OpenAI-compatible adapter,
 * a missing key is refused at startup rather than mid-conversation, and the
 * route actually chosen is printed either way — never a guess.
 *
 * @module @teoclub/rigo-cli
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootWorkBase } from '@teoclub/work-base'
import { OpenAICompatibleAdapter } from '@teoclub/harness-llm-openai-compatible'

/** The boot handle, by inference: the bundle does not re-export the type. */
type BootHandle = Awaited<ReturnType<typeof bootWorkBase>>

/** Environment the CLI reads. This interface is the reference for all of it. */
export interface CliEnvironment {
  /** Data directory for the SQLite databases (default `<cwd>/.rigo`). */
  RIGO_HOME?: string
  /** Bound port; 0 picks an ephemeral one (default 3080). */
  RIGO_PORT?: string
  /** Provider route id (default `openai` with a base URL, else `mock`). */
  RIGO_LLM_PROVIDER?: string
  /** Model id sent with every request. */
  RIGO_LLM_MODEL?: string
  /** OpenAI-compatible base URL, e.g. `https://api.example.com/v1`. */
  RIGO_LLM_BASE_URL?: string
  /** Name of the environment variable holding the API key (default `RIGO_LLM_API_KEY`). */
  RIGO_LLM_API_KEY_ENV?: string
  /** Set to `1` to force the deterministic mock provider. */
  RIGO_LLM_MOCK?: string
  /** Directory of built web assets; overrides discovery. */
  RIGO_STATIC_DIR?: string
}

/** Everything `boot` needs, resolved from the environment but not yet used. */
export interface CliPlan {
  dataDir: string
  port: number
  provider: string
  model: string
  /** Adapter registry handed to the harness; empty means the bundle's mock. */
  adapters: Record<string, unknown>
  /** The built UI directory, when one was found. */
  staticDir?: string
  /** One line naming the chosen model route, printed at startup. */
  route: string
}

/** A booted harness: where it listens, and how to stop it. */
export interface CliHandle {
  url: string
  dataDir: string
  route: string
  /** Whether the built UI is being served (false means API-only). */
  servingUi: boolean
  dispose(): Promise<void>
}

/**
 * Where the built web UI might be, in priority order.
 *
 * Two candidates because the CLI runs from two places: installed (its own
 * `dist`, if a package ever ships one) and in-repo (`../..`, where the Vite
 * build writes). Discovery is by `index.html` rather than by directory
 * existence, because Vite leaves an empty `dist` behind after a failed build
 * and serving that would 404 every asset.
 * @param here - directory of the running module.
 * @returns absolute candidate directories, nearest first.
 */
function uiCandidates(here: string): string[] {
  return [
    resolve(here, '../dist'),
    resolve(here, '../../../apps/work-web/dist'),
  ]
}

/**
 * Resolve the run plan from the environment without booting anything.
 *
 * Split from {@link boot} so the decisions that are easy to get wrong — which
 * provider, which model, whether a UI build exists — are testable without
 * starting a server or holding a port.
 * @param env - the environment to read (defaults to `process.env`).
 * @param cwd - working directory used for the default data dir.
 * @param here - directory of the running module (for UI discovery).
 * @returns the plan {@link boot} will execute.
 * @throws when the port is not a port number, or a real provider is selected
 *   without the API key its credential reference names.
 */
export function planCli(
  env: CliEnvironment = process.env,
  cwd = process.cwd(),
  here = dirname(fileURLToPath(import.meta.url)),
): CliPlan {
  const home = env.RIGO_HOME
  const dataDir = resolve(home !== undefined && home.length > 0 ? home : join(cwd, '.rigo'))

  const port = Number(env.RIGO_PORT ?? '3080')
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`RIGO_PORT must be a port number in 0..65535, got ${JSON.stringify(env.RIGO_PORT)}`)
  }

  const baseUrl = env.RIGO_LLM_BASE_URL
  const useMock = env.RIGO_LLM_MOCK === '1' || baseUrl === undefined || baseUrl.length === 0
  const provider = env.RIGO_LLM_PROVIDER ?? (useMock ? 'mock' : 'openai')

  const adapters: Record<string, unknown> = {}
  let model: string
  let route: string
  if (useMock) {
    // The mock adapter lives in the bundle and is selected by the provider id
    // alone, so nothing is registered here — naming the route is the whole job.
    model = env.RIGO_LLM_MODEL ?? 'mock'
    route = 'mock (deterministic; set RIGO_LLM_BASE_URL for a real model)'
  } else {
    // No invented default: there is no model id that means "whatever the
    // endpoint has", so an omission would surface as the provider's own
    // rejection, far from the setting that caused it.
    const requested = env.RIGO_LLM_MODEL
    if (requested === undefined || requested.length === 0) {
      throw new Error('RIGO_LLM_BASE_URL is set but RIGO_LLM_MODEL is empty; name the model to send requests to')
    }
    model = requested
    const keyEnv = env.RIGO_LLM_API_KEY_ENV ?? 'RIGO_LLM_API_KEY'
    // Checked here, at startup, rather than at the first model call: a missing
    // key discovered mid-conversation reads as a broken harness, while a
    // refusal before the port opens names the variable to set. The value is
    // read from `process.env` rather than from `env` because that is exactly
    // what the adapter's credential reference resolves against at request
    // time — checking anywhere else would let the two disagree.
    const key = process.env[keyEnv]
    if (key === undefined || key.length === 0) {
      throw new Error(`RIGO_LLM_BASE_URL is set but $${keyEnv} is empty; export it or use RIGO_LLM_MOCK=1`)
    }
    adapters[provider] = new OpenAICompatibleAdapter({
      baseUrl,
      apiKey: { kind: 'env', name: keyEnv },
    })
    route = `${provider} → ${baseUrl} (model ${model}, key from $${keyEnv})`
  }

  const override = env.RIGO_STATIC_DIR
  const staticDir = override !== undefined && override.length > 0
    ? (existsSync(join(override, 'index.html')) ? resolve(override) : undefined)
    : uiCandidates(here).find(candidate => existsSync(join(candidate, 'index.html')))

  return {
    dataDir,
    port,
    provider,
    model,
    adapters,
    ...(staticDir === undefined ? {} : { staticDir }),
    route,
  }
}

/**
 * Give a first run something to start from.
 *
 * A new session needs an absolute workspace root that already exists, and the
 * stored defaults that supply it start out empty — so an untouched install
 * cannot create a session at all, failing with a message about the workspace
 * rather than about the missing setting. Seeding the document once turns
 * "boots" into "usable", and it happens **only when the document is absent**:
 * after the first run the settings surface owns the file and the CLI must
 * never overwrite what a person chose.
 * @param plan - the resolved run plan (supplies the home and the model route).
 * @param workspaceRoot - the directory created for new sessions.
 */
async function seedDefaults(plan: CliPlan, workspaceRoot: string): Promise<void> {
  const path = join(plan.dataDir, 'session-defaults.json')
  if (existsSync(path)) return
  const defaults = { providerId: plan.provider, modelId: plan.model, workspaceRoot, title: '' }
  try {
    // 'wx' rather than an existsSync guard alone: two boots racing on the same
    // home must not both decide the file is absent, and the loser of that race
    // has nothing to repair.
    await writeFile(path, `${JSON.stringify(defaults, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * Boot the harness and resolve once it is listening.
 * @param env - the environment to read (defaults to `process.env`).
 * @returns the bound URL and a disposer; safe to call once per process.
 */
export async function boot(env: CliEnvironment = process.env): Promise<CliHandle> {
  const plan = planCli(env)
  let handle: BootHandle
  try {
    // The drivers open their SQLite files but do not create directories, so an
    // entry point that owns a home directory must make it. Doing it here rather
    // than in the bundle keeps directory creation a product decision: a library
    // mount should not write to disk merely because it was mounted.
    await mkdir(plan.dataDir, { recursive: true })
    const workspaceRoot = join(plan.dataDir, 'workspace')
    await mkdir(workspaceRoot, { recursive: true })
    await seedDefaults(plan, workspaceRoot)
    handle = await bootWorkBase(
      { adapters: plan.adapters },
      {
        dataDir: plan.dataDir,
        port: plan.port,
        provider: plan.provider,
        model: plan.model,
        ...(plan.staticDir === undefined ? {} : { staticDir: plan.staticDir }),
      },
    )
  } catch (error) {
    // The layers below are precise about what broke but silent about where —
    // "unable to open database file" names neither the file nor the setting
    // that chose it. The entry point is the only layer that knows both, and
    // preparing the home directory belongs inside the same report because it
    // is the same failure to a reader: "start me somewhere I cannot write".
    throw new Error(
      `harness boot failed (RIGO_HOME=${plan.dataDir}, port ${String(plan.port)}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  // The ephemeral-port case (`RIGO_PORT=0`) makes the requested port a lie;
  // the bound one is read back off the live server instead.
  const api = handle.ctx.get('httpServer') as { server: { address(): { port: number } | null } } | undefined
  const bound = api?.server.address()?.port ?? plan.port
  return {
    url: `http://127.0.0.1:${String(bound)}/`,
    dataDir: plan.dataDir,
    route: plan.route,
    servingUi: plan.staticDir !== undefined,
    dispose: () => handle.dispose(),
  }
}

/**
 * Boot, report, and serve until a termination signal arrives.
 *
 * The signal handlers are installed *after* a successful boot: a handler
 * registered before it would swallow a Ctrl-C during startup and leave the
 * process hanging with nothing to shut down.
 * @param env - the environment to read (defaults to `process.env`).
 * @returns the process exit code the launcher should use.
 */
export async function run(env: CliEnvironment = process.env): Promise<number> {
  let handle: CliHandle
  try {
    handle = await boot(env)
  } catch (error) {
    console.error(`rigo: failed to start — ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }

  console.log(`rigo harness  ${handle.url}`)
  console.log(`  model    ${handle.route}`)
  console.log(`  data     ${handle.dataDir}`)
  console.log(`  ui       ${handle.servingUi ? 'serving built assets' : 'API only — run the work-web dev server and proxy, or build it first'}`)

  // The HTTP server keeps the event loop alive, so the returned promise is
  // what makes "serve until told to stop" explicit rather than incidental —
  // and what lets the launcher own the exit code.
  return await new Promise<number>((resolveExit) => {
    let stopping = false
    const stop = (signal: NodeJS.Signals): void => {
      if (stopping) return
      stopping = true
      console.log(`\nrigo: ${signal} — shutting down`)
      handle.dispose().then(
        () => { resolveExit(0) },
        (error: unknown) => {
          console.error(`rigo: shutdown failed — ${error instanceof Error ? error.message : String(error)}`)
          resolveExit(1)
        },
      )
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
