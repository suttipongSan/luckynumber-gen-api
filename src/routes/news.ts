// Member announcements: unread, active, published (oldest first); mark read.
import { Hono } from 'hono'
import { and, asc, eq, lte, notInArray } from 'drizzle-orm'
import type { AppEnv, News } from '../types'
import { getDb } from '../db/client'
import { news, newsReads } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { errors } from '../lib/http'
import { nowIso } from '../lib/time'

export const newsRoutes = new Hono<AppEnv>()

newsRoutes.get('/news', requireMember({ allowInactive: true }), async (c) => {
  const db = getDb(c.env)
  const member = c.get('member')
  const readIds = db
    .select({ id: newsReads.newsId })
    .from(newsReads)
    .where(eq(newsReads.memberId, member.id))
  const rows = await db
    .select()
    .from(news)
    .where(and(eq(news.active, true), lte(news.publishedAt, nowIso()), notInArray(news.id, readIds)))
    .orderBy(asc(news.publishedAt))
  const out: News[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    detailHtml: r.detailHtml,
    publishedAt: r.publishedAt,
  }))
  return c.json(out)
})

newsRoutes.post('/news/:id/read', requireMember({ allowInactive: true }), async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const item = await db.query.news.findFirst({ where: eq(news.id, id) })
  if (!item) throw errors.notFound()
  await db
    .insert(newsReads)
    .values({ memberId: c.get('member').id, newsId: id })
    .onConflictDoNothing()
  return c.body(null, 204)
})
