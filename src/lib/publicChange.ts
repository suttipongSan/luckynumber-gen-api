// Recording that the public results changed, from numbergen-api's side: DB ONLY. The free public results site is fed by
// the RESULTS API (numbergen-results-api), a Worker of its own on the same D1 database: it writes the official results,
// builds the snapshot files and uploads them to the PUBLIC_RESULTS bucket, and its cron publishes whatever is recorded
// here within a minute. THIS API NEVER TOUCHES THE BUCKET (it has no binding to it).
//
// What numbergen-api records is a change of the lottery CATALOGUE that it owns: an admin creating, renaming, switching
// off or deleting a lottery (routes/admin.ts). The statements below go in the SAME D1 batch as the change itself, so a
// version without its marks cannot exist (all or nothing):
//   - results_version (a site_settings row, seeded as "1" by migration 0010) goes up by one;
//   - results_dirty:l:<id>   the file lottery/<id>.json must be rebuilt (or removed when the lottery is not public any more);
//   - results_dirty:d:<date> the file day/<date>.json must be rebuilt: one for every date the lottery has OFFICIAL results
//     on (`allDatesOfLottery`: it became public or hidden, or is deleted, so its results enter or leave the day files).
// A mark's value is the version it was marked at. The results API reads them, builds, and deletes the marks it processed.
//
// This file is the MINIMAL copy: only what the catalogue routes need. The results API has the full one
// (numbergen-results-api/src/lib/publicChange.ts, which also writes the official results with the same marks). KEEP THE
// STATEMENTS IN SYNC: the keys and their meaning are a contract between the two Workers, and
// test/catalogueRecording.test.ts pins the exact rows a fixed sequence of catalogue changes leaves, in both repos.
// These rows are not in SITE_SETTING_KEYS, so /admin/settings does not change.
//
// Batches only contain query builders (never db.run): drizzle's D1 driver cannot bind parameters of a raw statement
// inside a batch. "Only when something really changed" uses SQLite's changes() of the statement before, which D1 and
// libSQL keep inside a batch.
import { sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DB } from '../db/client'
import { siteSettings } from '../db/schema'
import { OFFICIAL_MEMBER_ID } from './results'

type BatchSqlite = BatchItem<'sqlite'>

export const RESULTS_VERSION_KEY = 'results_version'
export const DIRTY_LOTTERY_PREFIX = 'results_dirty:l:'
export const DIRTY_DAY_PREFIX = 'results_dirty:d:'

export const dirtyLotteryKey = (id: string): string => `${DIRTY_LOTTERY_PREFIX}${id}`

/** What a catalogue change makes stale. today.json needs no entry: every build rewrites it. */
export interface ChangeMarks {
  /** lottery/<id>.json files */
  lotteryIds?: readonly string[]
  /** every date this lottery has official results on (it became public or hidden, was deleted, ...) */
  allDatesOfLottery?: string
}

const upsertMark = { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` }

/**
 * The statements that count a change and mark its files, to be appended to the batch of the change itself (BEFORE the
 * deletes of a lottery delete: the marks of `allDatesOfLottery` read the dates of results that those remove). They
 * always form a chain, each one running only when the one before it changed a row. The caller has already decided that
 * the change counts (a change that cannot alter a public file is not recorded at all).
 */
export function recordChangeStatements(db: DB, at: string, marks: ChangeMarks): BatchSqlite[] {
  const out: BatchSqlite[] = [
    db
      .insert(siteSettings)
      .select(sql`select ${RESULTS_VERSION_KEY}, '1', ${at} where 1`)
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: sql`cast(${siteSettings.value} as integer) + 1`, updatedAt: at },
      }),
  ]
  const keys = [...new Set((marks.lotteryIds ?? []).map(dirtyLotteryKey))]
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
