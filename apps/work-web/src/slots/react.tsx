/**
 * The React binding: provider, hooks, and the one slot outlet.
 *
 * The outlet is the whole renderer. It emits a layout-neutral anchor
 * (`display: contents`) around whatever the kind dispatch resolves to — an
 * anchor that is present for the empty, fallback and crash states alike, so it
 * never flickers with registration churn and gives CSS and tests a stable
 * target (`[data-slot="…"]`, `[data-slot-error="…"]`).
 *
 * Only this module touches React state subscription; `core.ts` stays
 * framework-free and `host.ts` stays React-free. A crashing contribution is
 * contained by an error boundary keyed on the entry, and for shadowing kinds
 * the entry abdicates so the cell falls through to its next survivor instead
 * of wedging.
 *
 * @module @teoclub/work-web/slots/react
 */

import {
  Component,
  Fragment,
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { SlotKey, StoredEntry } from './core.ts'
import type { ClientApp } from './host.ts'

const SlotAppContext = createContext<ClientApp | null>(null)

export function SlotHostProvider(props: { app: ClientApp; children: ReactNode }): ReactNode {
  return <SlotAppContext.Provider value={props.app}>{props.children}</SlotAppContext.Provider>
}

/** The composed application. Throws outside the provider — a wiring bug, not a state. */
export function useClientApp(): ClientApp {
  const app = useContext(SlotAppContext)
  if (app === null) throw new Error('useClientApp() outside a SlotHostProvider')
  return app
}

/** The same-origin API client, for contributions that need to call the host. */
export function useApiClient<C>(): C {
  return useClientApp().client as C
}

/** True when a provider is installed; lets a component choose between a bare and a composed render. */
export function useHasSlotHost(): boolean {
  return useContext(SlotAppContext) !== null
}

export interface SlotOutletProps {
  slot: SlotKey
  /** Props the declaring owner passes at this render site. */
  owner: object
  /** Which cell to render, for `keyed` slots. */
  entryKey?: string | undefined
  /** Rendered when the slot is declared but has no live entry. */
  fallback?: ReactNode
}

/**
 * Render a slot into a layout-neutral anchor.
 *
 * `null` when no provider is installed (a bare component test renders no
 * extensions) or when the slot is undeclared (a declaring owner may simply be
 * unmounted) — both are ordinary states, not errors.
 */
export function SlotOutlet(props: SlotOutletProps): ReactNode {
  const app = useContext(SlotAppContext)
  if (app === null) return null
  return <SlotOutletLive app={app} {...props} />
}

/**
 * The subscribing half. Split from `SlotOutlet` so `useSyncExternalStore` is
 * never behind a conditional return: hooks run in the same order on every
 * render of this component.
 */
function SlotOutletLive({ app, slot, owner, entryKey, fallback }: SlotOutletProps & { app: ClientApp }): ReactNode {
  useSyncExternalStore(
    (onChange) => app.host.subscribe(slot, onChange),
    () => app.host.getVersion(slot),
  )
  return (
    <div data-slot={slot} style={{ display: 'contents' }}>
      {renderOutletContent(app, slot, owner, entryKey, fallback)}
    </div>
  )
}

function renderOutletContent(
  app: ClientApp,
  slot: SlotKey,
  owner: object,
  entryKey: string | undefined,
  fallback: ReactNode,
): ReactNode {
  const spec = app.host.specOf(slot)
  if (spec === undefined) return null
  const entries = app.host.entriesOfSlot(slot)
  const empty = fallback ?? null

  switch (spec.kind) {
    case 'single': {
      const entry = entries[0]
      return entry === undefined ? empty : withBoundary(app, slot, entry, owner)
    }
    case 'keyed': {
      const entry = entries.find(candidate => candidate.options.key === entryKey)
      return entry === undefined ? empty : withBoundary(app, slot, entry, owner)
    }
    case 'list': {
      if (entries.length === 0) return empty
      // Keyed by entry identity, not by id: a disposed id can be reused, and a
      // reused key would let a fresh row inherit a predecessor's failed boundary.
      return entries.map(entry => <Fragment key={entry.uid}>{withBoundary(app, slot, entry, owner)}</Fragment>)
    }
    case 'chain': {
      // A chain is a takeover: the first entry whose selector returns non-null
      // wins and receives the matched value. A throwing selector degrades to a
      // decline, never a blackout — the selector runs before its entry's
      // boundary exists, so it has nowhere else to fail to.
      for (const entry of entries) {
        const select = entry.select as ((owner: object) => unknown) | undefined
        if (select === undefined) continue
        let matched: unknown
        try {
          matched = select(owner)
        } catch (error) {
          console.error(`slot "${slot}": chain selector threw`, error)
          continue
        }
        if (matched === null || matched === undefined) continue
        return withBoundary(app, slot, entry, owner, { matched })
      }
      return empty
    }
    default:
      return empty
  }
}

function withBoundary(
  app: ClientApp,
  slot: SlotKey,
  entry: StoredEntry,
  owner: object,
  extra: Record<string, unknown> = {},
): ReactNode {
  return (
    <SlotErrorBoundary key={entry.uid} slot={slot} entry={entry} onError={app.host.reportEntryError}>
      {createElement(entry.component as never, {
        ...owner,
        ...extra,
        renderSlot: makeRenderSlot(),
      } as never)}
    </SlotErrorBoundary>
  )
}

/**
 * The `renderSlot` handed to a declaring entry. It returns an element rather
 * than rendering inline, so a child slot mounts as its own component with its
 * own subscription.
 */
function makeRenderSlot() {
  return (key: SlotKey, owner: object, opts?: { entryKey?: string; fallback?: ReactNode }): ReactNode => (
    <SlotOutlet slot={key} owner={owner} entryKey={opts?.entryKey} fallback={opts?.fallback} />
  )
}

interface BoundaryProps {
  slot: SlotKey
  entry: StoredEntry
  onError: (key: SlotKey, entry: StoredEntry, error: unknown) => void
  children: ReactNode
}

interface BoundaryState { failed: boolean }

/**
 * Containment for one contribution. A crash renders a text crash face and
 * retires the entry from its cell, so a shadowing slot falls through to its
 * next survivor instead of going dark.
 */
export class SlotErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(this.props.slot, this.props.entry, error)
  }

  override render(): ReactNode {
    if (this.state.failed) return <div data-slot-error={this.props.slot} />
    return this.props.children
  }
}
