import { describe, expect, it } from 'vitest'
import { isUnread, markAllSeen, parseReadState, upsertSeen } from './read-state.ts'

describe('session read-state', () => {
  it('parses a well-formed map and ignores junk', () => {
    expect(parseReadState(null)).toEqual({})
    expect(parseReadState('{')).toEqual({})
    expect(parseReadState('[]')).toEqual({})
    expect(parseReadState('{"a": 2, "b": "nope"}')).toEqual({ a: 2 })
  })

  it('treats unseen sessions as unread and compares lastSeq', () => {
    expect(isUnread('s', 0, {})).toBe(true)
    expect(isUnread('s', 3, { s: 3 })).toBe(false)
    expect(isUnread('s', 4, { s: 3 })).toBe(true)
  })

  it('upserts a seq and marks every listed session read', () => {
    const seen = upsertSeen({}, 'a', 1)
    expect(seen).toEqual({ a: 1 })
    expect(markAllSeen(seen, [{ sessionId: 'a', lastSeq: 4 }, { sessionId: 'b', lastSeq: 0 }])).toEqual({
      a: 4,
      b: 0,
    })
  })
})
