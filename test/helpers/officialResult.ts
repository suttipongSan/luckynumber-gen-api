// An OFFICIAL result as the results API (numbergen-results-api, PUT /results) stores it, for the tests of what members
// read. numbergen-api no longer has a route that writes official results (the back office and the robot call the results
// API, which is tested in its own repo), so these tests put the row in the database directly, with the same replace
// semantics as that route: a result of the same draw is replaced in place (its id and created_at stay), a new draw is a
// new row. The answer has the shape the route answers (its AdminLotteryResult).
import { and, eq, isNull } from 'drizzle-orm'
import type { DB } from '../../src/db/client'
import { lotteries } from '../../src/db/schema'
import { newId } from '../../src/lib/ids'
import { upsertResult } from '../../src/lib/results'
import { nowIso } from '../../src/lib/time'

/** What the results API answers for an official result (its AdminLotteryResult). */
export interface OfficialResult {
  id: string
  lotteryId: string
  date: string
  time: string
  top3: string | null
  top2: string | null
  bottom2: string | null
  source: string | null
  createdAt: string
  updatedAt: string
}

/** The body of the results API's PUT /results (the lottery by id or by exact name). */
export interface OfficialResultInput {
  lotteryId?: string
  lotteryName?: string
  date: string
  time?: string | null
  top3?: string | null
  top2?: string | null
  bottom2?: string | null
  source?: string | null
}

/** Stores the official result and answers the stored row; `created` is false when it replaced an earlier one. */
export async function storeOfficialResult(db: DB, body: OfficialResultInput): Promise<{ answer: OfficialResult; created: boolean }> {
  let lotteryId = body.lotteryId
  if (lotteryId === undefined) {
    const [l] = await db
      .select({ id: lotteries.id })
      .from(lotteries)
      .where(and(eq(lotteries.name, body.lotteryName ?? ''), isNull(lotteries.ownerMemberId)))
      .limit(1)
    lotteryId = l.id
  }
  const now = nowIso()
  const { saved, created } = await upsertResult(db, {
    id: newId(),
    lotteryId,
    drawDate: body.date,
    drawTime: body.time ?? '',
    memberId: '',
    top3: body.top3 ?? null,
    top2: body.top2 ?? null,
    bottom2: body.bottom2 ?? null,
    source: body.source || null,
    createdAt: now,
    updatedAt: now,
  })
  return {
    created,
    answer: {
      id: saved.id,
      lotteryId: saved.lotteryId,
      date: saved.drawDate,
      time: saved.drawTime,
      top3: saved.top3,
      top2: saved.top2,
      bottom2: saved.bottom2,
      source: saved.source,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    },
  }
}

/** Like the route: a Response with the stored row, 201 for a new draw, 200 when an earlier result was replaced. */
export async function putOfficialResult(db: DB, body: OfficialResultInput): Promise<Response> {
  const { answer, created } = await storeOfficialResult(db, body)
  return Response.json(answer, { status: created ? 201 : 200 })
}
