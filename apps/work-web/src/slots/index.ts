/**
 * The contribution kit: ledger, composition host, and React binding.
 *
 * Written to be lifted into its own package unchanged — it imports nothing
 * from the rest of the app (only React types and its own modules), and its
 * client type is a parameter rather than a concrete API client.
 *
 * @module @teoclub/work-web/slots
 */

export * from './core.ts'
export * from './host.ts'
export * from './react.tsx'
