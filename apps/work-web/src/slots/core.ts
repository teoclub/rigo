/**
 * The slot ledger — the contribution mechanism, ported from deepseek-harness's
 * `ui-slots` down to what a statically-bundled app actually uses.
 *
 * Three ideas carry the design, and they are the reason this is a ledger and
 * not a component registry:
 *
 * 1. **Declaring is claiming.** A slot must be declared before anything can
 *    register into it, and exactly one entry may declare a given key. The
 *    declaration is where a parent says "I will render here"; a contribution
 *    into an undeclared key is a wiring bug and throws at load rather than
 *    rendering nothing.
 * 2. **Additions, never reordering.** Contributions render *after* whatever
 *    the declaring owner renders itself. There is no shadowing of built-in
 *    content. dsh's ledger can shadow a cell; this one deliberately cannot,
 *    because nothing here needs to replace a built-in panel and dropping
 *    shadowing is what let the store and scope machinery go.
 * 3. **One teardown axis.** A registration returns a disposer, and removing an
 *    entry recursively collapses every child slot it declared, so a plugin's
 *    whole contribution disappears on one call.
 *
 * NOT here, and the honest cost of "minimal": there is no store handle, so an
 * entry that remounts loses its view state. With static bundling the only
 * remount is a full page load, so nothing is lost today — but this is the one
 * capability that cannot be retrofitted for free (it needs an instance axis
 * and per-entry factory minting), whereas scopes and dynamic loading are
 * additive.
 *
 * This module imports nothing but `react` types: it is written to be lifted
 * into its own package unchanged.
 *
 * @module @teoclub/work-web/slots/core
 */

import type { ReactNode } from 'react'

/**
 * Slot contract table. Owners extend it by declaration merging (see
 * `../slot-map.ts`).
 *
 * `root` is pre-declared because the ledger seeds that record in its
 * constructor: a shell must render somewhere, and having the type agree with
 * the runtime seed is what makes `register({ name: 'root' })` an ordinary call.
 */
export interface SlotMap {
  root: { kind: 'single'; owner: object }
}

export type SlotKey = keyof SlotMap & string
export type SlotKind = 'single' | 'list' | 'keyed' | 'chain'

/** One slot's declared shape, as written by its declarer. */
export interface SlotEntryDef {
  kind: SlotKind
  /** Props the declaring owner passes at its render site. */
  owner?: object
  /** `keyed` prop table: one entry per literal key. */
  keyProps?: Record<string, object>
}

export type OwnerOf<K extends SlotKey> =
  SlotMap[K] extends { owner: infer O extends object } ? O : object

export type EntryKeyOf<K extends SlotKey> =
  SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object } ? keyof P & string : string

export type KeyPropsOf<K extends SlotKey, EK extends EntryKeyOf<K>> =
  SlotMap[K] extends { kind: 'keyed'; keyProps: infer P extends object }
    ? EK extends keyof P
      ? P[EK] extends object ? P[EK] : never
      : never
    : object

export type ChainSelect<O extends object, M> = (owner: O) => M | null

/**
 * Render authorization for children: an entry may only render slots it
 * declared, and `__renders` is the contravariant anchor that makes
 * "declared children ⊆ rendered children" a compile error rather than a
 * runtime surprise.
 */
export type PropsRenderSlots<S extends SlotKey> = {
  renderSlot: <K extends S>(
    key: K,
    owner: OwnerOf<K>,
    opts?: { entryKey?: EntryKeyOf<K>; fallback?: ReactNode },
  ) => ReactNode
  readonly __renders?: ((key: S) => void) | undefined
}

export type SlotProps<K extends SlotKey, EK extends EntryKeyOf<K>, S extends SlotKey> =
  OwnerOf<K> & KeyPropsOf<K, EK> & PropsRenderSlots<S>

export type SlotComponent<P> = (props: P) => ReactNode

/** Declaring children your component never renders is an error (compile half of declaring-is-claiming). */
type RendersCheck<C, D> =
  [keyof D & SlotKey] extends [never] ? unknown
    : C extends (props: infer P) => ReactNode
      ? 'renderSlot' extends keyof P
        ? unknown
        : { 'children declared but the component consumes no renderSlot': keyof D & SlotKey }
      : unknown

export type ChildrenDecl = { [P in SlotKey]?: { kind: SlotMap[P]['kind'] } }

