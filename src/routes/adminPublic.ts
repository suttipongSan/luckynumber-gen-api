// Back office endpoints of the public results site. Mounted by ./admin at /admin/public AFTER requireAdmin,
// so every route here needs the admin session:
//   GET    /admin/public/lotteries                        the catalog lotteries with publicEnabled and their schedule rows
//   PATCH  /admin/public/lotteries/:id                    { publicEnabled }   the "แสดงบนเว็บผลหวย" switch
//   PUT    /admin/public/lotteries/:id/schedules          create or replace one schedule row (draw time)
//   DELETE /admin/public/lotteries/:id/schedules?drawTime=  delete one schedule row
//   PUT    /admin/public/lotteries/:id/schedules/closed   { drawTime, closedDate | null }  "no draw on this date"
//   GET    /admin/public/status                           the state of the snapshots
//   PUT    /admin/public/enabled                          { enabled }  the public_results_enabled switch
//   POST   /admin/public/publish                          { rebuild?, allDays? }  run one publishing pass
// Official results are written by ./results (PUT /results, the import). A change that can alter a public
// file bumps the version and marks the files to rebuild (src/lib/publicChange.ts) in the same batch as
// the change, and starts a build in the background (src/lib/publicPublish.ts); a change that cannot (a
// lottery that is not public, a value that stays the same) does neither.
import { Hono } from 'hono'
import { and, asc, eq, isNull } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { AdminPublicLottery, AdminSchedule, AppEnv, Group, ResultField } from '../types'
import { MAX_SCHEDULES_PER_LOTTERY } from '../types'
import { getDb, type DB } from '../db/client'
import { lotteries, lotterySchedules } from '../db/schema'
import { errors, parseJson, parseWith } from '../lib/http'
import {
  bumpVersion,
  loadPublicStatus,
  markEverything,
  recordChangeStatements,
  setPublicEnabled,
} from '../lib/publicChange'
import { CRON_MAX_MARKS, runPublishPass, schedulePublish, type PublishRun } from '../lib/publicPublish'
import {
  DEFAULT_EXPECTED_FIELDS,
  formatDays,
  formatExpectedFields,
  parseDays,
  parseExpectedFields,
} from '../lib/publicSnapshot'
import { nowIso } from '../lib/time'
import {
  patchPublicLotterySchema,
  publicEnabledSchema,
  publishSchema,
  putScheduleSchema,
  scheduleClosedSchema,
  scheduleKeyQuerySchema,
} from '../validation'

type BatchSqlite = BatchItem<'sqlite'>
type LotteryRow = typeof lotteries.$inferSelect
type ScheduleRow = typeof lotterySchedules.$inferSelect

export const adminPublicRoutes = new Hono<AppEnv>()

const toAdminSchedule = (r: ScheduleRow): AdminSchedule => ({
  drawTime: r.drawTime,
  resultTime: r.resultTime,
  days: parseDays(r.days),
  expectedFields: parseExpectedFields(r.expectedFields),
  closedDate: r.closedDate,
})

const toAdminPublicLottery = (r: LotteryRow, schedules: ScheduleRow[]): AdminPublicLottery => ({
  id: r.id,
  name: r.name,
  shortName: r.shortName,
  group: r.groupKey as Group,
  accent: r.accent,
  sortOrder: r.sortOrder,
  active: r.active,
  publicEnabled: r.publicEnabled,
  schedules: schedules.map(toAdminSchedule),
})

/** A lottery of the CATALOG: a member's own lottery (or an unknown id) is 404, whatever is asked. */
async function catalogLottery(db: DB, id: string): Promise<LotteryRow> {
  const [row] = await db
    .select()
    .from(lotteries)
    .where(and(eq(lotteries.id, id), isNull(lotteries.ownerMemberId)))
    .limit(1)
  if (!row) throw errors.notFound('ไม่พบหวย')
  return row
}

const schedulesOf = (db: DB, lotteryId: string) =>
  db
    .select()
    .from(lotterySchedules)
    .where(eq(lotterySchedules.lotteryId, lotteryId))
    .orderBy(asc(lotterySchedules.drawTime))

const isPublic = (r: LotteryRow) => r.active && r.publicEnabled

const sameFields = (a: readonly ResultField[], b: readonly ResultField[]) =>
  formatExpectedFields(a) === formatExpectedFields(b)

// ---- lotteries

