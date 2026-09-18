/**
 * The slot contract: every key in one place, merged into the kit's empty
 * `SlotMap`.
 *
 * Declaration merging is what makes a slot a *contract* rather than a string:
 * a contribution's owner props are checked against the declaration, and a key
 * that nobody declared cannot be registered into at all. Keeping them in one
 * file (rather than beside each owner) is deliberate — the whole seat list is
 * readable in one screen, which is the point at this size.
 *
 * The seats are all **additive**: a contribution renders after whatever the
 * declaring owner renders itself, so none of them can displace built-in
 * content. See `slots/core.ts` for why that simplification was chosen.
 *
 * @module @teoclub/work-web/slot-map
 */

import type { PropsRenderSlots } from './slots/core.ts'
import type { ApprovalRecord, ApprovalResolveResult, WorkApiClient } from './api.ts'
import type { StreamViewModel } from './events.ts'

/** Props the shell passes to anything contributing to the top banner strip. */
export interface BannerOwner {
  /** The shell's own notice text; empty when there is nothing to announce. */
  notice: string
}

/** Props for overlay surfaces raised above the whole shell (dialogs and the like). */
export interface OverlayOwner {
  /** The open session, or `undefined` on the home surface. */
  session: { sessionId: string; providerId?: string; modelId?: string; title?: string } | undefined
  client: WorkApiClient
  values: { providerId: string; modelId: string; workspaceRoot: string; title: string }
  onValuesChange(values: { providerId: string; modelId: string; workspaceRoot: string; title: string }): void
}

/** Props for anything added to the chat's right rail, after the built-in panels. */
export interface ChatRailOwner {
  view: StreamViewModel
}

/**
 * Props for the approvals surface.
 *
 * The chat view owns the stream that produces the pending list, so it supplies
 * the list and the resolve callback rather than the contribution reaching for
 * state it cannot see. That keeps the contribution a pure renderer and is why
 * this kit needs no store.
 */
export interface ChatApprovalsOwner {
  sessionId: string
  client: WorkApiClient
  approvals: ApprovalRecord[]
  onResolved: (result: ApprovalResolveResult) => void
}

/** Props for a section contributed to the settings dialog. */
export interface SettingsSectionOwner {
  client: WorkApiClient
}

/** Props for controls added to the composer row. */
export interface ChatComposerOwner {
  sessionId: string
  client: WorkApiClient
}

declare module './slots/core.ts' {
  interface SlotMap {
    'app.banner': { kind: 'list'; owner: BannerOwner }
    'shell.overlay': { kind: 'list'; owner: OverlayOwner }
    'chat.rail': { kind: 'list'; owner: ChatRailOwner }
    'chat.approvals': { kind: 'list'; owner: ChatApprovalsOwner }
    'chat.composer.bar': { kind: 'list'; owner: ChatComposerOwner }
    'settings.section': { kind: 'list'; owner: SettingsSectionOwner }
  }
}

/** Every seat the shell declares, and the only keys a contribution may target today. */
export type ShellSlotKey = keyof import('./slots/core.ts').SlotMap & string

/** The `renderSlot` the shell threads down to render sites that are not the declarer. */
export type ShellRenderSlot = PropsRenderSlots<ShellSlotKey>['renderSlot']
