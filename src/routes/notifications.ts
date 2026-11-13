// Member daily reminders ("เวลาลง"), one line per lottery the member can see: the active catalog
// lotteries plus their own private ones. Lines start from the admin default; saving stores every
// line as the member's own, and a stored line wins over the default from then on.
import { Hono } from 'hono'
import { and, eq, isNull, or, sql } from 'drizzle-orm'
import type { AppEnv, NotificationItem } from '../types'
import { getDb, type DB } from '../db/client'
import { lotteries, memberNotifications } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { chunk } from '../lib/chunk'
import { parseJson } from '../lib/http'
import { nowIso } from '../lib/time'
import { notificationsSchema } from '../validation'
import { sortLotteriesForMember } from './lotteries'

export const notificationRoutes = new Hono<AppEnv>()
notificationRoutes.use('/notifications', requireMember())

// member_notifications upserts bind 5 parameters per row (member, lottery, time, enabled,
// updated_at); 18 rows = 90 of D1's 100 bound parameters per statement.
const ROWS_PER_INSERT = 18

/** The lotteries a member may keep reminders for: active catalog lotteries and their own. */
const visibleTo = (memberId: string) =>
  or(
    and(isNull(lotteries.ownerMemberId), eq(lotteries.active, true)),
    eq(lotteries.ownerMemberId, memberId),
  )

/**
 * The member's lines in the order of `GET /lotteries` (group, sort order, name). A line the
 * member saved shows their values; otherwise a catalog lottery shows the admin default and a
 * private lottery shows "off".
 */
export async function loadNotificationItems(db: DB, memberId: string): Promise<NotificationItem[]> {
  const rows = await db
    .select({
      lottery: lotteries,
      savedMemberId: memberNotifications.memberId,
      savedTime: memberNotifications.notifyTime,
      savedEnabled: memberNotifications.enabled,
    })
    .from(lotteries)
    .leftJoin(
      memberNotifications,
      and(eq(memberNotifications.lotteryId, lotteries.id), eq(memberNotifications.memberId, memberId)),
    )
    .where(visibleTo(memberId))
  const byId = new Map(rows.map((r) => [r.lottery.id, r]))
  const items: NotificationItem[] = []
  for (const l of sortLotteriesForMember(
    rows.map((r) => r.lottery),
    memberId,
  )) {
    const r = byId.get(l.id)!
    const saved = r.savedMemberId !== null
    const own = r.lottery.ownerMemberId === memberId
    let notifyTime: string | null = null
    let enabled = false
    if (saved) {
      notifyTime = r.savedTime
      enabled = r.savedEnabled === true
    } else if (!own) {
      notifyTime = r.lottery.notifyTime
      enabled = r.lottery.notifyEnabled && r.lottery.notifyTime !== null
    }
    items.push({
      lotteryId: l.id,
      name: l.name,
      groupKey: l.group,
      own,
      notifyTime,
      enabled,
      saved,
    })
  }
  return items
}

notificationRoutes.get('/notifications', async (c) => {
  const items = await loadNotificationItems(getDb(c.env), c.get('member').id)
  return c.json({ items })
})

notificationRoutes.put('/notifications', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const body = await parseJson(c, notificationsSchema)

  // A line whose lottery the member cannot see (unknown, someone else's, switched off, deleted)
  // is skipped and the rest is saved. A lottery can vanish while the page is open (the admin
  // switches it off, or the member deletes their own on another device); rejecting the request
  // would make every later save fail, and reloading throws the edits away. The answer is the
  // refreshed list, so the page drops the line.
  const visible = async () =>
    new Set(
      (
        await db.select({ id: lotteries.id }).from(lotteries).where(visibleTo(memberId))
      ).map((r) => r.id),
    )
  const onlyVisible = (items: typeof body.items, known: Set<string>) =>
    items.filter((it) => known.has(it.lotteryId))

  const updatedAt = nowIso()
  const save = async (items: typeof body.items) => {
    const stmts = chunk(items, ROWS_PER_INSERT).map((part) =>
      db
        .insert(memberNotifications)
        .values(
          part.map((it) => ({
            memberId,
            lotteryId: it.lotteryId,
            notifyTime: it.notifyTime,
            enabled: it.enabled,
            updatedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [memberNotifications.memberId, memberNotifications.lotteryId],
          // last_sent_day stays as it is: it records the last send, not the setting.
          set: {
            notifyTime: sql`excluded.notify_time`,
            enabled: sql`excluded.enabled`,
            updatedAt: sql`excluded.updated_at`,
          },
        }),
    )
    if (stmts.length) {
      await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]])
    }
  }

  const items = onlyVisible(body.items, await visible())
  try {
    await save(items)
  } catch (e) {
    // A lottery deleted between the check and the batch fails its FOREIGN KEY and rolls the
    // whole batch back: skip it too and save once more. Any other failure is a real error.
    const rest = onlyVisible(items, await visible())
    if (rest.length === items.length) throw e
    await save(rest)
  }
  return c.json({ items: await loadNotificationItems(db, memberId) })
})
