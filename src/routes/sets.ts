// Lottery sets ("ชุดรายการ"). A new member's starter sets (see db/starterSets.ts) are created
// on the first GET /sets. The default set (isDefault) can be neither renamed nor deleted.
import { Hono } from 'hono'
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { AppEnv, LotterySet } from '../types'
import { MAX_SETS } from '../types'
import { getDb, type DB } from '../db/client'
import { chunk, IN_CHUNK } from '../lib/chunk'
import { lotteries, setLotteries, sets } from '../db/schema'
import { STARTER_SETS } from '../db/starterSets'
import { requireMember } from '../middleware/memberAuth'
import { changedRows, errors, parseJson } from '../lib/http'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'
import { memberLotteryIds } from '../lib/views'
import { patchSetSchema, setNameSchema } from '../validation'

const starterId = (entry: string | [string, number]): string =>
  typeof entry === 'string' ? entry : entry[0]

export const setRoutes = new Hono<AppEnv>()
setRoutes.use('/sets', requireMember())
setRoutes.use('/sets/*', requireMember())

export type SetRow = typeof sets.$inferSelect
export type LinkRow = { setId: string; lotteryId: string; sortOrder: number; round: number }
type LocalLink = { lotteryId: string; sortOrder: number; round: number }
type BatchSqlite = BatchItem<'sqlite'>

// F4: set_lotteries has 4 columns. 25 rows × 4 params = 100 bound parameters, D1's hard
// per-statement cap. A full 80-lottery set still fits in ≤ 4 upsert statements per batch.
const LINK_ROWS_PER_INSERT = 25

// sets has 5 columns; 20 rows × 5 params = 100 bound parameters, D1's per-statement cap.
const SET_ROWS_PER_INSERT = 20

/** Default first, then creation order (rows is already sorted by createdAt,id). */
export function buildSets(rows: SetRow[], links: LinkRow[]): LotterySet[] {
  const bySet = new Map<string, LinkRow[]>()
  for (const l of links) {
    const arr = bySet.get(l.setId) ?? []
    arr.push(l)
    bySet.set(l.setId, arr)
  }
  // Order each set's links by sort_order (stable, per set).
  for (const arr of bySet.values()) arr.sort((a, b) => a.sortOrder - b.sortOrder)
  const sorted = [...rows].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
  return sorted.map((r) => {
    const entry = bySet.get(r.id) ?? []
    return {
      id: r.id,
      name: r.name,
      isDefault: r.isDefault,
      lotteryIds: entry.map((e) => e.lotteryId),
      rounds: entry.map((e) => e.round),
    }
  })
}

/** One round trip: the member's sets + all their set_lotteries links (via inner join on sets). */
export async function loadSetsAndLinks(
  db: DB,
  memberId: string,
): Promise<{ rows: SetRow[]; links: LinkRow[] }> {
  const setsQ = db
    .select()
    .from(sets)
    .where(eq(sets.memberId, memberId))
    .orderBy(asc(sets.createdAt), asc(sets.id))
  const linksQ = db
    .select({
      setId: setLotteries.setId,
      lotteryId: setLotteries.lotteryId,
      sortOrder: setLotteries.sortOrder,
      round: setLotteries.round,
    })
    .from(setLotteries)
    .innerJoin(sets, eq(sets.id, setLotteries.setId))
    .where(eq(sets.memberId, memberId))
  const res = await db.batch([setsQ, linksQ] as [BatchSqlite, BatchSqlite])
  return { rows: res[0] as SetRow[], links: res[1] as LinkRow[] }
}

