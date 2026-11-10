// Member announcements: unread, active, published (oldest first); mark read.
import { Hono } from 'hono'
import { and, asc, eq, lte, notInArray } from 'drizzle-orm'
import type { AppEnv, News } from '../types'
import { getDb, type DB } from '../db/client'
import { news, newsReads } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { errors } from '../lib/http'
import { nowIso } from '../lib/time'

export const newsRoutes = new Hono<AppEnv>()

/**
 * The drizzle select statement GET /news runs. Exported so /bootstrap can include it in the
 * same db.batch as its other reads without duplicating the WHERE clause.
 */
export function unreadNewsQuery(db: DB, memberId: string, nowIsoValue: string) {
  const readIds = db
    .select({ id: newsReads.newsId })
    .from(newsReads)
    .where(eq(newsReads.memberId, memberId))
  return db
    .select()
    .from(news)
    .where(and(eq(news.active, true), lte(news.publishedAt, nowIsoValue), notInArray(news.id, readIds)))
    .orderBy(asc(news.publishedAt))
}

type NewsRow = typeof news.$inferSelect

export function toNewsList(rows: NewsRow[]): News[] {
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    detailHtml: r.detailHtml,
    publishedAt: r.publishedAt,
  }))
}

newsRoutes.get('/news', requireMember({ allowInactive: true }), async (c) => {
  const db = getDb(c.env)
  const rows = await unreadNewsQuery(db, c.get('member').id, nowIso())
  return c.json(toNewsList(rows))
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
