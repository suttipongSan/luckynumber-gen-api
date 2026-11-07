// Lottery sets ("ชุดรายการ"). The Default set is created on the first GET /sets and can be
// neither renamed nor deleted.
import { Hono } from 'hono'
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { AppEnv, LotterySet } from '../types'
import { MAX_SETS } from '../types'
import { getDb, type DB } from '../db/client'
import { chunk } from '../lib/chunk'
import { setLotteries, sets } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { errors, parseJson } from '../lib/http'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'
import { memberLotteryIds } from '../lib/views'
import { patchSetSchema, setNameSchema } from '../validation'

export const DEFAULT_SET_NAME = 'Default'
/** Same starter list as the mockup's Default set. */
export const DEFAULT_SET_LOTTERIES = [
  'hanoi-regular',
  'hanoi-vip',
  'lao-pattana',
  'lao-samakki',
  'dow-jones',
  'thai-gov',
]

export const setRoutes = new Hono<AppEnv>()
setRoutes.use('/sets', requireMember())
setRoutes.use('/sets/*', requireMember())

type SetRow = typeof sets.$inferSelect

async function loadSets(db: DB, memberId: string): Promise<LotterySet[]> {
  const rows = await db
    .select()
    .from(sets)
    .where(eq(sets.memberId, memberId))
    .orderBy(asc(sets.createdAt), asc(sets.id))
  return attachLotteries(db, rows)
}

async function attachLotteries(db: DB, rows: SetRow[]): Promise<LotterySet[]> {
  if (rows.length === 0) return []
  const links = await db
    .select()
    .from(setLotteries)
    .where(
      inArray(
        setLotteries.setId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(setLotteries.sortOrder))
  const bySet = new Map<string, { lotteryIds: string[]; rounds: number[] }>()
  for (const l of links) {
    const entry = bySet.get(l.setId) ?? { lotteryIds: [], rounds: [] }
    entry.lotteryIds.push(l.lotteryId)
    entry.rounds.push(l.round)
    bySet.set(l.setId, entry)
  }
  // Default first, then creation order.
  const sorted = [...rows].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return sorted.map((r) => {
    const entry = bySet.get(r.id)
    return {
      id: r.id,
      name: r.name,
      isDefault: r.isDefault,
      lotteryIds: entry?.lotteryIds ?? [],
      rounds: entry?.rounds ?? [],
    }
  })
}

// F4: set_lotteries now has 4 columns. 25 rows × 4 params = 100 bound parameters, D1's hard
// per-statement cap. A full set (~80 lotteries) still fits in ≤ 4 statements per batch.
const LINK_ROWS_PER_INSERT = 25

function linkInserts(
  db: DB,
  setId: string,
  lotteryIds: string[],
  rounds: number[],
) {
  const values = lotteryIds.map((lotteryId, i) => ({
    setId,
    lotteryId,
    sortOrder: i,
    round: rounds[i] ?? 1,
  }))
  return chunk(values, LINK_ROWS_PER_INSERT).map((part) => db.insert(setLotteries).values(part))
}

async function ensureDefault(db: DB, memberId: string): Promise<void> {
  const existing = await db.query.sets.findFirst({
    where: and(eq(sets.memberId, memberId), eq(sets.isDefault, true)),
  })
  if (existing) return
  const id = newId()
  const valid = await memberLotteryIds(db, memberId, DEFAULT_SET_LOTTERIES)
  const ids = DEFAULT_SET_LOTTERIES.filter((l) => valid.has(l))
  const rounds = ids.map(() => 1)
  try {
    await db.batch([
      db.insert(sets).values({
        id,
        memberId,
        name: DEFAULT_SET_NAME,
        isDefault: true,
        createdAt: nowIso(),
      }),
      ...linkInserts(db, id, ids, rounds),
    ])
  } catch (e) {
    // A concurrent first GET /sets won the race (unique index sets_one_default_idx); the batch
    // was rolled back as a whole. Anything else is a real error.
    const raced = await db.query.sets.findFirst({
      where: and(eq(sets.memberId, memberId), eq(sets.isDefault, true)),
    })
    if (!raced) throw e
  }
}

async function ownedSet(db: DB, memberId: string, id: string): Promise<SetRow> {
  const row = await db.query.sets.findFirst({
    where: and(eq(sets.id, id), eq(sets.memberId, memberId)),
  })
  if (!row) throw errors.notFound('ไม่พบชุดรายการ')
  return row
}

setRoutes.get('/sets', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  await ensureDefault(db, memberId)
  return c.json(await loadSets(db, memberId))
})

