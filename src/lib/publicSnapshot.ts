// The public results snapshots: small JSON files with the OFFICIAL lottery results and per-lottery
// statistics that the free public results site reads (it never talks to this API or to D1). This
// module is the ONE place that decides what is public and in which shape:
//
//   - the PUBLIC FILTER: only official results (lottery_results.member_id = '') of catalog lotteries
//     (owner_member_id IS NULL) that are active = 1 AND public_enabled = 1 are ever read for a file
//     (`isPublicLottery`, applied by every loader here). A member's typed result, a member's own
//     lottery, a switched-off lottery and a lottery with public_enabled = 0 can never get in.
//   - the FIELD WHITELIST: every file is built field by field from the types below (rows are never
//     spread), so no row id, `source`, member id or reminder column can get in, and `assertWhitelisted`
//     checks the finished file again before it is uploaded (and in the tests).
//   - the PURE functions: draw state (final / partial) and the statistics, unit tested on fixtures.
//
// Files (paths have no query string; every one carries `v`, the version of the build that wrote it):
//   v1/version.json          { v, serverTime }                       written LAST by a build
//   v1/today.json            every public lottery with its schedule and its results of Bangkok today and yesterday
//   v1/day/<YYYY-MM-DD>.json the results of one date (lotteries by id; names are in today.json)
//   v1/lottery/<id>.json     one lottery: info, schedule, last 90 draws, statistics for 30 / 60 / 90 draws
//
// Storing them (versions, which files to rebuild, R2) is src/lib/publicPublish.ts.
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import type { DB } from '../db/client'
import { GROUP_LABELS, GROUP_ORDER } from '../db/catalog'
import { lotteries, lotteryResults, lotterySchedules } from '../db/schema'
import type { Group, ResultField } from '../types'
import { RESULT_FIELDS } from '../types'
import { OFFICIAL_MEMBER_ID } from './results'
import { addDays, bangkokDay } from './time'

// ---------------------------------------------------------------------------------------------
// The shapes of the files (the contract with the public site)
// ---------------------------------------------------------------------------------------------

/** 'final' = every number the draw's schedule expects is there; otherwise 'partial'. */
export type ResultState = 'final' | 'partial'

/** `v1/version.json`. `serverTime` is the ISO instant (UTC) the build wrote it. */
export interface PublicVersionFile {
  v: number
  serverTime: string
}

/** One draw time of a lottery. `days`: ISO weekdays it draws, 1 = Monday .. 7 = Sunday. */
export interface PublicSchedule {
  /** '' (one draw a day) or "HH:MM": the `time` of the results of this draw. */
  drawTime: string
  /** "HH:MM" Asia/Bangkok: when the result is expected. */
  resultTime: string
  days: number[]
  /** The numbers this draw publishes, in the order top3, top2, bottom2. */
  expectedFields: ResultField[]
  /** YYYY-MM-DD when the back office says "no draw on this date", else null. */
  closedDate: string | null
}

export interface PublicLotteryInfo {
  id: string
  name: string
  shortName: string
  group: Group
  accent: string
  sortOrder: number
}

/** The numbers of one draw. `time` is '' or "HH:MM"; `updatedAt` is the ISO instant (UTC) the numbers last changed. */
export interface PublicDraw {
  date: string
  time: string
  top3: string | null
  top2: string | null
  bottom2: string | null
  state: ResultState
  updatedAt: string
}

export interface PublicTodayLottery extends PublicLotteryInfo {
  schedules: PublicSchedule[]
  /** Its draws of Bangkok today and yesterday (as of the build), newest first. */
  results: PublicDraw[]
}

/** `v1/today.json`: every public lottery in display order (group, sortOrder, name). */
export interface PublicTodayFile {
  v: number
  builtAt: string
  /** The Bangkok dates `results` cover: the day of the build and the one before. */
  today: string
  yesterday: string
  /** The groups that have a public lottery, in display order, with their Thai names. */
  groups: { key: Group; label: string }[]
  lotteries: PublicTodayLottery[]
}