/** count(*) + whether any row is isDefault, in a single statement. */
async function countAndDefault(
  db: DB,
  memberId: string,
): Promise<{ total: number; hasDefault: boolean }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)`,
      defaults: sql<number>`coalesce(sum(case when ${sets.isDefault} then 1 else 0 end), 0)`,
    })
    .from(sets)
    .where(eq(sets.memberId, memberId))
  return { total: Number(row?.total ?? 0), hasDefault: Number(row?.defaults ?? 0) > 0 }
}

/**
 * First visit: creates the member's starter sets (STARTER_SETS, the locked default set among them)
 * in one batch. Members who already have a default set are left exactly as they are. Callers must
 * decide whether to invoke this using a prior read (so this never runs after the first visit).
 */
export async function ensureDefault(db: DB, memberId: string): Promise<void> {
  const wanted = [...new Set(STARTER_SETS.flatMap((s) => s.lotteries.map(starterId)))]
  const valid = await memberLotteryIds(db, memberId, wanted)
  // createdAt steps by 1 ms so the list keeps this order (it sorts by createdAt, then id).
  const base = Date.now()
  const setRows: SetRow[] = []
  const linkRows: (typeof setLotteries.$inferInsert)[] = []
  STARTER_SETS.forEach((s, i) => {
    const id = newId()
    setRows.push({ id, memberId, name: s.name, isDefault: s.isDefault, createdAt: nowIso(base + i) })
    const seen = new Set<string>()
    for (const entry of s.lotteries) {
      const lotteryId = starterId(entry)
      if (!valid.has(lotteryId) || seen.has(lotteryId)) continue
      linkRows.push({
        setId: id,
        lotteryId,
        sortOrder: seen.size,
        round: typeof entry === 'string' ? 1 : entry[1],
      })
      seen.add(lotteryId)
    }
  })
  const ops = [
    ...chunk(setRows, SET_ROWS_PER_INSERT).map((part) => db.insert(sets).values(part)),
    ...chunk(linkRows, LINK_ROWS_PER_INSERT).map((part) => db.insert(setLotteries).values(part)),
  ]
  try {
    await db.batch(ops as [(typeof ops)[number], ...(typeof ops)[number][]])
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
  // Normal path (every call after the first visit): 1 round trip, no ensureDefault probe.
  let { rows, links } = await loadSetsAndLinks(db, memberId)
  if (!rows.some((r) => r.isDefault)) {
    // First visit (or wiped Default). ensureDefault retries safely on the unique-index race.
    await ensureDefault(db, memberId)
    ;({ rows, links } = await loadSetsAndLinks(db, memberId))
  }
  return c.json(buildSets(rows, links))
})

setRoutes.post('/sets', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const { name } = await parseJson(c, setNameSchema)
  // count(*) + hasDefault in one statement; no separate ensureDefault probe.
  let stats = await countAndDefault(db, memberId)
  if (!stats.hasDefault) {
    await ensureDefault(db, memberId)
    stats = await countAndDefault(db, memberId)
  }
  const quotaError = () => errors.conflict('QUOTA', `สร้างชุดได้สูงสุด ${MAX_SETS} ชุด`)
  // The pre-check is the fast path; the conditional INSERT is what actually holds the quota
  // when several POSTs race (count and insert in one statement = atomic in SQLite).
  if (stats.total >= MAX_SETS) throw quotaError()
  const row: SetRow = { id: newId(), memberId, name, isDefault: false, createdAt: nowIso() }
  const inserted = changedRows(
    await db.run(sql`
      insert into sets (id, member_id, name, is_default, created_at)
      select ${row.id}, ${row.memberId}, ${row.name}, 0, ${row.createdAt}
      where (select count(*) from sets where member_id = ${memberId}) < ${MAX_SETS}`),
  )
  if (inserted === 0) throw quotaError()
  const out: LotterySet = { id: row.id, name: row.name, isDefault: false, lotteryIds: [], rounds: [] }
  return c.json(out)
})

setRoutes.patch('/sets/:id', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const body = await parseJson(c, patchSetSchema)
  const setId = c.req.param('id')

  // De-duplicate incoming lotteryIds (first occurrence wins) and mirror rounds alongside.
  let nextIds: string[] | null = null
  let providedRounds: number[] | null = null
  if (body.lotteryIds !== undefined) {
    const seen = new Set<string>()
    const ids: string[] = []
    const rds: number[] = []
    for (let i = 0; i < body.lotteryIds.length; i++) {
      const id = body.lotteryIds[i]
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
      if (body.rounds !== undefined) rds.push(body.rounds[i])
    }
    nextIds = ids
    providedRounds = body.rounds !== undefined ? rds : null
  }

  // One round-trip read batch: ownership + current links (needed for rounds fallback and
  // for the response when `lotteryIds` is omitted) + lottery-id validation (chunked if more
  // than IN_CHUNK ids were sent).
  const ownedQ = db
    .select()
    .from(sets)
    .where(and(eq(sets.id, setId), eq(sets.memberId, memberId)))
  const currentQ = db
    .select({
      lotteryId: setLotteries.lotteryId,
      sortOrder: setLotteries.sortOrder,
      round: setLotteries.round,
    })
    .from(setLotteries)
    .where(eq(setLotteries.setId, setId))
  const validationChunks = nextIds && nextIds.length > 0 ? chunk(nextIds, IN_CHUNK) : []
  const validationQueries = validationChunks.map((part) =>
    db
      .select({ id: lotteries.id })
      .from(lotteries)
      .where(
        and(
          inArray(lotteries.id, part),
          or(isNull(lotteries.ownerMemberId), eq(lotteries.ownerMemberId, memberId)),
        ),
      ),
  )
  const readOps: BatchSqlite[] = [ownedQ, currentQ, ...validationQueries]
  const results = (await db.batch(
    readOps as [BatchSqlite, ...BatchSqlite[]],
  )) as unknown[]

  const rowResult = results[0] as SetRow[]
  if (rowResult.length === 0) throw errors.notFound('ไม่พบชุดรายการ')
  const row = rowResult[0]
  const current = results[1] as LocalLink[]
  const validIds = new Set<string>()
  for (let i = 0; i < validationQueries.length; i++) {
    const rows = results[2 + i] as { id: string }[]
    for (const r of rows) validIds.add(r.id)
  }

  // Default-locked rename check (same text as before).
  if (body.name !== undefined && row.isDefault && body.name !== row.name) {
    throw errors.conflict('DEFAULT_LOCKED', 'ไม่สามารถเปลี่ยนชื่อชุดหลักได้')
  }

  // Unknown-lottery abort before any write.
  if (nextIds) {
    const unknown = nextIds.filter((id) => !validIds.has(id))
    if (unknown.length) throw errors.validation(`ไม่พบหวย: ${unknown.slice(0, 5).join(', ')}`)
  }

  // Resolve rounds: client-provided overrides; otherwise keep each existing lottery's round and
  // default added ids to 1.
  let finalRounds: number[] = []
  if (nextIds) {
    if (providedRounds) {
      finalRounds = providedRounds
    } else {
      const prevRound = new Map(current.map((r) => [r.lotteryId, r.round]))
      finalRounds = nextIds.map((id) => prevRound.get(id) ?? 1)
    }
  }

  // Build the write operations.
  //
  // When `lotteryIds` is supplied we delete every existing link for this set and reinsert
  // the requested list inside ONE db.batch (= one D1 transaction). That makes PATCH last-
  // writer-wins across concurrent requests: two tabs racing on the same set still see a
  // final state that matches one of the two PATCH bodies, never a merge-across-snapshots.
  // A per-row diff would commit between the read and the write and could leave rows that
  // neither client sent (D1 has no interactive transactions, only all-or-nothing batches).
  // For the realistic max (≤ 112 ids) the write stays within D1's 50-statements-per-request
  // free-plan limit: 1 rename + 1 wipe + ≤ 5 upserts = ≤ 7 statements.
  const writeOps: BatchSqlite[] = []
  const willRename = body.name !== undefined && !row.isDefault && body.name !== row.name
  if (willRename) {
    writeOps.push(db.update(sets).set({ name: body.name! }).where(eq(sets.id, row.id)))
  }

  if (nextIds) {
    // Wipe-and-reinsert: deletes all current rows for this set, then inserts the requested
    // list. sort_order is assigned 0..n-1 so the readers' ORDER BY sort_order yields exactly
    // the client-sent order. Chunked by LINK_ROWS_PER_INSERT (25 rows × 4 params = 100 cap).
    writeOps.push(db.delete(setLotteries).where(eq(setLotteries.setId, row.id)))
    const insertRows = nextIds.map((lid, i) => ({
      setId: row.id,
      lotteryId: lid,
      sortOrder: i,
      round: finalRounds[i],
    }))
    for (const part of chunk(insertRows, LINK_ROWS_PER_INSERT)) {
      writeOps.push(db.insert(setLotteries).values(part))
    }
  }

  if (writeOps.length) {
    try {
      await db.batch(writeOps as [BatchSqlite, ...BatchSqlite[]])
    } catch (e) {
      // A concurrent DELETE /sets/:id that commits between our read and this batch makes the
      // link inserts fail their FOREIGN KEY to sets (the batch rolls back as a whole). Report
      // that as the set being gone rather than a 500; any other failure is a real error.
      const still = await db
        .select({ id: sets.id })
        .from(sets)
        .where(and(eq(sets.id, setId), eq(sets.memberId, memberId)))
      if (still.length === 0) throw errors.notFound('ไม่พบชุดรายการ')
      throw e
    }
  }

  // Response from in-memory state — no extra reads.
  const sortedCurrent = nextIds === null
    ? [...current].sort((a, b) => a.sortOrder - b.sortOrder)
    : null
  const out: LotterySet = {
    id: row.id,
    name: willRename ? body.name! : row.name,
    isDefault: row.isDefault,
    lotteryIds: nextIds ?? sortedCurrent!.map((r) => r.lotteryId),
    rounds: nextIds ? finalRounds : sortedCurrent!.map((r) => r.round),
  }
  return c.json(out)
})

setRoutes.delete('/sets/:id', async (c) => {
  const db = getDb(c.env)
  const row = await ownedSet(db, c.get('member').id, c.req.param('id'))
  if (row.isDefault) throw errors.conflict('DEFAULT_LOCKED', 'ไม่สามารถลบชุดหลักได้')
  await db.batch([
    db.delete(setLotteries).where(eq(setLotteries.setId, row.id)),
    db.delete(sets).where(eq(sets.id, row.id)),
  ])
  return c.body(null, 204)
})
