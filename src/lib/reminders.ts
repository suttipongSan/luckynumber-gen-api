// Daily reminders ("เวลาลง"): the work of the per-minute cron (wrangler.toml [triggers]).
//
// A run looks at the Bangkok minutes it is responsible for, finds which members have a lottery
// due in those minutes, and sends one Web Push message per member to each of their devices.
//
// Exactly-once-ish delivery without a queue: the last processed minute is a cursor row in
// site_settings. A run claims the minutes after it with a compare-and-set BEFORE sending, so two
// overlapping runs can never both send the same minute (at the price that a run which dies after
// claiming loses those reminders; they are not retried).
import { eq, inArray, sql } from 'drizzle-orm'
import type { DB } from '../db/client'
import { getDb } from '../db/client'
import { GROUP_ORDER } from '../db/catalog'
import { memberNotifications, pushSubscriptions, siteSettings } from '../db/schema'
import type { Bindings, PushPayload } from '../types'
import { chunk, IN_CHUNK } from './chunk'
import { changedRows } from './http'
import { addMinutes, bangkokDay, bangkokMinute, nowIso } from './time'
import { createPushSender, loadVapidConfig, type PushSender } from './webpush'

/** site_settings key holding the last processed Bangkok minute (`YYYY-MM-DDTHH:MM`). */
export const NOTIFY_CURSOR_KEY = 'notify_cursor'
/** A run never goes further back than this many minutes (a cron outage is not replayed). */
export const MAX_CATCHUP_MINUTES = 5
/**
 * Pushes (one per device) a single run may send. Every push is a subrequest and a Worker
 * invocation is limited to 50 on the free plan (far more on paid), shared with the run's own D1
 * calls (about 6), so the default leaves headroom below 50. Raise it on the paid plan. Each push
 * also costs roughly 0.3 ms of CPU for the encryption (measured in workerd), which matters on the
 * free plan's small CPU budget per invocation.
 */
export const MAX_SENDS_PER_RUN = 40
/** Workers allow 6 simultaneous open connections per invocation. */
export const SEND_CONCURRENCY = 6
const DEFAULT_WEB_ORIGIN = 'https://pnphoto.co'
/** Notification body budget (UTF-16 units); the long tail becomes "และอีก N หวย". */
const MAX_BODY_CHARS = 120
/** Most lottery ids carried in one payload (the JSON must stay far below the 4 KB push limit). */
const MAX_PAYLOAD_LOTTERY_IDS = 30
/** (member, lottery) pairs per last_sent_day UPDATE: 2 parameters each + 1 for the day. */
const PAIRS_PER_UPDATE = 45

const MINUTE_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/

// ---------------------------------------------------------------------------------------------
// Which minutes a run handles
// ---------------------------------------------------------------------------------------------

/**
 * The minutes in (cursor, now] a run must handle, oldest first. Without a (valid) cursor only the
 * current minute is handled. At most {@link MAX_CATCHUP_MINUTES} are returned, never a minute
 * before today's 00:00 (a reminder for 23:59 is not sent at 00:01), and none when the cursor is
 * already at or past `nowMinute`.
 */
export function minutesToProcess(cursor: string | null, nowMinute: string): string[] {
  if (cursor === null || !MINUTE_RE.test(cursor)) return [nowMinute]
  if (cursor >= nowMinute) return []
  const dayStart = `${nowMinute.slice(0, 10)}T00:00`
  const oldestAllowed = addMinutes(nowMinute, -(MAX_CATCHUP_MINUTES - 1))
  let minute = addMinutes(cursor, 1)
  if (minute < oldestAllowed) minute = oldestAllowed
  if (minute < dayStart) minute = dayStart
  const out: string[] = []
  for (; minute <= nowMinute; minute = addMinutes(minute, 1)) out.push(minute)
  return out
}

/**
 * Claims the minutes this run will handle by moving the cursor to `nowMinute` with a
 * compare-and-set. Returns the minutes, `[]` when there is nothing new, or null when another run
 * moved the cursor first (this run must then do nothing).
 */