export interface PublicDayResult extends PublicDraw {
  lotteryId: string
}

/** `v1/day/<date>.json`: every public result of one date ordered by lotteryId, then time. May be empty. */
export interface PublicDayFile {
  v: number
  builtAt: string
  date: string
  results: PublicDayResult[]
}

export interface PublicHistoryDraw {
  date: string
  time: string
  top3: string | null
  top2: string | null
  bottom2: string | null
  state: ResultState
}

/** Statistics of ONE field (2 ตัวบน or 2 ตัวล่าง) over a window of draws. All counts are of draws. */
export interface PublicFieldStats {
  /** Draws of the window that have this number (the base of every count below). */
  of: number
  /** Index = digit 0..9: the number of draws in which the digit appears in the number ("เลขวิ่งออกบ่อย"). */
  digitCounts: number[]
  /** The most frequent two-digit numbers, at most 10: count desc, then seen more recently, then number asc. */
  topNumbers: { n: string; count: number }[]
  /** All ten digits, longest absent first ("เลขไม่ออกนาน"): `gap` draws since it last appeared (0 = in the newest draw), `last` that draw's date (null = not in the window, then gap = `of`). */
  digitGaps: { digit: number; gap: number; last: string | null }[]
  /** The numbers seen in the window that have been absent longest, at most 10: gap desc, then number asc. */
  numberGaps: { n: string; gap: number; last: string }[]
  even: number
  odd: number
  /** 00-49 */
  low: number
  /** 50-99 */
  high: number
  /** เลขเบิ้ล: both digits the same (00, 11 ... 99). */
  doubles: number
}

/** The newest `draws` final draws (30, 60 or 90); `from` / `to` are the dates of the oldest / newest one. */
export interface PublicStatsWindow {
  draws: 30 | 60 | 90
  from: string
  to: string
  top2: PublicFieldStats
  bottom2: PublicFieldStats
}

/**
 * `v1/lottery/<id>.json`. `draws` are the last 90 draws (any state) newest first; `stats` is null while
 * the lottery has fewer than 30 final draws, otherwise the windows it has enough final draws for
 * (30, then 60 and 90 when there are that many).
 */
export interface PublicLotteryFile {
  v: number
  builtAt: string
  lottery: PublicLotteryInfo
  schedules: PublicSchedule[]
  draws: PublicHistoryDraw[]
  stats: PublicStatsWindow[] | null
}

// ---------------------------------------------------------------------------------------------
// Paths, cache headers, limits
// ---------------------------------------------------------------------------------------------

export const VERSION_PATH = 'v1/version.json'
export const TODAY_PATH = 'v1/today.json'
export const DAY_DIR = 'v1/day/'
export const LOTTERY_DIR = 'v1/lottery/'

export const dayPath = (date: string): string => `${DAY_DIR}${date}.json`
export const lotteryPath = (id: string): string => `${LOTTERY_DIR}${id}.json`

/** A lottery id that can be a file name. Ids that are not (only possible by editing the database by hand) are not published. */
export const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** The path of a file that may be read through GET /public-data/* (local development) or from the bucket. */
export const PUBLIC_PATH_RE =
  /^v1\/(?:version\.json|today\.json|day\/\d{4}-\d{2}-\d{2}\.json|lottery\/[A-Za-z0-9_-]{1,64}\.json)$/

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

/**
 * Cache-Control stored on each object (an R2 custom domain serves it as it is). The client polls
 * version.json and re-reads today.json when `v` moves, and retries a file older than the version it
 * is chasing after 3 s (max 5 times), so those two must not be cached for longer than that horizon.
 */
export function cacheControlFor(path: string): string {
  if (path === VERSION_PATH) return 'public, max-age=5'
  if (path === TODAY_PATH) return 'public, max-age=10'
  return 'public, max-age=60'
}

