// Cookie sessions. Cookie value = `<sessionId>.<hex HMAC-SHA256(SESSION_SECRET, kind:sessionId)>`;
// the session row (with its own 24 h expiry, never refreshed) is the source of truth.
import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../types'
import { SESSION_TTL_SECONDS } from '../types'
import { getDb } from '../db/client'
import { memberSessions, adminSessions } from '../db/schema'
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

export async function startMemberSession(c: Context<AppEnv>, memberId: string): Promise<void> {
  const db = getDb(c.env)
  const id = newToken()
  await db.insert(memberSessions).values({
    id,
    memberId,
    expiresAt: expiryIso(),
    createdAt: nowIso(),
  })
  setCookie(c, MEMBER_COOKIE, await signValue(c.env.SESSION_SECRET, 'member', id), cookieOptions(c))
}

/** Returns the memberId of a valid (unexpired) session, or null. */
export async function readMemberSession(c: Context<AppEnv>): Promise<string | null> {
  const id = await readSigned(c, MEMBER_COOKIE, 'member')
  if (!id) return null
  const db = getDb(c.env)
  const row = await db.query.memberSessions.findFirst({ where: eq(memberSessions.id, id) })
  if (!row) return null
  if (row.expiresAt <= nowIso()) {
    await db.delete(memberSessions).where(eq(memberSessions.id, id))
    return null
  }
  return row.memberId
}

export async function endMemberSession(c: Context<AppEnv>): Promise<void> {
  const id = await readSigned(c, MEMBER_COOKIE, 'member')
  if (id) await getDb(c.env).delete(memberSessions).where(eq(memberSessions.id, id))
  deleteCookie(c, MEMBER_COOKIE, cookieOptions(c))
}

export async function startAdminSession(c: Context<AppEnv>): Promise<void> {
  const id = newToken()
  await getDb(c.env).insert(adminSessions).values({ id, expiresAt: expiryIso() })
  setCookie(c, ADMIN_COOKIE, await signValue(c.env.SESSION_SECRET, 'admin', id), cookieOptions(c))
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
