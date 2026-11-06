// Row → API shape mappers and small shared queries.
import { and, eq, inArray } from 'drizzle-orm'
import type { DB } from '../db/client'
import { lotteries, renderCounters, type members } from '../db/schema'
import type { AdminMember, Group, Lottery, Member } from '../types'
import { RENDERS_PER_DAY } from '../types'
import { isExpired, utcDay } from './time'

type MemberRow = typeof members.$inferSelect
type LotteryRow = typeof lotteries.$inferSelect

export function toLottery(r: LotteryRow): Lottery {
  return {
    id: r.id,
    name: r.name,
    shortName: r.shortName,
    group: r.groupKey as Group,
    accent: r.accent,
    sortOrder: r.sortOrder,
    active: r.active,
  }
}

export function toMember(r: MemberRow, rendersToday: number): Member {
  return {
    id: r.id,
    displayName: r.displayName,
    expiresAt: r.expiresAt,
    expired: isExpired(r.expiresAt),
    disabled: r.disabled,
    rendersToday,
    rendersLimit: RENDERS_PER_DAY,
  }
}

export function memberLink(webUrl: string, linkToken: string): string {
  return `${webUrl.replace(/\/$/, '')}/m/${linkToken}`
}

export function toAdminMember(r: MemberRow, rendersToday: number, webUrl: string): AdminMember {
  return {
    ...toMember(r, rendersToday),
    linkToken: r.linkToken,
    link: memberLink(webUrl, r.linkToken),
    hasPassword: r.passwordHash !== null,
    lastLoginAt: r.lastLoginAt,
    createdAt: r.createdAt,
    rendersTotal: r.rendersTotal,
  }
}

export async function rendersTodayFor(db: DB, memberId: string): Promise<number> {
  const row = await db.query.renderCounters.findFirst({
    where: and(eq(renderCounters.memberId, memberId), eq(renderCounters.day, utcDay())),
  })
  return row?.count ?? 0
}

export async function rendersTodayMap(db: DB, memberIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (memberIds.length === 0) return out
  const rows = await db
    .select()
    .from(renderCounters)
    .where(and(inArray(renderCounters.memberId, memberIds), eq(renderCounters.day, utcDay())))
  for (const r of rows) out.set(r.memberId, r.count)
  return out
}

/** Returns the subset of `ids` that exist in the lottery catalog. */
export async function existingLotteryIds(db: DB, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db
    .select({ id: lotteries.id })
    .from(lotteries)
    .where(inArray(lotteries.id, ids))
  return new Set(rows.map((r) => r.id))
}
