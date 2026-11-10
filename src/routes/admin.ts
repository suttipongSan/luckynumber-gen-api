// Back office API (operator). Cookie `ng_admin`; everything except login/logout requires it.
import { Hono } from 'hono'
import { and, asc, desc, eq, inArray, isNull, like, lt, or, sql } from 'drizzle-orm'
import type { AdminNews, AdminSettings, AppEnv } from '../types'
import { getDb, type DB } from '../db/client'
import {
  adminSessions,
  assets,
  cardSettings,
  loginAttempts,
  lotteries,
  memberSessions,
  members,
  news,
  newsReads,
  renderCounters,
  setLotteries,
  sets,
  siteSettings,
} from '../db/schema'
import { requireAdmin } from '../middleware/adminAuth'
import { errors, parseJson } from '../lib/http'
import { timingSafeEqualStr, verifyPassword } from '../lib/crypto'
import {
  endAdminSession,
  finishAdminSession,
  newAdminSessionRow,
} from '../lib/session'
import { adminKey, clearFailures, linkKey, lockRemaining, recordFailure } from '../lib/loginLimiter'
import { newId, newToken } from '../lib/ids'
import {
  CONTACT_LINE_ID,
  CONTACT_LINE_URL,
  CONTACT_TELEGRAM_ID,
  CONTACT_TELEGRAM_URL,
  DEFAULTS,
  getSiteSettings,
  parseDefaultRenderLimit,
  RENDER_LIMIT_DEFAULT,
  type SiteSettingKey,
} from '../lib/siteSettings'
import { nowIso, toIso, utcDay } from '../lib/time'
import { rendersTodayFor, rendersTodayMap, toAdminMember, toLottery } from '../lib/views'
import {
  adminLoginSchema,
  adminSettingsSchema,
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
  const session = newAdminSessionRow()
  // Independent writes in one round trip: session insert, lockout reset, and expired admin
  // session cleanup (the admin_sessions table is tiny so the full scan is fine). Lockout
  // semantics unchanged.
  await db.batch([
    db.insert(adminSessions).values(session),
    db.delete(adminSessions).where(lt(adminSessions.expiresAt, nowIso())),
    db.delete(loginAttempts).where(eq(loginAttempts.key, key)),
  ])
  await finishAdminSession(c, session.id)
  return c.body(null, 204)
})

adminRoutes.post('/logout', async (c) => {
  await endAdminSession(c)
  return c.body(null, 204)
})

adminRoutes.use('*', requireAdmin)

adminRoutes.get('/me', (c) => c.json({ username: c.get('adminUser') }))

// ---- members

/** Reads the admin-configured default render limit; returns RENDERS_PER_DAY on fallback. */
async function readDefaultRenderLimit(db: DB): Promise<number> {
  const row = await db.query.siteSettings.findFirst({
    where: eq(siteSettings.key, RENDER_LIMIT_DEFAULT),
  })
  return parseDefaultRenderLimit(row?.value ?? DEFAULTS[RENDER_LIMIT_DEFAULT])
}

async function adminMember(db: DB, id: string, webUrl: string, defaultLimit: number) {
  const row = await db.query.members.findFirst({ where: eq(members.id, id) })
  if (!row) throw errors.notFound('ไม่พบสมาชิก')
  return toAdminMember(row, await rendersTodayFor(db, id), webUrl, defaultLimit)
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
  const [today, defaultLimit] = await Promise.all([
    rendersTodayMap(
      db,
      rows.map((r) => r.id),
    ),
    readDefaultRenderLimit(db),
  ])
  return c.json(
    rows.map((r) => toAdminMember(r, today.get(r.id) ?? 0, c.env.WEB_URL, defaultLimit)),
  )
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
    renderLimit: null,
  }
  await db.insert(members).values(row)
  const defaultLimit = await readDefaultRenderLimit(db)
  return c.json(toAdminMember(row, 0, c.env.WEB_URL, defaultLimit))
})

