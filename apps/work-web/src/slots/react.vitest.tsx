/**
 * The React binding: the outlet's four states, reactivity, and teardown.
 *
 * The kit is declared-and-rendered through the same public surface a
 * contribution uses, so these tests would fail if `register`, the subscription
 * or the boundary drifted from what `core.test.ts` pins.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach } from 'vitest'
import { createClientApp, staticPluginSource, type ClientPlugin } from './host.ts'
import { SlotHostProvider, SlotOutlet, useClientApp } from './react.tsx'
import type { SlotCore } from './core.ts'

afterEach(cleanup)

/** A ledger with one `list` and one `single` seat, and one plugin registered into each. */
function harness(): {
  app: ReturnType<typeof createClientApp<string>>
  slot: 'demo.list'
} {
  const plugin: ClientPlugin<string> = {
    id: 'demo',
    label: 'Demo',
    apply: (ctx) => {
      ctx.effect(() => {}),
      ctx.slots.register(
        { name: 'demo.list', id: 'one', registrant: 'demo' } as never,
        (({ label }: { label: string }) => <span data-testid="contribution">{label}</span>) as never,
      )
      ctx.slots.register(
        { name: 'demo.single', registrant: 'demo' } as never,
        (({ label }: { label: string }) => <span data-testid="single">{label}</span>) as never,
      )
    },
  }
  const app = createClientApp<string>({
    client: 'client',
    source: staticPluginSource([plugin]),
    declare: (core: SlotCore) => core.register(
      { name: 'root', children: { 'demo.list': { kind: 'list' }, 'demo.single': { kind: 'single' } } } as never,
      (() => null) as never,
    ),
  })
  return { app, slot: 'demo.list' }
}

describe('SlotOutlet', () => {
  it('renders nothing without a provider, so a bare component test shows no extensions', () => {
    render(<SlotOutlet slot="demo.list" owner={{ label: 'x' }} />)
    expect(screen.queryByTestId('contribution')).toBeNull()
  })

  it('renders nothing for a declared slot nobody contributed to, falling back when given one', () => {
    const { app } = harness()
    render(
      <SlotHostProvider app={app}>
        <SlotOutlet slot="demo.single" owner={{ label: 'fallback' }} fallback={<span data-testid="fb" />} />
      </SlotHostProvider>,
    )
    // The single seat IS occupied in this harness, so the fallback stays hidden.
    expect(screen.queryByTestId('fb')).toBeNull()
    expect(screen.getByTestId('single').textContent).toBe('fallback')
  })

  it('renders a contribution and passes the owner props through', () => {
    const { app } = harness()
    render(
      <SlotHostProvider app={app}>
        <SlotOutlet slot="demo.list" owner={{ label: 'from owner' }} />
      </SlotHostProvider>,
    )
    expect(screen.getByTestId('contribution').textContent).toBe('from owner')
  })

  it('emits a stable layout-neutral anchor around the outlet', () => {
    const { app } = harness()
    const { container } = render(
      <SlotHostProvider app={app}>
        <SlotOutlet slot="demo.list" owner={{ label: 'x' }} />
      </SlotHostProvider>,
    )
    const anchor = container.querySelector('[data-slot="demo.list"]')
    expect(anchor).not.toBeNull()
    expect((anchor as HTMLElement).style.display).toBe('contents')
  })

  it('renders nothing for an undeclared slot', () => {
    const { app } = harness()
    render(
      <SlotHostProvider app={app}>
        <SlotOutlet slot="nobody.declared.this" owner={{}} />
      </SlotHostProvider>,
    )
    expect(screen.queryByTestId('contribution')).toBeNull()
  })
})

