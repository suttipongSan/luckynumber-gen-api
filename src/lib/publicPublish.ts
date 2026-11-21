// Publishing the public results snapshots to the PUBLIC_RESULTS R2 bucket: one bounded "pass" that
// rebuilds the files that were marked dirty (src/lib/publicChange.ts), the per-minute reconcile of the
// cron, and the helper a route calls after a change. What the files contain is src/lib/publicSnapshot.ts.
//
// A pass (runPublishPass):
//   1. nothing happens without the bucket binding or when public_results_enabled is "false"; one cheap
//      read of results_version / results_published_version ends it when they are equal;
//   2. it takes at most `maxMarks` marked files (lotteries first, then dates newest first), builds them
//      and today.json from D1 (every query goes through the public filter), writes the lottery files
//      (writeLotteryFiles, see below), the other data files and then, LAST, version.json, all stamped
//      with the version it read at the start;
//   3. then, in one D1 batch, it deletes the marks it processed (same key AND value) and moves
//      results_published_version up when no mark of that version or older is left.
// The work of a pass is bounded on purpose (a Worker may make only so many D1 / R2 calls per
// invocation: the Workers Free plan allows 50): a large import leaves marks behind and the next cron
// runs continue it. A pass that fails leaves its marks, so the next one repeats the work.
//
// A slow older pass must never overwrite a newer one. Every object stores its version in custom
// metadata `v`, and an upload (putMonotonic) reads that first, skips the file when the stored version is
// newer, and writes with an etag condition so a newer write that lands in between makes it fail and
// look again. A removal (removeMonotonic) reads it too and leaves a file that a newer build wrote.
// That is not enough for the LOTTERY files, because the absence of one means something (its lottery is
// not public) and an absent file carries no version: a pass that began before a lottery was hidden would
// create the file again after the newer pass removed it (the hidden lottery's whole history, public
// again), and a pass that began while it was hidden would delete the file a newer pass wrote when it was
// shown again. So the lottery files go through writeLotteryFiles, which asks D1 whether each lottery is
// still what the pass believes twice: just before it touches the files (a job that no longer matches is put
// off and its mark stays) and just after (what turned out wrong is undone at once and marked again, so a
// later pass puts it right). R2 has no conditional delete and no lock, so no check can close the window
// completely; the second look is what makes the end state right whatever the interleaving.
import type { Context } from 'hono'
import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import { getDb, type DB } from '../db/client'
import { siteSettings } from '../db/schema'
import type { AppEnv, Bindings, PublicBucket } from '../types'
import {
  DIRTY_DAY_PREFIX,
  DIRTY_END,
  DIRTY_LOTTERY_PREFIX,
  DIRTY_PREFIX,
  DIRTY_TODAY_KEY,
  PUBLIC_RESULTS_ENABLED_KEY,
  RESULTS_PUBLISHED_KEY,
  RESULTS_ROLLOVER_KEY,
  RESULTS_VERSION_KEY,
  markEverything,
  readPublishState,
  recordChangeStatements,
  type PublishState,
} from './publicChange'
import {
  JSON_CONTENT_TYPE,
  PUBLIC_ID_RE,
  TODAY_PATH,
  VERSION_PATH,
  assertWhitelisted,
  buildDayFile,
  buildLotteryFile,
  buildTodayFile,
  buildVersionFile,
  cacheControlFor,
  dayPath,
  loadLotteryDraws,
  loadPublicIds,
  loadPublicLotteries,
  loadPublicSchedules,
  loadResultsOfDates,
  lotteryPath,
} from './publicSnapshot'
import { addDays, bangkokDay, isCalendarDay, nowIso } from './time'

type BatchSqlite = BatchItem<'sqlite'>

/** Marked files one pass handles when a request triggered it (the request has its own calls to spare). */
export const REQUEST_MAX_MARKS = 4
/** Marked files one pass handles when the cron or the back office triggered it. */
export const CRON_MAX_MARKS = 8

// ---------------------------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------------------------

