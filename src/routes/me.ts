// GET /me — works for expired / disabled members (the web app shows the lock screen).
import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { AppEnv } from '../types'
import { getDb } from '../db/client'
import { renderCounters, siteSettings } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import {
  DEFAULTS,
  parseDefaultRenderLimit,
  RENDER_LIMIT_DEFAULT,
} from '../lib/siteSettings'
import { bangkokDay } from '../lib/time'
import { toMember } from '../lib/views'

type BatchSqlite = BatchItem<'sqlite'>

export const meRoutes = new Hono<AppEnv>()

meRoutes.get('/me', requireMember({ allowInactive: true }), async (c) => {
  const db = getDb(c.env)
  const m = c.get('member')
  // One D1 round trip: today's render counter + the admin-configured default limit.
  const counterQ = db
    .select({ count: renderCounters.count })
    .from(renderCounters)
    .where(and(eq(renderCounters.memberId, m.id), eq(renderCounters.day, bangkokDay())))
  const defaultQ = db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, RENDER_LIMIT_DEFAULT))
  const res = (await db.batch([counterQ, defaultQ] as [BatchSqlite, BatchSqlite])) as unknown[]
  const counterRows = res[0] as { count: number }[]
  const defaultRows = res[1] as { value: string }[]
  const defaultLimit = parseDefaultRenderLimit(defaultRows[0]?.value ?? DEFAULTS[RENDER_LIMIT_DEFAULT])
  return c.json(toMember(m, counterRows[0]?.count ?? 0, defaultLimit))
})
