/**
 * Per-browser unread state for the session list. The server has no read
 * cursor, so this tab records the last seq it has seen per session id.
 */
import { useCallback, useEffect, useState } from 'react'

export const READ_STATE_KEY = 'rigo-work/read-state-v1'

/** sessionId → last seq this browser has marked read. */
export type ReadState = Record<string, number>

/** Parse a stored JSON blob into a read-state map (never throws). */
export function parseReadState(raw: string | null): ReadState {
  if (raw === null || raw.length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const result: ReadState = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isSafeInteger(value)) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

/** True when this browser has never marked the session, or lastSeq moved past that mark. */
export function isUnread(sessionId: string, lastSeq: number, seen: ReadState): boolean {
  const seenSeq = seen[sessionId]
  if (seenSeq === undefined) return true
  return lastSeq > seenSeq
}

/** Record that `sessionId` has been read through `lastSeq`. */
export function upsertSeen(seen: ReadState, sessionId: string, lastSeq: number): ReadState {
  if (seen[sessionId] === lastSeq) return seen
  return { ...seen, [sessionId]: lastSeq }
}

/** Mark every listed session read through its current lastSeq. */
export function markAllSeen(
  seen: ReadState,
  sessions: ReadonlyArray<{ sessionId: string; lastSeq: number }>,
): ReadState {
  if (sessions.length === 0) return seen
  const next = { ...seen }
  for (const session of sessions) next[session.sessionId] = session.lastSeq
  return next
}

function loadReadState(): ReadState {
  try {
    return parseReadState(localStorage.getItem(READ_STATE_KEY))
  } catch {
    return {}
  }
}

function saveReadState(seen: ReadState): void {
  try {
    localStorage.setItem(READ_STATE_KEY, JSON.stringify(seen))
  } catch {
    // Private mode / quota — keep the in-memory copy only.
  }
}

export function useReadState(): {
  seen: ReadState
  markSeen: (sessionId: string, lastSeq: number) => void
  markAllSeen: (sessions: ReadonlyArray<{ sessionId: string; lastSeq: number }>) => void
} {
  const [seen, setSeen] = useState<ReadState>(loadReadState)

  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== READ_STATE_KEY) return
      setSeen(parseReadState(event.newValue))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const markSeen = useCallback((sessionId: string, lastSeq: number) => {
    setSeen((current) => {
      const next = upsertSeen(current, sessionId, lastSeq)
      if (next !== current) saveReadState(next)
      return next
    })
  }, [])

  const markAll = useCallback((sessions: ReadonlyArray<{ sessionId: string; lastSeq: number }>) => {
    setSeen((current) => {
      const next = markAllSeen(current, sessions)
      if (next !== current) saveReadState(next)
      return next
    })
  }, [])

  return { seen, markSeen, markAllSeen: markAll }
}
