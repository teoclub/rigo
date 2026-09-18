/**
 * `work.approvals` — the approvals panel, as a contribution.
 *
 * The panel itself is the same component the chat used to render inline; what
 * changed is who puts it there. The chat view knows the pending list (it owns
 * the SSE stream that produces it) and hands it down as owner props, so the
 * contribution stays a pure renderer and no store has to survive remounts.
 *
 * Removing this plugin from the host's composition removes the panel. That is
 * the point of host-owned composition, and it is also why the panel's being
 * present is now something the host asserts rather than something the shell
 * hard-codes.
 *
 * @module @teoclub/work-web/plugins/approvals
 */

import type { JSX } from 'react'
import { ApprovalsPanel } from '../components.tsx'
import type { WorkClientContext, WorkClientPlugin } from './types.ts'

/** Owner props supplied by the chat view; mirrors what the panel already took. */
interface ApprovalsProps {
  sessionId: string
  client: WorkClientContext['client']
  approvals: Parameters<typeof ApprovalsPanel>[0]['approvals']
  onResolved: Parameters<typeof ApprovalsPanel>[0]['onResolved']
}

function ApprovalsContribution({ client, approvals, onResolved }: ApprovalsProps): JSX.Element {
  return <ApprovalsPanel approvals={approvals} client={client} onResolved={onResolved} />
}

export const approvalsPlugin: WorkClientPlugin = {
  id: 'work.approvals',
  label: 'Approvals',
  apply: (ctx) => {
    ctx.effect(ctx.slots.register(
      { name: 'chat.approvals', id: 'panel', order: 0, registrant: 'work.approvals' },
      ApprovalsContribution as never,
    ))
  },
}