async function claimMinutes(db: DB, nowMs: number): Promise<string[] | null> {
  const nowMinute = bangkokMinute(nowMs)
  const [row] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, NOTIFY_CURSOR_KEY))
    .limit(1)
  const stored = row?.value ?? null
  const minutes = minutesToProcess(stored, nowMinute)
  if (minutes.length === 0) return []
  const updatedAt = nowIso(nowMs)
  const res =
    stored === null
      ? await db.run(sql`
          insert into site_settings (key, value, updated_at)
          values (${NOTIFY_CURSOR_KEY}, ${nowMinute}, ${updatedAt})
          on conflict (key) do nothing`)
      : await db.run(sql`
          update site_settings set value = ${nowMinute}, updated_at = ${updatedAt}
          where key = ${NOTIFY_CURSOR_KEY} and value = ${stored}`)
  return changedRows(res) === 1 ? minutes : null
}

// ---------------------------------------------------------------------------------------------
// What is due
// ---------------------------------------------------------------------------------------------

interface DueRow {
  member_id: string
  lottery_id: string
  name: string
  group_key: string
  sort_order: number
  time: string
  /** 1 = the line comes from the member's own member_notifications row, 0 = admin default. */
  saved: number
  sub_id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * One row per (due lottery, device) for members that are active (not disabled, not expired) and
 * have at least one push subscription. The effective setting of a (member, lottery) pair is the
 * member's own row when there is one, otherwise (catalog lotteries only) the lottery's default.
 * Inactive lotteries never fire. Two branches, both driven by the small "due" side:
 *   - the member's own enabled lines (index member_notifications_due_idx), and
 *   - the due catalog defaults crossed with the subscriptions of members that have no own line
 *     for that lottery (CROSS JOIN fixes the order: lotteries first, so a minute in which no
 *     default is due costs one scan of the small lotteries table).
 */
async function loadDue(db: DB, minutes: string[], nowMs: number): Promise<DueRow[]> {
  const times = sql.join(
    minutes.map((m) => sql`${m.slice(11)}`),
    sql`, `,
  )
  const now = nowIso(nowMs)
  return db.all<DueRow>(sql`
    select mn.member_id as member_id, l.id as lottery_id, l.name as name, l.group_key as group_key,
           l.sort_order as sort_order, mn.notify_time as time, 1 as saved,
           s.id as sub_id, s.endpoint as endpoint, s.p256dh as p256dh, s.auth as auth
      from member_notifications mn
      join lotteries l on l.id = mn.lottery_id
      join members m on m.id = mn.member_id
      join push_subscriptions s on s.member_id = mn.member_id
     where mn.enabled = 1 and mn.notify_time in (${times})
       and l.active = 1 and (l.owner_member_id is null or l.owner_member_id = mn.member_id)
       and m.disabled = 0 and m.expires_at > ${now}
    union all
    select s.member_id, l.id, l.name, l.group_key, l.sort_order, l.notify_time, 0,
           s.id, s.endpoint, s.p256dh, s.auth
      from lotteries l
      cross join push_subscriptions s
      join members m on m.id = s.member_id
     where l.owner_member_id is null and l.active = 1 and l.notify_enabled = 1
       and l.notify_time in (${times})
       and m.disabled = 0 and m.expires_at > ${now}
       and not exists (
         select 1 from member_notifications x where x.member_id = s.member_id and x.lottery_id = l.id)
    order by member_id, time, sort_order, lottery_id, sub_id`)
}

// ---------------------------------------------------------------------------------------------
// Notification text
// ---------------------------------------------------------------------------------------------

/** A lottery that is due for one member. */
export interface DueLine {
  lotteryId: string
  name: string
  groupKey: string
  sortOrder: number
  /** "HH:MM" the reminder is set to. */
  time: string
}

function groupIndex(group: string): number {
  const i = GROUP_ORDER.indexOf(group as (typeof GROUP_ORDER)[number])
  return i === -1 ? GROUP_ORDER.length : i
}

/** Earliest time first, then the member's list order (group, sort order, name). */
export function compareDueLines(a: DueLine, b: DueLine): number {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1
  const g = groupIndex(a.groupKey) - groupIndex(b.groupKey)
  if (g !== 0) return g
  const s = a.sortOrder - b.sortOrder
  if (s !== 0) return s
  return a.name.localeCompare(b.name) || (a.lotteryId < b.lotteryId ? -1 : a.lotteryId > b.lotteryId ? 1 : 0)
}

/** Names joined with ", "; when too long, whole names are kept and the rest is counted. */
function joinNames(names: string[], max = MAX_BODY_CHARS): string {
  const all = names.join(', ')
  if (all.length <= max) return all
  let kept = ''
  let count = 0
  for (const name of names) {
    const next = count === 0 ? name : `${kept}, ${name}`
    const rest = names.length - count - 1
    const tail = rest > 0 ? ` และอีก ${rest} หวย` : ''
    if (count > 0 && next.length + tail.length > max) break
    kept = next
    count++
  }
  const rest = names.length - count
  return rest > 0 ? `${kept} และอีก ${rest} หวย` : kept
}

/**
 * The one notification a member gets for everything due in this run. One lottery: its name in the
 * title. Several: the count in the title and the names in the body. `url` opens the first
 * lottery in the web app (`<web origin>/?lottery=<id>`).
 */
export function buildReminderMessage(lines: DueLine[], webOrigin: string): PushPayload {
  const sorted = [...lines].sort(compareDueLines)
  const first = sorted[0]
  const url = `${webOrigin}/?lottery=${encodeURIComponent(first.lotteryId)}`
  const lotteryIds = sorted.slice(0, MAX_PAYLOAD_LOTTERY_IDS).map((l) => l.lotteryId)
  if (sorted.length === 1) {
    return { title: `ถึงเวลาลง ${first.name}`, body: 'แตะเพื่อเปิดหวยนี้', lotteryIds, url }
  }
  return {
    title: `ถึงเวลาลง ${sorted.length} หวย`,
    body: joinNames(sorted.map((l) => l.name)),
    lotteryIds,
    url,
  }
}

/** First origin of WEB_URL (it may list several, comma separated). */
export function primaryWebOrigin(webUrl: string | undefined): string {
  const first = (webUrl ?? '').split(',')[0]?.trim().replace(/\/+$/, '')
  return first || DEFAULT_WEB_ORIGIN
}

// ---------------------------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------------------------

export interface RunOptions {
  /** WEB_URL; the push `url` points at its first origin. */
  webUrl?: string
  /** Cap on pushes per run (default {@link MAX_SENDS_PER_RUN}). */
  maxSends?: number
  /** Simultaneous sends (default {@link SEND_CONCURRENCY}). */
  concurrency?: number
}

export interface RunSummary {
  /** Set when the run did nothing: another run took the minutes, or no new minute has begun. */
  skipped?: 'cursor-taken' | 'no-new-minute'
  /** The Bangkok minutes (`YYYY-MM-DDTHH:MM`) this run handled. */
  minutes: string[]
  /** Members that had something due and at least one device. */
  members: number
  /** Pushes accepted by a push service. */
  sent: number
  /** Pushes that failed (non-2xx other than 404 / 410, or an exception). */
  failed: number
  /** Subscriptions deleted because the push service answered 404 / 410. */
  removed: number
  /** Pushes skipped because the per-run cap was reached. */
  dropped: number
}

interface Device {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

interface MemberDue {
  lines: Map<string, DueLine & { saved: boolean }>
  devices: Map<string, Device>
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'invalid-endpoint'
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; `fn` must not throw. */
async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker))
}

