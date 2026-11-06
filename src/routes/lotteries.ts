// GET /lotteries — active catalog, sorted.
import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import type { AppEnv } from '../types'
import { getDb } from '../db/client'
import { lotteries } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { toLottery } from '../lib/views'

export const lotteryRoutes = new Hono<AppEnv>()

lotteryRoutes.get('/lotteries', requireMember(), async (c) => {
  const rows = await getDb(c.env)
    .select()
    .from(lotteries)
    .where(eq(lotteries.active, true))
    .orderBy(asc(lotteries.sortOrder), asc(lotteries.name))
  return c.json(rows.map(toLottery))
})
