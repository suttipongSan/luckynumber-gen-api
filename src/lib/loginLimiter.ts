// Brute-force limiter for password logins: 5 wrong tries → locked (429) for 15 minutes.
// State lives in the `login_attempts` table so the lock holds across every Worker isolate
// (an in-memory Map would reset on isolate restart and differ per isolate).
//   member link login : key `link:<linkToken>`
//   back office login : key `admin:<client ip>` (per IP, so an attacker cannot lock the operator out
//                       from everywhere)
import { eq, sql } from 'drizzle-orm'
import type { DB } from '../db/client'
import { loginAttempts } from '../db/schema'
import { nowIso } from './time'

export const MAX_FAILED_LOGINS = 5
export const LOCK_MS = 15 * 60 * 1000

export const linkKey = (linkToken: string) => `link:${linkToken}`
export const adminKey = (ip: string) => `admin:${ip}`

/** Milliseconds remaining on a lock, or 0 when the key may try again. */
export async function lockRemaining(db: DB, key: string, now = Date.now()): Promise<number> {
  const row = await db.query.loginAttempts.findFirst({ where: eq(loginAttempts.key, key) })
  if (!row?.lockedUntil) return 0
  const until = Date.parse(row.lockedUntil)
  if (until > now) return until - now
  // Lock elapsed → start fresh.
  await db.delete(loginAttempts).where(eq(loginAttempts.key, key))
  return 0
}

/** Records a failed try (atomic upsert). Returns true when this failure triggered the lock. */
export async function recordFailure(db: DB, key: string, now = Date.now()): Promise<boolean> {
  const [row] = await db
    .insert(loginAttempts)
    .values({ key, failures: 1, lockedUntil: null })
    .onConflictDoUpdate({
      target: loginAttempts.key,
      set: { failures: sql`${loginAttempts.failures} + 1` },
    })
    .returning({ failures: loginAttempts.failures })
  if (row.failures >= MAX_FAILED_LOGINS) {
    await db
      .update(loginAttempts)
      .set({ failures: 0, lockedUntil: nowIso(now + LOCK_MS) })
      .where(eq(loginAttempts.key, key))
    return true
  }
  return false
}

export async function clearFailures(db: DB, key: string): Promise<void> {
  await db.delete(loginAttempts).where(eq(loginAttempts.key, key))
}

/** Test helper: forget every counter / lock. */
export async function resetLimiter(db: DB): Promise<void> {
  await db.delete(loginAttempts)
}
