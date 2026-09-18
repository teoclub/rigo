/**
 * Host-side session defaults.
 *
 * These four values used to live only in the browser's `localStorage`, which
 * meant the host never knew them and no other surface could read them. Moving
 * them here is what lets the settings UI become a *contribution*: a
 * contribution renders in the browser but its state belongs to the host, so
 * the browser's job is reduced to reading and writing one endpoint.
 *
 * Storage is a single JSON document under the Rigo home, written atomically
 * through a temp file + rename so a crash mid-write cannot leave a half-filled
 * document behind.
 *
 * @module @teoclub/work-base/session-defaults
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Service, type Context } from '@teoclub/cordis'
import type { ApiRoute } from '@teoclub/api-http'

/** The values a new session is created with. */
export interface SessionDefaults {
  providerId: string
  modelId: string
  workspaceRoot: string
  title: string
}

/** The endpoint the browser reads and writes. */
export const SESSION_DEFAULTS_ROUTE = '/settings/session-defaults'

const EMPTY: SessionDefaults = { providerId: '', modelId: '', workspaceRoot: '', title: '' }

declare module '@teoclub/cordis' {
  interface Context {
    sessionDefaults: SessionDefaultsService
  }
}

/** Read and write the durable session defaults document. */
export class SessionDefaultsService extends Service {
  private readonly path: string
  private cache: SessionDefaults | undefined

  constructor(ctx: Context, home: string) {
    super(ctx, 'sessionDefaults')
    this.path = join(home, 'session-defaults.json')
  }

  /** The current defaults; an absent or unreadable document reads as empty. */
  async read(): Promise<SessionDefaults> {
    if (this.cache !== undefined) return { ...this.cache }
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<SessionDefaults>
      this.cache = { ...EMPTY, ...pick(parsed) }
    } catch {
      // Absent or corrupt: start from empty rather than failing the surface.
      this.cache = { ...EMPTY }
    }
    return { ...this.cache }
  }

  /**
   * Merge a patch into the defaults and persist it.
   * @param patch - the fields to change; unknown fields are ignored.
   * @returns the merged defaults as stored.
   */
  async write(patch: Partial<SessionDefaults>): Promise<SessionDefaults> {
    const next = { ...(await this.read()), ...pick(patch) }
    this.cache = next
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(temp, this.path)
    return { ...next }
  }
}

/** Keep only known string fields, so a hostile body cannot widen the document. */
function pick(source: Partial<SessionDefaults>): Partial<SessionDefaults> {
  const result: Partial<SessionDefaults> = {}
  for (const key of Object.keys(EMPTY) as (keyof SessionDefaults)[]) {
    const value = source[key]
    if (typeof value === 'string') result[key] = value
  }
  return result
}

/**
 * Mount the defaults service and publish its endpoint.
 * @param ctx - the context to mount into (rooted, like the other rigo services).
 * @param home - the Rigo home directory holding the document.
 */
export function mountSessionDefaults(ctx: Context, home: string): void {
  const root = ctx.root
  root.plugin(SessionDefaultsService, home)
  const routes = root.get('apiRoutes')
  if (routes === undefined) throw new Error('session defaults require the apiRoutes registry')
  ctx.effect(() => routes.add({
    method: 'GET',
    path: SESSION_DEFAULTS_ROUTE,
    handle: async ({ json }) => {
      json(200, { values: await root.sessionDefaults.read() })
    },
  } as ApiRoute), 'rigo.sessionDefaults.read()')
  ctx.effect(() => routes.add({
    method: 'PUT',
    path: SESSION_DEFAULTS_ROUTE,
    handle: async ({ json, fail, readBody }) => {
      const body = await readBody()
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        fail('INVALID_REQUEST', 'body must be an object of session defaults')
        return
      }
      const values = await root.sessionDefaults.write(body as Partial<SessionDefaults>)
      json(200, { values })
    },
  } as ApiRoute), 'rigo.sessionDefaults.write()')
}