setRoutes.post('/sets', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const { name } = await parseJson(c, setNameSchema)
  await ensureDefault(db, memberId)
  const count = (await db.select({ id: sets.id }).from(sets).where(eq(sets.memberId, memberId)))
    .length
  if (count >= MAX_SETS) throw errors.conflict('QUOTA', `สร้างชุดได้สูงสุด ${MAX_SETS} ชุด`)
  const row: SetRow = { id: newId(), memberId, name, isDefault: false, createdAt: nowIso() }
  await db.insert(sets).values(row)
  const out: LotterySet = { id: row.id, name: row.name, isDefault: false, lotteryIds: [], rounds: [] }
  return c.json(out)
})

setRoutes.patch('/sets/:id', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const body = await parseJson(c, patchSetSchema)
  const row = await ownedSet(db, memberId, c.req.param('id'))
  if (body.name !== undefined && row.isDefault && body.name !== row.name) {
    throw errors.conflict('DEFAULT_LOCKED', 'ไม่สามารถเปลี่ยนชื่อชุด Default ได้')
  }
  const ops = []
  if (body.name !== undefined && !row.isDefault) {
    ops.push(db.update(sets).set({ name: body.name }).where(eq(sets.id, row.id)))
  }
  if (body.lotteryIds !== undefined) {
    // De-duplicate but keep first occurrence's position, and mirror the rounds array alongside.
    const seen = new Set<string>()
    const ids: string[] = []
    const rounds: number[] = []
    for (let i = 0; i < body.lotteryIds.length; i++) {
      const id = body.lotteryIds[i]
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      rounds.push(body.rounds?.[i] ?? NaN)
    }
    const valid = await memberLotteryIds(db, memberId, ids)
    const unknown = ids.filter((i) => !valid.has(i))
    if (unknown.length) throw errors.validation(`ไม่พบหวย: ${unknown.slice(0, 5).join(', ')}`)
    // If rounds not provided, keep the existing round for lotteries already in the set (else 1).
    if (body.rounds === undefined) {
      const current = await db
        .select({ lotteryId: setLotteries.lotteryId, round: setLotteries.round })
        .from(setLotteries)
        .where(eq(setLotteries.setId, row.id))
      const prev = new Map(current.map((r) => [r.lotteryId, r.round]))
      for (let i = 0; i < ids.length; i++) rounds[i] = prev.get(ids[i]) ?? 1
    }
    ops.push(db.delete(setLotteries).where(eq(setLotteries.setId, row.id)))
    ops.push(...linkInserts(db, row.id, ids, rounds))
  }
  if (ops.length) await db.batch(ops as [(typeof ops)[number], ...(typeof ops)[number][]])
  const fresh = await ownedSet(db, memberId, row.id)
  const [out] = await attachLotteries(db, [fresh])
  return c.json(out)
})

setRoutes.delete('/sets/:id', async (c) => {
  const db = getDb(c.env)
  const row = await ownedSet(db, c.get('member').id, c.req.param('id'))
  if (row.isDefault) throw errors.conflict('DEFAULT_LOCKED', 'ไม่สามารถลบชุด Default ได้')
  await db.batch([
    db.delete(setLotteries).where(eq(setLotteries.setId, row.id)),
    db.delete(sets).where(eq(sets.id, row.id)),
  ])
  return c.body(null, 204)
})
