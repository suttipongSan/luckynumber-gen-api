// Bulk import of OFFICIAL results (POST /admin/results/import): old results pasted as CSV text (or sent
// as rows), validated row by row, previewed with `dryRun` and then saved. The rules of one row are the
// ones of PUT /results (a real day, HH:MM or no time, exactly 3 / 2 / 2 ASCII digits, at least one
// number, a catalog lottery, not more than a day ahead) plus: not before 2000-01-01, and a draw
// may appear only once per call. Importing old dates is normal.
//
// Columns (position matters): lottery (an id or the exact name), date, time (optional), top3, top2,
// bottom2 (each optional, at least one). Comma, semicolon or tab separated; a header line whose 2nd cell
// is "date" / "วันที่" is skipped; "quoted" cells may hold the delimiter.
//
// What gets written: every 'new' and 'changed' row, replace semantics as in PUT /results (the draw becomes
// exactly the three numbers of the row), in one atomic D1 batch of a few statements however many rows
// (the rows travel as JSON, so the statement count and the 100-parameter limit do not depend on the
// row count), together with one version bump and the marks of the affected dates and lotteries (a
// 'same' row writes nothing and bumps nothing). The files are rebuilt afterwards, a few per pass.
import { and, between, eq, inArray, isNull, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { DB } from '../db/client'
import { lotteries, lotteryResults } from '../db/schema'
import type { ImportReport, ImportRowReport } from '../types'
import { MAX_IMPORT_ROWS } from '../types'
import { NOTIFY_TIME_RE } from '../validation'
import { chunk } from './chunk'
import { errors } from './http'
import { newId } from './ids'
import { recordChangeStatements } from './publicChange'
import { OFFICIAL_MEMBER_ID, latestResultDate } from './results'
import { isCalendarDay, nowIso } from './time'

type BatchSqlite = BatchItem<'sqlite'>

/** The oldest date an import accepts. */
export const EARLIEST_IMPORT_DATE = '2000-01-01'
/** `source` of an imported row (back office only). */
export const IMPORT_SOURCE = 'นำเข้า'
/** Rows per statement: each travels as one JSON array of ~80 bytes. */
const ROWS_PER_STATEMENT = 500
/** Lotteries per lookup of the existing rows: 80 ids + 3 other parameters stay under D1's 100. */
const LOTTERIES_PER_LOOKUP = 80

// ---------------------------------------------------------------------------------------------
// Reading the input
// ---------------------------------------------------------------------------------------------

/** One row as it came in, before validation. `error` is a problem found while splitting the line. */
export interface RawImportRow {
  line: number
  lottery: unknown
  date: unknown
  time: unknown
  top3: unknown
  top2: unknown
  bottom2: unknown
  error?: string
}

/** Splits one line on `delim`; "quoted" cells may hold the delimiter and "" is a quote. Null = a quote that never closes. */
export function splitLine(line: string, delim: string): string[] | null {
  const cells: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch !== '"') cell += ch
      else if (line[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = false
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
    } else if (ch === delim) {
      cells.push(cell.trim())
      cell = ''
    } else cell += ch
  }
  if (quoted) return null
  cells.push(cell.trim())
  return cells
}

const count = (s: string, ch: string) => s.split(ch).length - 1

/**
 * The rows of pasted text: tab, semicolon or comma separated (decided per line: a tab wins, then
 * whichever of ; and , there is more of), blank lines skipped, a header line skipped, `line` = the
 * 1-based line of the text. A line that cannot be split (an unclosed quote, more than 6 cells) is a row
 * with an `error`.
 */
export function parseImportText(text: string): RawImportRow[] {
  const rows: RawImportRow[] = []
  const lines = text.replace(/^﻿/, '').split(/\r\n|\n|\r/)
  let first = true
  lines.forEach((raw, i) => {
    if (raw.trim() === '') return
    const delim = raw.includes('\t') ? '\t' : count(raw, ';') > count(raw, ',') ? ';' : ','
    const cells = splitLine(raw, delim)
    const wasFirst = first
    first = false
    const empty = { lottery: '', date: '', time: '', top3: '', top2: '', bottom2: '' }
    if (cells === null) {
      rows.push({ line: i + 1, ...empty, error: 'เครื่องหมายคำพูด " ไม่ครบคู่' })
      return
    }
    if (wasFirst && ['date', 'วันที่'].includes((cells[1] ?? '').toLowerCase())) return // the header line
    if (cells.length > 6) {
      rows.push({ line: i + 1, ...empty, lottery: cells[0], error: 'มีมากกว่า 6 ช่อง (หวย, วันที่, เวลา, 3 ตัวบน, 2 ตัวบน, 2 ตัวล่าง)' })
      return
    }
    const [lottery = '', date = '', time = '', top3 = '', top2 = '', bottom2 = ''] = cells
    rows.push({ line: i + 1, lottery, date, time, top3, top2, bottom2 })
  })
  return rows
}

