/**
 * The shell's seat declaration.
 *
 * This single `register` call is the whole shell contract: it occupies `root`
 * and, in the same `children` table, declares every seat a contribution may
 * target. Because it runs before any plugin is composed, no contribution can
 * ever race a declaration — which is why the kit needs no declaration-waiting
 * API at this size.
 *
 * @module @teoclub/work-web/shell-slots
 */

import type { SlotCore } from './slots/index.ts'
import { WorkShell } from './plugins/shell.tsx'

/**
 * Declare the shell seats and occupy `root` with the shell component.
 * @param core - the ledger to declare into.
 * @returns a disposer releasing the shell entry and collapsing every seat.
 */
export function declareShellSlots(core: SlotCore): () => void {
  return core.register(
    {
      name: 'root',
      registrant: 'work.shell',
      children: {
        'app.banner': { kind: 'list' },
        'shell.overlay': { kind: 'list' },
        'chat.rail': { kind: 'list' },
        'chat.approvals': { kind: 'list' },
        'chat.composer.bar': { kind: 'list' },
        'settings.section': { kind: 'list' },
      },
    },
    WorkShell as never,
  )
}
