// Back office API (operator). Cookie `ng_admin`; everything except login/logout requires it.
import { Hono } from 'hono'
import { asc, desc, eq, inArray, like, or } from 'drizzle-orm'
import type { AdminNews, AppEnv } from '../types'
import { getDb, type DB } from '../db/client'
import {
  assets,
  cardSettings,
  lotteries,
  memberSessions,
  members,
  news,
  newsReads,
  renderCounters,
  setLotteries,
  sets,
} from '../db/schema'
import { requireAdmin } from '../middleware/adminAuth'
import { errors, parseJson } from '../lib/http'
import { timingSafeEqualStr, verifyPassword } from '../lib/crypto'
import { endAdminSession, startAdminSession } from '../lib/session'
import { adminKey, clearFailures, linkKey, lockRemaining, recordFailure } from '../lib/loginLimiter'
import { newId, newToken } from '../lib/ids'
import { nowIso, toIso } from '../lib/time'
import { rendersTodayFor, rendersTodayMap, toAdminMember, toLottery } from '../lib/views'
import {
  adminLoginSchema,
  createMemberSchema,
  lotterySchema,
  newsSchema,
  patchLotterySchema,
  patchMemberSchema,
  patchNewsSchema,
} from '../validation'

export const adminRoutes = new Hono<AppEnv>()

// ---- auth

function lockedError(ms: number) {
  return errors.rateLimited(
    `ใส่รหัสผ่านผิดหลายครั้ง กรุณาลองใหม่ใน ${Math.ceil(ms / 60000)} นาที`,
  )
}

adminRoutes.post('/login', async (c) => {
  const db = getDb(c.env)
  // Same 5 tries / 15 min lock as member links, keyed by the client IP (Cloudflare sets
  // CF-Connecting-IP; it cannot be spoofed through the edge).
  const key = adminKey(c.req.header('CF-Connecting-IP') ?? 'local')
  const locked = await lockRemaining(db, key)
  if (locked > 0) throw lockedError(locked)
  const { username, password } = await parseJson(c, adminLoginSchema)
  const userOk = timingSafeEqualStr(username, c.env.ADMIN_USERNAME ?? '')
  const passOk = await verifyPassword(password, c.env.ADMIN_PASSWORD_HASH)
  if (!userOk || !passOk) {
    if (await recordFailure(db, key)) throw lockedError(await lockRemaining(db, key))
    throw errors.unauthenticated('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
  }
  await clearFailures(db, key)
  await startAdminSession(c)
  return c.body(null, 204)
})

adminRoutes.post('/logout', async (c) => {
  await endAdminSession(c)
  return c.body(null, 204)
})

adminRoutes.use('*', requireAdmin)

adminRoutes.get('/me', (c) => c.json({ username: c.get('adminUser') }))

// ---- members

async function adminMember(db: DB, id: string, webUrl: string) {
  const row = await db.query.members.findFirst({ where: eq(members.id, id) })
  if (!row) throw errors.notFound('ไม่พบสมาชิก')
  return toAdminMember(row, await rendersTodayFor(db, id), webUrl)
}

adminRoutes.get('/members', async (c) => {
  const db = getDb(c.env)
  const q = (c.req.query('q') ?? '').trim()
  const pattern = `%${q.replace(/[%_]/g, '')}%`
  const rows = await db
    .select()
    .from(members)
    .where(q ? or(like(members.displayName, pattern), like(members.linkToken, pattern)) : undefined)
    .orderBy(desc(members.createdAt))
  const today = await rendersTodayMap(
    db,
    rows.map((r) => r.id),
  )
  return c.json(rows.map((r) => toAdminMember(r, today.get(r.id) ?? 0, c.env.WEB_URL)))
})

adminRoutes.post('/members', async (c) => {
  const db = getDb(c.env)
  const body = await parseJson(c, createMemberSchema)
  const row = {
    id: newId(),
    displayName: body.displayName,
    linkToken: newToken(),
    passwordHash: null,
    expiresAt: toIso(body.expiresAt),
    disabled: false,
    lastLoginAt: null,
    createdAt: nowIso(),
    rendersTotal: 0,
  }
  await db.insert(members).values(row)
  return c.json(toAdminMember(row, 0, c.env.WEB_URL))
})

adminRoutes.patch('/members/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const body = await parseJson(c, patchMemberSchema)
  const patch: Partial<typeof members.$inferInsert> = {}
  if (body.displayName !== undefined) patch.displayName = body.displayName
  if (body.expiresAt !== undefined) patch.expiresAt = toIso(body.expiresAt)
  if (body.disabled !== undefined) patch.disabled = body.disabled
  if (Object.keys(patch).length) {
    const updated = await db
      .update(members)
      .set(patch)
      .where(eq(members.id, id))
      .returning({ id: members.id })
    if (updated.length === 0) throw errors.notFound('ไม่พบสมาชิก')
  }
  return c.json(await adminMember(db, id, c.env.WEB_URL))
})

adminRoutes.post('/members/:id/reset-password', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const row = await db.query.members.findFirst({ where: eq(members.id, id) })
  if (!row) throw errors.notFound('ไม่พบสมาชิก')
  await db.batch([
    db.update(members).set({ passwordHash: null }).where(eq(members.id, id)),
    db.delete(memberSessions).where(eq(memberSessions.memberId, id)),
  ])
  await clearFailures(db, linkKey(row.linkToken))
  return c.body(null, 204)
})