const ROW_KEYS = ['lottery', 'date', 'time', 'top3', 'top2', 'bottom2']

/** The rows of a JSON `rows` array: each item an object with the same fields as the columns; `line` = position + 1. */
export function rowsFromObjects(items: readonly unknown[]): RawImportRow[] {
  return items.map((item, i) => {
    const empty = { lottery: '', date: '', time: '', top3: '', top2: '', bottom2: '' }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { line: i + 1, ...empty, error: 'แถวต้องเป็นออบเจ็กต์ {lottery, date, time, top3, top2, bottom2}' }
    }
    const o = item as Record<string, unknown>
    const unknownKey = Object.keys(o).find((k) => !ROW_KEYS.includes(k))
    return {
      line: i + 1,
      lottery: o.lottery ?? '',
      date: o.date ?? '',
      time: o.time ?? '',
      top3: o.top3 ?? '',
      top2: o.top2 ?? '',
      bottom2: o.bottom2 ?? '',
      ...(unknownKey !== undefined ? { error: `ไม่รู้จักช่อง "${unknownKey}"` } : {}),
    }
  })
}

// ---------------------------------------------------------------------------------------------
// Validating a row
// ---------------------------------------------------------------------------------------------

export interface CatalogLottery {
  id: string
  name: string
  /** active and shown on the results site: its changes reach the public files */
  public: boolean
}

/** A row that passed every check. */
export interface ValidRow {
  line: number
  lotteryId: string
  lotteryName: string
  date: string
  time: string
  top3: string | null
  top2: string | null
  bottom2: string | null
}

type Checked = { ok: true; row: ValidRow } | { ok: false; error: string; partial: Partial<ValidRow> }

const text = (v: unknown): string | null => (typeof v === 'string' ? v.trim() : v == null ? '' : null)

/**
 * Checks one raw row against the catalog (an id first, then an exact name; a member's own lottery is
 * never in `catalog`, so it is "not found") and `latest` (the newest date accepted).
 */
