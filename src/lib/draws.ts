// The numbers a member last drew (member_draws): saving what POST /render/numbers returned,
// reading it back for GET /draws, and the daily cleanup the cron runs.
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DB } from '../db/client'
import { getDb } from '../db/client'
import { memberDraws } from '../db/schema'
import { DRAW_RETENTION_DAYS } from '../types'
import type { Bindings, CardNumbers, MemberDraw } from '../types'
import { chunk } from './chunk'
import { changedRows } from './http'
import { bangkokMinute, nowIso } from './time'

/** member_draws upserts bind 6 parameters per row, so 16 rows = 96 of D1's 100 per statement. */
const DRAW_ROWS_PER_INSERT = 16
/** The cron cleans up in this Bangkok minute: a quiet one, away from the :00 / :30 reminder rush. */
export const DRAW_PRUNE_TIME = '03:17'
const DAY_MS = 86_400_000

/**
 * Stores the numbers a render call returned: one row per lottery under (member, scope, card date),
 * replacing the numbers of an earlier สุ่ม of the same card. A lottery listed twice keeps its last
 * numbers. One D1 batch (all rows or none); callers decide whether a failure matters.
 */
export async function saveDraws(
  db: DB,
  memberId: string,
  scope: string,
  cardDate: string,
  draws: readonly { lotteryId: string; numbers: CardNumbers }[],
  nowMs = Date.now(),
): Promise<void> {
  const byLottery = new Map(draws.map((d) => [d.lotteryId, d.numbers] as const))
  const updatedAt = nowIso(nowMs)
  const rows = [...byLottery].map(([lotteryId, numbers]) => ({
    memberId,
    scope,
    lotteryId,
    cardDate,
    numbers: JSON.stringify(numbers),
    updatedAt,
  }))
  const stmts = chunk(rows, DRAW_ROWS_PER_INSERT).map((part) =>
    db
      .insert(memberDraws)
      .values(part)
      .onConflictDoUpdate({
        target: [memberDraws.memberId, memberDraws.scope, memberDraws.lotteryId, memberDraws.cardDate],
        set: { numbers: sql`excluded.numbers`, updatedAt: sql`excluded.updated_at` },
      }),
  )
  if (stmts.length) await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]])
}

function parseNumbers(json: string): CardNumbers | null {
  try {
    const v: unknown = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as CardNumbers) : null
  } catch {
    return null
  }
}

/**
 * The member's saved draws for one card date, ordered by scope then lottery id. `scopes` limits
 * them to those scopes ('single' and / or set ids); empty = every scope. A row whose JSON cannot
 * be read (only possible by editing the database by hand) is left out.
 */
export async function loadDraws(
  db: DB,
  memberId: string,
  cardDate: string,
  scopes: readonly string[] = [],
): Promise<MemberDraw[]> {
  const rows = await db
    .select({
      scope: memberDraws.scope,
      lotteryId: memberDraws.lotteryId,
      numbers: memberDraws.numbers,
      updatedAt: memberDraws.updatedAt,
    })
    .from(memberDraws)
    .where(
      and(
        eq(memberDraws.memberId, memberId),
        eq(memberDraws.cardDate, cardDate),
        scopes.length ? inArray(memberDraws.scope, [...scopes]) : undefined,
      ),
    )
    .orderBy(asc(memberDraws.scope), asc(memberDraws.lotteryId))
  const out: MemberDraw[] = []
  for (const r of rows) {
    const numbers = parseNumbers(r.numbers)
    if (numbers) out.push({ scope: r.scope, lotteryId: r.lotteryId, numbers, updatedAt: r.updatedAt })
  }
  return out
}

/**
 * Deletes the saved draws last written more than DRAW_RETENTION_DAYS days before `nowMs` (by
 * `updated_at`, so a row always lives that long after its last สุ่ม, whatever its card date is).
 * One statement and one pass over the table, because the table has no index for this: it runs
 * once a day, and every index would be one more D1 row written for every card a member draws.
 * Returns the number of rows deleted.
 */
export async function pruneMemberDraws(db: DB, nowMs = Date.now()): Promise<number> {
  const cutoff = nowIso(nowMs - DRAW_RETENTION_DAYS * DAY_MS)
  return changedRows(await db.run(sql`delete from member_draws where updated_at < ${cutoff}`))
}

/**
 * The cron entry of the cleanup. The trigger fires every minute; the cleanup runs once a day, in
 * the invocation that was due at DRAW_PRUNE_TIME (Bangkok). Every other minute returns null and
 * reads nothing. `scheduledTime` is the minute the trigger was due (so a late run still counts),
 * `nowMs` the clock the cutoff is measured from.
 */
export async function runScheduledPrune(
  env: Bindings,
  scheduledTime: number,
  nowMs = Date.now(),
): Promise<number | null> {
  if (bangkokMinute(scheduledTime).slice(11) !== DRAW_PRUNE_TIME) return null
  const removed = await pruneMemberDraws(getDb(env), nowMs)
  if (removed > 0) console.log('member_draws cleanup', JSON.stringify({ removed }))
  return removed
}
