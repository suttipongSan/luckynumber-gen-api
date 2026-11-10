// GET /lotteries — active global catalog + the member's own custom lotteries, sorted by group
// then sortOrder. POST / PATCH / DELETE operate on the member's own lotteries only.
import { Hono } from 'hono'
import { and, eq, isNull, or } from 'drizzle-orm'
import type { AppEnv, Lottery } from '../types'
import { MAX_CUSTOM_LOTTERIES } from '../types'
import { getDb } from '../db/client'
import { cardSettings, lotteries, setLotteries } from '../db/schema'
import { GROUP_ORDER } from '../db/catalog'
import { requireMember } from '../middleware/memberAuth'
import { errors, parseJson } from '../lib/http'
import { newId } from '../lib/ids'
import { toLottery } from '../lib/views'
import { memberLotterySchema, patchMemberLotterySchema } from '../validation'
import { groupAccent } from '../lib/palette'

export const lotteryRoutes = new Hono<AppEnv>()
lotteryRoutes.use('/lotteries', requireMember())
lotteryRoutes.use('/lotteries/*', requireMember())

function groupIndex(group: string): number {
  const i = GROUP_ORDER.indexOf(group as (typeof GROUP_ORDER)[number])
  return i === -1 ? GROUP_ORDER.length : i
}

/**
 * Sorts lottery rows into the shape GET /lotteries returns: group order first, then sortOrder,
 * then name. Exported so bootstrap can reuse the identical ordering without a second query.
 */
export function sortLotteriesForMember(
  rows: (typeof lotteries.$inferSelect)[],
  memberId: string,
): Lottery[] {
  const out = rows.map((r) => toLottery(r, memberId))
  out.sort((a, b) => {
    const g = groupIndex(a.group) - groupIndex(b.group)
    if (g !== 0) return g
    const s = a.sortOrder - b.sortOrder
    if (s !== 0) return s
    return a.name.localeCompare(b.name)
  })
  return out
}

lotteryRoutes.get('/lotteries', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  // Active global lotteries (owner_member_id IS NULL) OR all of this member's own.
  const rows = await db
    .select()
    .from(lotteries)
    .where(
      or(
        and(isNull(lotteries.ownerMemberId), eq(lotteries.active, true)),
        eq(lotteries.ownerMemberId, memberId),
      ),
    )
  return c.json(sortLotteriesForMember(rows, memberId))
})

lotteryRoutes.post('/lotteries', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const body = await parseJson(c, memberLotterySchema)

  // Enforce 30-per-member quota.
  const existing = await db
    .select({ id: lotteries.id, sortOrder: lotteries.sortOrder })
    .from(lotteries)
    .where(eq(lotteries.ownerMemberId, memberId))
  if (existing.length >= MAX_CUSTOM_LOTTERIES) {
    throw errors.conflict('QUOTA', `สร้างหวยของตัวเองได้สูงสุด ${MAX_CUSTOM_LOTTERIES} รายการ`)
  }

  const shortName = (body.shortName ?? body.name.replace(/\s+/g, '')).slice(0, 20) || body.name.slice(0, 20)
  const highest = existing.reduce((m, r) => Math.max(m, r.sortOrder), 10_000 - 1)
  const nextSort = Math.max(10_000, highest + 1)

  const id = `m-${newId()}`
  const row = {
    id,
    name: body.name,
    shortName,
    groupKey: body.group,
    accent: groupAccent(body.group),
    sortOrder: nextSort,
    active: true,
    ownerMemberId: memberId,
  }
  await db.insert(lotteries).values(row)
  return c.json(toLottery(row, memberId))
})

async function ownedLottery(db: ReturnType<typeof getDb>, memberId: string, id: string) {
  const row = await db.query.lotteries.findFirst({
    where: and(eq(lotteries.id, id), eq(lotteries.ownerMemberId, memberId)),
  })
  if (!row) throw errors.notFound('ไม่พบหวย')
  return row
}

lotteryRoutes.patch('/lotteries/:id', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const id = c.req.param('id')
  const body = await parseJson(c, patchMemberLotterySchema)
  const row = await ownedLottery(db, memberId, id)
  const patch: Partial<typeof lotteries.$inferInsert> = {}
  if (body.name !== undefined) patch.name = body.name
  if (body.shortName !== undefined) patch.shortName = body.shortName
  if (body.group !== undefined) {
    patch.groupKey = body.group
    if (body.group !== row.groupKey) patch.accent = groupAccent(body.group)
  }
  if (Object.keys(patch).length) {
    await db
      .update(lotteries)
      .set(patch)
      .where(and(eq(lotteries.id, row.id), eq(lotteries.ownerMemberId, memberId)))
  }
  const fresh = await ownedLottery(db, memberId, row.id)
  return c.json(toLottery(fresh, memberId))
})

lotteryRoutes.delete('/lotteries/:id', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const id = c.req.param('id')
  const row = await ownedLottery(db, memberId, id)
  // Cascade manually so another member's sets / settings referencing this lottery (which cannot
  // happen through the member API) are also cleaned up, as a defence in depth.
  await db.batch([
    db.delete(setLotteries).where(eq(setLotteries.lotteryId, row.id)),
    db.delete(cardSettings).where(eq(cardSettings.lotteryId, row.id)),
    db
      .delete(lotteries)
      .where(and(eq(lotteries.id, row.id), eq(lotteries.ownerMemberId, memberId))),
  ])
  return c.body(null, 204)
})