adminPublicRoutes.get('/lotteries', async (c) => {
  const db = getDb(c.env)
  const [rows, schedules] = (await db.batch([
    db
      .select()
      .from(lotteries)
      .where(isNull(lotteries.ownerMemberId))
      .orderBy(asc(lotteries.sortOrder), asc(lotteries.name)),
    db.select().from(lotterySchedules).orderBy(asc(lotterySchedules.lotteryId), asc(lotterySchedules.drawTime)),
  ])) as [LotteryRow[], ScheduleRow[]]
  const byLottery = new Map<string, ScheduleRow[]>()
  for (const s of schedules) byLottery.set(s.lotteryId, [...(byLottery.get(s.lotteryId) ?? []), s])
  return c.json(rows.map((r) => toAdminPublicLottery(r, byLottery.get(r.id) ?? [])))
})

// The switch "แสดงบนเว็บผลหวย". Turning it on or off changes what the public files hold only for a lottery that
// is also active, and then it must bring every one of its results into (or out of) the day files too.
adminPublicRoutes.patch('/lotteries/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const body = await parseJson(c, patchPublicLotterySchema)
  const row = await catalogLottery(db, id)
  if (row.publicEnabled !== body.publicEnabled) {
    const visibilityChanged = isPublic(row) !== (row.active && body.publicEnabled)
    await db.batch([
      db
        .update(lotteries)
        .set({ publicEnabled: body.publicEnabled })
        .where(and(eq(lotteries.id, id), isNull(lotteries.ownerMemberId))),
      ...(visibilityChanged
        ? recordChangeStatements(db, nowIso(), { lotteryIds: [id], allDatesOfLottery: id })
        : []),
    ] as [BatchSqlite, ...BatchSqlite[]])
    if (visibilityChanged) await schedulePublish(c)
  }
  const fresh = await catalogLottery(db, id)
  return c.json(toAdminPublicLottery(fresh, await schedulesOf(db, id)))
})

// ---- schedules

// One draw time of a lottery, created or replaced as a whole (201 new, 200 replaced or unchanged). Only a
// change of what the row means for the public files counts; the "no draw today" switch is kept.
adminPublicRoutes.put('/lotteries/:id/schedules', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const body = await parseJson(c, putScheduleSchema)
  const lottery = await catalogLottery(db, id)
  const rows = await schedulesOf(db, id)
  const existing = rows.find((r) => r.drawTime === body.drawTime)
  if (!existing && rows.length >= MAX_SCHEDULES_PER_LOTTERY) {
    throw errors.conflict('QUOTA', `หวยหนึ่งตั้งรอบได้ไม่เกิน ${MAX_SCHEDULES_PER_LOTTERY} รอบ`)
  }
  const next = {
    lotteryId: id,
    drawTime: body.drawTime,
    resultTime: body.resultTime,
    days: formatDays(body.days),
    expectedFields: formatExpectedFields(body.expectedFields),
  }
  const unchanged =
    existing !== undefined &&
    existing.resultTime === next.resultTime &&
    existing.days === next.days &&
    existing.expectedFields === next.expectedFields
  if (unchanged) return c.json(toAdminSchedule(existing), 200)
  // A change of the expected fields (or a first row that differs from the default three) changes the
  // state of every draw of the lottery, so its day files are rebuilt too.
  const fieldsChanged = !sameFields(
    existing ? parseExpectedFields(existing.expectedFields) : DEFAULT_EXPECTED_FIELDS,
    body.expectedFields,
  )
  await db.batch([
    db
      .insert(lotterySchedules)
      .values({ ...next, closedDate: existing?.closedDate ?? null })
      .onConflictDoUpdate({
        target: [lotterySchedules.lotteryId, lotterySchedules.drawTime],
        set: { resultTime: next.resultTime, days: next.days, expectedFields: next.expectedFields },
      }),
    ...(isPublic(lottery)
      ? recordChangeStatements(db, nowIso(), {
          lotteryIds: [id],
          allDatesOfLottery: fieldsChanged ? id : undefined,
        })
      : []),
  ] as [BatchSqlite, ...BatchSqlite[]])
  if (isPublic(lottery)) await schedulePublish(c)
  const [saved] = await db
    .select()
    .from(lotterySchedules)
    .where(and(eq(lotterySchedules.lotteryId, id), eq(lotterySchedules.drawTime, body.drawTime)))
  return c.json(toAdminSchedule(saved), existing ? 200 : 201)
})

