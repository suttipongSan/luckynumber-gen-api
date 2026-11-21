// Lottery results as members meet them: the numbers of each draw (3 ตัวบน, 2 ตัวบน, 2 ตัวล่าง), of two kinds.
//   OFFICIAL  typed by the back office or the results robot, for a catalog lottery, seen by every member. They are
//     written by the RESULTS API (numbergen-results-api: PUT /results, DELETE /results/:id, GET /admin/results, the bulk
//     import); this API only reads them, in GET /results below.
//   PERSONAL  typed by a member, for any lottery they can see, seen by that member only:
//     PUT    /results/mine     member: create / replace their own result of one draw
//     DELETE /results/mine?lotteryId=&date=&time=   member: remove their own result of one draw
//   GET /results?date=         member: what applies to them on one Thai date (their own result wins over the official one)
// No row = no result yet. The web app highlights the numbers a member's card got right by comparing
// the card with these. Rows of both kinds live in lottery_results (member_id '' = official). Nothing here is a
// change of the PUBLIC results (the free site shows official results only), so none of it is recorded for the
// results API's publisher.
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { AppEnv } from '../types'
import { MAX_MY_RESULT_BODY_BYTES } from '../types'
import { getDb } from '../db/client'
import { lotteryResults } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { parseJsonLimited, parseWith } from '../lib/http'
import { newId } from '../lib/ids'
import { loadMemberResults, requireVisibleLottery, upsertResult } from '../lib/results'
import { nowIso } from '../lib/time'
import { myResultQuerySchema, putMyResultSchema, resultsQuerySchema } from '../validation'

export const resultRoutes = new Hono<AppEnv>()

// A member's own result of one draw. Replace semantics (the three numbers become exactly what was sent), 201 when the
// member had no result of that draw yet, 200 when theirs was replaced. The lottery must be one the member can see (404
// LOTTERY_NOT_FOUND otherwise), the row is always the caller's own (member_id = the session member), so an official row
// and another member's row can never be written or deleted here. Both answer what the member now reads for that lottery
// and date (the same rows GET /results lists for it), so the page can update at once.
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
