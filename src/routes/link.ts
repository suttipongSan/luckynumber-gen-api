// Member link entry: GET /link/:token, set-password, login; plus /logout.
import { Hono } from 'hono'
import { and, eq, isNull, lt } from 'drizzle-orm'
import type { AppEnv } from '../types'
import { getDb } from '../db/client'
import { loginAttempts, memberSessions, members } from '../db/schema'
import { ApiError, errors, parseJson } from '../lib/http'
import { hashPassword, verifyPassword } from '../lib/crypto'
import {
  endMemberSession,
  finishMemberSession,
  newMemberSessionRow,
} from '../lib/session'
import { linkKey, lockRemaining, recordFailure } from '../lib/loginLimiter'
import { isExpired, nowIso } from '../lib/time'
import { loginPasswordSchema, passwordSchema } from '../validation'

export const linkRoutes = new Hono<AppEnv>()

async function findByToken(c: { env: AppEnv['Bindings'] }, token: string) {
  if (!/^[0-9A-Za-z]{8,64}$/.test(token)) return undefined
  return getDb(c.env).query.members.findFirst({ where: eq(members.linkToken, token) })
}

function lockedError(ms: number) {
  const minutes = Math.ceil(ms / 60000)
  return errors.rateLimited(`ใส่รหัสผ่านผิดหลายครั้ง กรุณาลองใหม่ใน ${minutes} นาที`)
}

linkRoutes.get('/link/:token', async (c) => {
  const m = await findByToken(c, c.req.param('token'))
  if (!m) throw errors.notFound('ไม่พบลิงก์นี้')
  return c.json({
    displayName: m.displayName,
    hasPassword: m.passwordHash !== null,
    expiresAt: m.expiresAt,
    expired: isExpired(m.expiresAt),
    disabled: m.disabled,
  })
})

linkRoutes.post('/link/:token/set-password', async (c) => {
  const db = getDb(c.env)
  const m = await findByToken(c, c.req.param('token'))
  if (!m) throw errors.notFound('ไม่พบลิงก์นี้')
  const { password } = await parseJson(c, passwordSchema)
  if (m.passwordHash !== null) throw errors.conflict('PASSWORD_ALREADY_SET', 'ตั้งรหัสผ่านไปแล้ว')
  const hash = await hashPassword(password)
  // Guard against a concurrent set-password: only update while still unset.
  const updated = await db
    .update(members)
    .set({ passwordHash: hash, lastLoginAt: nowIso() })
    .where(and(eq(members.id, m.id), isNull(members.passwordHash)))
    .returning({ id: members.id })
  if (updated.length === 0) throw errors.conflict('PASSWORD_ALREADY_SET', 'ตั้งรหัสผ่านไปแล้ว')
  const session = newMemberSessionRow(m.id)
  // Independent writes in one round trip. The expired-session cleanup is scoped to this member
  // so the session tables do not grow unbounded (the 24 h cookie drops before the lazy delete
  // in readMemberSession ever fires).
  await db.batch([
    db.insert(memberSessions).values(session),
    db
      .delete(memberSessions)
      .where(
        and(eq(memberSessions.memberId, m.id), lt(memberSessions.expiresAt, nowIso())),
      ),
    db.delete(loginAttempts).where(eq(loginAttempts.key, linkKey(m.linkToken))),
  ])
  await finishMemberSession(c, session.id)
  return c.body(null, 204)
})

linkRoutes.post('/link/:token/login', async (c) => {
  const db = getDb(c.env)
  const m = await findByToken(c, c.req.param('token'))
  if (!m) throw errors.notFound('ไม่พบลิงก์นี้')
  const key = linkKey(m.linkToken)
  const locked = await lockRemaining(db, key)
  if (locked > 0) throw lockedError(locked)
  const { password } = await parseJson(c, loginPasswordSchema)
  if (m.passwordHash === null) {
    throw errors.conflict('PASSWORD_NOT_SET', 'ยังไม่ได้ตั้งรหัสผ่าน')
  }
  if (!(await verifyPassword(password, m.passwordHash))) {
    if (await recordFailure(db, key)) throw lockedError(await lockRemaining(db, key))
    throw new ApiError(401, 'BAD_PASSWORD', 'รหัสผ่านไม่ถูกต้อง')
  }
  const session = newMemberSessionRow(m.id)
  // Independent writes in one round trip: session insert, last_login_at bump, lockout reset,
  // and this member's expired sessions cleanup. Lockout semantics unchanged.
  await db.batch([
    db.insert(memberSessions).values(session),
    db
      .delete(memberSessions)
      .where(
        and(eq(memberSessions.memberId, m.id), lt(memberSessions.expiresAt, nowIso())),
      ),
    db.update(members).set({ lastLoginAt: nowIso() }).where(eq(members.id, m.id)),
    db.delete(loginAttempts).where(eq(loginAttempts.key, key)),
  ])
  await finishMemberSession(c, session.id)
  return c.body(null, 204)
})

linkRoutes.post('/logout', async (c) => {
  await endMemberSession(c)
  return c.body(null, 204)
})
