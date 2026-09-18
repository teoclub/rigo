/**
 * `work.settings` — host-side session defaults, edited as a settings section.
 *
 * This is the first real proof of the mechanism: the plugin is not imported by
 * anything. It appears because the host declared `work.settings` and the shell
 * declared a `settings.section` seat, and it disappears the same way. Nothing
 * in the shell knows it exists.
 *
 * It also demonstrates the intended split — the state lives on the HOST (one
 * JSON document under the Rigo home, reachable by any surface) and the
 * contribution is only its editor.
 *
 * Every test id here is in a fresh `host*` namespace: the dialog already owns
 * `provider`, `model`, `workspaceRoot` and `title`, and a duplicate would break
 * the pinned component contract.
 *
 * @module @teoclub/work-web/plugins/settings
 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import type { SessionDefaults } from '@teoclub/api-wire'
import type { WorkClientContext, WorkClientPlugin } from './types.ts'

const EMPTY: SessionDefaults = { providerId: '', modelId: '', workspaceRoot: '', title: '' }

export function SettingsSection({ client }: { client: WorkClientContext['client'] }): JSX.Element {
  const [values, setValues] = useState<SessionDefaults>(EMPTY)
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void client.sessionDefaults()
      .then((loaded) => { if (!cancelled) setValues(loaded) })
      .catch((cause: unknown) => {
        if (!cancelled) setStatus(cause instanceof Error ? cause.message : 'Could not load host settings.')
      })
    return () => { cancelled = true }
  }, [client])

  const update = useCallback((key: keyof SessionDefaults, value: string): void => {
    setValues(current => ({ ...current, [key]: value }))
  }, [])

  const save = useCallback((): void => {
    setSaving(true)
    setStatus('')
    void client.saveSessionDefaults(values)
      .then((saved) => { setValues(saved); setStatus('Saved.') })
      .catch((cause: unknown) => {
        setStatus(cause instanceof Error ? cause.message : 'Could not save host settings.')
      })
      .finally(() => { setSaving(false) })
  }, [client, values])

  return (
    <section className="settings-section" aria-label="Host settings">
      <h3 className="settings-section-head">Session defaults (stored by the host)</h3>
      <p className="settings-section-hint">
        These are kept by the server, so any surface reads the same values.
      </p>
      <label className="field" htmlFor="hostProvider">
        <span className="field-label">Provider</span>
        <input
          id="hostProvider"
          data-testid="hostProvider"
          className="input"
          value={values.providerId}
          onChange={(event) => update('providerId', event.target.value)}
        />
      </label>
      <label className="field" htmlFor="hostModel">
        <span className="field-label">Model</span>
        <input
          id="hostModel"
          data-testid="hostModel"
          className="input"
          value={values.modelId}
          onChange={(event) => update('modelId', event.target.value)}
        />
      </label>
      <label className="field" htmlFor="hostWorkspaceRoot">
        <span className="field-label">Workspace root</span>
        <input
          id="hostWorkspaceRoot"
          data-testid="hostWorkspaceRoot"
          className="input"
          value={values.workspaceRoot}
          onChange={(event) => update('workspaceRoot', event.target.value)}
        />
      </label>
      {/* `type="button"` on purpose: this section renders inside the settings
          dialog, and a submit button would close whatever form contains it. */}
      <button type="button" className="btn btn--secondary btn--small" data-testid="hostSettingsSave" disabled={saving} onClick={save}>
        {saving ? 'Saving…' : 'Save host settings'}
      </button>
      {status.length > 0 && (
        <p role="status" data-testid="hostSettingsStatus" className="field-hint">{status}</p>
      )}
    </section>
  )
}

export const settingsPlugin: WorkClientPlugin = {
  id: 'work.settings',
  label: 'Host settings',
  apply: (ctx) => {
    ctx.effect(ctx.slots.register(
      { name: 'settings.section', id: 'host-defaults', registrant: 'work.settings' },
      SettingsSection as never,
    ))
  },
}
