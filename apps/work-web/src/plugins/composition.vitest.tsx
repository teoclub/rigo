/**
 * Host-owned composition, end to end on the browser side.
 *
 * The property under test is the one that makes this a *composition* rather
 * than a plugin list: what the host lists is what renders, and what it does not
 * list does not render. Nothing in the app tree names the feature plugins, so
 * these assertions are the only place that coupling is visible.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { App } from '../app.tsx'
import { WorkApiClient } from '../api.ts'
import { ALL_CLIENT_PLUGIN_IDS, CLIENT_PLUGINS, selectClientPlugins } from './table.ts'

afterEach(cleanup)

/** A client whose only useful answer is the composition-under-test's own data. */
function stubClient(): WorkApiClient {
  const client = new WorkApiClient('http://127.0.0.1:0')
  client.listSessions = async () => []
  client.sessionDefaults = async () => ({ providerId: 'p', modelId: 'm', workspaceRoot: '/w', title: 't' })
  return client
}

describe('host-owned composition', () => {
  it('exposes exactly the three shipped features to the host', () => {
    expect([...ALL_CLIENT_PLUGIN_IDS]).toEqual(['work.settings', 'work.model-selection', 'work.approvals'])
    expect(CLIENT_PLUGINS.map(plugin => plugin.label)).toEqual(['Host settings', 'Model selection', 'Approvals'])
  })

  it('composes every shipped plugin when the host list is omitted', () => {
    // The default keeps every pre-composition test behaving exactly as before.
    expect(selectClientPlugins(ALL_CLIENT_PLUGIN_IDS).enabled).toHaveLength(3)
  })

  it('leaves out a feature the host did not list', async () => {
    render(<App client={stubClient()} plugins={['work.settings']} />)
    // The settings seat is populated by its plugin...
    await waitFor(() => { expect(screen.queryByTestId('hostProvider')).toBeNull() })
    // ...and nothing else is composed, so no model selector exists either.
    expect(screen.queryByTestId('composerModel')).toBeNull()
    expect(screen.queryByTestId('settingsDialog')).toBeNull()
  })

  it('tells the reader when the host lists a plugin this build does not have', async () => {
    // Built by hand rather than through `App` so the notice is reachable
    // without a running host: `App` takes the host list as a prop.
    const { container } = render(<App client={stubClient()} plugins={['work.settings', 'work.from-the-future']} />)
    await waitFor(() => {
      expect(screen.getByTestId('compositionNotice').textContent)
        .toContain('work.from-the-future')
    })
    expect(container.querySelector('[data-testid="compositionNotice"]')?.textContent)
      .toContain('is not in this build')
  })
})
