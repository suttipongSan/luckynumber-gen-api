// GET /draws?date=&scope= — the numbers the member last drew (saved by POST /render/numbers when
// the request names a `scope`), so the single and multiple pages can show them again after a
// reload. Member auth; a member only ever reads their own rows.
import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { getDb } from '../db/client'
import { requireMember } from '../middleware/memberAuth'
import { loadDraws } from '../lib/draws'
import { parseWith } from '../lib/http'
import { drawsQuerySchema } from '../validation'

export const drawRoutes = new Hono<AppEnv>()

drawRoutes.get('/draws', requireMember(), async (c) => {
  // `scope` may repeat (?scope=single&scope=<set id>); without it every scope of the date is returned.
  const query = parseWith(drawsQuerySchema, {
    date: c.req.query('date'),
    scope: c.req.queries('scope'),
  })
  const draws = await loadDraws(getDb(c.env), c.get('member').id, query.date, query.scope ?? [])
  return c.json({ date: query.date, draws })
})
