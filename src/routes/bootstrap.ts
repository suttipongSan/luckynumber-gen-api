// GET /bootstrap — single call used by the SPA on page load instead of 6 separate endpoints.
// Member auth, but like GET /me it also answers for expired / disabled members (allowInactive).
// Shape:
//   active member  -> { me, lotteries, sets, settings, assets, news }
//   inactive member -> { me, news }   (same two endpoints that stay open on /me / /news today)
// Each field uses exactly the same shape as its individual endpoint, so a web client can
// replace the per-endpoint fan-out without any other change.
import { Hono } from 'hono'
import { and, asc, eq, isNull, or } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { AppEnv, Asset, CardSettings, Lottery, Member, News } from '../types'
import { getDb, type DB } from '../db/client'
import {
  assets as assetsTable,
  cardSettings,
  lotteries,
  renderCounters,
  setLotteries,
  sets as setsTable,
  siteSettings,
} from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import {
  DEFAULTS,
  parseDefaultRenderLimit,
  RENDER_LIMIT_DEFAULT,
} from '../lib/siteSettings'
import { isExpired, nowIso, bangkokDay } from '../lib/time'
import { toMember } from '../lib/views'
import { parseSettingsJson } from './settings'
import { sortLotteriesForMember } from './lotteries'
import {
  buildSets,
  ensureDefault,
  loadSetsAndLinks,
  type LinkRow,
  type SetRow,
} from './sets'
import { toNewsList, unreadNewsQuery } from './news'
import { buildAssetsResponse } from './assets'
import { apiOrigin } from './render'

type BatchSqlite = BatchItem<'sqlite'>
type LotteryRow = typeof lotteries.$inferSelect
type CardSettingsRow = typeof cardSettings.$inferSelect
type AssetRow = typeof assetsTable.$inferSelect
type NewsRow = typeof import('../db/schema').news.$inferSelect

interface BootstrapInactive {
  me: Member
  news: News[]
}
interface BootstrapActive {
  me: Member
  lotteries: Lottery[]
  sets: ReturnType<typeof buildSets>
  settings: Record<string, CardSettings>
  assets: Asset[]
  news: News[]
}
type BootstrapResponse = BootstrapInactive | BootstrapActive

export const bootstrapRoutes = new Hono<AppEnv>()

