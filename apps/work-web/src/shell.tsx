/**
 * Desktop shell: persistent sidebar + home view. ChatView stays in
 * components.tsx; this module only composes the home/list chrome.
 */
import { useEffect, useMemo, useState, type JSX, type MouseEvent } from 'react'
import type { SessionSnapshot, WorkApiClient } from './api.ts'
import type { ShellRenderSlot } from './slot-map.ts'
import {
  HOME_SUGGESTIONS,
  SessionCreateForm,
  SessionOpenForm,
  SessionSettingsFields,
  needsSessionSetup,
  type SessionFormValues,
} from './forms.tsx'
import { Icon, ICONS, LogoMark } from './icons.tsx'
import { isUnread, type ReadState } from './read-state.ts'

export function userNameFromPath(path: string): string | undefined {
  const match = path.match(/^\/(?:Users|home)\/([^/]+)/)
  const name = match?.[1]
  return name === undefined || name.length === 0 ? undefined : name
}

export function workspaceBasename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const parts = trimmed.split('/').filter((part) => part.length > 0)
  return parts[parts.length - 1] ?? path
}

export function relativeTime(iso: string | undefined, now = Date.now()): string {
  if (iso === undefined || iso.length === 0) return ''
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return ''
  const delta = now - then
  if (delta < 0) return ''
  const minutes = Math.floor(delta / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function sessionLabel(session: SessionSnapshot): string {
  return session.title ?? session.sessionId
}

function SessionRow(props: {
  session: SessionSnapshot
  active: boolean
  unread: boolean
  compact?: boolean
  testIdPrefix: string
  onOpen: (sessionId: string) => void
}): JSX.Element {
  const { session } = props
  return (
    <button
      type="button"
      className={`session-row${props.active ? ' session-row--active' : ''}${props.compact === true ? ' session-row--compact' : ''}`}
      data-testid={`${props.testIdPrefix}-${session.sessionId}`}
      aria-current={props.active ? 'page' : undefined}
      onClick={() => props.onOpen(session.sessionId)}
    >
      {props.unread && (
        <span
          className="unread-dot"
          data-testid={props.testIdPrefix === 'nav-session' ? `unread-${session.sessionId}` : undefined}
        >
          <span className="visually-hidden">Unread</span>
        </span>
      )}
      <span className="session-row-body">
        <span className="session-row-title">{sessionLabel(session)}</span>
        <span className="session-row-meta">
          {session.cwd !== undefined && session.cwd.length > 0 && (
            <span className="session-row-cwd">{workspaceBasename(session.cwd)}</span>
          )}
          <span className="session-row-time">{relativeTime(session.updatedAt ?? session.createdAt)}</span>
        </span>
      </span>
    </button>
  )
}

export function Sidebar(props: {
  sessions: SessionSnapshot[]
  activeSessionId?: string
  seen: ReadState
  workspaceRoot: string
  onWorkspaceChange: (cwd: string) => void
  onOpenListed: (sessionId: string) => void
  onNewSession: () => void
  onMarkAllRead: () => void
  onOpenSettings: () => void
  onRetryList?: () => void
  listError: string
  userName?: string
}): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  const workspaces = useMemo(() => {
    const roots: string[] = []
    for (const session of props.sessions) {
      if (session.cwd === undefined || session.cwd.length === 0) continue
      if (!roots.includes(session.cwd)) roots.push(session.cwd)
    }
    if (props.workspaceRoot.length > 0 && !roots.includes(props.workspaceRoot)) {
      roots.unshift(props.workspaceRoot)
    }
    return roots
  }, [props.sessions, props.workspaceRoot])

  return (
    <aside className="sidebar" aria-label="Workspace">
      <div className="sidebar-brand">
        <LogoMark size={22} />
        <span className="sidebar-brand-name">rigo</span>
      </div>
      <div className="mode-switch" role="group" aria-label="Product" data-active="work">
        <span className="mode-switch-thumb" aria-hidden="true" />
        <button type="button" className="mode-switch-btn mode-switch-btn--active" aria-pressed="true">
          <Icon path={ICONS.work} size={14} />
          Work
        </button>
        <button
          type="button"
          className="mode-switch-btn"
          disabled
          title="Rigo Code is not in the MVP"
        >
          <Icon path={ICONS.code} size={14} />
          Code
        </button>
      </div>

      <div className="workspace-picker">
        <button
          type="button"
          className="workspace-picker-btn"
          aria-haspopup="listbox"
          aria-expanded={pickerOpen}
          aria-label="Workspace"
          onClick={() => setPickerOpen((open) => !open)}
        >
          <Icon path={ICONS.folder} size={15} />
          <span className="sidebar-label workspace-picker-label">
            {props.workspaceRoot.length === 0 ? 'Select a workspace' : workspaceBasename(props.workspaceRoot)}
          </span>
          <Icon path={ICONS.chevron} size={12} />
        </button>
        {pickerOpen && (
          <ul className="workspace-picker-menu" role="listbox" aria-label="Workspaces">
            {workspaces.length === 0 && (
              <li className="workspace-picker-empty">
                <button
                  type="button"
                  className="workspace-picker-option"
                  onClick={() => {
                    setPickerOpen(false)
                    props.onOpenSettings()
                  }}
                >
                  Set a workspace in Settings
                </button>
              </li>
            )}
            {workspaces.map((cwd) => (
              <li key={cwd} role="option" aria-selected={cwd === props.workspaceRoot}>
                <button
                  type="button"
                  className="workspace-picker-option"
                  onClick={() => {
                    props.onWorkspaceChange(cwd)
                    setPickerOpen(false)
                  }}
                >
                  {cwd}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-body">
        <section className="nav-section" aria-label="Recent sessions">
          <div className="project-header">
            <h2 className="nav-section-title sidebar-label">Sessions</h2>
            <button
              type="button"
              className="btn-icon-only"
              aria-label="Home"
              onClick={props.onNewSession}
            >
              <Icon path={ICONS.plus} size={13} />
            </button>
            {props.sessions.length > 0 && (
              <button
                type="button"
                className="btn btn--ghost btn--small sidebar-label"
                data-testid="markAllRead"
                onClick={props.onMarkAllRead}
              >
                Mark all read
              </button>
            )}
          </div>
          {props.listError.length > 0 && (
            <div className="list-error-row">
              <p role="status" className="alert alert--info" data-testid="listError">{props.listError}</p>
              {props.onRetryList !== undefined && (
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  data-testid="listRetry"
                  onClick={props.onRetryList}
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {props.sessions.length === 0 && props.listError.length === 0 && (
            <p className="nav-empty">No sessions yet</p>
          )}
          <ul className="nav-list">
            {props.sessions.map((session) => (
              <li key={session.sessionId}>
                <SessionRow
                  session={session}
                  compact
                  testIdPrefix="nav-session"
                  active={session.sessionId === props.activeSessionId}
                  unread={isUnread(session.sessionId, session.lastSeq, props.seen)}
                  onOpen={props.onOpenListed}
                />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="sidebar-footer">
        <span className="profile-chip">
          <span className="profile-avatar" aria-hidden="true">
            {(props.userName ?? 'R').slice(0, 1).toUpperCase()}
          </span>
          <span className="sidebar-label profile-name">{props.userName ?? 'Local user'}</span>
        </span>
        <button
          type="button"
          className="btn-icon-only"
          aria-label="Settings"
          data-testid="settingsButton"
          onClick={props.onOpenSettings}
        >
          <Icon path={ICONS.gear} size={14} />
        </button>
      </div>
    </aside>
  )
}

export function SettingsDialog(props: {
  open: boolean
  onClose: () => void
  client: WorkApiClient
  values: SessionFormValues
  onValuesChange: (values: SessionFormValues) => void
  onOpened: (session: SessionSnapshot) => void
  /** Threaded from the shell, which declares `settings.section`. */
  renderSlot?: ShellRenderSlot | undefined
}): JSX.Element | null {
  useEffect(() => {
    if (!props.open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.open, props.onClose])

  if (!props.open) return null

  const onOverlayMouseDown = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) props.onClose()
  }

  return (
    <div className="settings-overlay" onMouseDown={onOverlayMouseDown}>
      <div
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-testid="settingsDialog"
      >
        <div className="settings-dialog-head">
          <h2 id="settings-title">Settings</h2>
          <button
            type="button"
            className="btn-icon-only"
            aria-label="Close settings"
            onClick={props.onClose}
          >
            <Icon path={ICONS.deny} size={14} />
          </button>
        </div>
        <SessionSettingsFields
          values={props.values}
          onChange={props.onValuesChange}
          idPrefix="settings"
        />
        <SessionOpenForm
          client={props.client}
          onOpened={(session) => {
            props.onOpened(session)
            props.onClose()
          }}
        />
        {props.renderSlot?.('settings.section', { client: props.client })}
        <div className="settings-dialog-actions">
          <button type="button" className="btn btn--primary" onClick={props.onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export function HomeView(props: {
  client: WorkApiClient
  formValues: SessionFormValues
  onValuesChange: (values: SessionFormValues) => void
  onCreated: (session: SessionSnapshot, firstMessage?: string) => void
  onOpenSettings: () => void
  userName?: string
}): JSX.Element {
  const greeting = props.userName === undefined ? 'Your local-first knowledge assistant.' : `Welcome back, ${props.userName}`
  const setupNeeded = needsSessionSetup(props.formValues)
  return (
    <div className="home">
      <h1 className="home-brand">Rigo Work</h1>
      <p className="home-greeting">{greeting}</p>
      {setupNeeded && (
        <div className="setup-hint" role="status">
          <p>Set provider, model, and workspace in Settings before starting. Local mock: provider <code>mock</code>, model <code>mock</code>, workspace must be an absolute path.</p>
          <button type="button" className="btn btn--secondary btn--small" onClick={props.onOpenSettings}>
            Set up to start
          </button>
        </div>
      )}
      <SessionCreateForm
        client={props.client}
        onCreated={props.onCreated}
        values={props.formValues}
        onValuesChange={props.onValuesChange}
        showSettings={false}
        suggestions={HOME_SUGGESTIONS}
      />
    </div>
  )
}

/** Copy the session id to the clipboard (a no-op where unavailable). */
export function CopyButton(props: { value: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    const clipboard = (navigator as Navigator & { clipboard?: { writeText(text: string): Promise<void> } }).clipboard
    if (clipboard === undefined) return
    void clipboard.writeText(props.value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => undefined)
  }
  return (
    <button type="button" className="copy-btn" onClick={copy} title="Copy session id">
      <Icon path={ICONS.clipboard} size={12} />
      {copied ? 'copied' : `${props.value.slice(0, 18)}${props.value.length > 18 ? '…' : ''}`}
    </button>
  )
}