/**
 * One cron run at `nowMs`: claim the minutes since the last run, find what is due, and push it.
 * `sender` does the actual delivery (see createPushSender), so tests can stub it. A send that
 * fails never stops the others; devices whose push service answers 404 / 410 are deleted.
 */
export async function runReminders(
  db: DB,
  nowMs: number,
  sender: PushSender,
  options: RunOptions = {},
): Promise<RunSummary> {
  const summary: RunSummary = { minutes: [], members: 0, sent: 0, failed: 0, removed: 0, dropped: 0 }

  const minutes = await claimMinutes(db, nowMs)
  if (minutes === null) return { ...summary, skipped: 'cursor-taken' }
  if (minutes.length === 0) return { ...summary, skipped: 'no-new-minute' }
  summary.minutes = minutes

  const rows = await loadDue(db, minutes, nowMs)
  if (rows.length === 0) return summary

  // Group the (line x device) rows by member.
  const byMember = new Map<string, MemberDue>()
  for (const r of rows) {
    let m = byMember.get(r.member_id)
    if (!m) {
      m = { lines: new Map(), devices: new Map() }
      byMember.set(r.member_id, m)
    }
    m.lines.set(r.lottery_id, {
      lotteryId: r.lottery_id,
      name: r.name,
      groupKey: r.group_key,
      sortOrder: r.sort_order,
      time: r.time,
      saved: Number(r.saved) === 1,
    })
    m.devices.set(r.sub_id, { id: r.sub_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth })
  }
  summary.members = byMember.size

  // One message per member, one push per device.
  const webOrigin = primaryWebOrigin(options.webUrl)
  interface Task {
    memberId: string
    device: Device
    message: PushPayload
  }
  const tasks: Task[] = []
  for (const [memberId, m] of byMember) {
    const message = buildReminderMessage([...m.lines.values()], webOrigin)
    for (const device of m.devices.values()) tasks.push({ memberId, device, message })
  }

  const maxSends = options.maxSends ?? MAX_SENDS_PER_RUN
  if (tasks.length > maxSends) {
    const dropped = tasks.splice(maxSends)
    summary.dropped = dropped.length
    console.warn(
      `reminders: send cap ${maxSends} reached, dropped ${dropped.length} push(es) for minutes ` +
        `${minutes[0]}..${minutes[minutes.length - 1]}`,
      JSON.stringify({
        members: [...new Set(dropped.map((t) => t.memberId))].slice(0, 20),
        lotteries: [...new Set(dropped.flatMap((t) => t.message.lotteryIds))].slice(0, 20),
      }),
    )
  }

  const delivered = new Set<string>()
  const gone: string[] = []
  await forEachLimited(tasks, options.concurrency ?? SEND_CONCURRENCY, async (t) => {
    try {
      const { status } = await sender(
        { endpoint: t.device.endpoint, p256dh: t.device.p256dh, auth: t.device.auth },
        t.message,
      )
      if (status >= 200 && status < 300) {
        summary.sent++
        delivered.add(t.memberId)
      } else if (status === 404 || status === 410) {
        gone.push(t.device.id)
      } else {
        summary.failed++
        console.warn(`reminders: push to ${hostOf(t.device.endpoint)} answered ${status}`)
      }
    } catch (err) {
      summary.failed++
      console.warn(`reminders: push to ${hostOf(t.device.endpoint)} failed`, err)
    }
  })

  // Bookkeeping after the sends; a failure here must not hide that the pushes went out.
  const day = bangkokDay(nowMs)
  const firedPairs: [string, string][] = []
  for (const memberId of delivered) {
    for (const line of byMember.get(memberId)!.lines.values()) {
      // Only members who saved a line have a row to stamp; nobody gets a row created here.
      if (line.saved) firedPairs.push([memberId, line.lotteryId])
    }
  }
  const stmts = [
    ...chunk(gone, IN_CHUNK).map((part) =>
      db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, part)),
    ),
    ...chunk(firedPairs, PAIRS_PER_UPDATE).map((part) =>
      db
        .update(memberNotifications)
        .set({ lastSentDay: day })
        .where(
          sql`(${memberNotifications.memberId}, ${memberNotifications.lotteryId}) in (values ${sql.join(
            part.map(([memberId, lotteryId]) => sql`(${memberId}, ${lotteryId})`),
            sql`, `,
          )})`,
        ),
    ),
  ]
  if (stmts.length) {
    try {
      await db.batch(stmts as [(typeof stmts)[number], ...(typeof stmts)[number][]])
      summary.removed = gone.length
    } catch (err) {
      console.error('reminders: bookkeeping after sending failed', err)
    }
  }
  return summary
}

/**
 * The cron entry point: does nothing unless the VAPID keys are configured (then the cursor is
 * not touched either), otherwise runs {@link runReminders} with the real sender.
 * Returns null when push is not configured.
 */
export async function runScheduledReminders(
  env: Bindings,
  nowMs = Date.now(),
  options: RunOptions = {},
): Promise<RunSummary | null> {
  const vapid = await loadVapidConfig(env)
  if (!vapid) return null
  const summary = await runReminders(getDb(env), nowMs, createPushSender(vapid), {
    webUrl: env.WEB_URL,
    ...options,
  })
  if (summary.members > 0 || summary.failed > 0) console.log('reminders', JSON.stringify(summary))
  return summary
}
