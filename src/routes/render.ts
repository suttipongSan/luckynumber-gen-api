// POST /render/numbers — the gate. Verifies session + expiry (middleware), enforces the
// 600/day limit, generates numbers server-side and returns short-lived signed asset URLs.
import { Hono } from 'hono'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AppEnv, CardNumbers, CardSettings } from '../types'
import { ASSET_URL_TTL_SECONDS, RENDERS_PER_DAY } from '../types'
import { getDb } from '../db/client'
import { chunk, IN_CHUNK } from '../lib/chunk'
import { assets, cardSettings, lotteries, members, renderCounters } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { errors, parseJson } from '../lib/http'
import { generateForSettings } from '../lib/numbers'
import { signedAssetUrl } from '../lib/crypto'
import { utcDay } from '../lib/time'
import { renderSchema } from '../validation'
import { parseSettingsJson } from './settings'

export const renderRoutes = new Hono<AppEnv>()

/** Public origin of this API, used to build absolute signed asset URLs. */
export function apiOrigin(reqUrl: string): string {
  return new URL(reqUrl).origin
}

renderRoutes.post('/render/numbers', requireMember(), async (c) => {
  const db = getDb(c.env)
  const member = c.get('member')
  const body = await parseJson(c, renderSchema)
  const n = body.items.length

  // Lotteries must exist (inactive ones are still allowed so saved sets keep working).
  const ids = Array.from(new Set(body.items.map((i) => i.lotteryId)))
  const found = await db.select({ id: lotteries.id }).from(lotteries).where(inArray(lotteries.id, ids))
  const known = new Set(found.map((r) => r.id))
  const missing = ids.filter((i) => !known.has(i))
  if (missing.length) throw errors.notFound(`ไม่พบหวย: ${missing.slice(0, 5).join(', ')}`)

  // Rate limit: increment first (atomic upsert), roll back if it went over the limit.
  const day = utcDay()
  const [counter] = await db
    .insert(renderCounters)
    .values({ memberId: member.id, day, count: n })
    .onConflictDoUpdate({
      target: [renderCounters.memberId, renderCounters.day],
      set: { count: sql`${renderCounters.count} + ${n}` },
    })
    .returning({ count: renderCounters.count })
  if (counter.count > RENDERS_PER_DAY) {
    await db
      .update(renderCounters)
      .set({ count: sql`${renderCounters.count} - ${n}` })
      .where(and(eq(renderCounters.memberId, member.id), eq(renderCounters.day, day)))
    throw errors.rateLimited(`ใช้งานครบ ${RENDERS_PER_DAY} ครั้งต่อวันแล้ว`)
  }
  await db
    .update(members)
    .set({ rendersTotal: sql`${members.rendersTotal} + ${n}` })
    .where(eq(members.id, member.id))

  // Saved settings for items without an override.
  const needSaved = ids.filter((id) => body.items.some((i) => i.lotteryId === id && !i.settings))
  const saved = new Map<string, CardSettings>()
  if (needSaved.length) {
    const rows = await db
      .select()
      .from(cardSettings)
      .where(and(eq(cardSettings.memberId, member.id), inArray(cardSettings.lotteryId, needSaved)))
    for (const r of rows) saved.set(r.lotteryId, parseSettingsJson(r.settingsJson))
  }

  const assetRefs = new Set<string>()
  const results: { lotteryId: string; numbers: CardNumbers }[] = body.items.map((item) => {
    const settings = (item.settings as CardSettings | undefined) ?? saved.get(item.lotteryId) ?? null
    if (settings?.backgroundAssetId) assetRefs.add(settings.backgroundAssetId)
    if (settings?.logo?.assetId) assetRefs.add(settings.logo.assetId)
    return { lotteryId: item.lotteryId, numbers: generateForSettings(settings, item.fixed) }
  })

  // Sign only assets that belong to this member.
  const signed: Record<string, string> = {}
  if (assetRefs.size) {
    const owned: { id: string }[] = []
    for (const part of chunk([...assetRefs], IN_CHUNK)) {
      owned.push(
        ...(await db
          .select({ id: assets.id })
          .from(assets)
          .where(and(eq(assets.memberId, member.id), inArray(assets.id, part)))),
      )
    }
    const origin = apiOrigin(c.req.url)
    for (const a of owned) {
      signed[a.id] = await signedAssetUrl(origin, c.env.ASSET_SIGNING_SECRET, a.id, ASSET_URL_TTL_SECONDS)
    }
  }

  return c.json({
    results,
    assets: signed,
    rendersToday: counter.count,
    rendersLimit: RENDERS_PER_DAY,
    date: body.date,
  })
})
