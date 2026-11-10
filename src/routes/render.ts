// POST /render/numbers — the gate. Verifies session + expiry (middleware), enforces the
// per-member daily limit (members.render_limit ?? site_settings.render_limit_default ??
// RENDERS_PER_DAY), generates numbers server-side and returns short-lived signed asset URLs.
import { Hono } from 'hono'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { AppEnv, CardNumbers, CardSettings } from '../types'
import { getDb } from '../db/client'
import { assets, cardSettings, lotteries, members, renderCounters, siteSettings } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { errors, parseJson } from '../lib/http'
import { generateForSettings } from '../lib/numbers'
import { signedAssetUrl } from '../lib/crypto'
import {
  DEFAULTS,
  effectiveRenderLimit,
  parseDefaultRenderLimit,
  RENDER_LIMIT_DEFAULT,
} from '../lib/siteSettings'
import { utcDay } from '../lib/time'
import { renderSchema } from '../validation'
import { parseSettingsJson } from './settings'

/**
 * The extension suffix of a stored R2 key. Defined inline (rather than imported from
 * `./assets`) because `./assets` already imports `apiOrigin` from this module; adding the
 * reverse edge would make the two files a two-way module graph.
 */
function extFromR2Key(r2Key: string): string {
  const dot = r2Key.lastIndexOf('.')
  return dot < 0 ? '' : r2Key.slice(dot + 1)
}