/** Draws listed in a lottery file. */
export const HISTORY_SHOWN = 90
/** Draws read for a lottery file: a few more than shown, so partial draws among them do not cost a statistics window. */
export const HISTORY_FETCH = 120
/** Statistics are published only from this many final draws on. */
export const MIN_DRAWS_FOR_STATS = 30
export const STATS_WINDOWS = [30, 60, 90] as const
/** Length of the "most frequent" and "absent longest" lists. */
export const STATS_LIST_SIZE = 10

// ---------------------------------------------------------------------------------------------
// Pure functions: expected fields, weekdays, state
// ---------------------------------------------------------------------------------------------

export const DEFAULT_EXPECTED_FIELDS: readonly ResultField[] = RESULT_FIELDS

/**
 * The stored `expected_fields` ("top3,top2,bottom2"-style text) as a list in canonical order, without
 * duplicates or unknown names. Nothing usable (empty, garbage) gives the default three fields.
 */
export function parseExpectedFields(text: string | null | undefined): ResultField[] {
  const named = new Set((text ?? '').split(',').map((s) => s.trim()))
  const fields = RESULT_FIELDS.filter((f) => named.has(f))
  return fields.length > 0 ? fields : [...DEFAULT_EXPECTED_FIELDS]
}

/** The text stored in `expected_fields`: the given fields in canonical order, comma separated. */
export function formatExpectedFields(fields: readonly ResultField[]): string {
  return RESULT_FIELDS.filter((f) => fields.includes(f)).join(',')
}

/** The stored `days` ("1234567"-style text) as sorted unique ISO weekdays 1..7; nothing usable gives every day. */
export function parseDays(text: string | null | undefined): number[] {
  const days = new Set<number>()
  for (const ch of text ?? '') {
    const d = Number(ch)
    if (d >= 1 && d <= 7) days.add(d)
  }
  return days.size > 0 ? [...days].sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6, 7]
}

/** The text stored in `days`: the weekdays sorted, one digit each. */
export function formatDays(days: readonly number[]): string {
  return [...new Set(days)].sort((a, b) => a - b).join('')
}

/** A number counts as present when it is a non-empty string (the API never stores anything else). */
const has = (v: string | null | undefined): v is string => typeof v === 'string' && v !== ''

/** 'final' when every expected field of the result is present, otherwise 'partial'. No timers: only the numbers decide. */
export function resultState(
  row: { top3: string | null; top2: string | null; bottom2: string | null },
  expected: readonly ResultField[] = DEFAULT_EXPECTED_FIELDS,
): ResultState {
  return expected.every((f) => has(row[f])) ? 'final' : 'partial'
}

/**
 * The expected fields of a draw: those of the schedule row with the same draw time, the default three
 * when the lottery has no row for that time.
 */
export function expectedFieldsFor(
  schedules: readonly { drawTime: string; expectedFields: readonly ResultField[] }[],
  drawTime: string,
): readonly ResultField[] {
  return schedules.find((s) => s.drawTime === drawTime)?.expectedFields ?? DEFAULT_EXPECTED_FIELDS
}

// ---------------------------------------------------------------------------------------------
// Pure functions: statistics
// ---------------------------------------------------------------------------------------------

/** What the statistics read of a final draw (newest first). */
export interface StatsDraw {
  date: string
  top2: string | null
  bottom2: string | null
}

const TWO_DIGITS = /^\d{2}$/

/**
 * Statistics of one two-digit field over `entries` (newest first, only the draws that have the field).
 * "Draws" are positions in `entries`, so `gap` 0 means "in the newest draw" and a number never seen has
 * a gap of `of`.
 */