adminPublicRoutes.delete('/lotteries/:id/schedules', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const { drawTime } = parseWith(scheduleKeyQuerySchema, { drawTime: c.req.query('drawTime') })
  const lottery = await catalogLottery(db, id)
  const existing = (await schedulesOf(db, id)).find((r) => r.drawTime === drawTime)
  if (!existing) throw errors.notFound('ไม่พบรอบของหวยนี้')
  const fieldsChanged = !sameFields(parseExpectedFields(existing.expectedFields), DEFAULT_EXPECTED_FIELDS)
  await db.batch([
    db
      .delete(lotterySchedules)
      .where(and(eq(lotterySchedules.lotteryId, id), eq(lotterySchedules.drawTime, drawTime))),
    ...(isPublic(lottery)
      ? recordChangeStatements(db, nowIso(), {
          lotteryIds: [id],
          allDatesOfLottery: fieldsChanged ? id : undefined,
        })
      : []),
  ] as [BatchSqlite, ...BatchSqlite[]])
  if (isPublic(lottery)) await schedulePublish(c)
  return c.body(null, 204)
})

// "วันนี้งดออกผล": the closed date of one schedule row (it must exist: create the round first).
adminPublicRoutes.put('/lotteries/:id/schedules/closed', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const body = await parseJson(c, scheduleClosedSchema)
  const lottery = await catalogLottery(db, id)
  const existing = (await schedulesOf(db, id)).find((r) => r.drawTime === body.drawTime)
  if (!existing) throw errors.notFound('ไม่พบรอบของหวยนี้ ให้ตั้งรอบก่อน')
  if (existing.closedDate !== body.closedDate) {
    await db.batch([
      db
        .update(lotterySchedules)
        .set({ closedDate: body.closedDate })
        .where(and(eq(lotterySchedules.lotteryId, id), eq(lotterySchedules.drawTime, body.drawTime))),
      ...(isPublic(lottery) ? recordChangeStatements(db, nowIso(), { lotteryIds: [id] }) : []),
    ] as [BatchSqlite, ...BatchSqlite[]])
    if (isPublic(lottery)) await schedulePublish(c)
  }
  return c.json(toAdminSchedule({ ...existing, closedDate: body.closedDate }))
})

// ---- the snapshots

adminPublicRoutes.get('/status', async (c) => {
  return c.json(await loadPublicStatus(getDb(c.env), c.env.PUBLIC_RESULTS !== undefined))
})

// The kill switch: off = nothing is published (changes still count and mark files, so switching it on
// again catches up). On starts a build.
adminPublicRoutes.put('/enabled', async (c) => {
  const db = getDb(c.env)
  const body = await parseJson(c, publicEnabledSchema)
  await setPublicEnabled(db, body.enabled)
  if (body.enabled) await schedulePublish(c)
  return c.json(await loadPublicStatus(db, c.env.PUBLIC_RESULTS !== undefined))
})

// Runs ONE bounded publishing pass now (the cron does the same every minute) and answers the state. With
// `rebuild` it first marks every public lottery, the last two weeks of dates (every date with `allDays`)
// and any file of a lottery that is not public (to be removed), and counts a new version: the way to
// publish for the first time, after a deploy that changed the files, or after editing the data by hand.
// While `pending` in the answer is above 0 call it again (or wait for the cron); `passes` runs several
// passes in one call, which only a local `wrangler dev` (or a paid plan) can afford. The body may be empty.
adminPublicRoutes.post('/publish', async (c) => {
  const db = getDb(c.env)
  const text = (await c.req.text()).trim()
  let raw: unknown = {}
  if (text !== '') {
    try {
      raw = JSON.parse(text)
    } catch {
      throw errors.validation('ต้องส่งข้อมูลเป็น JSON')
    }
  }
  const body = parseWith(publishSchema, raw)
  if (body.rebuild) {
    const version = await bumpVersion(db)
    await markEverything(db, { version, nowMs: Date.now(), allDays: body.allDays ?? false, bucket: c.env.PUBLIC_RESULTS })
  }
  const bound = c.env.PUBLIC_RESULTS !== undefined
  let run: PublishRun = await runPublishPass(c.env, { maxMarks: CRON_MAX_MARKS })
  let passes = 1
  while (passes < (body.passes ?? 1) && run.status === 'published' && (await loadPublicStatus(db, bound)).pending > 0) {
    run = await runPublishPass(c.env, { maxMarks: CRON_MAX_MARKS })
    passes++
  }
  return c.json({ ...(await loadPublicStatus(db, bound)), run, passes })
})
