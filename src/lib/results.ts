// Lottery results (PUT / GET /results, PUT / DELETE /results/mine, GET /admin/results): row -> JSON
// mappers, the upsert both writers share, which rows a member reads, and the lookups of the lottery
// a result belongs to.
//
// A row is OFFICIAL (member_id '', written by the back office or the robot) or PERSONAL (member_id =
// the member who typed it). A member reads the official rows and their own personal ones, never
// anyone else's, and a personal result hides the official ones of the same lottery and date.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { DB } from '../db/client'
import { lotteries, lotteryResults } from '../db/schema'
import type { AdminLotteryResult, LotteryResult, MemberLotteryResult } from '../types'
import { ApiError, errors } from './http'
import { addDays, bangkokDay } from './time'
import { visibleToMember } from './views'

export type ResultRow = typeof lotteryResults.$inferSelect

/** The `member_id` of an official result (see the schema: '' and not NULL, so the unique index works). */
export const OFFICIAL_MEMBER_ID = ''

/**
 * The latest draw date an OFFICIAL result may carry (PUT /results and the import): tomorrow in Bangkok.
 * A draw is dated at most a day ahead (a robot on another time zone is ahead of Bangkok for hours), a
 * result further in the future is a typo and is refused.
 */
export function latestResultDate(nowMs = Date.now()): string {
  return addDays(bangkokDay(nowMs), 1)
}

/** 400 VALIDATION unless `date` (a real YYYY-MM-DD day) is not later than {@link latestResultDate}. */
export function assertNotTooFarAhead(date: string, nowMs = Date.now()): void {
  const latest = latestResultDate(nowMs)
  if (date > latest) {
    throw errors.validation(`date ล่วงหน้าได้ไม่เกิน 1 วัน (ไม่เกิน ${latest})`)
  }
}

/** The shape of one draw's numbers: no id, no source, no timestamps. */
export function toLotteryResult(r: ResultRow): LotteryResult {
  return {
    lotteryId: r.lotteryId,
    date: r.drawDate,
    time: r.drawTime,
    top3: r.top3,
    top2: r.top2,
    bottom2: r.bottom2,
  }
}

/** The shape members get from GET /results: the draw plus whose it is and what it hides. */
export function toMemberLotteryResult(r: ResultRow, hidden: ResultRow | null): MemberLotteryResult {
  return {
    ...toLotteryResult(r),
    mine: r.memberId !== OFFICIAL_MEMBER_ID,
    official: hidden ? { time: hidden.drawTime, top3: hidden.top3, top2: hidden.top2, bottom2: hidden.bottom2 } : null,
  }
}

/**
 * What a member reads, from the rows they may read (the official ones and their own; any other row
 * is ignored, so it can never leak, whatever the query returned). Per lottery: when the member has
 * a personal result of it, only their personal results are listed (every official result of that
 * lottery and date is hidden, whatever its draw time, so the member's own numbers always win) and
 * each says in `official` which official draw is behind it (the latest by time); otherwise the
 * official results are listed as they are. The order of `rows` (by lottery, then time) is kept.
 */
export function resolveForMember(rows: readonly ResultRow[], memberId: string): MemberLotteryResult[] {
  const byLottery = new Map<string, { official: ResultRow[]; mine: ResultRow[] }>()
  for (const r of rows) {
    const isOfficial = r.memberId === OFFICIAL_MEMBER_ID
    if (!isOfficial && r.memberId !== memberId) continue
    let entry = byLottery.get(r.lotteryId)
    if (!entry) byLottery.set(r.lotteryId, (entry = { official: [], mine: [] }))
    ;(isOfficial ? entry.official : entry.mine).push(r)
  }
  const out: MemberLotteryResult[] = []
  for (const { official, mine } of byLottery.values()) {
    if (mine.length === 0) {
      for (const r of official) out.push(toMemberLotteryResult(r, null))
      continue
    }
    // the largest draw time; "" (no time) is the smallest, like the web app's latestResults
    const latest = official.reduce<ResultRow | null>((a, r) => (a === null || r.drawTime > a.drawTime ? r : a), null)
    for (const r of mine) out.push(toMemberLotteryResult(r, latest))
  }
  return out
}

/**
 * The results a member reads for one Thai date (GET /results): the official results and the
 * member's own, of the lotteries they can see (active catalog lotteries and their own), resolved by
 * {@link resolveForMember}, ordered by lottery, then draw time ("" first, then "HH:MM" ascending).
 * `lotteryId` limits it to that lottery (the answers of PUT / DELETE /results/mine).
 */