/** 'written', or 'older' when the file already holds a newer version (or keeps being rewritten by a newer build). */
export type PutOutcome = 'written' | 'older'

/**
 * Uploads a public file unless the bucket already holds a NEWER version of it. The version is read
 * from the object's custom metadata `v` (an HEAD, no body), the write is conditional on the etag that
 * was read (or on the file not existing), and when the condition fails the whole check is repeated, so
 * two builds racing for a file end with the newer one in it. Equal versions overwrite each other (same
 * state of the data). The body is checked against the whitelist before it leaves.
 */
export async function putMonotonic(
  bucket: PublicBucket,
  path: string,
  body: unknown,
  v: number,
): Promise<PutOutcome> {
  assertWhitelisted(body)
  const text = JSON.stringify(body)
  const meta = {
    httpMetadata: { contentType: JSON_CONTENT_TYPE, cacheControl: cacheControlFor(path) },
    customMetadata: { v: String(v) },
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const head = await bucket.head(path)
    if (head) {
      const stored = Number(head.customMetadata?.v)
      if (Number.isFinite(stored) && stored > v) return 'older'
    }
    let stored: unknown
    if (head) {
      stored = await bucket.put(path, text, { ...meta, onlyIf: { etagMatches: head.etag } })
    } else {
      try {
        stored = await bucket.put(path, text, { ...meta, onlyIf: { etagDoesNotMatch: '*' } })
      } catch {
        // a runtime that cannot express "only if absent": a plain write is what it would have done
        stored = await bucket.put(path, text, meta)
      }
    }
    if (stored !== null) return 'written'
  }
  return 'older'
}

/** 'removed', 'absent' (there was nothing to remove) or 'newer' (the file holds a newer build's data and was left alone). */
export type RemoveOutcome = 'removed' | 'absent' | 'newer'

/**
 * Removes a public file unless the bucket holds a NEWER version of it than the pass that asks. The version
 * is read from the object's custom metadata `v` (an HEAD, no body): a file that is newer than the pass was
 * written after the pass loaded its data (the lottery was shown again), so removing it would undo that
 * build. R2 has no conditional delete, so a newer write that lands between the HEAD and the DELETE is
 * caught afterwards (see writeLotteryFiles). A file without a usable `v` is removed.
 */
export async function removeMonotonic(bucket: PublicBucket, path: string, v: number): Promise<RemoveOutcome> {
  const head = await bucket.head(path)
  if (!head) return 'absent'
  const stored = Number(head.customMetadata?.v)
  if (Number.isFinite(stored) && stored > v) return 'newer'
  await bucket.delete(path)
  return 'removed'
}

// ---------------------------------------------------------------------------------------------
// The marks a pass works on
// ---------------------------------------------------------------------------------------------

interface Mark {
  key: string
  value: string
}

interface Work {
  lotteries: (Mark & { id: string })[]
  days: (Mark & { date: string })[]
  today: Mark | null
  /** marks beyond the budget exist */
  more: boolean
  /** no mark of any kind exists */
  none: boolean
}

