// Brute-force limiter for password logins: 5 wrong tries → locked (429) for 15 minutes.
// State lives in the `login_attempts` table so the lock holds across every Worker isolate
// (an in-memory Map would reset on isolate restart and differ per isolate).
//   member link login : key `link:<linkToken>`
//   back office login : key `admin:<client ip>` (per IP — IPv6 per /64, since one client usually
//                       owns the whole /64 — so an attacker cannot lock the operator out from
//                       everywhere) plus the global ceiling `admin:*` (ADMIN_GLOBAL_MAX_FAILED),
//                       so rotating addresses does not buy unlimited guesses.
//
// Every attempt is RESERVED (counted as a failure) in one atomic upsert BEFORE the slow PBKDF2
// verify, and the counter is cleared on success. Reading the lock first and counting the failure
// only after the verify let N parallel requests all pass the check and all get verified.
import { inArray, sql } from 'drizzle-orm'
import type { DB } from '../db/client'
import { loginAttempts } from '../db/schema'
import { nowIso } from './time'

export const MAX_FAILED_LOGINS = 5
export const ADMIN_GLOBAL_MAX_FAILED = 20
export const LOCK_MS = 15 * 60 * 1000

export const ADMIN_GLOBAL_KEY = 'admin:*'
export const linkKey = (linkToken: string) => `link:${linkToken}`
export const adminKey = (ip: string) => `admin:${ipBucket(ip)}`

/**
 * IPv4 → unchanged; IPv6 → its /64 prefix (`2001:db8:0:1::/64`); IPv4-mapped IPv6 → the IPv4
 * address. Anything unparseable is returned as-is (still a distinct, exact key).
 */
export function ipBucket(ip: string): string {
  const s = ip.trim().toLowerCase().split('%')[0]
  if (!s.includes(':')) return s
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s)
  if (mapped) return mapped[1]
  const halves = s.split('::')
  if (halves.length > 2) return s
  const part = (h: string) => {
    const g = h ? h.split(':') : []
    // An embedded IPv4 tail (`::1.2.3.4`) is 32 bits = two groups; only the first 64 bits matter.
    if (g.length && g[g.length - 1].includes('.')) g.splice(-1, 1, '0', '0')
    return g
  }
  const head = part(halves[0])
  const tail = halves.length === 2 ? part(halves[1]) : []
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (fill < 0) return s
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail]
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return s
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`
}

export interface Attempt {
  /** False → refuse without verifying (locked, or the limit is already used by other tries). */
  allowed: boolean
  /** Milliseconds left on the lock (0 = not locked). For an allowed try that then fails, > 0
   *  means this try used the last slot and the key is now locked → answer 429. */
  remainingMs: number
}

/**
 * Atomically counts one attempt for `key` (as a failure until {@link clearFailures} runs on
 * success) and reports whether it may be verified.
 *  - lock elapsed        → counter restarts at 1, lock cleared
 *  - reaching `max`      → the lock is set NOW (so a crashed in-flight verify cannot leave the
 *                          key stuck at the limit with no expiry); this try is still verified
 *  - already locked      → counter keeps growing, lock time is neither reset nor extended
 * The counter is never reset while locked, so in-flight attempts cannot restart the count.
 * SQLite evaluates every SET expression against the OLD row, so the CASEs see one snapshot.
 */
export async function reserveAttempt(
  db: DB,
  key: string,
  max = MAX_FAILED_LOGINS,
  now = Date.now(),
): Promise<Attempt> {
  const nowS = nowIso(now)
  const lockS = nowIso(now + LOCK_MS)
  const elapsed = sql`(${loginAttempts.lockedUntil} IS NOT NULL AND ${loginAttempts.lockedUntil} <= ${nowS})`
  const [row] = await db
    .insert(loginAttempts)
    .values({ key, failures: 1, lockedUntil: max <= 1 ? lockS : null })
    .onConflictDoUpdate({
      target: loginAttempts.key,
      set: {
        failures: sql`CASE WHEN ${elapsed} THEN 1 ELSE ${loginAttempts.failures} + 1 END`,
        lockedUntil: sql`CASE
          WHEN ${elapsed} THEN NULL
          WHEN ${loginAttempts.lockedUntil} IS NOT NULL THEN ${loginAttempts.lockedUntil}
          WHEN ${loginAttempts.failures} + 1 >= ${max} THEN ${lockS}
          ELSE NULL END`,
      },
    })
    .returning({ failures: loginAttempts.failures, lockedUntil: loginAttempts.lockedUntil })
  const remainingMs = row.lockedUntil ? Math.max(0, Date.parse(row.lockedUntil) - now) : 0
  // A locked row is verified only when THIS try set the lock (lockedUntil === lockS). Counting
  // alone is not enough: rows locked by the previous limiter kept failures = 0, so
  // `failures <= max` would let up to `max` guesses through an existing lock after deploy.
  const setLockNow = row.lockedUntil === lockS
  return { allowed: row.failures <= max && (row.lockedUntil === null || setLockNow), remainingMs }
}

export async function clearFailures(db: DB, ...keys: string[]): Promise<void> {
  if (keys.length) await db.delete(loginAttempts).where(inArray(loginAttempts.key, keys))
}

/** Test helper: forget every counter / lock. */
export async function resetLimiter(db: DB): Promise<void> {
  await db.delete(loginAttempts)
}
