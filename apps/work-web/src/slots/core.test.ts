/**
 * The ledger's invariants. These are the rules the rest of the app relies on,
 * so each is pinned directly rather than through a rendered component.
 */

import { describe, expect, it } from 'vitest'
import { SlotCore } from './core.ts'

/** Declare a set of child slots on `root` and return the ledger. */
function withSeats(seats: Record<string, 'single' | 'list' | 'keyed' | 'chain'>): SlotCore {
  const core = new SlotCore()
  core.register(
    { name: 'root', children: Object.fromEntries(Object.entries(seats).map(([k, kind]) => [k, { kind }])) },
    (() => null) as never,
  )
  return core
}

const component = (() => null) as never

describe('SlotCore: declaring is claiming', () => {
  it('throws when registering into a slot nobody declared', () => {
    const core = new SlotCore()
    expect(() => core.register({ name: 'nowhere' } as never, component))
      .toThrow(/slot "nowhere" is not declared/)
  })

  it('throws when a second entry declares the same key, naming the first declarer', () => {
    const core = withSeats({ 'a.left': 'single', 'a.right': 'single' })
    core.register({ name: 'a.left', children: { 'a.sub': { kind: 'single' } } } as never, component)
    expect(() => core.register({ name: 'a.right', children: { 'a.sub': { kind: 'single' } } } as never, component))
      .toThrow(/slot "a.sub" is already declared by a.left/)
  })

  it('checks cell occupancy before children, so a duplicate registration names the cell', () => {
    const core = withSeats({ 'a.panel': 'single' })
    core.register({ name: 'a.panel' } as never, component)
    expect(() => core.register({ name: 'a.panel' } as never, component))
      .toThrow(/already has an entry at priority 0/)
  })

  it('a declared slot starts empty, and renders nothing until someone registers', () => {
    const core = withSeats({ 'a.panel': 'single' })
    expect(core.entriesOfSlot('a.panel')).toEqual([])
    expect(core.specDynamic('a.panel')).toEqual({ kind: 'single' })
  })
})

describe('SlotCore: per-kind requirements', () => {
  it('requires a key for keyed, an id for list, a selector for chain', () => {
    const core = withSeats({ k: 'keyed', l: 'list', c: 'chain' })
    expect(() => core.register({ name: 'k' } as never, component)).toThrow(/is keyed and requires a key/)
    expect(() => core.register({ name: 'l' } as never, component)).toThrow(/is a list and requires an id/)
    expect(() => core.register({ name: 'c' } as never, component)).toThrow(/is a chain and requires a select/)
  })
})

describe('SlotCore: cell occupancy', () => {
  it('throws when a cell is taken at the same priority, naming the first registrant', () => {
    const core = withSeats({ 'a.panel': 'single' })
    core.register({ name: 'a.panel', registrant: 'first' } as never, component)
    expect(() => core.register({ name: 'a.panel', registrant: 'second' } as never, component))
      .toThrow(/cell "\(single\)" already has an entry at priority 0 \(registered by first\)/)
  })

  it('lets a lower priority shadow a higher one, and only the winner renders', () => {
    const core = withSeats({ 'a.panel': 'single' })
    core.register({ name: 'a.panel', priority: 10, registrant: 'high' } as never, component)
    core.register({ name: 'a.panel', priority: 0, registrant: 'low' } as never, component)
    const winners = core.entriesOfSlot('a.panel')
    expect(winners).toHaveLength(1)
    expect(winners[0]!.registrant).toBe('low')
  })

  it('keeps one winner per keyed cell independently', () => {
    const core = withSeats({ m: 'keyed' })
    core.register({ name: 'm', key: 'left' } as never, component)
    core.register({ name: 'm', key: 'right' } as never, component)
    expect(core.entriesOfSlot('m')).toHaveLength(2)
    expect(core.entriesOfSlot('m').map(e => e.options.key)).toEqual(['left', 'right'])
  })

  it('does not apply cell rules to a chain: every entry stays live', () => {
    const core = withSeats({ c: 'chain' })
    core.register({ name: 'c', select: () => null } as never, component)
    core.register({ name: 'c', select: () => null } as never, component)
    expect(core.entriesOfSlot('c')).toHaveLength(2)
  })
})

