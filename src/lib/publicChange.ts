// Recording that the public results changed: the version counter, the "dirty" marks that say which
// snapshot files must be rebuilt, and the writes of official results that do both atomically. Building
// and uploading the files is src/lib/publicPublish.ts; what a file contains is src/lib/publicSnapshot.ts.
//
// site_settings rows used (none of them is in SITE_SETTING_KEYS, so /admin/settings does not change):
//   results_version            counter, +1 for every change that can alter a public file ("1" is seeded by migration 0010)
//   results_published_version  the last version whose marks were all published (no row = nothing published yet)
//   public_results_enabled     "false" stops all publishing (default on); writes still count and mark
//   results_rollover_day       the Bangkok day today.json was last rolled over to (see runPublishPass)
//   results_dirty:l:<id>       the file lottery/<id>.json must be rebuilt (or removed when the lottery is not public any more)
//   results_dirty:d:<date>     the file day/<date>.json must be rebuilt
//   results_dirty:t            today.json must be rebuilt (it is rewritten by every build anyway; this only carries the version)
// A mark's value is the version it was (re)marked at. A change writes its data, bumps the version and
// sets its marks in ONE D1 batch (all or nothing), so a version without its marks cannot exist; a build
// deletes only the marks it processed (same key AND same value), so a change that arrives during a build
// keeps its marks. The invariant "marks exist => results_version > results_published_version" is what
// lets the cron do one cheap read and stop when the two versions are equal.
//
// Batches only contain query builders (never db.run): drizzle's D1 driver cannot bind parameters of a raw
// statement inside a batch. "Only when something really changed" uses SQLite's changes() of the
// statement before, which D1 and libSQL keep inside a batch (the render counter relies on it too).
import { and, eq, gte, lt, or, sql, type SQL } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DB } from '../db/client'
import { lotteries, lotteryResults, siteSettings } from '../db/schema'
import type { PublicBucket, PublicStatus } from '../types'
import { LOTTERY_DIR, isPublicLottery, loadPublicLotteries } from './publicSnapshot'
import { OFFICIAL_MEMBER_ID, type ResultRow } from './results'
import { addDays, bangkokDay, nowIso } from './time'

type BatchSqlite = BatchItem<'sqlite'>

export const RESULTS_VERSION_KEY = 'results_version'
export const RESULTS_PUBLISHED_KEY = 'results_published_version'
export const PUBLIC_RESULTS_ENABLED_KEY = 'public_results_enabled'
export const RESULTS_ROLLOVER_KEY = 'results_rollover_day'

/** Every mark starts with this; the next character after the prefix' ':' is ';', which ends the key range. */
export const DIRTY_PREFIX = 'results_dirty:'
export const DIRTY_END = 'results_dirty;'
export const DIRTY_LOTTERY_PREFIX = 'results_dirty:l:'
export const DIRTY_DAY_PREFIX = 'results_dirty:d:'
export const DIRTY_TODAY_KEY = 'results_dirty:t'
/** A rebuild of "everything" covers the dates of the last this many days (the admin can ask for all dates). */
export const RECENT_DAYS = 14

export const dirtyLotteryKey = (id: string): string => `${DIRTY_LOTTERY_PREFIX}${id}`
export const dirtyDayKey = (date: string): string => `${DIRTY_DAY_PREFIX}${date}`

// ---------------------------------------------------------------------------------------------
// Reading the state
// ---------------------------------------------------------------------------------------------

export interface PublishState {
  /** public_results_enabled: only the exact text "false" means off. */
  enabled: boolean
  version: number
  published: number
  rolloverDay: string | null
}