export function validateRow(
  raw: RawImportRow,
  catalog: { byId: ReadonlyMap<string, CatalogLottery>; byName: ReadonlyMap<string, CatalogLottery[]> },
  latest: string,
): Checked {
  const partial: Partial<ValidRow> = { line: raw.line }
  const fail = (error: string): Checked => ({ ok: false, error, partial })
  if (raw.error) return fail(raw.error)

  const lottery = text(raw.lottery)
  if (lottery === null) return fail('ช่องหวยต้องเป็นข้อความ')
  if (lottery === '') return fail('ไม่ได้ระบุหวย')
  const found = catalog.byId.get(lottery) ?? undefined
  const named = found ? [found] : (catalog.byName.get(lottery) ?? [])
  if (named.length > 1) return fail(`มีหวยชื่อ "${lottery}" มากกว่าหนึ่งรายการ ให้ใช้รหัสหวยแทน`)
  if (named.length === 0) return fail(`ไม่พบหวย "${lottery}"`)
  partial.lotteryId = named[0].id
  partial.lotteryName = named[0].name

  const date = text(raw.date)
  if (date === null || !isCalendarDay(date)) return fail('วันที่ต้องเป็น YYYY-MM-DD ที่มีอยู่จริง เช่น 2026-11-19')
  partial.date = date
  if (date < EARLIEST_IMPORT_DATE) return fail(`วันที่เก่าเกินไป (รับตั้งแต่ ${EARLIEST_IMPORT_DATE})`)
  if (date > latest) return fail(`วันที่ล่วงหน้าได้ไม่เกิน 1 วัน (ไม่เกิน ${latest})`)

  const time = text(raw.time)
  if (time === null || (time !== '' && !NOTIFY_TIME_RE.test(time))) {
    return fail('เวลาต้องเป็น HH:MM (00:00-23:59) หรือเว้นว่าง')
  }
  partial.time = time

  const digits = (value: unknown, n: 2 | 3, label: string): { value: string | null } | string => {
    const t = text(value)
    if (t === null) return `${label} ต้องเป็นข้อความตัวเลข ${n} หลัก`
    if (t === '') return { value: null }
    return new RegExp(`^\\d{${n}}$`).test(t) ? { value: t } : `${label} ต้องเป็นตัวเลข ${n} หลักเท่านั้น (0-9)`
  }
  const top3 = digits(raw.top3, 3, '3 ตัวบน')
  if (typeof top3 === 'string') return fail(top3)
  const top2 = digits(raw.top2, 2, '2 ตัวบน')
  if (typeof top2 === 'string') return fail(top2)
  const bottom2 = digits(raw.bottom2, 2, '2 ตัวล่าง')
  if (typeof bottom2 === 'string') return fail(bottom2)
  Object.assign(partial, { top3: top3.value, top2: top2.value, bottom2: bottom2.value })
  if (top3.value === null && top2.value === null && bottom2.value === null) {
    return fail('ต้องมีเลขอย่างน้อยหนึ่งช่อง (3 ตัวบน, 2 ตัวบน หรือ 2 ตัวล่าง)')
  }
  return {
    ok: true,
    row: {
      line: raw.line,
      lotteryId: named[0].id,
      lotteryName: named[0].name,
      date,
      time,
      top3: top3.value,
      top2: top2.value,
      bottom2: bottom2.value,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Running an import
// ---------------------------------------------------------------------------------------------

interface Existing {
  top3: string | null
  top2: string | null
  bottom2: string | null
}

const keyOf = (r: { lotteryId: string; date: string; time: string }) => `${r.lotteryId}|${r.date}|${r.time}`

/** The existing official rows a set of valid rows may collide with, by (lottery, date, time). */
async function loadExisting(db: DB, rows: readonly ValidRow[]): Promise<Map<string, Existing>> {
  const out = new Map<string, Existing>()
  if (rows.length === 0) return out
  const dates = rows.map((r) => r.date).sort()
  const ids = [...new Set(rows.map((r) => r.lotteryId))]
  for (const part of chunk(ids, LOTTERIES_PER_LOOKUP)) {
    const found = await db
      .select({
        lotteryId: lotteryResults.lotteryId,
        date: lotteryResults.drawDate,
        time: lotteryResults.drawTime,
        top3: lotteryResults.top3,
        top2: lotteryResults.top2,
        bottom2: lotteryResults.bottom2,
      })
      .from(lotteryResults)
      .where(
        and(
          eq(lotteryResults.memberId, OFFICIAL_MEMBER_ID),
          inArray(lotteryResults.lotteryId, part),
          between(lotteryResults.drawDate, dates[0], dates[dates.length - 1]),
        ),
      )
    for (const f of found) out.set(keyOf(f), { top3: f.top3, top2: f.top2, bottom2: f.bottom2 })
  }
  return out
}

const same = (a: Existing, b: Existing) => a.top3 === b.top3 && a.top2 === b.top2 && a.bottom2 === b.bottom2

/**
 * Validates, classifies and (unless `dryRun`) saves an import. `raw` are the rows as read; more than
 * MAX_IMPORT_ROWS of them is a 400 for the whole call. Row errors never fail the call: they are in the
 * report and the row is skipped.
 */
export async function runImport(
  db: DB,
  raw: readonly RawImportRow[],
  opts: { dryRun: boolean; nowMs?: number },
): Promise<ImportReport> {
  if (raw.length > MAX_IMPORT_ROWS) {
    throw errors.validation(`นำเข้าได้ครั้งละไม่เกิน ${MAX_IMPORT_ROWS} แถว (ส่งมา ${raw.length} แถว)`)
  }
  const nowMs = opts.nowMs ?? Date.now()
  const latest = latestResultDate(nowMs)

  // Only catalog lotteries: a member's own lottery is not in the list, so it can never be imported into.
  const catalogRows = await db
    .select({ id: lotteries.id, name: lotteries.name, active: lotteries.active, publicEnabled: lotteries.publicEnabled })
    .from(lotteries)
    .where(isNull(lotteries.ownerMemberId))
  const byId = new Map<string, CatalogLottery>()
  const byName = new Map<string, CatalogLottery[]>()
  for (const l of catalogRows) {
    const entry = { id: l.id, name: l.name, public: l.active && l.publicEnabled }
    byId.set(l.id, entry)
    byName.set(l.name, [...(byName.get(l.name) ?? []), entry])
  }

  // Validate every row; a draw that appears twice is an error from its second appearance on.
  const reports: ImportRowReport[] = []
  const valid: ValidRow[] = []
  const firstLine = new Map<string, number>()
  for (const r of raw) {
    const checked = validateRow(r, { byId, byName }, latest)
    if (checked.ok) {
      const key = keyOf(checked.row)
      const earlier = firstLine.get(key)
      if (earlier !== undefined) {
        reports.push(reportOf(checked.row, 'error', null, `ซ้ำกับบรรทัด ${earlier}`))
        continue
      }
      firstLine.set(key, checked.row.line)
      valid.push(checked.row)
      reports.push(reportOf(checked.row, 'new', null, null)) // status is settled below
    } else {
      const p = checked.partial
      reports.push({
        line: r.line,
        status: 'error',
        lotteryId: p.lotteryId ?? null,
        lotteryName: p.lotteryName ?? null,
        date: p.date ?? null,
        time: p.time ?? '',
        top3: p.top3 ?? null,
        top2: p.top2 ?? null,
        bottom2: p.bottom2 ?? null,
        previous: null,
        error: checked.error,
      })
    }
  }

  const existing = await loadExisting(db, valid)
  const toWrite: ValidRow[] = []
  const byLine = new Map(reports.map((r) => [r.line, r] as const))
  for (const row of valid) {
    const report = byLine.get(row.line)!
    const old = existing.get(keyOf(row))
    if (!old) report.status = 'new'
    else if (same(old, row)) report.status = 'same'
    else {
      report.status = 'changed'
      report.previous = { top3: old.top3, top2: old.top2, bottom2: old.bottom2 }
    }
    if (report.status !== 'same') toWrite.push(row)
  }

  if (!opts.dryRun && toWrite.length > 0) await saveRows(db, toWrite, byId, nowMs)

  const summary = { total: reports.length, new: 0, changed: 0, same: 0, errors: 0 }
  for (const r of reports) {
    if (r.status === 'error') summary.errors++
    else summary[r.status]++
  }
  return { dryRun: opts.dryRun, saved: opts.dryRun ? 0 : toWrite.length, summary, rows: reports }
}

function reportOf(row: ValidRow, status: ImportRowReport['status'], previous: ImportRowReport['previous'], error: string | null): ImportRowReport {
  return {
    line: row.line,
    status,
    lotteryId: row.lotteryId,
    lotteryName: row.lotteryName,
    date: row.date,
    time: row.time,
    top3: row.top3,
    top2: row.top2,
    bottom2: row.bottom2,
    previous,
    error,
  }
}

/**
 * One atomic batch: the rows (500 per statement, as JSON) upserted with replace semantics, one version
 * bump and the marks of the dates and lotteries that reach the public files. Rows of lotteries that are
 * not public are saved without bumping or marking anything.
 */
async function saveRows(
  db: DB,
  rows: readonly ValidRow[],
  catalog: ReadonlyMap<string, CatalogLottery>,
  nowMs: number,
): Promise<void> {
  const at = nowIso(nowMs)
  const stmts: BatchSqlite[] = chunk(rows, ROWS_PER_STATEMENT).map((part) =>
    db
      .insert(lotteryResults)
      .select(
        sql`select json_extract(j.value, '$[0]'), json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]'),
                   json_extract(j.value, '$[3]'), ${OFFICIAL_MEMBER_ID}, json_extract(j.value, '$[4]'),
                   json_extract(j.value, '$[5]'), json_extract(j.value, '$[6]'), ${IMPORT_SOURCE}, ${at}, ${at}
            from json_each(${JSON.stringify(part.map((r) => [newId(), r.lotteryId, r.date, r.time, r.top3, r.top2, r.bottom2]))}) as j
            where true`,
      )
      .onConflictDoUpdate({
        target: [lotteryResults.lotteryId, lotteryResults.drawDate, lotteryResults.drawTime, lotteryResults.memberId],
        set: {
          top3: sql`excluded.top3`,
          top2: sql`excluded.top2`,
          bottom2: sql`excluded.bottom2`,
          source: sql`excluded.source`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`${lotteryResults.top3} is not excluded.top3 or ${lotteryResults.top2} is not excluded.top2 or ${lotteryResults.bottom2} is not excluded.bottom2`,
      }),
  )
  const publicRows = rows.filter((r) => catalog.get(r.lotteryId)?.public)
  if (publicRows.length > 0) {
    stmts.push(
      ...recordChangeStatements(db, at, {
        dates: [...new Set(publicRows.map((r) => r.date))],
        lotteryIds: [...new Set(publicRows.map((r) => r.lotteryId))],
      }),
    )
  }
  await db.batch(stmts as [BatchSqlite, ...BatchSqlite[]])
}
