/**
 * The shell: the `root` seat's occupant, and the owner of every other seat.
 *
 * This is the previous `App` body, unchanged in markup and behaviour, plus the
 * slot outlets that let contributions join the fixed tree. It is a plugin like
 * any other — it registers into `root` through the same `register()` a feature
 * plugin uses — which is what keeps "the shell is special" out of the kit.
 *
 * The shell is the sole renderer of its declared children, so it receives
 * `renderSlot` from the ledger. Render sites that are not the declarer (the
 * chat rail, the composer row) get it threaded down as a plain prop: the
 * authorizing identity stays with this entry, and the child is only a site.
 *
 * @module @teoclub/work-web/plugins/shell
 */

import { useCallback, useEffect, useState, type JSX } from 'react'
import type { SessionSnapshot, WorkApiClient } from '../api.ts'
import { ChatView } from '../components.tsx'
import { Icon, ICONS } from '../icons.tsx'
import { CopyButton, HomeView, SettingsDialog, Sidebar, userNameFromPath } from '../shell.tsx'
import { readSessionSettings, writeSessionSettings, type SessionFormValues } from '../forms.tsx'
import { useReadState } from '../read-state.ts'
import { useApiClient, useClientApp } from '../slots/index.ts'
import type { ShellRenderSlot } from '../slot-map.ts'

export function WorkShell({ renderSlot }: { renderSlot: ShellRenderSlot }): JSX.Element {
  const client = useApiClient<WorkApiClient>()
  const { unknown: unknownPlugins } = useClientApp()
  const [session, setSession] = useState<SessionSnapshot | undefined>(undefined)
  const [pendingMessage, setPendingMessage] = useState('')
  const [formValues, setFormValues] = useState<SessionFormValues>(readSessionSettings)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSnapshot[]>([])
  const [listError, setListError] = useState('')
  const [notice, setNotice] = useState('')
  const [opening, setOpening] = useState(false)
  const closeSettings = useCallback((): void => setSettingsOpen(false), [])
  const persistValues = useCallback((values: SessionFormValues): void => {
    setFormValues(values)
    writeSessionSettings(values)
  }, [])
  const { seen, markSeen, markAllSeen } = useReadState()

  const refreshSessions = useCallback(async (): Promise<void> => {
    try {
      const listed = await client.listSessions()
      setSessions(Array.isArray(listed) ? listed : [])
      setListError('')
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : ''
      setListError(message.length > 0 && message !== '[object Object]' ? message : 'Failed to load sessions.')
    }
  }, [client])

  useEffect(() => {
    void refreshSessions()
    const onFocus = (): void => {
      void refreshSessions()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshSessions])

  const goHome = (): void => {
    setPendingMessage('')
    setSession(undefined)
    setNotice('')
    void refreshSessions()
  }

  const openSnapshot = (next: SessionSnapshot): void => {
    setPendingMessage('')
    setSession(next)
    markSeen(next.sessionId, next.lastSeq)
    if (next.cwd !== undefined && next.cwd.length > 0 && formValues.workspaceRoot.length === 0) {
      persistValues({ ...formValues, workspaceRoot: next.cwd })
    }
  }

  const handleCreated = (next: SessionSnapshot, firstMessage?: string): void => {
    setPendingMessage(firstMessage ?? '')
    setSession(next)
    markSeen(next.sessionId, next.lastSeq)
    void refreshSessions()
  }

  const openListed = async (sessionId: string): Promise<void> => {
    setPendingMessage('')
    setNotice('')
    setOpening(true)
    try {
      const live = await client.getSession(sessionId)
      if (live !== undefined) {
        openSnapshot(live)
        return
      }
      try {
        const resumed = await client.resumeSession(sessionId)
        if (resumed !== undefined) {
          openSnapshot(resumed)
          return
        }
      } catch (cause) {
        const retry = await client.getSession(sessionId)
        if (retry !== undefined) {
          openSnapshot(retry)
          return
        }
        setNotice(cause instanceof Error ? cause.message : `Session "${sessionId}" was not found.`)
        return
      }
      setNotice(`Session "${sessionId}" was not found.`)
    } finally {
      setOpening(false)
    }
  }

  const userName = userNameFromPath(formValues.workspaceRoot)
    ?? userNameFromPath(sessions[0]?.cwd ?? '')

  return (
    <div className="app">
      {notice.length > 0 && (
        <div className="banner" role="status" data-testid="notice">
          <span className="alert-icon"><Icon path={ICONS.info} size={14} /></span>
          {notice}
        </div>
      )}
      {unknownPlugins.length > 0 && (
        <div className="banner banner--warn" role="status" data-testid="compositionNotice">
          <span className="alert-icon"><Icon path={ICONS.alert} size={14} /></span>
          {`Server plugin${unknownPlugins.length === 1 ? '' : 's'} ${unknownPlugins.join(', ')} `
            + `${unknownPlugins.length === 1 ? 'is' : 'are'} not in this build.`}
        </div>
      )}
      {renderSlot('app.banner', { notice })}
      <div className="shell">
        <Sidebar
          sessions={sessions}
          {...(session === undefined ? {} : { activeSessionId: session.sessionId })}
          seen={seen}
          workspaceRoot={formValues.workspaceRoot}
          onWorkspaceChange={(cwd) => persistValues({ ...formValues, workspaceRoot: cwd })}
          onOpenListed={(id) => void openListed(id)}
          onNewSession={goHome}
          onMarkAllRead={() => markAllSeen(sessions)}
          onOpenSettings={() => setSettingsOpen(true)}
          onRetryList={() => void refreshSessions()}
          listError={listError}
          {...(userName === undefined ? {} : { userName })}
        />
        <main className="main">
          {opening && session === undefined && (
            <p className="opening-status" role="status">Opening session…</p>
          )}
          {session === undefined ? (
            <HomeView
              client={client}
              formValues={formValues}
              onValuesChange={persistValues}
              onCreated={handleCreated}
              onOpenSettings={() => setSettingsOpen(true)}
              {...(userName === undefined ? {} : { userName })}
            />
          ) : (
            <>
              <div className="chat-header">
                <h2 className="session-title" data-testid="sessionTitle">{session.title ?? session.sessionId}</h2>
                <span className="session-meta">
                  {session.providerId !== undefined && session.modelId !== undefined && (
                    <span className="chip">
                      <span className="chip-label">{session.providerId}</span>·{session.modelId}
                    </span>
                  )}
                  <CopyButton value={session.sessionId} />
                </span>
                <button type="button" className="btn btn--ghost btn--small" onClick={goHome}>
                  New session
                </button>
              </div>
              <ChatView
                session={session}
                client={client}
                renderSlot={renderSlot}
                onDisconnected={() => setNotice('Connection lost — reconnecting with the last event id…')}
                initialMessage={pendingMessage}
                onInitialMessageConsumed={() => setPendingMessage('')}
              />
            </>
          )}
        </main>
      </div>
      <SettingsDialog
        open={settingsOpen}
        onClose={closeSettings}
        client={client}
        values={formValues}
        onValuesChange={persistValues}
        onOpened={openSnapshot}
        renderSlot={renderSlot}
      />
      {renderSlot('shell.overlay', { session, client, values: formValues, onValuesChange: persistValues })}
    </div>
  )
}