const toCount = (v: string | undefined): number => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** One cheap read: the four settings above. Missing rows are version 0, published 0, enabled, no rollover day. */
export async function readPublishState(db: DB): Promise<PublishState> {
  const rows = await db
    .select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings)
    .where(
      or(
        eq(siteSettings.key, RESULTS_VERSION_KEY),
        eq(siteSettings.key, RESULTS_PUBLISHED_KEY),
        eq(siteSettings.key, PUBLIC_RESULTS_ENABLED_KEY),
        eq(siteSettings.key, RESULTS_ROLLOVER_KEY),
      ),
    )
  const map = new Map(rows.map((r) => [r.key, r.value] as const))
  return {
    enabled: map.get(PUBLIC_RESULTS_ENABLED_KEY) !== 'false',
    version: toCount(map.get(RESULTS_VERSION_KEY)),
    published: toCount(map.get(RESULTS_PUBLISHED_KEY)),
    rolloverDay: map.get(RESULTS_ROLLOVER_KEY) ?? null,
  }
}

/** The state for the back office: the settings plus how many marks wait. */
export async function loadPublicStatus(db: DB, bucketBound: boolean): Promise<PublicStatus> {
  const state = await readPublishState(db)
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(siteSettings)
    .where(and(gte(siteSettings.key, DIRTY_PREFIX), lt(siteSettings.key, DIRTY_END)))
  return {
    enabled: state.enabled,
    bucketBound,
    version: state.version,
    publishedVersion: state.published,
    pending: Number(row?.n ?? 0),
  }
}

/** Sets public_results_enabled. Off = nothing is published (writes still bump the version and mark files). */
export async function setPublicEnabled(db: DB, enabled: boolean): Promise<void> {
  await db
    .insert(siteSettings)
    .values({ key: PUBLIC_RESULTS_ENABLED_KEY, value: String(enabled), updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
    })
}

// ---------------------------------------------------------------------------------------------
// Recording a change (statements for a write batch)
// ---------------------------------------------------------------------------------------------

/** What a change makes stale. today.json needs no entry: every build rewrites it. */
export interface ChangeMarks {
  /** day/<date>.json files */
  dates?: readonly string[]
  /** lottery/<id>.json files */
  lotteryIds?: readonly string[]
  /** every date this lottery has official results on (it became public or hidden, or its expected fields changed) */
  allDatesOfLottery?: string
  /** only carry a new version to the clients (the Bangkok day rolled over) */
  today?: boolean
}