export async function loadMemberResults(
  db: DB,
  memberId: string,
  date: string,
  lotteryId?: string,
): Promise<MemberLotteryResult[]> {
  const rows = await db
    .select({ result: lotteryResults })
    .from(lotteryResults)
    .innerJoin(lotteries, eq(lotteries.id, lotteryResults.lotteryId))
    .where(
      and(
        eq(lotteryResults.drawDate, date),
        inArray(lotteryResults.memberId, [OFFICIAL_MEMBER_ID, memberId]),
        visibleToMember(memberId),
        lotteryId === undefined ? undefined : eq(lotteryResults.lotteryId, lotteryId),
      ),
    )
    .orderBy(asc(lotteryResults.lotteryId), asc(lotteryResults.drawTime))
  return resolveForMember(
    rows.map((r) => r.result),
    memberId,
  )
}

/**
 * Stores a result, or replaces the one of the same draw and kind (the unique index (lottery, date,
 * time, member) decides, so writers racing for one draw end up with one row, the later write wins).
 * A replace keeps the old row's `id` and `created_at`; the new `id` of `row` only survives on an
 * insert, which is how `created` tells the two cases apart. Throws the driver's error when the
 * lottery is gone (its FOREIGN KEY fails): callers turn that into "unknown lottery".
 */
export async function upsertResult(db: DB, row: ResultRow): Promise<{ saved: ResultRow; created: boolean }> {
  const [saved] = await db
    .insert(lotteryResults)
    .values(row)
    .onConflictDoUpdate({
      target: [lotteryResults.lotteryId, lotteryResults.drawDate, lotteryResults.drawTime, lotteryResults.memberId],
      set: {
        top3: row.top3,
        top2: row.top2,
        bottom2: row.bottom2,
        source: row.source,
        updatedAt: row.updatedAt,
      },
    })
    .returning()
  return { saved, created: saved.id === row.id }
}

/** The back office / robot shape: the member shape plus id, source and timestamps. */
export function toAdminLotteryResult(r: ResultRow): AdminLotteryResult {
  return {
    id: r.id,
    ...toLotteryResult(r),
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

const lotteryNotFound = (what: string) => new ApiError(404, 'LOTTERY_NOT_FOUND', `ไม่พบหวย: ${what}`)

/**
 * The id of the catalog lottery a PUT /results is about, from its `lotteryId` or its exact
 * `lotteryName` (the schema guarantees that exactly one of them is given). Only catalog lotteries
 * count (`owner_member_id IS NULL`, active or not, so a result can be prepared for a lottery that
 * is switched off): a member's own lottery never has results. The name is compared exactly
 * (case-sensitive, no normalisation) with `lotteries.name`.
 *   - unknown id / name: 404 LOTTERY_NOT_FOUND
 *   - a name that more than one catalog lottery has: 409 LOTTERY_AMBIGUOUS (send the id instead)
 */
export async function resolveResultLottery(
  db: DB,
  ref: { lotteryId?: string | null; lotteryName?: string | null },
): Promise<string> {
  if (ref.lotteryId != null) {
    const [row] = await db
      .select({ id: lotteries.id })
      .from(lotteries)
      .where(and(eq(lotteries.id, ref.lotteryId), isNull(lotteries.ownerMemberId)))
      .limit(1)
    if (!row) throw lotteryNotFound(ref.lotteryId)
    return row.id
  }
  const name = ref.lotteryName ?? ''
  const rows = await db
    .select({ id: lotteries.id })
    .from(lotteries)
    .where(and(eq(lotteries.name, name), isNull(lotteries.ownerMemberId)))
    .limit(2)
  if (rows.length === 0) throw lotteryNotFound(name)
  if (rows.length > 1) {
    throw errors.conflict('LOTTERY_AMBIGUOUS', `มีหวยชื่อ "${name}" มากกว่าหนึ่งรายการ กรุณาระบุด้วย lotteryId`)
  }
  return rows[0].id
}

/**
 * Throws 404 LOTTERY_NOT_FOUND unless `lotteryId` is a lottery this member can see: an active
 * catalog lottery or one of their own (the rule of GET /lotteries). Another member's lottery, a
 * catalog lottery that is switched off and an unknown id all give the same answer, so the route
 * tells nothing about lotteries the member cannot see. The guard of PUT / DELETE /results/mine.
 */
export async function requireVisibleLottery(db: DB, memberId: string, lotteryId: string): Promise<void> {
  const [row] = await db
    .select({ id: lotteries.id })
    .from(lotteries)
    .where(and(eq(lotteries.id, lotteryId), visibleToMember(memberId)))
    .limit(1)
  if (!row) throw lotteryNotFound(lotteryId)
}
