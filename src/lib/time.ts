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