const upsertMark = { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` }

/**
 * The statements that count a change and mark its files, to be appended to the batch of the change
 * itself. They always form a chain, each one running only when the one before it changed a row:
 *   - `chained: true`  the first one also needs the statement BEFORE this chain (the write of the data)
 *     to have changed a row, so a re-sent identical result neither bumps the version nor marks anything;
 *   - `onlyIfPublicLottery` additionally needs that lottery to be public (a change to a switched-off
 *     lottery changes no file).
 * Without options they run unconditionally (an admin change that the caller has already compared).
 */
export function recordChangeStatements(
  db: DB,
  at: string,
  marks: ChangeMarks,
  opts: { chained?: boolean; onlyIfPublicLottery?: string } = {},
): BatchSqlite[] {
  const conditions: SQL[] = []
  if (opts.chained) conditions.push(sql`changes() > 0`)
  if (opts.onlyIfPublicLottery !== undefined) {
    conditions.push(
      sql`exists ${db
        .select({ one: sql`1` })
        .from(lotteries)
        .where(and(eq(lotteries.id, opts.onlyIfPublicLottery), isPublicLottery))}`,
    )
  }
  const when = conditions.length > 0 ? sql.join(conditions, sql` and `) : sql`1`
  const out: BatchSqlite[] = [
    db
      .insert(siteSettings)
      .select(sql`select ${RESULTS_VERSION_KEY}, '1', ${at} where ${when}`)
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: sql`cast(${siteSettings.value} as integer) + 1`, updatedAt: at },
      }),
  ]
  const keys = [
    ...new Set([
      ...(marks.dates ?? []).map(dirtyDayKey),
      ...(marks.lotteryIds ?? []).map(dirtyLotteryKey),
      ...(marks.today ? [DIRTY_TODAY_KEY] : []),
    ]),
  ]
  if (keys.length > 0) {
    out.push(
      db
        .insert(siteSettings)
        .select(
          sql`select j.value, (select value from site_settings where key = ${RESULTS_VERSION_KEY}), ${at}
              from json_each(${JSON.stringify(keys)}) as j where changes() > 0`,
        )
        .onConflictDoUpdate({ target: siteSettings.key, set: upsertMark }),
    )
  }
  if (marks.allDatesOfLottery !== undefined) {
    // Last of the chain: a lottery without results inserts no row, and a following statement would stop.
    out.push(
      db
        .insert(siteSettings)
        .select(
          sql`select ${DIRTY_DAY_PREFIX} || draw_date, (select value from site_settings where key = ${RESULTS_VERSION_KEY}), ${at}
              from lottery_results
              where lottery_id = ${marks.allDatesOfLottery} and member_id = ${OFFICIAL_MEMBER_ID} and changes() > 0
              group by draw_date`,
        )
        .onConflictDoUpdate({ target: siteSettings.key, set: upsertMark }),
    )
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Writing official results
// ---------------------------------------------------------------------------------------------

/**
 * Stores an official result like the upsert both writers always used (the unique index decides, the
 * later write wins, an existing row keeps its id and created_at), with two differences:
 *   - a result that already holds exactly these three numbers is left ALONE: no row is written, its
 *     `updated_at` (the "ออกแล้ว 18:31" mark) does not move and nothing is counted or marked. The
 *     `source` of such a re-send is not stored either.
 *   - a real change is counted and marks its files in the same batch (see recordChangeStatements),
 *     when the lottery is public.
 * Throws the driver's error when the lottery is gone (its FOREIGN KEY fails), like upsertResult.
 */
export async function writeOfficialResult(
  db: DB,
  row: ResultRow,
): Promise<{ saved: ResultRow; created: boolean; changed: boolean }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const upsert = db
      .insert(lotteryResults)
      .values(row)
      .onConflictDoUpdate({
        target: [lotteryResults.lotteryId, lotteryResults.drawDate, lotteryResults.drawTime, lotteryResults.memberId],
        set: { top3: row.top3, top2: row.top2, bottom2: row.bottom2, source: row.source, updatedAt: row.updatedAt },
        setWhere: sql`${lotteryResults.top3} is not ${row.top3} or ${lotteryResults.top2} is not ${row.top2} or ${lotteryResults.bottom2} is not ${row.bottom2}`,
      })
      .returning()
    const res = (await db.batch([
      upsert,
      ...recordChangeStatements(
        db,
        row.updatedAt,
        { dates: [row.drawDate], lotteryIds: [row.lotteryId] },
        { chained: true, onlyIfPublicLottery: row.lotteryId },
      ),
    ] as [BatchSqlite, ...BatchSqlite[]])) as unknown[]
    const [saved] = res[0] as ResultRow[]
    if (saved) return { saved, created: saved.id === row.id, changed: true }
    // Nothing changed: the draw already holds these numbers. Answer with the stored row.
    const [existing] = await db
      .select()
      .from(lotteryResults)
      .where(
        and(
          eq(lotteryResults.lotteryId, row.lotteryId),
          eq(lotteryResults.drawDate, row.drawDate),
          eq(lotteryResults.drawTime, row.drawTime),
          eq(lotteryResults.memberId, OFFICIAL_MEMBER_ID),
        ),
      )
      .limit(1)
    if (existing) return { saved: existing, created: false, changed: false }
    // It was deleted between the two statements: write it again.
  }
  throw new Error('writeOfficialResult: the draw keeps changing under the write')
}

/**
 * Deletes one OFFICIAL result by id (a personal result's id is "not found") and counts the change when
 * the lottery is public. Returns false when there was no such result.
 */
export async function deleteOfficialResult(db: DB, id: string): Promise<boolean> {
  const [row] = await db
    .select({ lotteryId: lotteryResults.lotteryId, drawDate: lotteryResults.drawDate })
    .from(lotteryResults)
    .where(and(eq(lotteryResults.id, id), eq(lotteryResults.memberId, OFFICIAL_MEMBER_ID)))
    .limit(1)
  if (!row) return false
  const res = (await db.batch([
    db
      .delete(lotteryResults)
      .where(and(eq(lotteryResults.id, id), eq(lotteryResults.memberId, OFFICIAL_MEMBER_ID)))
      .returning({ id: lotteryResults.id }),
    ...recordChangeStatements(
      db,
      nowIso(),
      { dates: [row.drawDate], lotteryIds: [row.lotteryId] },
      { chained: true, onlyIfPublicLottery: row.lotteryId },
    ),
  ] as [BatchSqlite, ...BatchSqlite[]])) as unknown[]
  return (res[0] as unknown[]).length > 0
}

// ---------------------------------------------------------------------------------------------
// Marking everything
// ---------------------------------------------------------------------------------------------

async function listKeys(bucket: PublicBucket, prefix: string): Promise<string[]> {
  const keys: string[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const res = await bucket.list({ prefix, cursor, limit: 1000 })
    for (const o of res.objects) keys.push(o.key)
    if (!res.truncated) break
    cursor = res.cursor
  }
  return keys
}

/**
 * Marks every public lottery's file, the day file of every date with an official result in the last
 * RECENT_DAYS days (or of every date with `allDays`) and the file of every lottery in the bucket that is
 * not public (so it is removed), all at `version`. Used for the first publish, after a version bump
 * that has no marks (someone edited the data by hand) and by the back office "rebuild everything".
 */
export async function markEverything(
  db: DB,
  args: { version: number; nowMs: number; allDays: boolean; bucket?: PublicBucket },
): Promise<void> {
  const at = nowIso(args.nowMs)
  const version = String(args.version)
  const stmts: BatchSqlite[] = [
    db
      .insert(siteSettings)
      .select(sql`select ${DIRTY_LOTTERY_PREFIX} || id, ${version}, ${at} from lotteries where ${isPublicLottery}`)
      .onConflictDoUpdate({ target: siteSettings.key, set: upsertMark }),
    db
      .insert(siteSettings)
      .select(
        args.allDays
          ? sql`select ${DIRTY_DAY_PREFIX} || draw_date, ${version}, ${at} from lottery_results
                where member_id = ${OFFICIAL_MEMBER_ID} group by draw_date`
          : sql`select ${DIRTY_DAY_PREFIX} || draw_date, ${version}, ${at} from lottery_results
                where member_id = ${OFFICIAL_MEMBER_ID} and draw_date >= ${addDays(bangkokDay(args.nowMs), -RECENT_DAYS)}
                group by draw_date`,
      )
      .onConflictDoUpdate({ target: siteSettings.key, set: upsertMark }),
  ]
  if (args.bucket) {
    const publicIds = new Set((await loadPublicLotteries(db)).map((l) => l.id))
    const orphans = (await listKeys(args.bucket, LOTTERY_DIR))
      .map((k) => k.slice(LOTTERY_DIR.length).replace(/\.json$/, ''))
      .filter((id) => id !== '' && !publicIds.has(id))
    if (orphans.length > 0) {
      stmts.push(
        db
          .insert(siteSettings)
          .select(
            sql`select ${DIRTY_LOTTERY_PREFIX} || j.value, ${version}, ${at} from json_each(${JSON.stringify(orphans)}) as j where true`,
          )
          .onConflictDoUpdate({ target: siteSettings.key, set: upsertMark }),
      )
    }
  }
  await db.batch(stmts as [BatchSqlite, ...BatchSqlite[]])
}

/** Counts a change that has no data write of its own (the "rebuild everything" button) and returns the new version. */
export async function bumpVersion(db: DB, at = nowIso()): Promise<number> {
  await db
    .insert(siteSettings)
    .select(sql`select ${RESULTS_VERSION_KEY}, '1', ${at} where 1`)
    .onConflictDoUpdate({
      target: siteSettings.key,
      set: { value: sql`cast(${siteSettings.value} as integer) + 1`, updatedAt: at },
    })
  return (await readPublishState(db)).version
}
