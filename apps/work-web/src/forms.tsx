/**
 * Session create/open forms (Issue 033 contracts). The home composer is
 * prompt-only; provider / model / workspace / title / open-by-id live in
 * Settings. The standalone form still renders those fields so the pinned
 * create-form unit test can fill them without a dialog.
 */
import { useState, type JSX, type KeyboardEvent } from 'react'
import type { SessionSnapshot, WorkApiClient } from './api.ts'
import { Icon, ICONS } from './icons.tsx'

export interface SessionFormValues {
  providerId: string
  modelId: string
  workspaceRoot: string
  title: string
}

export const HOME_SUGGESTIONS = [
  'Summarize the workspace',
  'Find related documents',
  'Draft a plan from the sources',
  'What should I work on next?',
] as const

export const SESSION_SETTINGS_KEY = 'rigo-work/settings-v1'

const EMPTY_VALUES: SessionFormValues = { providerId: '', modelId: '', workspaceRoot: '', title: '' }

export function readSessionSettings(): SessionFormValues {
  try {
    const raw = localStorage.getItem(SESSION_SETTINGS_KEY)
    if (raw === null || raw.length === 0) return { ...EMPTY_VALUES }
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...EMPTY_VALUES }
    const row = parsed as Record<string, unknown>
    return {
      providerId: typeof row.providerId === 'string' ? row.providerId : '',
      modelId: typeof row.modelId === 'string' ? row.modelId : '',
      workspaceRoot: typeof row.workspaceRoot === 'string' ? row.workspaceRoot : '',
      title: typeof row.title === 'string' ? row.title : '',
    }
  } catch {
    return { ...EMPTY_VALUES }
  }
}

export function writeSessionSettings(values: SessionFormValues): void {
  try {
    localStorage.setItem(SESSION_SETTINGS_KEY, JSON.stringify(values))
  } catch {
    // Private mode / quota.
  }
}

/** Field checks in the pinned order and wording (ui.vitest.tsx). */
export function validateSessionForm(values: SessionFormValues): string[] {
  const problems: string[] = []
  if (values.providerId.trim().length === 0) problems.push('Provider is required.')
  if (values.modelId.trim().length === 0) problems.push('Model is required.')
  if (!values.workspaceRoot.trim().startsWith('/')) problems.push('Workspace root must be an absolute path.')
  if (Array.from(values.title).length > 200) problems.push('Title must be at most 200 characters.')
  return problems
}

/** True when provider/model/workspace still need to be set in Settings. */
export function needsSessionSetup(values: SessionFormValues): boolean {
  return values.providerId.trim().length === 0
    || values.modelId.trim().length === 0
    || !values.workspaceRoot.trim().startsWith('/')
}

export function SessionSettingsFields(props: {
  values: SessionFormValues
  onChange: (values: SessionFormValues) => void
  idPrefix?: string
  compact?: boolean
}): JSX.Element {
  const prefix = props.idPrefix ?? 'session'
  const compact = props.compact === true
  const fieldClass = compact ? 'field field--compact' : 'field'
  return (
    <div className={compact ? 'composer-fields' : 'settings-fields'}>
      <div className={fieldClass}>
        <label className="field-label" htmlFor={`${prefix}-provider`}>Provider</label>
        <input
          id={`${prefix}-provider`}
          className="input"
          data-testid="provider"
          value={props.values.providerId}
          onChange={(event) => props.onChange({ ...props.values, providerId: event.target.value })}
          placeholder="openai-compatible"
          aria-required="true"
        />
      </div>
      <div className={fieldClass}>
        <label className="field-label" htmlFor={`${prefix}-model`}>Model</label>
        <input
          id={`${prefix}-model`}
          className="input"
          data-testid="model"
          value={props.values.modelId}
          onChange={(event) => props.onChange({ ...props.values, modelId: event.target.value })}
          placeholder="default"
          aria-required="true"
        />
      </div>
      <div className={fieldClass}>
        <label className="field-label" htmlFor={`${prefix}-workspace`}>Workspace root</label>
        <input
          id={`${prefix}-workspace`}
          className="input"
          data-testid="workspaceRoot"
          value={props.values.workspaceRoot}
          onChange={(event) => props.onChange({ ...props.values, workspaceRoot: event.target.value })}
          placeholder="/absolute/workspace/path"
          aria-required="true"
          spellCheck={false}
        />
      </div>
      <div className={fieldClass}>
        <label className="field-label" htmlFor={`${prefix}-title`}>Title · optional</label>
        <input
          id={`${prefix}-title`}
          className="input"
          data-testid="title"
          value={props.values.title}
          onChange={(event) => props.onChange({ ...props.values, title: event.target.value })}
          placeholder="e.g. Q3 planning"
        />
      </div>
    </div>
  )
}