bootstrapRoutes.get('/bootstrap', requireMember({ allowInactive: true }), async (c) => {
  const db = getDb(c.env)
  const member = c.get('member')
  const inactive = member.disabled || isExpired(member.expiresAt)

  // Inactive members behave like today's /me + /news: no catalog, no sets, no settings, no
  // assets. One batch of three reads keeps it to a single D1 round trip (same shape as the
  // two endpoints would return independently, plus the admin default render limit for
  // rendersLimit on the lock screen).
  if (inactive) {
    const counterQ = db
      .select({ count: renderCounters.count })
      .from(renderCounters)
      .where(
        and(
          eq(renderCounters.memberId, member.id),
          eq(renderCounters.day, bangkokDay()),
        ),
      )
    const defaultLimitQ = db
      .select({ value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, RENDER_LIMIT_DEFAULT))
    const newsQ = unreadNewsQuery(db, member.id, nowIso())
    const res = (await db.batch([counterQ, defaultLimitQ, newsQ] as [
      BatchSqlite,
      BatchSqlite,
      BatchSqlite,
    ])) as unknown[]
    const counterRows = res[0] as { count: number }[]
    const defaultLimitRows = res[1] as { value: string }[]
    const newsRows = res[2] as NewsRow[]
    const defaultLimit = parseDefaultRenderLimit(
      defaultLimitRows[0]?.value ?? DEFAULTS[RENDER_LIMIT_DEFAULT],
    )
    const payload: BootstrapInactive = {
      me: toMember(member, counterRows[0]?.count ?? 0, defaultLimit),
      news: toNewsList(newsRows),
    }
    return c.json(payload)
  }

  // Active member: one big read batch (1 round trip) across all six endpoints plus the
  // admin-configured default render limit. On the very first visit the batch sees no
  // is_default set and we fall into the starter-set path, which reuses the sets-route
  // helpers: ensureDefault (1 round trip) + loadSetsAndLinks (1 more) = 3 round trips total
  // on first load, 1 afterwards.
  const counterQ = db
    .select({ count: renderCounters.count })
    .from(renderCounters)
    .where(and(eq(renderCounters.memberId, member.id), eq(renderCounters.day, bangkokDay())))
  const lotteriesQ = db
    .select()
    .from(lotteries)
    .where(
      or(
        and(isNull(lotteries.ownerMemberId), eq(lotteries.active, true)),
        eq(lotteries.ownerMemberId, member.id),
      ),
    )
  // The two sets queries mirror loadSetsAndLinks (sets then set_lotteries joined to sets) so
  // their results feed buildSets unchanged — no re-sort or de-dupe needed here.
  const setsQ = db
    .select()
    .from(setsTable)
    .where(eq(setsTable.memberId, member.id))
    .orderBy(setsTable.createdAt, setsTable.id)
  const linksQ = db
    .select({
      setId: setLotteries.setId,
      lotteryId: setLotteries.lotteryId,
      sortOrder: setLotteries.sortOrder,
      round: setLotteries.round,
    })
    .from(setLotteries)
    .innerJoin(setsTable, eq(setsTable.id, setLotteries.setId))
    .where(eq(setsTable.memberId, member.id))
  const settingsQ = db
    .select()
    .from(cardSettings)
    .where(eq(cardSettings.memberId, member.id))
  const assetsQ = db
    .select()
    .from(assetsTable)
    .where(eq(assetsTable.memberId, member.id))
    .orderBy(asc(assetsTable.createdAt))
  const newsQ = unreadNewsQuery(db, member.id, nowIso())
  const defaultLimitQ = db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, RENDER_LIMIT_DEFAULT))

  const results = (await db.batch([
    counterQ,
    lotteriesQ,
    setsQ,
    linksQ,
    settingsQ,
    assetsQ,
    newsQ,
    defaultLimitQ,
  ] as [
    BatchSqlite,
    BatchSqlite,
    BatchSqlite,
    BatchSqlite,
    BatchSqlite,
    BatchSqlite,
    BatchSqlite,
    BatchSqlite,
  ])) as unknown[]

  const counterRows = results[0] as { count: number }[]
  const lotteryRows = results[1] as LotteryRow[]
  let setRows = results[2] as SetRow[]
  let linkRows = results[3] as LinkRow[]
  const settingsRows = results[4] as CardSettingsRow[]
  const assetRows = results[5] as AssetRow[]
  const newsRows = results[6] as NewsRow[]
  const defaultLimitRows = results[7] as { value: string }[]
  const defaultLimit = parseDefaultRenderLimit(
    defaultLimitRows[0]?.value ?? DEFAULTS[RENDER_LIMIT_DEFAULT],
  )

  // Starter-set creation only when no default row was returned by the batch (same trigger as
  // GET /sets). ensureDefault retries safely on the unique-index race, then we re-read with
  // the same helper the sets route uses so the shape stays identical.
  if (!setRows.some((r) => r.isDefault)) {
    await ensureDefault(db, member.id)
    const reloaded = await loadSetsAndLinks(db, member.id)
    setRows = reloaded.rows
    linkRows = reloaded.links
  }

  const settings: Record<string, CardSettings> = {}
  for (const r of settingsRows) settings[r.lotteryId] = parseSettingsJson(r.settingsJson)

  const assetsOut = await buildAssetsResponse(
    apiOrigin(c.req.url),
    c.env.ASSET_SIGNING_SECRET,
    member.id,
    assetRows,
  )

  const payload: BootstrapActive = {
    me: toMember(member, counterRows[0]?.count ?? 0, defaultLimit),
    lotteries: sortLotteriesForMember(lotteryRows, member.id),
    sets: buildSets(setRows, linkRows),
    settings,
    assets: assetsOut,
    news: toNewsList(newsRows),
  }
  return c.json(payload)
})

export type { BootstrapResponse }
