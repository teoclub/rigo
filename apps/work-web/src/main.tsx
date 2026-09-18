/**
 * Rigo Work Web entry (Issue 033): mounts the App over the same-origin API.
 *
 * This module is where the composition fetch lives, and it must stay here
 * rather than inside `App`. Two reasons, both load-bearing:
 *
 *  - `App`'s composition is synchronous (its `useState` initializer), which is
 *    what keeps the component tests' render-then-interact pattern valid. An
 *    await inside `App` would break every one of them.
 *  - the component tests build a real `WorkApiClient` and override methods;
 *    a fetch they did not ask for must not happen behind their backs.
 *
 * A failure to read the composition renders a TEXT failure surface. It does
 * **not** fall back to composing everything: that would quietly enable
 * features the host never composed, which is the one thing host-owned
 * composition exists to prevent.
 *
 * @module @teoclub/work-web/main
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkApiClient } from './api.ts'
import { App } from './app.tsx'
import './styles.css'

const base = '' // same-origin /api/v1 (the Vite dev proxy targets the work host)

async function boot(): Promise<void> {
  const root = document.getElementById('root')
  if (root === null) return
  const client = new WorkApiClient(base)
  try {
    const composition = await client.clientPlugins()
    createRoot(root).render(
      <StrictMode>
        <App client={client} plugins={composition.plugins.map(plugin => plugin.id)} />
      </StrictMode>,
    )
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    createRoot(root).render(
      <div className="boot-error" role="alert" data-testid="bootError">
        Could not read the server&apos;s plugin composition: {message}
      </div>,
    )
  }
}

void boot()