export function fieldStats(entries: readonly { date: string; value: string }[]): PublicFieldStats {
  const valid = entries.filter((e) => TWO_DIGITS.test(e.value))
  const of = valid.length
  const digitCounts = new Array<number>(10).fill(0)
  const digitFirst = new Array<number>(10).fill(-1)
  const digitLast = new Array<string | null>(10).fill(null)
  const numbers = new Map<string, { count: number; first: number; last: string }>()
  let even = 0
  let low = 0
  let doubles = 0
  valid.forEach(({ date, value }, i) => {
    for (const d of new Set(value)) {
      const digit = Number(d)
      digitCounts[digit]++
      if (digitFirst[digit] === -1) {
        digitFirst[digit] = i
        digitLast[digit] = date
      }
    }
    const seen = numbers.get(value)
    if (seen) seen.count++
    else numbers.set(value, { count: 1, first: i, last: date })
    const n = Number(value)
    if (n % 2 === 0) even++
    if (n < 50) low++
    if (value[0] === value[1]) doubles++
  })
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const topNumbers = [...numbers]
    .sort(([an, a], [bn, b]) => b.count - a.count || a.first - b.first || byText(an, bn))
    .slice(0, STATS_LIST_SIZE)
    .map(([n, s]) => ({ n, count: s.count }))
  const digitGaps = digitCounts
    .map((_, digit) => ({
      digit,
      gap: digitFirst[digit] === -1 ? of : digitFirst[digit],
      last: digitLast[digit],
    }))
    .sort((a, b) => b.gap - a.gap || a.digit - b.digit)
  const numberGaps = [...numbers]
    .map(([n, s]) => ({ n, gap: s.first, last: s.last }))
    .sort((a, b) => b.gap - a.gap || byText(a.n, b.n))
    .slice(0, STATS_LIST_SIZE)
  return { of, digitCounts, topNumbers, digitGaps, numberGaps, even, odd: of - even, low, high: of - low, doubles }
}

/** The statistics of one window: the newest `n` of `draws` (final draws, newest first; at least `n` of them). */
export function statsWindow(draws: readonly StatsDraw[], n: 30 | 60 | 90): PublicStatsWindow {
  const slice = draws.slice(0, n)
  const entries = (field: 'top2' | 'bottom2') =>
    slice.flatMap((d) => (has(d[field]) ? [{ date: d.date, value: d[field] as string }] : []))
  return {
    draws: n,
    from: slice[slice.length - 1].date,
    to: slice[0].date,
    top2: fieldStats(entries('top2')),
    bottom2: fieldStats(entries('bottom2')),
  }
}

/**
 * The statistics windows of a lottery from its FINAL draws (newest first): null below 30 draws,
 * otherwise the 30 window, plus the 60 and 90 windows when there are that many draws. Official results
 * only (the caller passes nothing else), counted per draw, and nothing in it predicts anything.
 */
export function buildStats(finalDraws: readonly StatsDraw[]): PublicStatsWindow[] | null {
  if (finalDraws.length < MIN_DRAWS_FOR_STATS) return null
  return STATS_WINDOWS.filter((n) => finalDraws.length >= n).map((n) => statsWindow(finalDraws, n))
}

// ---------------------------------------------------------------------------------------------
// The public filter (one place) and the loaders
// ---------------------------------------------------------------------------------------------

/**
 * THE public filter on `lotteries`: catalog lotteries (no owner) that are switched on and shown on the
 * results site. Every query that feeds a snapshot file is joined to `lotteries` with this condition.
 */
export const isPublicLottery = and(
  isNull(lotteries.ownerMemberId),
  eq(lotteries.active, true),
  eq(lotteries.publicEnabled, true),
)

/** A result row as the builders read it: only the columns that may become public. */
export interface DrawRow {
  lotteryId: string
  date: string
  time: string
  top3: string | null
  top2: string | null
  bottom2: string | null
  updatedAt: string
}

const drawColumns = {
  lotteryId: lotteryResults.lotteryId,
  date: lotteryResults.drawDate,
  time: lotteryResults.drawTime,
  top3: lotteryResults.top3,
  top2: lotteryResults.top2,
  bottom2: lotteryResults.bottom2,
  updatedAt: lotteryResults.updatedAt,
}

