/**
 * Host-owned client composition (Issue 039).
 *
 * The browser composes only what the host lists, and the host's list is an
 * observation of its running plugin tree rather than a second manifest. These
 * cases pin the three properties that make that true: the list follows what is
 * actually mounted, the endpoint is fenced exactly like a built-in route, and
 * a contributed route cannot escape the same-origin guard.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@teoclub/cordis'
import { SessionStore } from '@teoclub/harness-session'
import { RuntimeFacade } from '@teoclub/api-sdk'
import { createApiServer, type ApiServer } from '@teoclub/api-http'
import { ApiRouteRegistry, clientFeaturesPlugin, compositionPlugin } from '@teoclub/work-base'

const openServers: { api: ApiServer; ctx: Context }[] = []

afterEach(async () => {
  for (const { api, ctx } of openServers.splice(0)) {
    await api.close()
    await ctx.fiber.dispose()
  }
})

async function server(): Promise<{ base: string; ctx: Context; routes: ApiRouteRegistry }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(compositionPlugin)
  await ctx.plugin(clientFeaturesPlugin)
  const facade = new RuntimeFacade(ctx, { agentFactory: () => ({ agent: { id: 'a', status: 'idle', send() {}, abort() {} }, dispose: async () => {} }) })
  const api = createApiServer({ facade, routes: () => ctx.root.get('apiRoutes')?.list() ?? [] })
  const port = await api.listen(0)
  openServers.push({ api, ctx })
  return { base: `http://127.0.0.1:${port}`, ctx, routes: ctx.root.get('apiRoutes')! }
}

describe('client plugin composition', () => {
  it('serves the ids the host has mounted, in mount order', async () => {
    const { base, ctx } = await server()
    const shipped = await (await fetch(`${base}/api/v1/client/plugins`)).json() as { rev: number; plugins: { id: string }[] }
    // The host's own features are listed because they are mounted, not because
    // a manifest says so.
    expect(shipped.plugins.map(plugin => plugin.id)).toEqual(['work.settings', 'work.model-selection', 'work.approvals'])

    ctx.clientPlugins.declare('work.first', { label: 'First' })
    const disposeSecond = ctx.clientPlugins.declare('work.second')

    const listed = await (await fetch(`${base}/api/v1/client/plugins`)).json() as { rev: number; plugins: { id: string; label: string }[] }
    expect(listed.plugins.slice(-2)).toEqual([
      { id: 'work.first', label: 'First' },
      { id: 'work.second', label: 'work.second' },
    ])
    expect(listed.rev).toBeGreaterThan(shipped.rev)

    // Unloading removes the declaration with its owner — that is what makes
    // the list an observation of the live tree rather than a manifest.
    disposeSecond()
    const after = await (await fetch(`${base}/api/v1/client/plugins`)).json() as { plugins: { id: string }[] }
    expect(after.plugins.map(plugin => plugin.id)).toEqual(['work.settings', 'work.model-selection', 'work.approvals', 'work.first'])
  })

  it('throws on a duplicate or malformed id', async () => {
    const { ctx } = await server()
    ctx.clientPlugins.declare('work.dup')
    expect(() => ctx.clientPlugins.declare('work.dup')).toThrow(/already declared/)
    expect(() => ctx.clientPlugins.declare('nodots')).toThrow(/must match/)
  })

  it('fences a contributed route with the same Host/Origin/CSRF guard as a built-in one', async () => {
    const { base, routes } = await server()
    routes.add({
      method: 'POST',
      path: '/demo/echo',
      handle: ({ json, params }) => { json(200, { ok: true, params }) },
    })

    // No CSRF token: refused exactly like a state-modifying built-in route.
    const refused = await fetch(`${base}/api/v1/demo/echo`, { method: 'POST' })
    expect(refused.status).toBe(403)
    expect((await refused.json() as { error: { code: string } }).error.code).toBe('INVALID_REQUEST')

    // With the token, the route runs and its path parameters are captured.
    const csrf = (await (await fetch(`${base}/api/v1/csrf`)).json() as { csrfToken: string }).csrfToken
    const allowed = await fetch(`${base}/api/v1/demo/echo`, { method: 'POST', headers: { 'x-csrf-token': csrf } })
    expect(allowed.status).toBe(200)
  })

  it('reads routes lazily, so contribution order does not matter', async () => {
    const { base, routes } = await server()
    routes.add({ method: 'GET', path: '/demo/late', handle: ({ json }) => { json(200, { late: true }) } })
    const response = await fetch(`${base}/api/v1/demo/late`)
    expect(await response.json()).toEqual({ late: true })
  })
})
