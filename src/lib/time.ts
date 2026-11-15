export function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString()
}

/** Thailand is UTC+7 all year (no DST). */
const BANGKOK_OFFSET_MS = 7 * 3600 * 1000

/**
 * Bangkok (UTC+7) day key `YYYY-MM-DD` used by render_counters, so the daily render limit
 * resets at local midnight (a UTC key reset at 07:00 Thailand time).
 */
export function bangkokDay(nowMs = Date.now()): string {
  return new Date(nowMs + BANGKOK_OFFSET_MS).toISOString().slice(0, 10)
}

/**
 * Bangkok (UTC+7) wall-clock minute `YYYY-MM-DDTHH:MM`. This is the unit of the reminder cursor;
 * its last five characters are the "HH:MM" a reminder is set to. Fixed width, so plain string
 * comparison orders minutes chronologically.
 */
export function bangkokMinute(nowMs = Date.now()): string {
  return new Date(nowMs + BANGKOK_OFFSET_MS).toISOString().slice(0, 16)
}

/** `minute` (see {@link bangkokMinute}) moved by `delta` minutes. */
export function addMinutes(minute: string, delta: number): string {
  return new Date(Date.parse(`${minute}:00Z`) + delta * 60_000).toISOString().slice(0, 16)
}

export function isExpired(expiresAt: string, nowMs = Date.now()): boolean {
  const t = Date.parse(expiresAt)
  return !Number.isFinite(t) || t <= nowMs
}

/** Normalises any parseable date string to ISO-8601 UTC. */
export function toIso(value: string): string {
  return new Date(Date.parse(value)).toISOString()
}

/**
 * date, optional "T" (or a space, as RFC 3339 allows) and a time with optional seconds / fraction,
 * optional zone: 2026-11-14, 2026-11-14T10:30, 2026-11-14T10:30:00.123Z, 2026-11-14 10:30:00+07:00
 */
const ISO_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/

const MAX_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999)

/**
 * Strict ISO-8601 reader: returns the instant as a `toISOString()` UTC string, or null when
 * `value` is not an ISO-8601 date or date-time, or names a day / time that does not exist
 * (February 30, 24:00, minute 60, ...). Unlike Date.parse it does not accept free-form text
 * ("Nov 3", "1") and does not depend on the server's time zone: a value without a zone (a date
 * only, or a time without Z / offset) is read as UTC. Years 1000..9999.
 */
export function parseIsoDateTime(value: string): string | null {
  const m = ISO_DATE_TIME_RE.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4] ?? 0)
  const minute = Number(m[5] ?? 0)
  const second = Number(m[6] ?? 0)
  const ms = m[7] ? Number(m[7].padEnd(3, '0').slice(0, 3)) : 0
  if (year < 1000 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) {
    return null
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, ms)
  const check = new Date(utc)
  // Date.UTC rolls an impossible day over to the next month: it must come back unchanged.
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  let offsetMinutes = 0
  const zone = m[8]
  if (zone && zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '')
    const zh = Number(digits.slice(0, 2))
    const zm = Number(digits.slice(2))
    if (zh > 23 || zm > 59) return null
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (zh * 60 + zm)
  }
  const instant = utc - offsetMinutes * 60_000
  // toISOString prints years above 9999 in a different (+YYYYYY) form: not an ISO-8601 UTC string.
  if (instant > MAX_ISO_MS) return null
  return new Date(instant).toISOString()
}