type BatchSqlite = BatchItem<'sqlite'>

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
  const day = utcDay()

  // Lotteries must exist and belong to this member (global catalog OR owned by them).
  // Inactive ones are still allowed so saved sets keep working. ids.length ≤ 80 (zod cap, also
  // MAX_ITEMS_PER_RENDER) < IN_CHUNK (90), so the inlined memberLotteryIds query fits in one
  // statement.
  const ids = Array.from(new Set(body.items.map((i) => i.lotteryId)))
  // Saved settings are needed only for items without an override.
  const needSaved = ids.filter((id) => body.items.some((i) => i.lotteryId === id && !i.settings))

  // Read batch (one D1 round trip) — all four reads are independent, so asset ownership no
  // longer waits on the settings result:
  //   1) lottery-id validation (inline memberLotteryIds — one chunk, see above)
  //   2) card_settings for this member's ids that need saved settings
  //   3) the member's assets (max 2 × 3 kinds = 6 rows, assets_member_idx)
  //   4) the admin-configured default render limit (site_settings PK lookup)
  const lotteryQ = db
    .select({ id: lotteries.id })
    .from(lotteries)
    .where(
      and(
        inArray(lotteries.id, ids),
        or(isNull(lotteries.ownerMemberId), eq(lotteries.ownerMemberId, member.id)),
      ),
    )
  const settingsQ = needSaved.length
    ? db
        .select({ lotteryId: cardSettings.lotteryId, settingsJson: cardSettings.settingsJson })
        .from(cardSettings)
        .where(
          and(eq(cardSettings.memberId, member.id), inArray(cardSettings.lotteryId, needSaved)),
        )
    : null
  const assetsQ = db
    .select({ id: assets.id, r2Key: assets.r2Key })
    .from(assets)
    .where(eq(assets.memberId, member.id))
  const defaultLimitQ = db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, RENDER_LIMIT_DEFAULT))
  const readOps: BatchSqlite[] = settingsQ
    ? [lotteryQ, settingsQ, assetsQ, defaultLimitQ]
    : [lotteryQ, assetsQ, defaultLimitQ]
  const readRes = (await db.batch(readOps as [BatchSqlite, ...BatchSqlite[]])) as unknown[]
  const knownRows = readRes[0] as { id: string }[]
  const settingsRows = (settingsQ ? readRes[1] : []) as { lotteryId: string; settingsJson: string }[]
  const assetRows = (settingsQ ? readRes[2] : readRes[1]) as { id: string; r2Key: string }[]
  const defaultLimitRows = (settingsQ ? readRes[3] : readRes[2]) as { value: string }[]
  const defaultLimit = parseDefaultRenderLimit(
    defaultLimitRows[0]?.value ?? DEFAULTS[RENDER_LIMIT_DEFAULT],
  )
  const limit = effectiveRenderLimit(member.renderLimit, defaultLimit)

  const known = new Set(knownRows.map((r) => r.id))
  const missing = ids.filter((i) => !known.has(i))
  if (missing.length) throw errors.notFound(`ไม่พบหวย: ${missing.slice(0, 5).join(', ')}`)

  const saved = new Map<string, CardSettings>()
  for (const r of settingsRows) saved.set(r.lotteryId, parseSettingsJson(r.settingsJson))

  const assetRefs = new Set<string>()
  const results: { lotteryId: string; numbers: CardNumbers }[] = body.items.map((item) => {
    const settings = (item.settings as CardSettings | undefined) ?? saved.get(item.lotteryId) ?? null
    if (settings?.backgroundAssetId) assetRefs.add(settings.backgroundAssetId)
    if (settings?.logo?.assetId) assetRefs.add(settings.logo.assetId)
    if (settings?.qr?.assetId) assetRefs.add(settings.qr.assetId)
    return { lotteryId: item.lotteryId, numbers: generateForSettings(settings, item.fixed) }
  })

  // Short-circuit: when this single call already overflows the effective limit it can never
  // land; this also catches the (rare) case where an admin set renderLimit < n after the day
  // began. The SQL guard below still enforces concurrency-safe atomicity.
  if (n > limit) throw errors.rateLimited(`ใช้งานครบ ${limit} ครั้งต่อวันแล้ว`)

  // Write batch (one D1 round trip, one row written on success) — atomic rate-limit upsert
  // then a guarded members increment, in a single batch (= single D1 transaction).
  //
  // (1) The upsert's `setWhere` caps today's counter at the EFFECTIVE limit (member override
  //     ?? admin default ?? RENDERS_PER_DAY), bound in once as a SQL parameter. On over-limit
  //     the ON CONFLICT clause is a SQLite no-op: no row is modified, RETURNING returns
  //     nothing, and `changes()` becomes 0. No compensating write is needed. The INSERT
  //     branch (no conflict) is guarded above by the `n > limit` check.
  //
  // (2) The members update only runs when the previous statement actually changed a row —
  //     i.e. when the render was allowed. SQLite's `changes()` reflects the row-change count
  //     of the preceding statement on the same connection, which D1 / libSQL preserves inside
  //     a batch. This keeps renders_total consistent with render_counters without reading
  //     either value back.
  const upsertStmt = db
    .insert(renderCounters)
    .values({ memberId: member.id, day, count: n })
    .onConflictDoUpdate({
      target: [renderCounters.memberId, renderCounters.day],
      set: { count: sql`${renderCounters.count} + ${n}` },
      setWhere: sql`${renderCounters.count} + ${n} <= ${limit}`,
    })
    .returning({ count: renderCounters.count })
  const membersStmt = db
    .update(members)
    .set({ rendersTotal: sql`${members.rendersTotal} + ${n}` })
    .where(and(eq(members.id, member.id), sql`changes() > 0`))
  const writeRes = (await db.batch([upsertStmt, membersStmt] as [BatchSqlite, BatchSqlite])) as unknown[]
  const counters = writeRes[0] as { count: number }[]
  const counter = counters[0]
  if (!counter) throw errors.rateLimited(`ใช้งานครบ ${limit} ครั้งต่อวันแล้ว`)

  // Sign only assets that belong to this member (ownership already resolved by the read
  // batch). `signedAssetUrl` buckets exp to the next 30-min boundary so repeat renders inside a bucket
  // yield the same URL and the browser cache can reuse the response.
  const signed: Record<string, string> = {}
  if (assetRefs.size && assetRows.length) {
    const ownedById = new Map(assetRows.map((r) => [r.id, r] as const))
    const origin = apiOrigin(c.req.url)
    for (const assetId of assetRefs) {
      const owned = ownedById.get(assetId)
      if (!owned) continue
      const ext = extFromR2Key(owned.r2Key)
      if (!ext) continue
      signed[assetId] = await signedAssetUrl(
        origin,
        c.env.ASSET_SIGNING_SECRET,
        assetId,
        member.id,
        ext,
      )
    }
  }

  return c.json({
    results,
    assets: signed,
    rendersToday: counter.count,
    rendersLimit: limit,
    date: body.date,
  })
})
