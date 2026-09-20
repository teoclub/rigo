/**
 * The newest user-sourced message the agent loop claimed for a turn.
 *
 * Retrieval runs during turn assembly, at a point where the input that started
 * the turn is no longer PENDING: the loop drains it out of the inbox
 * (`agent/inbox/spliced` with `removedCount`) and only writes the matching
 * `user/message` event later in the step. The agent-loop's `inbox` unit keeps
 * exactly the pending remainder, so its state is empty precisely when
 * retrieval needs the question. This unit folds the same splices and RETAINS
 * the newest user-sourced insertion, which is the question the turn is
 * answering.
 *
 * @module @teoclub/work-context/last-user-input
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@teoclub/harness-session-projection'
import type {} from '@teoclub/harness-agent'

/**
 * State of the `lastUserInput` unit: the retained text, empty before any claim.
 * The empty string is the "nothing claimed yet" value rather than an absent
 * property so the fold state stays a plain required field, which is what the
 * projection cache persists.
 */
export interface LastUserInputState {
  readonly text: string
}

/** Wire validation for the retained input. */
export const lastUserInputSchema = z.object({ text: z.string() }).readonly()

/** Standard fold retaining the newest user-sourced inbox insertion. */
export const lastUserInputProjection = {
  key: 'lastUserInput',
  stateSchema: lastUserInputSchema,
  init: (): LastUserInputState => ({ text: '' }),
  apply(state: LastUserInputState, event) {
    if (event.type !== 'agent/inbox/spliced') return state
    const inserted = event.data.inserted
    if (inserted === undefined || inserted.length === 0) return state
    // A drain inserts nothing and must leave the retained claim alone; an
    // enqueue of several messages retains the last user-sourced one.
    let text: string | undefined
    for (const message of inserted) {
      if (message.source?.kind !== 'user') continue
      const joined = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join('')
      if (joined.trim().length > 0) text = joined
    }
    return text === undefined ? state : { text }
  },
  stateVersion: 1,
} satisfies ProjectionDefinition<'lastUserInput', LastUserInputState>

declare module '@teoclub/harness-session-projection/types' {
  interface SessionProjectionStateMap {
    /** The newest user-sourced inbox insertion, retained across the claim. */
    lastUserInput: LastUserInputState
  }
}
