/**
 * The application entry: compose the ledger, then render its root seat.
 *
 * Composition is **synchronous**, inside the `useState` initializer, so the
 * very first render already sees a complete ledger. That is what keeps the
 * component tests' `render(<App/>)` + immediate `fireEvent` pattern working —
 * anything asynchronous between mount and interaction would put an await in
 * the middle of every one of them. Everything that needs to be asynchronous
 * (fetching the host's plugin list) happens in `main.tsx` *before* this
 * component exists.
 *
 * `plugins` is the host's enable list. Omitted means "compose everything this
 * bundle has", which is what every existing test gets.
 *
 * @module @teoclub/work-web/app
 */

import { useState, type JSX } from 'react'
import type { WorkApiClient } from './api.ts'
import { createClientApp, SlotHostProvider, SlotOutlet } from './slots/index.ts'
import { declareShellSlots } from './shell-slots.ts'
import { CLIENT_PLUGIN_SOURCE } from './plugins/table.ts'

export function App(props: { client: WorkApiClient; plugins?: readonly string[] }): JSX.Element {
  const [app] = useState(() => createClientApp<WorkApiClient>({
    client: props.client,
    source: CLIENT_PLUGIN_SOURCE,
    declare: declareShellSlots,
    ...(props.plugins === undefined ? {} : { plugins: props.plugins }),
  }))
  return (
    <SlotHostProvider app={app}>
      <SlotOutlet slot="root" owner={{}} />
    </SlotHostProvider>
  )
}

export default App