/** The state and the marks in ONE batch, so they are one consistent view (see runPublishPass step "no marks"). */
async function loadWork(db: DB, max: number): Promise<{ state: PublishState; work: Work }> {
  const markRows = (from: string, to: string, order: 'asc' | 'desc') =>
    db
      .select({ key: siteSettings.key, value: siteSettings.value })
      .from(siteSettings)
      .where(and(gte(siteSettings.key, from), lt(siteSettings.key, to)))
      .orderBy(order === 'asc' ? asc(siteSettings.key) : desc(siteSettings.key))
      .limit(max + 1)
  const res = (await db.batch([
    db
      .select({ key: siteSettings.key, value: siteSettings.value })
      .from(siteSettings)
      .where(
        sql`${siteSettings.key} in (${RESULTS_VERSION_KEY}, ${RESULTS_PUBLISHED_KEY}, ${PUBLIC_RESULTS_ENABLED_KEY}, ${RESULTS_ROLLOVER_KEY})`,
      ),
    markRows(DIRTY_LOTTERY_PREFIX, 'results_dirty:l;', 'asc'),
    markRows(DIRTY_DAY_PREFIX, 'results_dirty:d;', 'desc'),
    db
      .select({ key: siteSettings.key, value: siteSettings.value })
      .from(siteSettings)
      .where(eq(siteSettings.key, DIRTY_TODAY_KEY)),
  ] as [BatchSqlite, BatchSqlite, BatchSqlite, BatchSqlite])) as Mark[][]
  const map = new Map(res[0].map((r) => [r.key, r.value] as const))
  const count = (k: string) => {
    const n = Number.parseInt(map.get(k) ?? '', 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const state: PublishState = {
    enabled: map.get(PUBLIC_RESULTS_ENABLED_KEY) !== 'false',
    version: count(RESULTS_VERSION_KEY),
    published: count(RESULTS_PUBLISHED_KEY),
    rolloverDay: map.get(RESULTS_ROLLOVER_KEY) ?? null,
  }
  const lotteries = res[1].slice(0, max).map((m) => ({ ...m, id: m.key.slice(DIRTY_LOTTERY_PREFIX.length) }))
  const days = res[2]
    .slice(0, max - lotteries.length)
    .map((m) => ({ ...m, date: m.key.slice(DIRTY_DAY_PREFIX.length) }))
  const today = res[3][0] ?? null
  return {
    state,
    work: {
      lotteries,
      days,
      today,
      more: res[1].length + res[2].length > lotteries.length + days.length,
      none: res[1].length === 0 && res[2].length === 0 && today === null,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// One pass
// ---------------------------------------------------------------------------------------------

export interface PassOptions {
  /** The clock (tests); default Date.now(). The Bangkok today / yesterday of today.json come from it. */
  nowMs?: number
  /** Marked files to handle at most; default CRON_MAX_MARKS. */
  maxMarks?: number
  /** Also roll today.json over when the Bangkok day has changed (the cron does). */
  rollover?: boolean
}

export interface PublishRun {
  /**
   * 'no-bucket' (no PUBLIC_RESULTS binding: nothing to do), 'disabled' (public_results_enabled is false),
   * 'idle' (published version = version), 'published'.
   */
  status: 'no-bucket' | 'disabled' | 'idle' | 'published'
  version: number
  /** Paths written, in order (version.json last). */
  written: string[]
  /**
   * Paths left alone: a newer build had already written them, or their lottery was hidden / shown while
   * this pass ran (a later pass handles them).
   */
  skipped: string[]
  /** Paths removed because the lottery is not public any more. */
  deleted: string[]
  /** Marks are left for the next pass. */
  more: boolean
}

/** Moves today.json over to a new Bangkok day: a version bump with a mark that only carries it to the clients. */
async function rollOver(db: DB, nowMs: number): Promise<void> {
  const at = nowIso(nowMs)
  const stmts: BatchSqlite[] = [
    ...recordChangeStatements(db, at, { today: true }),
    db
      .insert(siteSettings)
      .values({ key: RESULTS_ROLLOVER_KEY, value: bangkokDay(nowMs), updatedAt: at })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      }),
  ]
  await db.batch(stmts as [BatchSqlite, ...BatchSqlite[]])
}

/**
 * One lottery file a pass has to bring in line with D1. `body` is the finished file; no `body` means the
 * lottery is not public and the file must go. `markKey` is the `site_settings` mark that asked for it.
 */
export interface LotteryFileJob {
  id: string
  path: string
  markKey: string
  body?: unknown
}

/**
 * After the files of `done` were written (`removed: false`) or removed (`removed: true`): read the
 * visibility of their lotteries again and put right what turned out wrong. A file written for a lottery
 * that is not public now, or removed for one that is public now, is marked and counted as a new change (so
 * the next pass, which reads D1 afresh, writes or removes it properly) and, when it must not exist, deleted
 * at once. The mark comes first, because it is what survives a pass that dies right here, but each of the
 * two is tried whatever happens to the other (a file that must not be public goes even when D1 refuses the
 * mark); the first failure is rethrown afterwards.
 */
async function settleLotteryFiles(
  db: DB,
  bucket: PublicBucket,
  done: readonly { job: LotteryFileJob; removed: boolean }[],
  v: number,
  at: string,
  run: PublishRun,
): Promise<void> {
  if (done.length === 0) return
  const visible = await loadPublicIds(db, done.map((d) => d.job.id))
  const wrong = done.filter((d) => visible.has(d.job.id) === d.removed)
  if (wrong.length === 0) return
  console.warn(
    'public snapshots: a lottery was hidden or shown while a build ran; its file is corrected',
    JSON.stringify(wrong.map((d) => d.job.id)),
  )
  let failure: unknown
  try {
    await db.batch(
      recordChangeStatements(db, at, { lotteryIds: wrong.map((d) => d.job.id) }) as [BatchSqlite, ...BatchSqlite[]],
    )
    run.more = true
  } catch (err) {
    failure = err
  }
  for (const d of wrong) {
    if (d.removed) continue // nothing to undo in the bucket: the mark makes the next pass write the file again
    try {
      // not a file that a newer build wrote since: removeMonotonic leaves that one (its lottery is public again)
      if ((await removeMonotonic(bucket, d.job.path, v)) === 'removed') run.deleted.push(d.job.path)
    } catch (err) {
      if (failure === undefined) failure = err
    }
  }
  if (failure !== undefined) throw failure
}

/**
 * Writes and removes the lottery files of ONE pass (removals first, then the uploads in the order given)
 * and returns the keys of the marks whose job was put off: the caller must leave those marks in place.
 *
 * The file of a lottery that is not public must not exist, and the pass built its jobs from reads of D1
 * that may be old by now (a build takes a while, and the cron and a request can run two passes at once).
 *   1. BEFORE it touches the bucket, one read says which of the lotteries are public now. A job that no
 *      longer matches (an upload for a lottery that was hidden or deleted, a removal for one that was shown
 *      again) is not done; its mark stays and a later pass, which reads D1 afresh, handles it.
 *   2. The files are written and removed, version-aware (putMonotonic, removeMonotonic).
 *   3. AFTER that, a second read (settleLotteryFiles) corrects what a change in between made wrong. It runs
 *      even when step 2 failed halfway; the error is rethrown afterwards.
 * A change after the second read is a change like any other: its own version, its own marks, its own pass.
 */
export async function writeLotteryFiles(
  db: DB,
  bucket: PublicBucket,
  jobs: readonly LotteryFileJob[],
  v: number,
  at: string,
  run: PublishRun,
): Promise<Set<string>> {
  const held = new Set<string>()
  if (jobs.length === 0) return held

  const visible = await loadPublicIds(db, jobs.map((j) => j.id))
  const todo: LotteryFileJob[] = []
  for (const j of jobs) {
    if (visible.has(j.id) === (j.body !== undefined)) {
      todo.push(j)
    } else {
      held.add(j.markKey)
      run.skipped.push(j.path)
      run.more = true
    }
  }

  const done: { job: LotteryFileJob; removed: boolean }[] = []
  let failure: unknown
  try {
    for (const j of todo.filter((t) => t.body === undefined)) {
      const outcome = await removeMonotonic(bucket, j.path, v)
      if (outcome === 'removed') {
        run.deleted.push(j.path)
        done.push({ job: j, removed: true })
      } else if (outcome === 'newer') {
        run.skipped.push(j.path)
      }
    }
    for (const j of todo.filter((t) => t.body !== undefined)) {
      const outcome = await putMonotonic(bucket, j.path, j.body, v)
      if (outcome === 'written') {
        run.written.push(j.path)
        done.push({ job: j, removed: false })
      } else {
        run.skipped.push(j.path)
      }
    }
  } catch (err) {
    failure = err
  }
  try {
    await settleLotteryFiles(db, bucket, done, v, at, run)
  } catch (err) {
    if (failure === undefined) failure = err
    else console.error('public snapshots: checking the lottery files after a failed build failed too', err)
  }
  if (failure !== undefined) throw failure
  return held
}

/**
 * One bounded publishing pass (see the header of this file). Never throws for "nothing to do"; D1 and R2
 * errors are thrown and leave the marks in place.
 */
export async function runPublishPass(env: Bindings, opts: PassOptions = {}): Promise<PublishRun> {
  const run: PublishRun = { status: 'no-bucket', version: 0, written: [], skipped: [], deleted: [], more: false }
  const bucket = env.PUBLIC_RESULTS
  if (!bucket) return run
  const db = getDb(env)
  const nowMs = opts.nowMs ?? Date.now()
  const maxMarks = opts.maxMarks ?? CRON_MAX_MARKS

  let state = await readPublishState(db)
  run.version = state.version
  if (!state.enabled) {
    run.status = 'disabled'
    return run
  }
  if (opts.rollover) {
    const today = bangkokDay(nowMs)
    if (state.rolloverDay === null) {
      // the first run ever: nothing to roll over (the first publish builds everything), just remember the day
      await db
        .insert(siteSettings)
        .values({ key: RESULTS_ROLLOVER_KEY, value: today, updatedAt: nowIso(nowMs) })
        .onConflictDoNothing()
    } else if (state.rolloverDay !== today) {
      await rollOver(db, nowMs)
      state = await readPublishState(db)
      run.version = state.version
    }
  }
  if (state.version <= state.published) {
    run.status = 'idle'
    return run
  }

  // Something is unpublished: read the state again together with the marks (one consistent view).
  let { state: fresh, work } = await loadWork(db, maxMarks)
  state = fresh
  run.version = state.version
  if (state.version <= state.published) {
    run.status = 'idle' // another run published it in the meantime
    return run
  }
  // Mark everything when
  //   - there is a newer version and not a single mark (someone changed the data by hand): nothing says
  //     what changed. The consistent read above is what makes this safe: a run that has just finished
  //     would have moved the published version in the same batch that removed its marks;
  //   - or nothing was ever published (no published version, and no version.json in the bucket): the
  //     first change after migration 0010 (it seeds version 1) must not stand in for the whole site.
  //     Once a pass has written version.json this never repeats, so the marks of a build that takes
  //     several passes are not marked again.
  const firstPublish = !work.none && state.published === 0 && (await bucket.head(VERSION_PATH)) === null
  if (work.none || firstPublish) {
    await markEverything(db, { version: state.version, nowMs, allDays: false, bucket })
    ;({ state: fresh, work } = await loadWork(db, maxMarks))
    state = fresh
  }
  const v = state.version
  run.version = v
  run.status = 'published'
  run.more = work.more

  const today = bangkokDay(nowMs)
  const infos = await loadPublicLotteries(db)
  const infoById = new Map(infos.map((l) => [l.id, l] as const))
  const schedules = await loadPublicSchedules(db)
  const publicIds = new Set(infoById.keys())
  const dates = [...new Set([today, addDays(today, -1), ...work.days.map((d) => d.date).filter(isCalendarDay)])]
  const dayRows = await loadResultsOfDates(db, dates)

  // Build everything first; a build error then leaves the bucket as it was.
  const lotteryJobs: LotteryFileJob[] = []
  const uploads: { path: string; body: unknown }[] = []
  for (const m of work.lotteries) {
    if (!PUBLIC_ID_RE.test(m.id)) continue // not a name a file can have; nothing was ever published under it
    const path = lotteryPath(m.id)
    const info = infoById.get(m.id)
    if (!info) {
      lotteryJobs.push({ id: m.id, path, markKey: m.key }) // not public: its file, if there is one, goes
      continue
    }
    const rows = await loadLotteryDraws(db, m.id)
    lotteryJobs.push({
      id: m.id,
      path,
      markKey: m.key,
      body: buildLotteryFile({ v, nowMs, lottery: info, schedules: schedules.get(m.id) ?? [], rows }),
    })
  }
  for (const m of work.days) {
    if (!isCalendarDay(m.date)) continue // not a date a file can be named after (a hand-edited mark); it is only deleted below
    uploads.push({
      path: dayPath(m.date),
      body: buildDayFile({ v, nowMs, date: m.date, publicIds, schedules, results: dayRows }),
    })
  }
  uploads.push({
    path: TODAY_PATH,
    body: buildTodayFile({ v, nowMs, lotteries: infos, schedules, results: dayRows }),
  })

  // Data files first (today.json, the one clients chase, after the files it points to), version.json LAST.
  // The lottery files go first and through their own guard (writeLotteryFiles): they are the only files
  // whose absence means something.
  const at = nowIso(nowMs)
  const held = await writeLotteryFiles(db, bucket, lotteryJobs, v, at, run)
  for (const u of uploads) {
    const outcome = await putMonotonic(bucket, u.path, u.body, v)
    ;(outcome === 'written' ? run.written : run.skipped).push(u.path)
  }
  const outcome = await putMonotonic(bucket, VERSION_PATH, buildVersionFile(v, nowMs), v)
  ;(outcome === 'written' ? run.written : run.skipped).push(VERSION_PATH)

  // The processed marks go and the published version moves up, atomically. A mark that was marked again
  // meanwhile has another value and stays; the version only moves when no mark of this version or older is
  // left. The mark of a lottery file that was put off stays too (writeLotteryFiles).
  const processed = [
    ...work.lotteries.filter((m) => !held.has(m.key)),
    ...work.days,
    ...(work.today ? [work.today] : []),
  ]
  const finish: BatchSqlite[] = []
  if (processed.length > 0) {
    finish.push(
      db.delete(siteSettings).where(
        sql.join(
          processed.map((m) => sql`(${siteSettings.key} = ${m.key} and ${siteSettings.value} = ${m.value})`),
          sql` or `,
        ),
      ),
    )
  }
  finish.push(
    db
      .insert(siteSettings)
      .select(
        sql`select ${RESULTS_PUBLISHED_KEY}, ${String(v)}, ${at}
            where not exists (select 1 from site_settings
                              where key >= ${DIRTY_PREFIX} and key < ${DIRTY_END} and cast(value as integer) <= ${v})`,
      )
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
        setWhere: sql`cast(${siteSettings.value} as integer) < cast(excluded.value as integer)`,
      }),
  )
  await db.batch(finish as [BatchSqlite, ...BatchSqlite[]])
  return run
}

// ---------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------

/**
 * The cron entry: the reconcile. Without the bucket it does nothing at all (no D1 read either); with
 * it, one cheap read ends the run when nothing is unpublished. Also rolls today.json over at the start
 * of a new Bangkok day.
 */
export async function runScheduledPublish(env: Bindings, nowMs = Date.now()): Promise<PublishRun | null> {
  if (!env.PUBLIC_RESULTS) return null
  const run = await runPublishPass(env, { nowMs, maxMarks: CRON_MAX_MARKS, rollover: true })
  if (run.status === 'published') {
    console.log('public snapshots', JSON.stringify({ v: run.version, files: run.written.length, more: run.more }))
  }
  return run
}

/**
 * Starts a pass after a change, in the background of the request (ctx.waitUntil). Never fails the
 * request: the data change is committed and its marks stay, so the cron repeats a failed build. A Worker
 * without the binding does nothing. Without an ExecutionContext (the Node tests) the returned promise is
 * the pass, for the caller to await.
 */
export function schedulePublish(c: Context<AppEnv>): Promise<void> | void {
  if (!c.env.PUBLIC_RESULTS) return
  const task = runPublishPass(c.env, { maxMarks: REQUEST_MAX_MARKS }).then(
    () => undefined,
    (err: unknown) => console.error('public snapshots: build failed (the cron will retry)', err),
  )
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    return task
  }
}
