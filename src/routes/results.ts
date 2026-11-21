// Lottery results: the numbers of each draw (3 ตัวบน, 2 ตัวบน, 2 ตัวล่าง), of two kinds.
//   OFFICIAL  typed by the back office or the results robot, for a catalog lottery, seen by every member:
//     PUT    /results          results robot (X-API-Key) or admin: upsert one draw's official numbers
//     DELETE /results/:id      admin: remove one official result
//     GET    /admin/results?date=   admin: every official result of one date (adminResultRoutes, mounted by ./admin)
//     POST   /admin/results/import  admin: bulk import of old official results (preview with dryRun, then save)
//   A change of an official result of a public lottery also counts for the public results site: it bumps the
//   version and marks the snapshot files to rebuild (src/lib/publicChange.ts) and starts a build in the
//   background (src/lib/publicPublish.ts).
//   PERSONAL  typed by a member, for any lottery they can see, seen by that member only:
//     PUT    /results/mine     member: create / replace their own result of one draw
//     DELETE /results/mine?lotteryId=&date=&time=   member: remove their own result of one draw
//   GET /results?date=         member: what applies to them on one Thai date (their own result wins over the official one)
// No row = no result yet. The web app highlights the numbers a member's card got right by comparing
// the card with these. Rows of both kinds live in lottery_results (member_id '' = official).
import { Hono } from 'hono'
import { and, asc, eq } from 'drizzle-orm'
import type { AppEnv } from '../types'
import { MAX_IMPORT_BODY_BYTES, MAX_MY_RESULT_BODY_BYTES } from '../types'
import { getDb } from '../db/client'
import { lotteryResults } from '../db/schema'
import { requireAdmin } from '../middleware/adminAuth'
import { requireMember } from '../middleware/memberAuth'
import { requireResultsWriter } from '../middleware/resultsAuth'
import { errors, parseJson, parseJsonLimited, parseWith } from '../lib/http'
import { newId } from '../lib/ids'
import { deleteOfficialResult, writeOfficialResult } from '../lib/publicChange'
import { schedulePublish } from '../lib/publicPublish'
import {
  assertNotTooFarAhead,
  loadMemberResults,
  OFFICIAL_MEMBER_ID,
  requireVisibleLottery,
  resolveResultLottery,
  toAdminLotteryResult,
  upsertResult,
} from '../lib/results'
import { parseImportText, rowsFromObjects, runImport } from '../lib/resultsImport'
import { nowIso } from '../lib/time'
import {
  importResultsSchema,
  myResultQuerySchema,
  putMyResultSchema,
  putResultSchema,
  resultsQuerySchema,
} from '../validation'

export const resultRoutes = new Hono<AppEnv>()

/** Every result of a date, ordered by lottery, then draw time ("" first, then "HH:MM" ascending). */
const byLotteryThenTime = [asc(lotteryResults.lotteryId), asc(lotteryResults.drawTime)] as const

// Replace semantics: the stored draw becomes exactly what was sent. A number that is left out (or
// null) is cleared, so a corrected result is one PUT with all the numbers. 201 when the draw had no
// row yet, 200 when an earlier one was replaced; both answer the stored AdminLotteryResult. The row
// is always an OFFICIAL one (member_id ''), whoever writes it, and only catalog lotteries count.
// A draw dated more than a day ahead (Bangkok) is refused (400). A result that already holds exactly
// these numbers is answered with 200 and the stored row and changes NOTHING (not even its updatedAt,
// and the public results site is not told); a real change also starts a rebuild of the public files.
resultRoutes.put('/results', requireResultsWriter, async (c) => {
  const db = getDb(c.env)
  const body = await parseJson(c, putResultSchema)
  assertNotTooFarAhead(body.date)
  const lotteryId = await resolveResultLottery(db, body)
  const now = nowIso()
  const row = {
    id: newId(),
    lotteryId,
    drawDate: body.date,
    drawTime: body.time ?? '',
    memberId: OFFICIAL_MEMBER_ID,
    top3: body.top3 ?? null,
    top2: body.top2 ?? null,
    bottom2: body.bottom2 ?? null,
    source: body.source || null,
    createdAt: now,
    updatedAt: now,
  }
  const { saved, created, changed } = await writeOfficialResult(db, row).catch(async (e: unknown) => {
    // The lottery was deleted between the lookup and the write (its FOREIGN KEY fails): that is
    // "unknown lottery", not a server error. Anything else is a real error.
    await resolveResultLottery(db, { lotteryId })
    throw e
  })
  if (changed) await schedulePublish(c)
  return c.json(toAdminLotteryResult(saved), created ? 201 : 200)
})