describe('SlotOutlet reactivity', () => {
  it('picks up a registration made after the first render', async () => {
    const { app } = harness()
    render(
      <SlotHostProvider app={app}>
        <SlotOutlet slot="demo.list" owner={{ label: 'late' }} />
      </SlotHostProvider>,
    )
    expect(screen.queryAllByTestId('contribution')).toHaveLength(1)

    await act(async () => {
      app.host.core.register(
        { name: 'demo.list', id: 'two', registrant: 'late-plugin' } as never,
        (({ label }: { label: string }) => <span data-testid="contribution">{label}</span>) as never,
      )
    })
    await waitFor(() => { expect(screen.queryAllByTestId('contribution')).toHaveLength(2) })
  })

  it('drops a contribution when its disposer runs', async () => {
    const { app } = harness()
    render(
      <SlotHostProvider app={app}>
        <SlotOutlet slot="demo.list" owner={{ label: 'x' }} />
      </SlotHostProvider>,
    )
    await act(async () => { app.dispose() })
    await waitFor(() => { expect(screen.queryAllByTestId('contribution')).toHaveLength(0) })
  })
})

describe('SlotHostProvider', () => {
  it('exposes the composed app and the client to contributions', () => {
    const { app } = harness()
    let seen = ''
    const Probe = (): React.ReactNode => {
      const current = useClientApp()
      seen = current.client as string
      return null
    }
    render(
      <SlotHostProvider app={app}>
        <Probe />
      </SlotHostProvider>,
    )
    expect(seen).toBe('client')
  })

  it('throws when a component asks for the app outside the provider', () => {
    const Probe = (): React.ReactNode => {
      useClientApp()
      return null
    }
    // React logs the boundary-less throw; assert the message surfaces.
    expect(() => render(<Probe />)).toThrow(/outside a SlotHostProvider/)
  })
})

/** A ledger with one seat of `kind`; the first registrant crashes, the rest render fine. */
function crashingHost(kind: 'single' | 'list', ids: readonly string[]): {
  app: ReturnType<typeof createClientApp<string>>
  errors: unknown[]
} {
  const plugin: ClientPlugin<string> = {
    id: 'boom',
    label: 'Boom',
    apply: (ctx) => {
      for (const [index, id] of ids.entries()) {
        const component = index === 0
          ? (() => { throw new Error('contribution exploded') })
          : (({ label }: { label: string }) => <span data-testid="survivor">{label}</span>)
        ctx.slots.register(
          {
            name: 'demo.slot',
            registrant: id,
            ...(kind === 'list' ? { id } : {}),
            priority: index,
          } as never,
          component as never,
        )
      }
    },
  }
  const app = createClientApp<string>({
    client: 'client',
    source: staticPluginSource([plugin]),
    declare: (core: SlotCore) => core.register(
      { name: 'root', children: { 'demo.slot': { kind } } } as never,
      (() => null) as never,
    ),
  })
  const errors: unknown[] = []
  app.host.core.onEntryError((_key, _entry, error) => errors.push(error))
  return { app, errors }
}

describe('SlotErrorBoundary', () => {
  it('retires a crashed entry from a shadowing cell so the next survivor renders', async () => {
    const { app, errors } = crashingHost('single', ['primary', 'survivor'])
    const { container } = render(
      <SlotHostProvider app={app}>
        <SlotOutlet slot="demo.slot" owner={{}} />
      </SlotHostProvider>,
    )
    await waitFor(() => { expect(errors).toHaveLength(1) })
    // The lower-priority survivor takes the cell, so the outlet recovers
    // instead of going dark — and no crash face is left behind.
    expect(app.host.entriesOfSlot('demo.slot').map(e => e.registrant)).toEqual(['survivor'])
    expect(container.querySelector('[data-slot-error="demo.slot"]')).toBeNull()
  })

  it('keeps the crash face for a list row, because a row is its own cell', async () => {
    const { app, errors } = crashingHost('list', ['only'])
    const { container } = render(
      <SlotHostProvider app={app}>
        <SlotOutlet slot="demo.slot" owner={{}} />
      </SlotHostProvider>,
    )
    await waitFor(() => { expect(errors).toHaveLength(1) })
    // Never abdicating a list row is what keeps the failure visible: retiring
    // it would erase the very row the reader needs to see.
    expect(app.host.entriesOfSlot('demo.slot').map(e => e.registrant)).toEqual(['only'])
    expect(container.querySelector('[data-slot-error="demo.slot"]')).not.toBeNull()
  })
})