export function SessionCreateForm(props: {
  client: WorkApiClient
  onCreated: (session: SessionSnapshot, firstMessage?: string) => void
  values?: SessionFormValues
  onValuesChange?: (values: SessionFormValues) => void
  suggestions?: readonly string[]
  healthText?: string
  /** Standalone tests keep the fields inline. The App home hides them. */
  showSettings?: boolean
}): JSX.Element {
  const [internal, setInternal] = useState<SessionFormValues>(EMPTY_VALUES)
  const values = props.values ?? internal
  const setValues = props.onValuesChange ?? setInternal
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const suggestions = props.suggestions ?? []
  const showSettings = props.showSettings !== false

  const submit = async (): Promise<void> => {
    const problems = validateSessionForm(values)
    if (problems.length > 0) {
      setError(problems.join(' '))
      return
    }
    setError('')
    setCreating(true)
    try {
      const firstMessage = message.trim()
      const explicitTitle = values.title.trim()
      const title = explicitTitle.length > 0
        ? explicitTitle
        : firstMessage.length === 0
          ? undefined
          : Array.from(firstMessage).slice(0, 80).join('')
      const session = await props.client.createSession({
        providerId: values.providerId.trim(),
        modelId: values.modelId.trim(),
        workspaceRoot: values.workspaceRoot.trim(),
        ...(title === undefined ? {} : { title }),
      })
      props.onCreated(session, firstMessage.length === 0 ? undefined : firstMessage)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to create the session.')
    } finally {
      setCreating(false)
    }
  }

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
      aria-label="Create session"
      className="composer-group"
    >
      {suggestions.length > 0 && (
        <div className="suggestion-row" aria-label="Suggested prompts">
          {suggestions.map((prompt, index) => (
            <button
              key={prompt}
              type="button"
              className="suggestion-chip"
              data-testid={`suggestion-${index}`}
              onClick={() => setMessage(prompt)}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
      <div className="composer-input-row">
        <textarea
          className="textarea composer-textarea"
          rows={2}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={onComposerKey}
          placeholder="Describe a task or ask a question"
          aria-label="Task description"
        />
        <button
          type="submit"
          className="btn btn--primary composer-submit"
          disabled={creating}
          data-testid="createButton"
          aria-label="Create session"
        >
          {creating ? 'Creating…' : '↵'}
        </button>
      </div>
      {error.length > 0 && (
        <p role="alert" data-testid="createError" className="alert">
          <span className="alert-icon"><Icon path={ICONS.alert} size={14} /></span>
          {error}
        </p>
      )}
      {(showSettings || (props.healthText !== undefined && props.healthText.length > 0)) && (
        <div className="composer-footer">
          {showSettings && (
            <SessionSettingsFields
              values={values}
              onChange={setValues}
              idPrefix="create"
              compact
            />
          )}
          {props.healthText !== undefined && props.healthText.length > 0 && (
            <p className="composer-health" data-testid="serverHealth">{props.healthText}</p>
          )}
        </div>
      )}
    </form>
  )
}

export function SessionOpenForm(props: {
  client: WorkApiClient
  onOpened: (session: SessionSnapshot) => void
}): JSX.Element {
  const [sessionId, setSessionId] = useState('')
  const [error, setError] = useState('')

  const open = async (): Promise<void> => {
    setError('')
    const session = await props.client.getSession(sessionId.trim())
    if (session === undefined) {
      setError(`Session "${sessionId.trim()}" was not found.`)
      return
    }
    props.onOpened(session)
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void open()
      }}
      aria-label="Open session"
      className="open-row"
    >
      <label className="field-label" htmlFor="open-session-id">Session id</label>
      <input
        id="open-session-id"
        className="input"
        data-testid="sessionId"
        value={sessionId}
        onChange={(event) => setSessionId(event.target.value)}
        placeholder="session_…"
        spellCheck={false}
      />
      <button type="submit" className="btn btn--ghost btn--small" data-testid="openButton">
        Open
      </button>
      {error.length > 0 && (
        <p role="alert" data-testid="openError" className="alert open-row-error">
          <span className="alert-icon"><Icon path={ICONS.alert} size={14} /></span>
          {error}
        </p>
      )}
    </form>
  )
}
