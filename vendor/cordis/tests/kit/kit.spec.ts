import { describe, expect, it } from 'vitest'
import { Time, clone, deepEqual } from '@teoclub/kit'

describe('clone', () => {
  it('preserves Map contents and usability', () => {
    const map = new Map([['a', { n: 1 }], ['b', [1, 2]]])
    const copy = clone(map)
    expect(copy).toBeInstanceOf(Map)
    expect(copy.size).toBe(2)
    expect(copy.get('a')).toEqual({ n: 1 })
    expect(copy.get('a')).not.toBe(map.get('a'))
    expect(copy.get('b')).toEqual([1, 2])
    // regression: must not produce a prototype-only shell that throws
    expect(() => copy.set('c', 3)).not.toThrow()
    expect(copy.size).toBe(3)
  })

  it('preserves Set contents and usability', () => {
    const set = new Set([{ x: 1 }, 2])
    const copy = clone(set)
    expect(copy).toBeInstanceOf(Set)
    expect(copy.size).toBe(2)
    expect(() => copy.add(3)).not.toThrow()
    expect(copy.has(2)).toBe(true)
    expect([...copy][0]).not.toBe([...set][0])
  })

  it('preserves TypedArray type and copies only the view bytes', () => {
    const bytes = new Uint8Array([1, 2, 255])
    const copy = clone(bytes)
    expect(copy).toBeInstanceOf(Uint8Array)
    expect(copy).toEqual(new Uint8Array([1, 2, 255]))
    expect(copy).not.toBe(bytes)

    // a subarray clones its visible bytes only, keeping the view type
    const sub = new Uint8Array([9, 9, 1, 2, 9]).subarray(2, 4)
    const subCopy = clone(sub)
    expect(subCopy).toBeInstanceOf(Uint8Array)
    expect([...subCopy]).toEqual([1, 2])
    expect(subCopy.byteLength).toBe(2)
  })

  it('preserves Buffer type', () => {
    const buffer = Buffer.from([1, 2, 3])
    const copy = clone(buffer)
    expect(copy).toBeInstanceOf(Buffer)
    expect(copy).toEqual(buffer)
    expect(copy).not.toBe(buffer)
  })

  it('preserves DataView semantics', () => {
    const view = new DataView(new Uint8Array([1, 2, 3, 4]).buffer, 1, 2)
    const copy = clone(view)
    expect(copy).toBeInstanceOf(DataView)
    expect(copy.byteLength).toBe(2)
    expect(copy.getUint8(0)).toBe(2)
  })

  it('handles Map/Set cycles', () => {
    const map = new Map()
    map.set('self', map)
    const copy = clone(map)
    expect(copy.get('self')).toBe(copy)
  })

  it('returns WeakMap/WeakSet/Promise by reference instead of a broken shell', () => {
    const weak = new WeakMap()
    const set = new WeakSet()
    const promise = Promise.resolve(1)
    expect(clone(weak)).toBe(weak)
    expect(clone(set)).toBe(set)
    expect(clone(promise)).toBe(promise)
  })
})

describe('deepEqual', () => {
  it('compares Maps by content', () => {
    expect(deepEqual(new Map([[1, 'a']]), new Map([[1, 'a']]))).toBe(true)
    expect(deepEqual(new Map([[1, 'a']]), new Map([[2, 'b']]))).toBe(false)
    expect(deepEqual(new Map([[1, 'a']]), new Map([[1, 'b']]))).toBe(false)
    expect(deepEqual(new Map([[1, 'a']]), new Map([[1, 'a'], [2, 'b']]))).toBe(false)
    expect(deepEqual(new Map([[1, 'a']]), {})).toBe(false)
    expect(deepEqual(new Map(), new Map())).toBe(true)

    const duplicateKeys = new Map([[{ x: 1 }, 1], [{ x: 1 }, 1]])
    const mismatchedValues = new Map([[{ x: 1 }, 1], [{ x: 1 }, 2]])
    expect(deepEqual(duplicateKeys, mismatchedValues)).toBe(false)
  })

  it('compares Sets by content', () => {
    expect(deepEqual(new Set([1, 2]), new Set([2, 1]))).toBe(true)
    expect(deepEqual(new Set([1]), new Set([9]))).toBe(false)
    expect(deepEqual(new Set([1]), new Set())).toBe(false)
    expect(deepEqual(new Set([1, 2]), new Set([1, 2, 3]))).toBe(false)
  })

  it('does not treat WeakMap/WeakSet/Promise as equal to anything else', () => {
    expect(deepEqual(new WeakMap(), new WeakMap())).toBe(false)
    expect(deepEqual(new WeakSet(), new WeakSet())).toBe(false)
    expect(deepEqual(Promise.resolve(1), Promise.resolve(1))).toBe(false)
    expect(deepEqual(new WeakMap(), {})).toBe(false)
  })

  it('keeps working for plain values', () => {
    expect(deepEqual([1, 2], [1, 2])).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual(new Date(1), new Date(1))).toBe(true)
    expect(deepEqual(new Date(1), new Date(2))).toBe(false)
  })
})

