// Cookie sessions. Cookie value = `<sessionId>.<hex HMAC-SHA256(SESSION_SECRET, kind:sessionId)>`;
// the session row (with its own 24 h expiry, never refreshed) is the source of truth.
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import type { AppEnv, SessionMember } from '../types'
import { SESSION_TTL_SECONDS } from '../types'
import { getDb } from '../db/client'
import { memberSessions, members, adminSessions } from '../db/schema'
import { hmacSha256Hex, verifyHmacHex } from './crypto'
import { newToken } from './ids'
import { nowIso } from './time'

export const MEMBER_COOKIE = 'ng_session'
export const ADMIN_COOKIE = 'ng_admin'

type Kind = 'member' | 'admin'

function cookieOptions(c: Context<AppEnv>) {
  const secure = c.env.COOKIE_SECURE === 'true'
  return {
    path: '/',
    httpOnly: true,
    secure,
    sameSite: secure ? ('None' as const) : ('Lax' as const),
    maxAge: SESSION_TTL_SECONDS,
  }
}

async function signValue(secret: string, kind: Kind, id: string) {
  return `${id}.${await hmacSha256Hex(secret, `${kind}:${id}`)}`
}

/** Returns the session id from a signed cookie, or null if absent / tampered. */
async function readSigned(c: Context<AppEnv>, name: string, kind: Kind): Promise<string | null> {
  const raw = getCookie(c, name)
  if (!raw) return null
  const dot = raw.indexOf('.')
  if (dot <= 0) return null
  const id = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  if (!/^[0-9A-Za-z]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(sig)) return null
  return (await verifyHmacHex(c.env.SESSION_SECRET, `${kind}:${id}`, sig)) ? id : null
}

function expiryIso() {
  return nowIso(Date.now() + SESSION_TTL_SECONDS * 1000)
}

/** New session id + the timestamps the row needs. Callers inline the INSERT (so it can be part
 *  of a db.batch) and call {@link finishMemberSession} once the batch resolves. */
export function newMemberSessionRow(memberId: string) {
  return {
    id: newToken(),
    memberId,
    expiresAt: expiryIso(),
    createdAt: nowIso(),
  }
}

/** Sets the signed cookie for a newly-inserted member session. */
export async function finishMemberSession(c: Context<AppEnv>, id: string): Promise<void> {
  setCookie(c, MEMBER_COOKIE, await signValue(c.env.SESSION_SECRET, 'member', id), cookieOptions(c))
}

export async function startMemberSession(c: Context<AppEnv>, memberId: string): Promise<void> {
  const row = newMemberSessionRow(memberId)
  await getDb(c.env).insert(memberSessions).values(row)
  await finishMemberSession(c, row.id)
}

/**
 * Loads the member in one JOIN query (session + member) instead of two sequential point lookups.
 * Selects only the columns handlers need via `c.get('member')` (no passwordHash / linkToken /
 * createdAt / lastLoginAt / rendersTotal). The expired-session row is deleted lazily when the
 * same cookie is presented again, just like the old implementation.
 */
export async function readMemberSession(c: Context<AppEnv>): Promise<SessionMember | null> {
  const sessionId = await readSigned(c, MEMBER_COOKIE, 'member')
  if (!sessionId) return null
  const db = getDb(c.env)
  const [row] = await db
    .select({
      id: members.id,
      displayName: members.displayName,
      expiresAt: members.expiresAt,
      disabled: members.disabled,
      renderLimit: members.renderLimit,
      sessionExpiresAt: memberSessions.expiresAt,
    })
    .from(memberSessions)
    .innerJoin(members, eq(members.id, memberSessions.memberId))
    .where(eq(memberSessions.id, sessionId))
    .limit(1)
  if (!row) return null
  if (row.sessionExpiresAt <= nowIso()) {
    await db.delete(memberSessions).where(eq(memberSessions.id, sessionId))
    return null
  }
  return {
    id: row.id,
    displayName: row.displayName,
    expiresAt: row.expiresAt,
    disabled: row.disabled,
    renderLimit: row.renderLimit,
  }
}

export async function endMemberSession(c: Context<AppEnv>): Promise<void> {
  const id = await readSigned(c, MEMBER_COOKIE, 'member')
  if (id) await getDb(c.env).delete(memberSessions).where(eq(memberSessions.id, id))
  deleteCookie(c, MEMBER_COOKIE, cookieOptions(c))
}

/** Mirrors {@link newMemberSessionRow} for the admin cookie. */
export function newAdminSessionRow() {
  return { id: newToken(), expiresAt: expiryIso() }
}

export async function finishAdminSession(c: Context<AppEnv>, id: string): Promise<void> {
  setCookie(c, ADMIN_COOKIE, await signValue(c.env.SESSION_SECRET, 'admin', id), cookieOptions(c))
}

export async function startAdminSession(c: Context<AppEnv>): Promise<void> {
  const row = newAdminSessionRow()
  await getDb(c.env).insert(adminSessions).values(row)
  await finishAdminSession(c, row.id)
}

export async function readAdminSession(c: Context<AppEnv>): Promise<boolean> {
  const id = await readSigned(c, ADMIN_COOKIE, 'admin')
  if (!id) return false
  const db = getDb(c.env)
  const row = await db.query.adminSessions.findFirst({ where: eq(adminSessions.id, id) })
  if (!row) return false
  if (row.expiresAt <= nowIso()) {
    await db.delete(adminSessions).where(eq(adminSessions.id, id))
    return false
  }
  return true
}

export async function endAdminSession(c: Context<AppEnv>): Promise<void> {
  const id = await readSigned(c, ADMIN_COOKIE, 'admin')
  if (id) await getDb(c.env).delete(adminSessions).where(eq(adminSessions.id, id))
  deleteCookie(c, ADMIN_COOKIE, cookieOptions(c))
}