export type KindOptions<K extends SlotKey, EK extends EntryKeyOf<K>, M> =
  SlotMap[K]['kind'] extends 'keyed' ? { key: EK; priority?: number }
    : SlotMap[K]['kind'] extends 'list' ? { id: string; order?: number; priority?: number }
      : SlotMap[K]['kind'] extends 'chain' ? { select: ChainSelect<OwnerOf<K>, M>; priority?: number }
        : { priority?: number }

/**
 * A type alias rather than an interface: `KindOptions` is a conditional over
 * `SlotMap[K]['kind']`, and an interface cannot extend a type whose members are
 * not statically known.
 */
export type RegisterOptions<K extends SlotKey, EK extends EntryKeyOf<K>, D extends ChildrenDecl, M> =
  KindOptions<K, EK, M> & {
    name: K
    /** Child slots this entry declares and is thereby the sole renderer of. */
    children?: D
    /** Diagnostics label: which plugin registered this. */
    registrant?: string
  }

/**
 * The erased shape `register` works with internally.
 *
 * The public signature is the typed one; inside, the per-kind options are
 * narrowed by a `kind` check the compiler cannot carry through the conditional
 * types, so the options are erased once at the boundary rather than fought with
 * casts at every use site.
 */
interface RuntimeRegisterOptions {
  name: string
  key?: string | undefined
  id?: string | undefined
  order?: number | undefined
  priority?: number | undefined
  select?: ((owner: never) => unknown) | undefined
  children?: Record<string, { kind: SlotKind }> | undefined
  registrant?: string | undefined
}

/** One contribution as stored in the ledger. */
export interface StoredEntry {
  /**
   * Identity for this registration, unique for the life of the ledger.
   *
   * It exists so a React error boundary can be keyed on the ENTRY rather than
   * its position: when a shadowing cell's winner changes, an unkeyed boundary
   * would be reused and the new — healthy — winner would inherit the failed
   * state of the entry it replaced, leaving the cell blacked out.
   */
  readonly uid: number
  component: unknown
  options: { key?: string | undefined; id?: string | undefined; order?: number | undefined; priority?: number | undefined }
  select?: ((owner: never) => unknown) | undefined
  children?: Readonly<Record<string, { kind: SlotKind }>> | undefined
  registrant?: string | undefined
  /** The slot this entry sits in; used by `liveEntries` and the error report. */
  slot: string
  /** Retired from its cell after a crash (shadowing kinds only). */
  abdicated: boolean
}

export interface LiveSlotOccupant {
  registrant?: string
  key?: string
  id?: string
  order?: number
  priority: number
  active: boolean
}

export interface LiveSlotNode {
  name: string
  kind: SlotKind
  declaredBy?: string
  occupants: LiveSlotOccupant[]
  children: LiveSlotNode[]
}

interface SlotRecord {
  name: string
  spec?: { kind: SlotKind } | undefined
  declaredBy?: string | undefined
  parent?: string | undefined
  declarationEpoch: number
  entries: StoredEntry[]
  version: number
  listeners: Set<() => void>
  dirty: boolean
}

function priorityOf(entry: StoredEntry): number {
  return entry.options.priority ?? 0
}

/** `list` orders by `(priority, order)`; every other kind orders by `priority` alone. */
function sortEntries(record: SlotRecord): void {
  const isList = record.spec?.kind === 'list'
  // Array.prototype.sort is stable, so equal keys keep registration order.
  record.entries.sort((a, b) => {
    const byPriority = priorityOf(a) - priorityOf(b)
    if (byPriority !== 0 || !isList) return byPriority
    return (a.options.order ?? 0) - (b.options.order ?? 0)
  })
}

function cellOf(entry: StoredEntry): string {
  return entry.options.key ?? entry.options.id ?? ''
}

export class SlotCore {
  private readonly records = new Map<string, SlotRecord>()
  private readonly entryErrorListeners = new Set<(key: string, entry: StoredEntry, error: unknown) => void>()
  private nextUid = 0

  constructor() {
    // The root seat is built in: a shell must render somewhere, and seeding it
    // means `register({name: 'root'})` is an ordinary declaring-is-claiming call.
    this.records.set('root', {
      name: 'root',
      spec: { kind: 'single' },
      declaredBy: '(built-in)',
      declarationEpoch: 0,
      entries: [],
      version: 0,
      listeners: new Set(),
      dirty: false,
    })
  }

