/** Time constants plus parsing and formatting helpers. */
export namespace Time {
  export const millisecond = 1
  export const second = 1000
  export const minute = second * 60
  export const hour = minute * 60
  export const day = hour * 24
  export const week = day * 7

  let timezoneOffset = new Date().getTimezoneOffset()

  export function setTimezoneOffset(offset: number) {
    timezoneOffset = offset
  }

  export function getTimezoneOffset() {
    return timezoneOffset
  }

  export function getDateNumber(date: number | Date = new Date(), offset?: number) {
    if (typeof date === 'number') date = new Date(date)
    if (offset === undefined) offset = timezoneOffset
    return Math.floor((date.valueOf() / minute - offset) / 1440)
  }

  export function fromDateNumber(value: number, offset?: number) {
    const date = new Date(value * day)
    if (offset === undefined) offset = timezoneOffset
    return new Date(+date + offset * minute)
  }

  const numeric = /\d+(?:\.\d+)?/.source
  const timeRegExp = new RegExp(`^${[
    'w(?:eek(?:s)?)?',
    'd(?:ay(?:s)?)?',
    'h(?:our(?:s)?)?',
    'm(?:in(?:ute)?(?:s)?)?',
    's(?:ec(?:ond)?(?:s)?)?',
  ].map(unit => `(${numeric}${unit})?`).join('')}$`)

  function parseTimeValue(source: string) {
    const capture = timeRegExp.exec(source)
    if (!capture) return undefined
    return (parseFloat(capture[1]) * week || 0)
      + (parseFloat(capture[2]) * day || 0)
      + (parseFloat(capture[3]) * hour || 0)
      + (parseFloat(capture[4]) * minute || 0)
      + (parseFloat(capture[5]) * second || 0)
  }

  /** Parse a duration into milliseconds, returning `0` for invalid input. */
  export function parseTime(source: string) {
    return parseTimeValue(source) ?? 0
  }

  /**
   * Parse a date expression into a `Date`.
   *
   * Accepts relative durations (`1d`, `2h30m`, `0s` — relative to now),
   * clock times (`HH`, `HH:mm`, `HH:mm:ss` — today at that time), month-day
   * plus optional clock (`M-D`, `M-D-HH:mm`, ... — this year), and falls
   * back to native parsing for full date strings. Clock-time forms are
   * assembled from explicit components so the result never depends on the
   * host locale.
  */
  export function parseDate(date: string) {
    const parsed = parseTimeValue(date)
    if (parsed !== undefined) {
      return new Date(Date.now() + parsed)
    }

    const clock = /^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?$/.exec(date)
    if (clock) {
      const now = new Date()
      const [, h = 0, m = 0, s = 0] = clock.map(value => value ? +value : 0)
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s)
    }

    const monthDay = /^(\d{1,2})-(\d{1,2})(?:-(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/.exec(date)
    if (monthDay) {
      const [, M = 1, D = 1, h = 0, m = 0, s = 0] = monthDay.map(value => value ? +value : 0)
      return new Date(new Date().getFullYear(), M - 1, D, h, m, s)
    }

    return date ? new Date(date) : new Date()
  }

  export function format(ms: number) {
    const abs = Math.abs(ms)
    if (abs >= day - hour / 2) {
      return Math.round(ms / day) + 'd'
    } else if (abs >= hour - minute / 2) {
      return Math.round(ms / hour) + 'h'
    } else if (abs >= minute - second / 2) {
      return Math.round(ms / minute) + 'm'
    } else if (abs >= second) {
      return Math.round(ms / second) + 's'
    }
    return ms + 'ms'
  }

  export function toDigits(source: number, length = 2) {
    return source.toString().padStart(length, '0')
  }

  export function template(template: string, time = new Date()) {
    return template
      .replace('yyyy', time.getFullYear().toString())
      .replace('yy', time.getFullYear().toString().slice(2))
      .replace('MM', toDigits(time.getMonth() + 1))
      .replace('dd', toDigits(time.getDate()))
      .replace('hh', toDigits(time.getHours()))
      .replace('mm', toDigits(time.getMinutes()))
      .replace('ss', toDigits(time.getSeconds()))
      .replace('SSS', toDigits(time.getMilliseconds(), 3))
  }
}
