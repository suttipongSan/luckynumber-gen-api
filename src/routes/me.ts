// GET /me — works for expired / disabled members (the web app shows the lock screen).
import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { getDb } from '../db/client'
import { requireMember } from '../middleware/memberAuth'
import { rendersTodayFor, toMember } from '../lib/views'

export const meRoutes = new Hono<AppEnv>()

meRoutes.get('/me', requireMember({ allowInactive: true }), async (c) => {
  const m = c.get('member')
  return c.json(toMember(m, await rendersTodayFor(getDb(c.env), m.id)))
})