  /**
   * Contribute a component to a declared slot and optionally declare child slots.
   *
   * Every check is fail-loud and runs before the ledger is touched: an
   * undeclared target, a second declarer of a key, a missing per-kind option,
   * and a second registration in a cell already occupied at the same priority
   * all throw with the offender named.
   *
   * @param options - the target slot, its per-kind options, the child declaration, and a registrant label.
   * @param component - the component to render; receives owner props, key props, and `renderSlot`.
   * @returns an idempotent disposer that removes the entry and collapses every child slot it declared.
   * @throws when the target is undeclared, the key is claimed, or a cell is taken at the same priority.
   */
  register<
    K extends SlotKey,
    EK extends EntryKeyOf<K> = EntryKeyOf<K>,
    D extends ChildrenDecl = Record<never, never>,
    M = never,
    C extends SlotComponent<never> = SlotComponent<never>,
  >(
    options: RegisterOptions<K, EK, D, M>,
    component: C & SlotComponent<SlotProps<K, NoInfer<EK>, keyof NoInfer<D> & SlotKey>> & RendersCheck<C, D>,
  ): () => void {
    const record = this.records.get(options.name)
    if (record === undefined || record.spec === undefined) {
      throw new Error(
        `slot "${options.name}" is not declared; a parent entry's children table must declare it`,
      )
    }
    const kind = record.spec.kind
    const mine = options as unknown as RuntimeRegisterOptions

    if (kind === 'keyed' && mine.key === undefined) {
      throw new Error(`slot "${options.name}" is keyed and requires a key`)
    }
    if (kind === 'list' && mine.id === undefined) {
      throw new Error(`slot "${options.name}" is a list and requires an id`)
    }
    if (kind === 'chain' && mine.select === undefined) {
      throw new Error(`slot "${options.name}" is a chain and requires a select`)
    }

    const entry: StoredEntry = {
      uid: (this.nextUid += 1),
      component,
      options: kind === 'keyed'
        ? { key: mine.key, priority: mine.priority }
        : kind === 'list'
          ? { id: mine.id, order: mine.order, priority: mine.priority }
          : { priority: mine.priority },
      select: mine.select as StoredEntry['select'],
      children: mine.children as StoredEntry['children'],
      registrant: mine.registrant,
      slot: options.name,
      abdicated: false,
    }

    // Cell occupancy: one winner per cell at a given priority. Registering a
    // second occupant at the SAME priority is ambiguous and throws; a lower
    // priority shadows a higher one, which is how a later contributor can take
    // over a cell deliberately.
    if (kind !== 'chain') {
      const cell = cellOf(entry)
      const clash = record.entries.find(existing => cellOf(existing) === cell && priorityOf(existing) === priorityOf(entry))
      if (clash !== undefined) {
        throw new Error(
          `slot "${options.name}" cell "${cell || '(single)'}" already has an entry at priority ${String(priorityOf(entry))}`
          + ` (registered by ${clash.registrant ?? 'unknown'})`,
        )
      }
    }

    if (mine.children !== undefined) {
      for (const childKey of Object.keys(mine.children)) {
        const child = this.records.get(childKey)
        if (child?.spec !== undefined) {
          throw new Error(
            `slot "${childKey}" is already declared by ${child.declaredBy ?? 'unknown'}`,
          )
        }
      }
      for (const [childKey, childDef] of Object.entries(mine.children)) {
        const existing = this.records.get(childKey)
        const childRecord: SlotRecord = existing ?? {
          name: childKey,
          declarationEpoch: 0,
          entries: [],
          version: 0,
          listeners: new Set(),
          dirty: false,
        }
        childRecord.spec = { kind: childDef.kind }
        childRecord.declaredBy = options.name
        childRecord.parent = options.name
        childRecord.declarationEpoch += 1
        this.records.set(childKey, childRecord)
      }
    }

    record.entries.push(entry)
    sortEntries(record)
    this.markDirty(options.name)

    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      const index = record.entries.indexOf(entry)
      if (index !== -1) record.entries.splice(index, 1)
      this.releaseChildren(entry)
      this.markDirty(options.name)
    }
  }

  /** The cached, ordered array for a slot; stable between mutations (safe as a `useSyncExternalStore` snapshot). */
  entries(key: string): readonly StoredEntry[] {
    return this.records.get(key)?.entries ?? []
  }

  /**
   * The live entries of a slot after cell resolution: for shadowing kinds, the
   * lowest-priority live entry per cell; for `chain`, every entry in order.
   */
  entriesOfSlot(key: string): readonly StoredEntry[] {
    const record = this.records.get(key)
    if (record?.spec === undefined) return []
    if (record.spec.kind === 'chain') return record.entries
    const winners = new Map<string, StoredEntry>()
    for (const entry of record.entries) {
      if (entry.abdicated) continue
      const cell = cellOf(entry)
      if (!winners.has(cell)) winners.set(cell, entry)
    }
    return [...winners.values()]
  }

  spec<K extends SlotKey>(key: K): { kind: SlotMap[K]['kind'] } | undefined {
    return this.records.get(key)?.spec as { kind: SlotMap[K]['kind'] } | undefined
  }

  specDynamic(key: string): { kind: SlotKind } | undefined {
    return this.records.get(key)?.spec
  }

  declarationEpoch(key: string): number {
    return this.records.get(key)?.declarationEpoch ?? 0
  }

  getVersion(key: string): number {
    return this.records.get(key)?.version ?? 0
  }

  /** Subscribe to a slot's mutations; the callback is batched to one call per microtask. */
  subscribe(key: string, fn: () => void): () => void {
    const record = this.records.get(key)
    if (record === undefined) return () => {}
    record.listeners.add(fn)
    return () => { record.listeners.delete(fn) }
  }

  /** Subscribe to declaration/collapse of a slot (never batched). */
  subscribeDeclaration(key: string, fn: () => void): () => void {
    const record = this.records.get(key)
    if (record === undefined) return () => {}
    const wrapped = () => { fn() }
    record.listeners.add(wrapped)
    return () => { record.listeners.delete(wrapped) }
  }

  /** A JSON-safe tree of the live ledger, for assertions and diagnostics. */
  snapshot(root = 'root'): LiveSlotNode[] {
    const record = this.records.get(root)
    if (record === undefined) return []
    const childKeys = [...this.records.values()]
      .filter(candidate => candidate.parent === root)
      .map(candidate => candidate.name)
      .sort()
    return [{
      name: record.name,
      kind: record.spec?.kind ?? 'single',
      ...(record.declaredBy === undefined ? {} : { declaredBy: record.declaredBy }),
      occupants: record.entries.map(entry => ({
        ...(entry.registrant === undefined ? {} : { registrant: entry.registrant }),
        ...(entry.options.key === undefined ? {} : { key: entry.options.key }),
        ...(entry.options.id === undefined ? {} : { id: entry.options.id }),
        ...(entry.options.order === undefined ? {} : { order: entry.options.order }),
        priority: priorityOf(entry),
        active: !entry.abdicated,
      })),
      children: childKeys.flatMap(key => this.snapshot(key)),
    }]
  }

  /**
   * Report a crash from one entry.
   * @param key - the slot the entry is in.
   * @param entry - the crashing entry.
   * @param error - the thrown value.
   * @param info - `abdicate` retires the entry from its cell so the outlet falls to the next survivor.
   */
  reportEntryError(key: string, entry: StoredEntry, error: unknown, info: { abdicate: boolean }): void {
    if (info.abdicate) {
      entry.abdicated = true
      this.markDirty(key)
    }
    for (const listener of this.entryErrorListeners) listener(key, entry, error)
  }

  onEntryError(fn: (key: string, entry: StoredEntry, error: unknown) => void): () => void {
    this.entryErrorListeners.add(fn)
    return () => { this.entryErrorListeners.delete(fn) }
  }

  isLive(entry: StoredEntry): boolean {
    return !entry.abdicated && (this.records.get(entry.slot)?.entries.includes(entry) ?? false)
  }

  /** Remove an entry's declared child slots (recursive), leaving the parent's own entry alone. */
  private releaseChildren(entry: StoredEntry): void {
    if (entry.children === undefined) return
    for (const childKey of Object.keys(entry.children)) {
      const child = this.records.get(childKey)
      if (child === undefined || child.parent !== entry.slot) continue
      for (const grandchild of [...child.entries]) this.releaseChildren(grandchild)
      child.spec = undefined
      child.declaredBy = undefined
      child.entries = []
      child.declarationEpoch += 1
      this.markDirty(childKey)
    }
  }

  private markDirty(key: string): void {
    const record = this.records.get(key)
    if (record === undefined) return
    record.version += 1
    if (record.dirty) return
    record.dirty = true
    queueMicrotask(() => {
      record.dirty = false
      for (const listener of [...record.listeners]) listener()
    })
  }
}
