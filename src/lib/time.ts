export function nowIso(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString()
}

/** UTC day key `YYYY-MM-DD` used by render_counters. */
export function utcDay(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

export function isExpired(expiresAt: string, nowMs = Date.now()): boolean {
  const t = Date.parse(expiresAt)
  return !Number.isFinite(t) || t <= nowMs
}

/** Normalises any parseable date string to ISO-8601 UTC. */
export function toIso(value: string): string {
  return new Date(Date.parse(value)).toISOString()
}