describe('Time', () => {
  it('parseTime preserves 0 for invalid input and zero durations', () => {
    expect(Time.parseTime('14:30')).toBe(0)
    expect(Time.parseTime('2026-08-27')).toBe(0)
    expect(Time.parseTime('')).toBe(0)
    expect(Time.parseTime('0s')).toBe(0)
    expect(Time.parseTime('1d')).toBe(Time.day)
    expect(Time.parseTime('2h30m')).toBe(2 * Time.hour + 30 * Time.minute)
  })

  it('parseDate clock forms are valid and locale-independent', () => {
    const d = Time.parseDate('14:30')
    expect(isNaN(d.valueOf())).toBe(false)
    expect(d.getHours()).toBe(14)
    expect(d.getMinutes()).toBe(30)

    const d2 = Time.parseDate('14:30:05')
    expect(isNaN(d2.valueOf())).toBe(false)
    expect(d2.getHours()).toBe(14)
    expect(d2.getMinutes()).toBe(30)
    expect(d2.getSeconds()).toBe(5)
  })

  it('parseDate never consults toLocaleDateString (locale-dependent parsing)', () => {
    const original = Date.prototype.toLocaleDateString
    Date.prototype.toLocaleDateString = () => {
      throw new Error('parseDate must not depend on the host locale')
    }
    try {
      expect(isNaN(Time.parseDate('14:30').valueOf())).toBe(false)
      expect(isNaN(Time.parseDate('14:30:05').valueOf())).toBe(false)
      expect(isNaN(Time.parseDate('2-3-14:30').valueOf())).toBe(false)
      expect(isNaN(Time.parseDate('1d').valueOf())).toBe(false)
      expect(isNaN(Time.parseDate('0s').valueOf())).toBe(false)
    } finally {
      Date.prototype.toLocaleDateString = original
    }
  })

  it('parseDate month-day forms resolve to this year', () => {
    const d = Time.parseDate('2-3-14:30')
    expect(isNaN(d.valueOf())).toBe(false)
    expect(d.getMonth()).toBe(1)
    expect(d.getDate()).toBe(3)
    expect(d.getHours()).toBe(14)
    expect(d.getMinutes()).toBe(30)
    expect(d.getFullYear()).toBe(new Date().getFullYear())
  })

  it('parseDate zero/relative durations resolve to now', () => {
    const before = Date.now()
    const d = Time.parseDate('0s')
    const after = Date.now()
    expect(isNaN(d.valueOf())).toBe(false)
    expect(d.valueOf()).toBeGreaterThanOrEqual(before)
    expect(d.valueOf()).toBeLessThanOrEqual(after)

    const day = Time.parseDate('1d')
    expect(day.valueOf()).toBeGreaterThanOrEqual(before + Time.day - 60_000)
    expect(day.valueOf()).toBeLessThanOrEqual(after + Time.day + 60_000)
  })

  it('parseDate full dates fall back to native parsing', () => {
    const d = Time.parseDate('2026-08-27')
    expect(isNaN(d.valueOf())).toBe(false)
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(7)
    expect(d.getDate()).toBe(27)
  })
})