adminRoutes.patch('/members/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const body = await parseJson(c, patchMemberSchema)
  const patch: Partial<typeof members.$inferInsert> = {}
  if (body.displayName !== undefined) patch.displayName = body.displayName
  if (body.expiresAt !== undefined) patch.expiresAt = toIso(body.expiresAt)
  if (body.disabled !== undefined) patch.disabled = body.disabled
  // `renderLimit: null` in the body means "clear override, fall back to the default".
  if (body.renderLimit !== undefined) patch.renderLimit = body.renderLimit
  if (Object.keys(patch).length) {
    const updated = await db
      .update(members)
      .set(patch)
      .where(eq(members.id, id))
      .returning({ id: members.id })
    if (updated.length === 0) throw errors.notFound('ไม่พบสมาชิก')
  }
  const defaultLimit = await readDefaultRenderLimit(db)
  return c.json(await adminMember(db, id, c.env.WEB_URL, defaultLimit))
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

/**
 * Resets today's (UTC) render counter for this member to 0, so they can keep using the
 * app after hitting the daily limit. Returns the updated AdminMember so the UI can refresh
 * the "สุ่มวันนี้" column without a second request.
 */
adminRoutes.post('/members/:id/reset-renders', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const row = await db.query.members.findFirst({ where: eq(members.id, id) })
  if (!row) throw errors.notFound('ไม่พบสมาชิก')
  const day = utcDay()
  // Upsert → the counter is always 0 for today afterwards, whether or not it existed.
  // Tests expect this ONE-ROW overwrite not to touch yesterday or other members.
  await db
    .insert(renderCounters)
    .values({ memberId: id, day, count: 0 })
    .onConflictDoUpdate({
      target: [renderCounters.memberId, renderCounters.day],
      set: { count: 0 },
    })
  const defaultLimit = await readDefaultRenderLimit(db)
  return c.json(await adminMember(db, id, c.env.WEB_URL, defaultLimit))
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
  // F5: also drop this member's custom lotteries and the set_lotteries / card_settings rows that
  // reference them (across all members, defence in depth — only this member can create them).
  const customLotteryIds = db
    .select({ id: lotteries.id })
    .from(lotteries)
    .where(eq(lotteries.ownerMemberId, id))
  await db.batch([
    db.delete(setLotteries).where(inArray(setLotteries.setId, setIds)),
    db.delete(setLotteries).where(inArray(setLotteries.lotteryId, customLotteryIds)),
    db.delete(cardSettings).where(inArray(cardSettings.lotteryId, customLotteryIds)),
    db.delete(sets).where(eq(sets.memberId, id)),
    db.delete(cardSettings).where(eq(cardSettings.memberId, id)),
    db.delete(assets).where(eq(assets.memberId, id)),
    db.delete(newsReads).where(eq(newsReads.memberId, id)),
    db.delete(renderCounters).where(eq(renderCounters.memberId, id)),
    db.delete(memberSessions).where(eq(memberSessions.memberId, id)),
    db.delete(lotteries).where(eq(lotteries.ownerMemberId, id)),
    db.delete(members).where(eq(members.id, id)),
  ])
  await clearFailures(db, linkKey(row.linkToken))
  return c.body(null, 204)
})

// ---- lotteries

// Admin only ever manages the global catalog (owner_member_id IS NULL). Member-created custom
// lotteries live on the same table but are invisible here.
adminRoutes.get('/lotteries', async (c) => {
  const rows = await getDb(c.env)
    .select()
    .from(lotteries)
    .where(isNull(lotteries.ownerMemberId))
    .orderBy(asc(lotteries.sortOrder), asc(lotteries.name))
  return c.json(rows.map((r) => toLottery(r)))
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
    ownerMemberId: null,
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
    await db
      .update(lotteries)
      .set(patch)
      .where(and(eq(lotteries.id, id), isNull(lotteries.ownerMemberId)))
  }
  const row = await db.query.lotteries.findFirst({
    where: and(eq(lotteries.id, id), isNull(lotteries.ownerMemberId)),
  })
  if (!row) throw errors.notFound('ไม่พบหวย')
  return c.json(toLottery(row))
})

adminRoutes.delete('/lotteries/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const row = await db.query.lotteries.findFirst({
    where: and(eq(lotteries.id, id), isNull(lotteries.ownerMemberId)),
  })
  if (!row) throw errors.notFound('ไม่พบหวย')
  await db.batch([
    db.delete(setLotteries).where(eq(setLotteries.lotteryId, id)),
    db.delete(cardSettings).where(eq(cardSettings.lotteryId, id)),
    db.delete(lotteries).where(and(eq(lotteries.id, id), isNull(lotteries.ownerMemberId))),
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

// ---- settings (contact info + default render limit)

function toAdminSettings(map: Record<string, string>): AdminSettings {
  return {
    contactLineId: map[CONTACT_LINE_ID] ?? '',
    contactLineUrl: map[CONTACT_LINE_URL] ?? '',
    contactTelegramId: map[CONTACT_TELEGRAM_ID] ?? '',
    contactTelegramUrl: map[CONTACT_TELEGRAM_URL] ?? '',
    renderLimitDefault: parseDefaultRenderLimit(map[RENDER_LIMIT_DEFAULT]),
  }
}

adminRoutes.get('/settings', async (c) => {
  const db = getDb(c.env)
  const map = await getSiteSettings(db)
  return c.json(toAdminSettings(map))
})

adminRoutes.put('/settings', async (c) => {
  const db = getDb(c.env)
  const body = await parseJson(c, adminSettingsSchema)
  const updatedAt = nowIso()
  const rows: { key: SiteSettingKey; value: string; updatedAt: string }[] = [
    { key: CONTACT_LINE_ID, value: body.contactLineId, updatedAt },
    { key: CONTACT_LINE_URL, value: body.contactLineUrl, updatedAt },
    { key: CONTACT_TELEGRAM_ID, value: body.contactTelegramId, updatedAt },
    { key: CONTACT_TELEGRAM_URL, value: body.contactTelegramUrl, updatedAt },
    { key: RENDER_LIMIT_DEFAULT, value: String(body.renderLimitDefault), updatedAt },
  ]
  // Single multi-row upsert: 5 rows × 3 params = 15 bound params, well under the 100-cap
  // and 50-stmt-per-request limits. Keeping it atomic avoids half-persisted settings.
  await db
    .insert(siteSettings)
    .values(rows)
    .onConflictDoUpdate({
      target: [siteSettings.key],
      set: {
        value: sql`excluded.value`,
        updatedAt: sql`excluded.updated_at`,
      },
    })
  const map = await getSiteSettings(db)
  return c.json(toAdminSettings(map))
})
