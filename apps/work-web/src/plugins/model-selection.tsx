/**
 * `work.model-selection` — a provider·model selector in the composer row.
 *
 * The second proof of the mechanism, and the one that shows a contribution can
 * change the host's state rather than only reading it: picking a model writes
 * the host's session defaults through the same endpoint `work.settings` edits,
 * so both surfaces stay consistent without knowing about each other.
 *
 * Its test ids are a fresh `composerModel*` namespace — the composer already
 * owns `messageInput`, `sendButton` and `abortButton`.
 *
 * @module @teoclub/work-web/plugins/model-selection
 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import type { SessionDefaults } from '@teoclub/api-wire'
import type { WorkClientContext, WorkClientPlugin } from './types.ts'

export function ModelSelect({ client }: { client: WorkClientContext['client'] }): JSX.Element {
  const [values, setValues] = useState<SessionDefaults | undefined>(undefined)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void client.sessionDefaults()
      .then((loaded) => { if (!cancelled) setValues(loaded) })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'unavailable')
      })
    return () => { cancelled = true }
  }, [client])

  const select = useCallback((key: 'providerId' | 'modelId', value: string): void => {
    setValues(current => (current === undefined ? current : { ...current, [key]: value }))
    setError('')
    void client.saveSessionDefaults({ [key]: value }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'save failed')
    })
  }, [client])

  if (error.length > 0) {
    return <span className="composer-model composer-model--error" data-testid="composerModelError" role="status">{error}</span>
  }
  if (values === undefined) return <></>

  return (
    <span className="composer-model" data-testid="composerModel">
      <input
        className="input input--compact"
        data-testid="composerModelProvider"
        aria-label="Provider"
        value={values.providerId}
        placeholder="provider"
        onChange={(event) => select('providerId', event.target.value)}
      />
      <span aria-hidden="true">·</span>
      <input
        className="input input--compact"
        data-testid="composerModelId"
        aria-label="Model"
        value={values.modelId}
        placeholder="model"
        onChange={(event) => select('modelId', event.target.value)}
      />
    </span>
  )
}

export const modelSelectionPlugin: WorkClientPlugin = {
  id: 'work.model-selection',
  label: 'Model selection',
  apply: (ctx) => {
    ctx.effect(ctx.slots.register(
      { name: 'chat.composer.bar', id: 'model', order: 0, registrant: 'work.model-selection' },
      ModelSelect as never,
    ))
  },
}
