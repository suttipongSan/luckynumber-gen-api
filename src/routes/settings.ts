// Per-lottery CardSettings, stored server-side as JSON.
import { Hono } from 'hono'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { AppEnv, CardSettings } from '../types'
import { getDb } from '../db/client'
import { cardSettings, lotteries } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { errors, parseJson, parseJsonLimited } from '../lib/http'
import { nowIso } from '../lib/time'
import { bulkSettingsSchema, cardSettingsSchema, MAX_BULK_SETTINGS_BYTES } from '../validation'
import { memberLotteryIds } from '../lib/views'

export const settingsRoutes = new Hono<AppEnv>()
settingsRoutes.use('/settings', requireMember())
settingsRoutes.use('/settings/*', requireMember())

export function parseSettingsJson(json: string): CardSettings {
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? (v as CardSettings) : {}
  } catch {
    return {}
  }
}

// D1 limits (free plan): ≤ 100 bound parameters per statement and ≤ 50 statements per request.
// Each card_settings row binds 4 params, so 20 rows = 80 params. 90 KB of JSON per INSERT keeps
// the whole payload compact; a full set of 80 lotteries still fits in ≤ 4 statements per batch.
export const SETTINGS_MAX_ROWS_PER_INSERT = 20
export const SETTINGS_MAX_BYTES_PER_INSERT = 90 * 1024

export interface SettingsRow {
  memberId: string
  lotteryId: string
  settingsJson: string
  updatedAt: string
}

/**
 * Splits settings rows into chunks so each INSERT has at most
 * {@link SETTINGS_MAX_ROWS_PER_INSERT} rows AND at most
 * {@link SETTINGS_MAX_BYTES_PER_INSERT} of `settings_json`.
 * A single oversized row (should be caught by the per-item 32 KB zod cap) still gets its own chunk.
 */
export function chunkSettingsRows(rows: readonly SettingsRow[]): SettingsRow[][] {
  const out: SettingsRow[][] = []
  let cur: SettingsRow[] = []
  let curBytes = 0
  for (const r of rows) {
    const b = new TextEncoder().encode(r.settingsJson).length
    const overRows = cur.length >= SETTINGS_MAX_ROWS_PER_INSERT
    const overBytes = cur.length > 0 && curBytes + b > SETTINGS_MAX_BYTES_PER_INSERT
    if (cur.length > 0 && (overRows || overBytes)) {
      out.push(cur)
      cur = []
      curBytes = 0
    }
    cur.push(r)
    curBytes += b
  }
  if (cur.length > 0) out.push(cur)
  return out
}

settingsRoutes.get('/settings', async (c) => {
  const rows = await getDb(c.env)
    .select()
    .from(cardSettings)
    .where(eq(cardSettings.memberId, c.get('member').id))
  const out: Record<string, CardSettings> = {}
  for (const r of rows) out[r.lotteryId] = parseSettingsJson(r.settingsJson)
  return c.json(out)
})

settingsRoutes.put('/settings', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const body = await parseJsonLimited(c, bulkSettingsSchema, MAX_BULK_SETTINGS_BYTES)
  const ids = body.items.map((it) => it.lotteryId)
  const valid = await memberLotteryIds(db, memberId, ids)
  const unknown = ids.filter((i) => !valid.has(i))
  if (unknown.length) {
    throw errors.validation(`ไม่พบหวย: ${unknown.slice(0, 5).join(', ')}`)
  }
  const updatedAt = nowIso()
  const rows: SettingsRow[] = body.items.map((it) => ({
    memberId,
    lotteryId: it.lotteryId,
    settingsJson: JSON.stringify(it.settings),
    updatedAt,
  }))
  const chunks = chunkSettingsRows(rows)
  const stmts = chunks.map((part) =>
    db
      .insert(cardSettings)
      .values(part)
      .onConflictDoUpdate({
        target: [cardSettings.memberId, cardSettings.lotteryId],
        set: {
          settingsJson: sql`excluded.settings_json`,
          updatedAt: sql`excluded.updated_at`,
        },
      }),
  )
  if (stmts.length) {
    await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]])
  }
  const out: Record<string, CardSettings> = {}
  for (const it of body.items) out[it.lotteryId] = it.settings
  return c.json({ settings: out })
})

settingsRoutes.get('/settings/:lotteryId', async (c) => {
  const row = await getDb(c.env).query.cardSettings.findFirst({
    where: and(
      eq(cardSettings.memberId, c.get('member').id),
      eq(cardSettings.lotteryId, c.req.param('lotteryId')),
    ),
  })
  if (!row) throw errors.notFound('ยังไม่มีการตั้งค่า')
  return c.json(parseSettingsJson(row.settingsJson))
})

settingsRoutes.put('/settings/:lotteryId', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const lotteryId = c.req.param('lotteryId')
  const body = await parseJson(c, cardSettingsSchema)
  const lottery = await db.query.lotteries.findFirst({
    where: and(
      eq(lotteries.id, lotteryId),
      or(isNull(lotteries.ownerMemberId), eq(lotteries.ownerMemberId, memberId)),
    ),
  })
  if (!lottery) throw errors.notFound('ไม่พบหวย')
  const json = JSON.stringify(body)
  const updatedAt = nowIso()
  await db
    .insert(cardSettings)
    .values({ memberId, lotteryId, settingsJson: json, updatedAt })
    .onConflictDoUpdate({
      target: [cardSettings.memberId, cardSettings.lotteryId],
      set: { settingsJson: json, updatedAt },
    })
  return c.json(body)
})

settingsRoutes.delete('/settings/:lotteryId', async (c) => {
  await getDb(c.env)
    .delete(cardSettings)
    .where(
      and(
        eq(cardSettings.memberId, c.get('member').id),
        eq(cardSettings.lotteryId, c.req.param('lotteryId')),
      ),
    )
  return c.body(null, 204)
})