const groupIndex = (g: string): number => {
  const i = (GROUP_ORDER as readonly string[]).indexOf(g)
  return i === -1 ? GROUP_ORDER.length : i
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** Every public lottery in display order: group, sortOrder, name, id (plain comparison, so the order never depends on the runtime's locale). */
export async function loadPublicLotteries(db: DB): Promise<PublicLotteryInfo[]> {
  const rows = await db
    .select({
      id: lotteries.id,
      name: lotteries.name,
      shortName: lotteries.shortName,
      group: lotteries.groupKey,
      accent: lotteries.accent,
      sortOrder: lotteries.sortOrder,
    })
    .from(lotteries)
    .where(isPublicLottery)
  return rows
    .filter((r) => PUBLIC_ID_RE.test(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      shortName: r.shortName,
      // an unknown group (only possible by editing the database by hand) is listed under "other"
      group: ((GROUP_ORDER as readonly string[]).includes(r.group) ? r.group : 'other') as Group,
      accent: r.accent,
      sortOrder: r.sortOrder,
    }))
    .sort(
      (a, b) =>
        groupIndex(a.group) - groupIndex(b.group) ||
        a.sortOrder - b.sortOrder ||
        byText(a.name, b.name) ||
        byText(a.id, b.id),
    )
}

/** D1 binds at most 100 parameters per statement; the filter itself uses two. */
const PUBLIC_IDS_PER_QUERY = 50

/**
 * Which of `ids` are public lotteries RIGHT NOW (the public filter above, a fresh read). A publishing pass
 * asks it just before it writes or removes lottery files and again just after, to notice a lottery that was
 * hidden, shown or deleted while it was building (src/lib/publicPublish.ts, `writeLotteryFiles`).
 */
export async function loadPublicIds(db: DB, ids: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (let i = 0; i < ids.length; i += PUBLIC_IDS_PER_QUERY) {
    const rows = await db
      .select({ id: lotteries.id })
      .from(lotteries)
      .where(and(isPublicLottery, inArray(lotteries.id, ids.slice(i, i + PUBLIC_IDS_PER_QUERY))))
    for (const r of rows) found.add(r.id)
  }
  return found
}

/** The schedule rows of the public lotteries, by lottery id, each list ordered by draw time ('' first). */
export async function loadPublicSchedules(db: DB): Promise<Map<string, PublicSchedule[]>> {
  const rows = await db
    .select({
      lotteryId: lotterySchedules.lotteryId,
      drawTime: lotterySchedules.drawTime,
      resultTime: lotterySchedules.resultTime,
      days: lotterySchedules.days,
      expectedFields: lotterySchedules.expectedFields,
      closedDate: lotterySchedules.closedDate,
    })
    .from(lotterySchedules)
    .innerJoin(lotteries, eq(lotteries.id, lotterySchedules.lotteryId))
    .where(isPublicLottery)
    .orderBy(asc(lotterySchedules.lotteryId), asc(lotterySchedules.drawTime))
  const out = new Map<string, PublicSchedule[]>()
  for (const r of rows) {
    const list = out.get(r.lotteryId) ?? []
    list.push({
      drawTime: r.drawTime,
      resultTime: r.resultTime,
      days: parseDays(r.days),
      expectedFields: parseExpectedFields(r.expectedFields),
      closedDate: r.closedDate,
    })
    out.set(r.lotteryId, list)
  }
  return out
}

/** The query behind {@link loadResultsOfDates} (exported so a test can ask SQLite for its plan). */
export function resultsOfDatesQuery(db: DB, dates: readonly string[]) {
  return db
    .select(drawColumns)
    .from(lotteryResults)
    .innerJoin(lotteries, eq(lotteries.id, lotteryResults.lotteryId))
    .where(
      and(
        eq(lotteryResults.memberId, OFFICIAL_MEMBER_ID),
        inArray(lotteryResults.drawDate, [...dates]),
        isPublicLottery,
      ),
    )
    .orderBy(asc(lotteryResults.lotteryId), asc(lotteryResults.drawDate), asc(lotteryResults.drawTime))
}

/** The official results of the given dates (lotteries by id, then date, then time). */
export async function loadResultsOfDates(db: DB, dates: readonly string[]): Promise<DrawRow[]> {
  if (dates.length === 0) return []
  return resultsOfDatesQuery(db, dates)
}

/** The query behind {@link loadLotteryDraws} (exported so a test can ask SQLite for its plan). */
export function lotteryDrawsQuery(db: DB, lotteryId: string, limit: number) {
  return db
    .select(drawColumns)
    .from(lotteryResults)
    .innerJoin(lotteries, eq(lotteries.id, lotteryResults.lotteryId))
    .where(
      and(
        eq(lotteryResults.lotteryId, lotteryId),
        eq(lotteryResults.memberId, OFFICIAL_MEMBER_ID),
        isPublicLottery,
      ),
    )
    .orderBy(desc(lotteryResults.drawDate), desc(lotteryResults.drawTime))
    .limit(limit)
}

/** The newest official results of ONE lottery, newest first (the index lottery_results_official_idx serves it). */
export async function loadLotteryDraws(db: DB, lotteryId: string, limit = HISTORY_FETCH): Promise<DrawRow[]> {
  return lotteryDrawsQuery(db, lotteryId, limit)
}

// ---------------------------------------------------------------------------------------------
// The builders (rows in, public file out; the whitelist lives here)
// ---------------------------------------------------------------------------------------------

type Schedules = ReadonlyMap<string, readonly PublicSchedule[]>

const builtAtOf = (nowMs: number) => new Date(nowMs).toISOString()

function toDraw(r: DrawRow, schedules: readonly PublicSchedule[]): PublicDraw {
  return {
    date: r.date,
    time: r.time,
    top3: r.top3,
    top2: r.top2,
    bottom2: r.bottom2,
    state: resultState(r, expectedFieldsFor(schedules, r.time)),
    updatedAt: r.updatedAt,
  }
}

/** Newest first: date, then time, descending. */
const newestFirst = (a: { date: string; time: string }, b: { date: string; time: string }) =>
  byText(b.date, a.date) || byText(b.time, a.time)

/**
 * `today.json`. `results` are the rows of Bangkok today and yesterday AS OF `nowMs` (rows of other dates
 * in `results` are ignored, so the window is decided here and nowhere else). The lotteries listed are
 * exactly `lotteries`, and results of any other lottery are dropped.
 */
export function buildTodayFile(args: {
  v: number
  nowMs: number
  lotteries: readonly PublicLotteryInfo[]
  schedules: Schedules
  results: readonly DrawRow[]
}): PublicTodayFile {
  const today = bangkokDay(args.nowMs)
  const yesterday = addDays(today, -1)
  const byLottery = new Map<string, DrawRow[]>()
  for (const r of args.results) {
    if (r.date !== today && r.date !== yesterday) continue
    const list = byLottery.get(r.lotteryId) ?? []
    list.push(r)
    byLottery.set(r.lotteryId, list)
  }
  const list: PublicTodayLottery[] = args.lotteries.map((l) => {
    const schedules = [...(args.schedules.get(l.id) ?? [])]
    return {
      id: l.id,
      name: l.name,
      shortName: l.shortName,
      group: l.group,
      accent: l.accent,
      sortOrder: l.sortOrder,
      schedules,
      results: (byLottery.get(l.id) ?? []).map((r) => toDraw(r, schedules)).sort(newestFirst),
    }
  })
  return {
    v: args.v,
    builtAt: builtAtOf(args.nowMs),
    today,
    yesterday,
    groups: GROUP_ORDER.filter((g) => list.some((l) => l.group === g)).map((key) => ({
      key,
      label: GROUP_LABELS[key],
    })),
    lotteries: list,
  }
}

/** `day/<date>.json`: the rows of that date that belong to one of `publicIds` (results of any other lottery are dropped). */
export function buildDayFile(args: {
  v: number
  nowMs: number
  date: string
  publicIds: ReadonlySet<string>
  schedules: Schedules
  results: readonly DrawRow[]
}): PublicDayFile {
  const results: PublicDayResult[] = args.results
    .filter((r) => r.date === args.date && args.publicIds.has(r.lotteryId))
    .map((r) => ({ lotteryId: r.lotteryId, ...toDraw(r, args.schedules.get(r.lotteryId) ?? []) }))
    .sort((a, b) => byText(a.lotteryId, b.lotteryId) || byText(a.time, b.time))
  return { v: args.v, builtAt: builtAtOf(args.nowMs), date: args.date, results }
}

/**
 * `lottery/<id>.json` from the lottery's newest official results (`rows`, newest first, normally up to
 * HISTORY_FETCH). The list shows the first HISTORY_SHOWN of them with their state; the statistics use the
 * FINAL ones among all of them.
 */
export function buildLotteryFile(args: {
  v: number
  nowMs: number
  lottery: PublicLotteryInfo
  schedules: readonly PublicSchedule[]
  rows: readonly DrawRow[]
}): PublicLotteryFile {
  const draws: PublicHistoryDraw[] = [...args.rows].sort(newestFirst).map((r) => {
    const d = toDraw(r, args.schedules)
    return { date: d.date, time: d.time, top3: d.top3, top2: d.top2, bottom2: d.bottom2, state: d.state }
  })
  const finals = draws.filter((d) => d.state === 'final')
  return {
    v: args.v,
    builtAt: builtAtOf(args.nowMs),
    lottery: {
      id: args.lottery.id,
      name: args.lottery.name,
      shortName: args.lottery.shortName,
      group: args.lottery.group,
      accent: args.lottery.accent,
      sortOrder: args.lottery.sortOrder,
    },
    schedules: [...args.schedules],
    draws: draws.slice(0, HISTORY_SHOWN),
    stats: buildStats(finals),
  }
}

export function buildVersionFile(v: number, nowMs: number): PublicVersionFile {
  return { v, serverTime: builtAtOf(nowMs) }
}

// ---------------------------------------------------------------------------------------------
// The whitelist check
// ---------------------------------------------------------------------------------------------

/**
 * Every key that may appear anywhere in a public file. A file with any other key (a row id, `source`,
 * `memberId`, `active`, `publicEnabled`, a reminder time ...) is never uploaded.
 */
export const PUBLIC_KEYS: ReadonlySet<string> = new Set([
  // version.json and the common header
  'v', 'serverTime', 'builtAt',
  // today.json
  'today', 'yesterday', 'groups', 'key', 'label', 'lotteries',
  // lottery info
  'id', 'name', 'shortName', 'group', 'accent', 'sortOrder',
  // schedule
  'schedules', 'drawTime', 'resultTime', 'days', 'expectedFields', 'closedDate',
  // results and draws
  'results', 'date', 'time', 'top3', 'top2', 'bottom2', 'state', 'updatedAt', 'lotteryId',
  // lottery file
  'lottery', 'draws', 'stats',
  // statistics
  'from', 'to', 'of', 'digitCounts', 'topNumbers', 'digitGaps', 'numberGaps',
  'n', 'count', 'digit', 'gap', 'last', 'even', 'odd', 'low', 'high', 'doubles',
])

/** Throws when `value` (a finished file) holds an object key that is not in {@link PUBLIC_KEYS}. */
export function assertWhitelisted(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertWhitelisted(item, `${path}[${i}]`))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (!PUBLIC_KEYS.has(key)) throw new Error(`public snapshot: key "${key}" at ${path} is not whitelisted`)
    assertWhitelisted(item, `${path}.${key}`)
  }
}