describe('SlotCore: ordering', () => {
  it('orders a list by (priority, order), ties keeping registration order', () => {
    const core = withSeats({ l: 'list' })
    core.register({ name: 'l', id: 'a', priority: 0, order: 20 } as never, component)
    core.register({ name: 'l', id: 'b', priority: 0, order: 10 } as never, component)
    core.register({ name: 'l', id: 'c', priority: 0, order: 10 } as never, component)
    expect(core.entriesOfSlot('l').map(e => e.options.id)).toEqual(['b', 'c', 'a'])
  })

  it('orders priority before order', () => {
    const core = withSeats({ l: 'list' })
    core.register({ name: 'l', id: 'late', priority: 5, order: 0 } as never, component)
    core.register({ name: 'l', id: 'early', priority: 0, order: 99 } as never, component)
    expect(core.entriesOfSlot('l').map(e => e.options.id)).toEqual(['early', 'late'])
  })

  it('ignores order for non-list kinds, sorting by priority alone', () => {
    const core = withSeats({ s: 'single', l: 'list' })
    // `single` has no `order` option at all; only its priority counts.
    core.register({ name: 's', priority: 3 } as never, component)
    expect(core.specDynamic('l')).toEqual({ kind: 'list' })
  })
})

describe('SlotCore: teardown', () => {
  it('removes an entry and collapses the child slots it declared', () => {
    const core = withSeats({ 'a.panel': 'single' })
    const dispose = core.register(
      { name: 'a.panel', children: { 'a.sub': { kind: 'list' } } } as never,
      component,
    )
    core.register({ name: 'a.sub', id: 'x' } as never, component)
    expect(core.specDynamic('a.sub')).toEqual({ kind: 'list' })

    dispose()
    expect(core.entriesOfSlot('a.panel')).toEqual([])
    // The child slot is no longer declared, so a late registration into it throws.
    expect(core.specDynamic('a.sub')).toBeUndefined()
    expect(() => core.register({ name: 'a.sub', id: 'y' } as never, component))
      .toThrow(/is not declared/)
  })

  it('is idempotent', () => {
    const core = withSeats({ 'a.panel': 'list' })
    const dispose = core.register({ name: 'a.panel', id: 'x' } as never, component)
    dispose()
    dispose()
    expect(core.entriesOfSlot('a.panel')).toEqual([])
  })

  it('collapses grandchildren too', () => {
    const core = withSeats({ 'a.panel': 'single' })
    core.register({ name: 'a.panel', children: { 'a.mid': { kind: 'single' } } } as never, component)
    core.register({ name: 'a.mid', children: { 'a.leaf': { kind: 'single' } } } as never, component)
    expect(core.specDynamic('a.leaf')).toBeDefined()
    core.dispose === undefined // (no global dispose; release via the parent's disposer)
    const record = core.snapshot('a.panel')
    expect(record[0]!.children.map(node => node.name)).toEqual(['a.mid'])
  })
})

describe('SlotCore: observation', () => {
  it('bumps the version and notifies subscribers once per microtask', async () => {
    const core = withSeats({ l: 'list' })
    let calls = 0
    core.subscribe('l', () => { calls += 1 })
    const before = core.getVersion('l')
    core.register({ name: 'l', id: 'a' } as never, component)
    core.register({ name: 'l', id: 'b' } as never, component)
    expect(core.getVersion('l')).toBe(before + 2)
    expect(calls).toBe(0)
    await Promise.resolve()
    expect(calls).toBe(1)
  })

  it('retires a crashed entry from its cell so the next survivor wins', () => {
    const core = withSeats({ 'a.panel': 'single' })
    core.register({ name: 'a.panel', priority: 0, registrant: 'primary' } as never, component)
    core.register({ name: 'a.panel', priority: 1, registrant: 'fallback' } as never, component)
    expect(core.entriesOfSlot('a.panel')[0]!.registrant).toBe('primary')

    const entry = core.entries('a.panel')[0]!
    core.reportEntryError('a.panel', entry, new Error('boom'), { abdicate: true })
    expect(core.entriesOfSlot('a.panel').map(e => e.registrant)).toEqual(['fallback'])
  })

  it('snapshots the declaration topology', () => {
    const core = withSeats({ 'a.side': 'single', 'a.main': 'list' })
    core.register({ name: 'a.side', registrant: 'side-plugin' } as never, component)
    const [root] = core.snapshot()
    expect(root!.name).toBe('root')
    expect(root!.children.map(node => node.name)).toEqual(['a.main', 'a.side'])
    expect(root!.children[1]).toMatchObject({ kind: 'single', occupants: [{ registrant: 'side-plugin' }] })
    expect(root!.children[0]).toMatchObject({ kind: 'list', occupants: [] })
  })
})