// A member's own result of one draw. Replace semantics like PUT /results (the three numbers become
// exactly what was sent), 201 when the member had no result of that draw yet, 200 when one was
// replaced. The lottery must be one the member can see (404 LOTTERY_NOT_FOUND otherwise), the row is
// always the caller's own (member_id = the session member), so an official row and another member's
// row can never be written or deleted here. Both answer what the member now reads for that lottery
// and date (the same rows GET /results lists for it), so the page can update at once. Registered
// before DELETE /results/:id (admin) so that `mine` is never read as an id.
resultRoutes.put('/results/mine', requireMember(), async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const body = await parseJsonLimited(c, putMyResultSchema, MAX_MY_RESULT_BODY_BYTES)
  await requireVisibleLottery(db, memberId, body.lotteryId)
  const now = nowIso()
  const row = {
    id: newId(),
    lotteryId: body.lotteryId,
    drawDate: body.date,
    drawTime: body.time ?? '',
    memberId,
    top3: body.top3 ?? null,
    top2: body.top2 ?? null,
    bottom2: body.bottom2 ?? null,
    source: null,
    createdAt: now,
    updatedAt: now,
  }
  const { created } = await upsertResult(db, row).catch(async (e: unknown) => {
    // The lottery was deleted (or became invisible) after the check: unknown lottery, not a server error.
    await requireVisibleLottery(db, memberId, body.lotteryId)
    throw e
  })
  const results = await loadMemberResults(db, memberId, body.date, body.lotteryId)
  return c.json({ date: body.date, lotteryId: body.lotteryId, results }, created ? 201 : 200)
})

// Removes the caller's own result of one draw; the official result of the lottery and date (if any)
// applies again. Idempotent: 200 also when the member had no such result (the state they asked for
// already holds), the answer is the same as PUT's. Parameters are in the query string because a
// DELETE has no body here: `time` absent = '' (as in PUT).
resultRoutes.delete('/results/mine', requireMember(), async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const q = parseWith(myResultQuerySchema, {
    lotteryId: c.req.query('lotteryId'),
    date: c.req.query('date'),
    time: c.req.query('time'),
  })
  await requireVisibleLottery(db, memberId, q.lotteryId)
  await db
    .delete(lotteryResults)
    .where(
      and(
        eq(lotteryResults.lotteryId, q.lotteryId),
        eq(lotteryResults.drawDate, q.date),
        eq(lotteryResults.drawTime, q.time ?? ''),
        eq(lotteryResults.memberId, memberId),
      ),
    )
  const results = await loadMemberResults(db, memberId, q.date, q.lotteryId)
  return c.json({ date: q.date, lotteryId: q.lotteryId, results })
})

resultRoutes.get('/results', requireMember(), async (c) => {
  const { date } = parseWith(resultsQuerySchema, { date: c.req.query('date') })
  const results = await loadMemberResults(getDb(c.env), c.get('member').id, date)
  return c.json({ date, results })
})

// The back office removes official results only: the id of a personal result (which nothing ever
// shows) is "not found", so a member's private data stays out of its reach.
resultRoutes.delete('/results/:id', requireAdmin, async (c) => {
  if (!(await deleteOfficialResult(getDb(c.env), c.req.param('id')))) throw errors.notFound('ไม่พบผลรางวัล')
  await schedulePublish(c)
  return c.body(null, 204)
})

/** Mounted by ./admin at /admin/results AFTER requireAdmin, so every route here needs the admin session. */
export const adminResultRoutes = new Hono<AppEnv>()

// Official results only: the members' personal results are their private data and are not listed.
adminResultRoutes.get('/', async (c) => {
  const { date } = parseWith(resultsQuerySchema, { date: c.req.query('date') })
  const rows = await getDb(c.env)
    .select()
    .from(lotteryResults)
    .where(and(eq(lotteryResults.drawDate, date), eq(lotteryResults.memberId, OFFICIAL_MEMBER_ID)))
    .orderBy(...byLotteryThenTime)
  return c.json({ date, results: rows.map(toAdminLotteryResult) })
})

// Bulk import of old official results: `{ csv }` (pasted text: lottery id or exact name, date, optional
// time, top3, top2, bottom2) or `{ rows: [{ lottery, date, time?, top3?, top2?, bottom2? }] }`, at most
// 2000 rows. `dryRun: true` only validates and reports (the preview); otherwise every valid row that is new
// or different is saved and the answer is the same report. Row errors are in the report, never a 400.
adminResultRoutes.post('/import', async (c) => {
  const body = await parseJsonLimited(c, importResultsSchema, MAX_IMPORT_BODY_BYTES)
  const raw = body.csv !== undefined ? parseImportText(body.csv) : rowsFromObjects(body.rows ?? [])
  const report = await runImport(getDb(c.env), raw, { dryRun: body.dryRun ?? false })
  if (report.saved > 0) await schedulePublish(c)
  return c.json(report)
})
