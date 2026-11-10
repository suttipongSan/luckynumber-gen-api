// Row → API shape mappers and small shared queries.
import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import type { DB } from '../db/client'
import { lotteries, renderCounters, type members } from '../db/schema'
import type { AdminMember, Group, Lottery, Member, SessionMember } from '../types'
import { effectiveRenderLimit } from './siteSettings'
import { isExpired, utcDay } from './time'
import { chunk, IN_CHUNK } from './chunk'

type MemberRow = typeof members.$inferSelect
type LotteryRow = typeof lotteries.$inferSelect

/**
 * Maps a lottery row to the API shape. Pass the requesting `memberId` to set `custom: true`
 * when the lottery is owned by that member. Admin / public callers omit the id and get
 * `custom: false`.
 */
export function toLottery(r: LotteryRow, memberId?: string): Lottery {
  return {
    id: r.id,
    name: r.name,
    shortName: r.shortName,
    group: r.groupKey as Group,
    accent: r.accent,
    sortOrder: r.sortOrder,
    active: r.active,
    custom: memberId !== undefined && r.ownerMemberId === memberId,
  }
}

export function toMember(
  r: SessionMember | MemberRow,
  rendersToday: number,
  defaultRenderLimit: number,
): Member {
  return {
    id: r.id,
    displayName: r.displayName,
    expiresAt: r.expiresAt,
    expired: isExpired(r.expiresAt),
    disabled: r.disabled,
    rendersToday,
    rendersLimit: effectiveRenderLimit(r.renderLimit, defaultRenderLimit),
  }
}

export function memberLink(webUrl: string, linkToken: string): string {
  // WEB_URL can be a comma-separated list; links always use the first (primary) origin.
  const primary = (webUrl.split(',')[0] ?? '').trim().replace(/\/+$/, '')
  return `${primary}/m/${linkToken}`
}

export function toAdminMember(
  r: MemberRow,
  rendersToday: number,
  webUrl: string,
  defaultRenderLimit: number,
): AdminMember {
  return {
    ...toMember(r, rendersToday, defaultRenderLimit),
    linkToken: r.linkToken,
    link: memberLink(webUrl, r.linkToken),
    hasPassword: r.passwordHash !== null,
    lastLoginAt: r.lastLoginAt,
    createdAt: r.createdAt,
    rendersTotal: r.rendersTotal,
    renderLimit: r.renderLimit,
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
  const day = utcDay()
  for (const part of chunk(memberIds, IN_CHUNK)) {
    const rows = await db
      .select()
      .from(renderCounters)
      .where(and(inArray(renderCounters.memberId, part), eq(renderCounters.day, day)))
    for (const r of rows) out.set(r.memberId, r.count)
  }
  return out
}

/**
 * Returns the subset of `ids` that this member may reference: global lotteries
 * (`owner_member_id IS NULL`) and the member's own custom ones. Another member's custom id
 * behaves like an unknown id. Used by sets.ts, settings.ts (single + bulk) and render.ts.
 */
export async function memberLotteryIds(
  db: DB,
  memberId: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const out = new Set<string>()
  for (const part of chunk(ids, IN_CHUNK)) {
    const rows = await db
      .select({ id: lotteries.id })
      .from(lotteries)
      .where(
        and(
          inArray(lotteries.id, part),
          or(isNull(lotteries.ownerMemberId), eq(lotteries.ownerMemberId, memberId)),
        ),
      )
    for (const r of rows) out.add(r.id)
  }
  return out
}
