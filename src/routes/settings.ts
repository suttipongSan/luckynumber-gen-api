// Per-lottery CardSettings, stored server-side as JSON.
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv, CardSettings } from '../types'
import { getDb } from '../db/client'
import { cardSettings, lotteries } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { errors, parseJson } from '../lib/http'
import { nowIso } from '../lib/time'
import { cardSettingsSchema } from '../validation'

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

settingsRoutes.get('/settings', async (c) => {
  const rows = await getDb(c.env)
    .select()
    .from(cardSettings)
    .where(eq(cardSettings.memberId, c.get('member').id))
  const out: Record<string, CardSettings> = {}
  for (const r of rows) out[r.lotteryId] = parseSettingsJson(r.settingsJson)
  return c.json(out)
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
  const lotteryId = c.req.param('lotteryId')
  const body = await parseJson(c, cardSettingsSchema)
  const lottery = await db.query.lotteries.findFirst({ where: eq(lotteries.id, lotteryId) })
  if (!lottery) throw errors.notFound('ไม่พบหวย')
  const json = JSON.stringify(body)
  const updatedAt = nowIso()
  await db
    .insert(cardSettings)
    .values({ memberId: c.get('member').id, lotteryId, settingsJson: json, updatedAt })
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
