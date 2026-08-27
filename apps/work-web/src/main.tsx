/**
 * Rigo Work Web entry (Issue 033): mounts the App over the same-origin API.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkApiClient } from './api.ts'
import { App } from './components.tsx'

const base = '' // same-origin /api/v1 (the Vite dev proxy targets the work host)
const root = document.getElementById('root')
if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <App client={new WorkApiClient(base)} />
    </StrictMode>,
  )
}