adminRoutes.delete('/members/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const row = await db.query.members.findFirst({ where: eq(members.id, id) })
  if (!row) throw errors.notFound('ไม่พบสมาชิก')
  const files = await db.select({ r2Key: assets.r2Key }).from(assets).where(eq(assets.memberId, id))
  if (files.length) {
    // R2 delete accepts up to 1000 keys per call.
    for (let i = 0; i < files.length; i += 1000) {
      await c.env.ASSETS.delete(files.slice(i, i + 1000).map((f) => f.r2Key))
    }
  }
  const setIds = db.select({ id: sets.id }).from(sets).where(eq(sets.memberId, id))
  await db.batch([
    db.delete(setLotteries).where(inArray(setLotteries.setId, setIds)),
    db.delete(sets).where(eq(sets.memberId, id)),
    db.delete(cardSettings).where(eq(cardSettings.memberId, id)),
    db.delete(assets).where(eq(assets.memberId, id)),
    db.delete(newsReads).where(eq(newsReads.memberId, id)),
    db.delete(renderCounters).where(eq(renderCounters.memberId, id)),
    db.delete(memberSessions).where(eq(memberSessions.memberId, id)),
    db.delete(members).where(eq(members.id, id)),
  ])
  await clearFailures(db, linkKey(row.linkToken))
  return c.body(null, 204)
})

// ---- lotteries

adminRoutes.get('/lotteries', async (c) => {
  const rows = await getDb(c.env)
    .select()
    .from(lotteries)
    .orderBy(asc(lotteries.sortOrder), asc(lotteries.name))
  return c.json(rows.map(toLottery))
})

adminRoutes.post('/lotteries', async (c) => {
  const db = getDb(c.env)
  const body = await parseJson(c, lotterySchema)
  const row = {
    id: newId(),
    name: body.name,
    shortName: body.shortName,
    groupKey: body.group,
    accent: body.accent,
    sortOrder: body.sortOrder,
    active: body.active,
  }
  await db.insert(lotteries).values(row)
  return c.json(toLottery(row))
})

adminRoutes.patch('/lotteries/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const body = await parseJson(c, patchLotterySchema)
  const patch: Partial<typeof lotteries.$inferInsert> = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.shortName !== undefined) patch.shortName = body.shortName
  if (body.group !== undefined) patch.groupKey = body.group
  if (body.accent !== undefined) patch.accent = body.accent
  if (body.sortOrder !== undefined) patch.sortOrder = body.sortOrder
  if (body.active !== undefined) patch.active = body.active
  if (Object.keys(patch).length) {
    await db.update(lotteries).set(patch).where(eq(lotteries.id, id))
  }
  const row = await db.query.lotteries.findFirst({ where: eq(lotteries.id, id) })
  if (!row) throw errors.notFound('ไม่พบหวย')
  return c.json(toLottery(row))
})

adminRoutes.delete('/lotteries/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const row = await db.query.lotteries.findFirst({ where: eq(lotteries.id, id) })
  if (!row) throw errors.notFound('ไม่พบหวย')
  await db.batch([
    db.delete(setLotteries).where(eq(setLotteries.lotteryId, id)),
    db.delete(cardSettings).where(eq(cardSettings.lotteryId, id)),
    db.delete(lotteries).where(eq(lotteries.id, id)),
  ])
  return c.body(null, 204)
})

// ---- news

type NewsRow = typeof news.$inferSelect
const toAdminNews = (r: NewsRow): AdminNews => ({
  id: r.id,
  title: r.title,
  detailHtml: r.detailHtml,
  publishedAt: r.publishedAt,
  active: r.active,
})

adminRoutes.get('/news', async (c) => {
  const rows = await getDb(c.env).select().from(news).orderBy(desc(news.publishedAt))
  return c.json(rows.map(toAdminNews))
})

adminRoutes.post('/news', async (c) => {
  const body = await parseJson(c, newsSchema)
  const row: NewsRow = {
    id: newId(),
    title: body.title,
    detailHtml: body.detailHtml,
    publishedAt: toIso(body.publishedAt),
    active: body.active,
  }
  await getDb(c.env).insert(news).values(row)
  return c.json(toAdminNews(row))
})

adminRoutes.patch('/news/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const body = await parseJson(c, patchNewsSchema)
  const patch: Partial<NewsRow> = {}
  if (body.title !== undefined) patch.title = body.title
  if (body.detailHtml !== undefined) patch.detailHtml = body.detailHtml
  if (body.publishedAt !== undefined) patch.publishedAt = toIso(body.publishedAt)
  if (body.active !== undefined) patch.active = body.active
  if (Object.keys(patch).length) await db.update(news).set(patch).where(eq(news.id, id))
  const row = await db.query.news.findFirst({ where: eq(news.id, id) })
  if (!row) throw errors.notFound()
  return c.json(toAdminNews(row))
})

adminRoutes.delete('/news/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const row = await db.query.news.findFirst({ where: eq(news.id, id) })
  if (!row) throw errors.notFound()
  await db.batch([
    db.delete(newsReads).where(eq(newsReads.newsId, id)),
    db.delete(news).where(eq(news.id, id)),
  ])
  return c.body(null, 204)
})
