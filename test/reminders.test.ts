// Daily reminders: which minutes a run handles, who is due (admin default vs the member's own
// line, inactive / private lotteries, devices), the notification text, de-duplication through the
// cursor, dead-device cleanup and the per-run cap. The sender is stubbed; the database is a real
// libSQL file with the project's migrations.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { openDb, runMigrations } from '../scripts/db'
import app from '../src/index'
import {
  lotteries,
  memberNotifications,
  members,
  pushSubscriptions,
  siteSettings,
} from '../src/db/schema'
import {
  MAX_CATCHUP_MINUTES,
  NOTIFY_CURSOR_KEY,
  buildReminderMessage,
  compareDueLines,
  minutesToProcess,
  primaryWebOrigin,
  runReminders,
  runScheduledReminders,
  type DueLine,
} from '../src/lib/reminders'
import { addMinutes, bangkokMinute } from '../src/lib/time'
import { bytesToBase64Url } from '../src/lib/crypto'
import { deriveContentKeys, generateVapidKeyPair, type PushSender, type PushTarget } from '../src/lib/webpush'
import type { Bindings, PushPayload } from '../src/types'

const DB_FILE = 'test-reminders.db'
const DB_URL = `file:${DB_FILE}`
const WEB = 'http://localhost:5173'

type Db = ReturnType<typeof openDb>['db']
let client: ReturnType<typeof openDb>['client']
let db: Db

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

beforeAll(async () => {
  removeDb()
  await runMigrations(DB_URL)
  ;({ client, db } = openDb(DB_URL))
})

afterAll(() => {
  client.close()
  try {
    removeDb()
  } catch {
    // file may still be held open on Windows; harmless
  }
})

beforeEach(async () => {
  // every test starts from an empty database (children first)
  await db.delete(memberNotifications)
  await db.delete(pushSubscriptions)
  await db.delete(lotteries)
  await db.delete(members)
  await db.delete(siteSettings)
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- fixtures ------------------------------------------------------------------------------------

/** Unix ms of a Bangkok wall-clock time (UTC+7). */
const at = (hhmm: string, day = '2026-11-14') => Date.parse(`${day}T${hhmm}:00+07:00`)

async function addMember(id: string, opts: { disabled?: boolean; expired?: boolean } = {}) {
  await db.insert(members).values({
    id,
    displayName: id,
    linkToken: `token-${id}`,
    passwordHash: null,
    expiresAt: opts.expired ? '2020-01-01T00:00:00.000Z' : '2099-01-01T00:00:00.000Z',
    disabled: opts.disabled ?? false,
    createdAt: '2026-01-01T00:00:00.000Z',
  })
}

/** Registers `count` devices; returns their endpoints. */
async function addDevices(memberId: string, count = 1): Promise<string[]> {
  const endpoints: string[] = []
  for (let i = 1; i <= count; i++) {
    const endpoint = `https://fcm.googleapis.com/fcm/send/${memberId}-${i}`
    endpoints.push(endpoint)
    await db.insert(pushSubscriptions).values({
      id: `sub-${memberId}-${i}`,
      memberId,
      endpoint,
      p256dh: 'p256dh-placeholder',
      auth: 'auth-placeholder',
      createdAt: `2026-01-01T00:00:0${i % 10}.000Z`,
    })
  }
  return endpoints
}

async function addLottery(
  id: string,
  o: {
    name?: string
    group?: string
    sortOrder?: number
    active?: boolean
    owner?: string | null
    time?: string | null
    enabled?: boolean
  } = {},
) {
  await db.insert(lotteries).values({
    id,
    name: o.name ?? id,
    shortName: o.name ?? id,
    groupKey: o.group ?? 'hanoi',
    accent: '#be123c',
    sortOrder: o.sortOrder ?? 0,
    active: o.active ?? true,
    ownerMemberId: o.owner ?? null,
    notifyTime: o.time ?? null,
    notifyEnabled: o.enabled ?? false,
  })
}

async function setLine(memberId: string, lotteryId: string, time: string | null, enabled: boolean) {
  await db.insert(memberNotifications).values({
    memberId,
    lotteryId,
    notifyTime: time,
    enabled,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
}

async function readCursor(): Promise<string | null> {
  const rows = await db.select().from(siteSettings).where(eq(siteSettings.key, NOTIFY_CURSOR_KEY))
  return rows[0]?.value ?? null
}

async function writeCursor(value: string) {
  await db.insert(siteSettings).values({ key: NOTIFY_CURSOR_KEY, value, updatedAt: '2026-01-01T00:00:00.000Z' })
}

interface Call {
  target: PushTarget
  message: PushPayload
}

/** A sender that records every push; `answer` picks the status (or an exception) per device. */
function stubSender(answer?: (target: PushTarget) => number | Error) {
  const calls: Call[] = []
  const sender: PushSender = async (target, message) => {
    calls.push({ target, message })
    const r = answer?.(target) ?? 201
    if (r instanceof Error) throw r
    return { status: r }
  }
  return { sender, calls }
}

const run = (nowMs: number, sender: PushSender, extra = {}) =>
  runReminders(db, nowMs, sender, { webUrl: WEB, ...extra })

const callsFor = (calls: Call[], memberId: string) => calls.filter((c) => c.target.endpoint.includes(`/${memberId}-`))

// ---- which minutes -------------------------------------------------------------------------------

describe('minutesToProcess', () => {
  const now = '2026-11-14T09:00'

  it('first run (no cursor) handles only the current minute', () => {
    expect(minutesToProcess(null, now)).toEqual([now])
    expect(minutesToProcess('garbage', now)).toEqual([now])
  })

  it('handles (cursor, now]', () => {
    expect(minutesToProcess('2026-11-14T08:59', now)).toEqual(['2026-11-14T09:00'])
    expect(minutesToProcess('2026-11-14T08:57', now)).toEqual(['2026-11-14T08:58', '2026-11-14T08:59', '2026-11-14T09:00'])
  })

  it('does nothing when the cursor is at or after now', () => {
    expect(minutesToProcess(now, now)).toEqual([])
    expect(minutesToProcess('2026-11-14T09:03', now)).toEqual([])
  })

  it(`never goes back more than ${MAX_CATCHUP_MINUTES} minutes`, () => {
    expect(minutesToProcess('2026-11-14T06:00', now)).toEqual([
      '2026-11-14T08:56',
      '2026-11-14T08:57',
      '2026-11-14T08:58',
      '2026-11-14T08:59',
      '2026-11-14T09:00',
    ])
    expect(minutesToProcess('2026-11-14T08:55', now)).toHaveLength(5)
    expect(minutesToProcess('2026-11-14T08:56', now)).toHaveLength(4)
  })

  it('never crosses midnight into the previous day', () => {
    expect(minutesToProcess('2026-11-13T23:50', '2026-11-14T00:02')).toEqual([
      '2026-11-14T00:00',
      '2026-11-14T00:01',
      '2026-11-14T00:02',
    ])
    expect(minutesToProcess('2026-11-13T23:59', '2026-11-14T00:00')).toEqual(['2026-11-14T00:00'])
    expect(minutesToProcess('2026-11-10T12:00', '2026-11-14T00:01')).toEqual(['2026-11-14T00:00', '2026-11-14T00:01'])
  })

  it('addMinutes / bangkokMinute use Bangkok wall time', () => {
    expect(bangkokMinute(Date.parse('2026-11-14T02:00:30Z'))).toBe('2026-11-14T09:00')
    expect(bangkokMinute(Date.parse('2026-11-13T17:00:00Z'))).toBe('2026-11-14T00:00')
    expect(bangkokMinute(Date.parse('2026-11-13T16:59:59Z'))).toBe('2026-11-13T23:59')
    expect(addMinutes('2026-11-14T00:00', -1)).toBe('2026-11-13T23:59')
    expect(addMinutes('2026-12-31T23:59', 1)).toBe('2027-01-01T00:00')
  })
})

// ---- notification text ---------------------------------------------------------------------------

describe('buildReminderMessage', () => {
  const line = (id: string, name: string, extra: Partial<DueLine> = {}): DueLine => ({
    lotteryId: id,
    name,
    groupKey: 'hanoi',
    sortOrder: 0,
    time: '09:00',
    ...extra,
  })

  it('one lottery: its name in the title, a fixed body, a link that opens it', () => {
    expect(buildReminderMessage([line('hanoi-regular', 'ฮานอยปกติ')], WEB)).toEqual({
      title: 'ถึงเวลาลง ฮานอยปกติ',
      body: 'แตะเพื่อเปิดหวยนี้',
      lotteryIds: ['hanoi-regular'],
      url: `${WEB}/?lottery=hanoi-regular`,
    })
  })

  it('several lotteries: the count in the title, the names joined with ", " in the body', () => {
    const msg = buildReminderMessage(
      [
        line('b', 'ดาวโจนส์', { groupKey: 'stock' }),
        line('a', 'ฮานอยปกติ', { groupKey: 'hanoi' }),
        line('c', 'ลาวพัฒนา', { groupKey: 'lao' }),
      ],
      'https://pnphoto.co',
    )
    expect(msg.title).toBe('ถึงเวลาลง 3 หวย')
    expect(msg.body).toBe('ฮานอยปกติ, ลาวพัฒนา, ดาวโจนส์') // list order: hanoi, lao, stock
    expect(msg.lotteryIds).toEqual(['a', 'c', 'b'])
    expect(msg.url).toBe('https://pnphoto.co/?lottery=a')
  })

  it('orders by time first, then by the list order', () => {
    const lines = [
      line('late', 'ปลาย', { time: '09:03', sortOrder: 1 }),
      line('x2', 'ข', { time: '09:00', sortOrder: 2 }),
      line('x1', 'ก', { time: '09:00', sortOrder: 1 }),
    ]
    expect([...lines].sort(compareDueLines).map((l) => l.lotteryId)).toEqual(['x1', 'x2', 'late'])
    expect(buildReminderMessage(lines, WEB).lotteryIds).toEqual(['x1', 'x2', 'late'])
  })

  it('a long list keeps whole names and counts the rest', () => {
    const names = Array.from({ length: 30 }, (_, i) => `ชื่อหวยยาวมากลำดับที่ ${i + 1}`)
    const msg = buildReminderMessage(
      names.map((n, i) => line(`id${i}`, n, { sortOrder: i })),
      WEB,
    )
    expect(msg.title).toBe('ถึงเวลาลง 30 หวย')
    expect(msg.body.length).toBeLessThanOrEqual(120)
    const m = msg.body.match(/^(.*) และอีก (\d+) หวย$/)!
    expect(m).not.toBeNull()
    const shown = m[1].split(', ')
    expect(shown).toEqual(names.slice(0, shown.length)) // whole names, in order, none cut
    expect(shown.length + Number(m[2])).toBe(30)
    expect(msg.lotteryIds).toHaveLength(30)
  })

  it('caps the ids in the payload and always fits in one push record', () => {
    const lines = Array.from({ length: 200 }, (_, i) => line(`m-${'x'.repeat(16)}${i}`, 'ก'.repeat(40), { sortOrder: i }))
    const msg = buildReminderMessage(lines, WEB)
    expect(msg.lotteryIds).toHaveLength(30)
    expect(new TextEncoder().encode(JSON.stringify(msg)).length).toBeLessThan(3000)
  })

  it('primaryWebOrigin takes the first origin of WEB_URL', () => {
    expect(primaryWebOrigin('https://pnphoto.co, http://localhost:5173')).toBe('https://pnphoto.co')
    expect(primaryWebOrigin('https://pnphoto.co/')).toBe('https://pnphoto.co')
    expect(primaryWebOrigin(undefined)).toBe('https://pnphoto.co')
    expect(primaryWebOrigin('')).toBe('https://pnphoto.co')
  })
})

// ---- who is due ----------------------------------------------------------------------------------

describe('runReminders: who is due', () => {
  it('a member without their own line follows the admin default (and no row is created for them)', async () => {
    await addLottery('hanoi-regular', { name: 'ฮานอยปกติ', time: '09:00', enabled: true })
    await addMember('m1')
    await addDevices('m1')
    const { sender, calls } = stubSender()

    const res = await run(at('09:00'), sender)

    expect(calls).toHaveLength(1)
    expect(calls[0].message).toEqual({
      title: 'ถึงเวลาลง ฮานอยปกติ',
      body: 'แตะเพื่อเปิดหวยนี้',
      lotteryIds: ['hanoi-regular'],
      url: `${WEB}/?lottery=hanoi-regular`,
    })
    expect(calls[0].target.endpoint).toBe('https://fcm.googleapis.com/fcm/send/m1-1')
    expect(res).toMatchObject({ minutes: ['2026-11-14T09:00'], members: 1, sent: 1, failed: 0, removed: 0, dropped: 0 })
    expect(await db.select().from(memberNotifications)).toHaveLength(0)
  })

  it('the minute must match: a first run at 08:59 or 09:01 sends nothing for a 09:00 default', async () => {
    await addLottery('l1', { time: '09:00', enabled: true })
    await addMember('m1')
    await addDevices('m1')
    for (const t of ['08:59', '09:01']) {
      await db.delete(siteSettings)
      const { sender, calls } = stubSender()
      expect((await run(at(t), sender)).sent).toBe(0)
      expect(calls).toHaveLength(0)
    }
  })

  it('the admin default being off (or having no time) never fires', async () => {
    await addLottery('off', { time: '09:00', enabled: false })
    await addLottery('no-time', { time: null, enabled: true }) // cannot be written by the API; the job must not care
    await addMember('m1')
    await addDevices('m1')
    const { sender, calls } = stubSender()
    await run(at('09:00'), sender)
    expect(calls).toHaveLength(0)
  })

  it("a member's own line wins over the default: a different time moves the reminder", async () => {
    await addLottery('l1', { name: 'หวยหนึ่ง', time: '09:00', enabled: true })
    await addMember('follows')
    await addMember('moved')
    await addDevices('follows')
    await addDevices('moved')
    await setLine('moved', 'l1', '10:30', true)

    const first = stubSender()
    await run(at('09:00'), first.sender)
    expect(first.calls.map((c) => c.target.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/follows-1'])

    const later = stubSender()
    await run(at('10:30'), later.sender)
    expect(later.calls.map((c) => c.target.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/moved-1'])
    expect(later.calls[0].message.title).toBe('ถึงเวลาลง หวยหนึ่ง')
  })

  it("a member's disabled line silences the default; an enabled line works while the default is off", async () => {
    await addLottery('on', { time: '09:00', enabled: true })
    await addLottery('off', { time: null, enabled: false })
    await addMember('quiet')
    await addMember('opted-in')
    await addDevices('quiet')
    await addDevices('opted-in')
    await setLine('quiet', 'on', '09:00', false) // same time but switched off
    await setLine('opted-in', 'off', '09:00', true) // no admin default, member turned it on
    const { sender, calls } = stubSender()

    await run(at('09:00'), sender)

    expect(callsFor(calls, 'quiet')).toHaveLength(0)
    // one device, one notification: their own line for "off" plus the default for "on"
    const mine = callsFor(calls, 'opted-in')
    expect(mine).toHaveLength(1)
    expect(mine[0].message.title).toBe('ถึงเวลาลง 2 หวย')
    expect(mine[0].message.lotteryIds.sort()).toEqual(['off', 'on'])
  })

  it('an inactive catalog lottery never fires, by default or through a member line', async () => {
    await addLottery('inactive', { active: false, time: '09:00', enabled: true })
    await addMember('m1')
    await addMember('m2')
    await addDevices('m1')
    await addDevices('m2')
    await setLine('m2', 'inactive', '09:00', true)
    const { sender, calls } = stubSender()
    await run(at('09:00'), sender)
    expect(calls).toHaveLength(0)
  })

  it('a private lottery fires only for its owner, only through their own line', async () => {
    await addMember('owner')
    await addMember('other')
    await addDevices('owner')
    await addDevices('other')
    await addLottery('m-private', { name: 'หวยส่วนตัว', owner: 'owner', time: '09:00', enabled: true })
    // No member line: private lotteries have no admin default, so nothing is due yet.
    const none = stubSender()
    await run(at('09:00'), none.sender)
    expect(none.calls).toHaveLength(0)

    await db.delete(siteSettings)
    await setLine('owner', 'm-private', '09:00', true)
    await setLine('other', 'm-private', '09:00', true) // corrupt row: someone else's private lottery
    const some = stubSender()
    await run(at('09:00'), some.sender)
    expect(some.calls.map((c) => c.target.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/owner-1'])
    expect(some.calls[0].message.title).toBe('ถึงเวลาลง หวยส่วนตัว')
  })

  it('a member with several lotteries due gets ONE notification per device, grouped', async () => {
    await addLottery('l-stock', { name: 'ดาวโจนส์', group: 'stock', time: '09:00', enabled: true })
    await addLottery('l-hanoi', { name: 'ฮานอยพิเศษ', group: 'hanoi', sortOrder: 2, time: '09:00', enabled: true })
    await addLottery('l-hanoi-1', { name: 'ฮานอยปกติ', group: 'hanoi', sortOrder: 1, time: '09:00', enabled: true })
    await addLottery('l-other-time', { name: 'ไม่ใช่ตอนนี้', time: '09:05', enabled: true })
    await addMember('m1')
    await addMember('solo')
    await addDevices('m1', 2)
    await addDevices('solo', 1)
    await addLottery('m-own', { name: 'ของฉัน', group: 'other', owner: 'm1' })
    await setLine('m1', 'm-own', '09:00', true) // own line, same minute
    await setLine('solo', 'l-hanoi', '09:00', false) // solo only has the other two
    await setLine('solo', 'l-stock', '09:30', true)
    await setLine('solo', 'l-hanoi-1', '09:30', true)
    const { sender, calls } = stubSender()

    const res = await run(at('09:00'), sender)

    const m1 = callsFor(calls, 'm1')
    expect(m1).toHaveLength(2) // one per device, not one per lottery
    for (const c of m1) {
      expect(c.message).toEqual({
        title: 'ถึงเวลาลง 4 หวย',
        body: 'ฮานอยปกติ, ฮานอยพิเศษ, ดาวโจนส์, ของฉัน',
        lotteryIds: ['l-hanoi-1', 'l-hanoi', 'l-stock', 'm-own'],
        url: `${WEB}/?lottery=l-hanoi-1`,
      })
    }
    expect(m1.map((c) => c.target.endpoint).sort()).toEqual([
      'https://fcm.googleapis.com/fcm/send/m1-1',
      'https://fcm.googleapis.com/fcm/send/m1-2',
    ])
    expect(callsFor(calls, 'solo')).toHaveLength(0) // both of solo's own lines moved to 09:30; the third is off
    expect(res).toMatchObject({ members: 1, sent: 2 })
  })

  it('no push without a subscription; disabled and expired members are skipped', async () => {
    await addLottery('l1', { time: '09:00', enabled: true })
    await addMember('no-device')
    await addMember('disabled', { disabled: true })
    await addMember('expired', { expired: true })
    await addMember('ok')
    await addDevices('disabled')
    await addDevices('expired')
    await addDevices('ok')
    await setLine('disabled', 'l1', '09:00', true)
    await setLine('expired', 'l1', '09:00', true)
    await setLine('no-device', 'l1', '09:00', true)
    const { sender, calls } = stubSender()
    const res = await run(at('09:00'), sender)
    expect(calls.map((c) => c.target.endpoint)).toEqual(['https://fcm.googleapis.com/fcm/send/ok-1'])
    expect(res.members).toBe(1)
  })

  it('a member whose expiry is between two runs stops getting reminders at the moment it passes', async () => {
    await addLottery('l1', { time: '09:00', enabled: true })
    await db.insert(members).values({
      id: 'soon',
      displayName: 'soon',
      linkToken: 'token-soon',
      passwordHash: null,
      expiresAt: new Date(at('08:59')).toISOString(),
      disabled: false,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await addDevices('soon')
    const { sender, calls } = stubSender()
    await run(at('09:00'), sender)
    expect(calls).toHaveLength(0)
  })
})

// ---- cursor: catch-up and de-duplication ---------------------------------------------------------

describe('runReminders: cursor', () => {
  async function setup() {
    await addMember('m1')
    await addDevices('m1')
  }

  it('the first run creates the cursor and handles only the current minute', async () => {
    await setup()
    await addLottery('earlier', { name: 'ก่อนหน้า', time: '08:59', enabled: true })
    await addLottery('now', { name: 'ตอนนี้', time: '09:00', enabled: true })
    const { sender, calls } = stubSender()
    const res = await run(at('09:00'), sender)
    expect(calls.map((c) => c.message.title)).toEqual(['ถึงเวลาลง ตอนนี้'])
    expect(res.minutes).toEqual(['2026-11-14T09:00'])
    expect(await readCursor()).toBe('2026-11-14T09:00')
  })

  it('catches up the minutes since the cursor, in one grouped notification', async () => {
    await setup()
    await writeCursor('2026-11-14T08:57')
    await addLottery('a', { name: 'เอ', time: '08:56', enabled: true }) // before the cursor: already handled
    await addLottery('b', { name: 'บี', time: '08:58', enabled: true })
    await addLottery('c', { name: 'ซี', time: '08:59', enabled: true })
    await addLottery('d', { name: 'ดี', time: '09:00', enabled: true })
    await addLottery('e', { name: 'อี', time: '09:01', enabled: true }) // not yet
    const { sender, calls } = stubSender()
    const res = await run(at('09:00'), sender)
    expect(res.minutes).toEqual(['2026-11-14T08:58', '2026-11-14T08:59', '2026-11-14T09:00'])
    expect(calls).toHaveLength(1)
    expect(calls[0].message).toMatchObject({
      title: 'ถึงเวลาลง 3 หวย',
      body: 'บี, ซี, ดี',
      lotteryIds: ['b', 'c', 'd'],
    })
    expect(await readCursor()).toBe('2026-11-14T09:00')
  })

  it(`never replays more than ${MAX_CATCHUP_MINUTES} minutes after an outage`, async () => {
    await setup()
    await writeCursor('2026-11-14T08:30')
    await addLottery('old', { name: 'เก่า', time: '08:55', enabled: true })
    await addLottery('edge', { name: 'ขอบ', time: '08:56', enabled: true })
    await addLottery('now', { name: 'ตอนนี้', time: '09:00', enabled: true })
    const { sender, calls } = stubSender()
    const res = await run(at('09:00'), sender)
    expect(res.minutes).toHaveLength(5)
    expect(calls[0].message.lotteryIds).toEqual(['edge', 'now'])
    expect(await readCursor()).toBe('2026-11-14T09:00')
  })

  it('does not reach back across midnight into yesterday', async () => {
    await setup()
    await writeCursor('2026-11-13T23:55')
    await addLottery('late', { name: 'ดึก', time: '23:59', enabled: true })
    await addLottery('zero', { name: 'เที่ยงคืน', time: '00:00', enabled: true })
    await addLottery('one', { name: 'ตีหนึ่ง', time: '00:01', enabled: true })
    const { sender, calls } = stubSender()
    const res = await run(at('00:02'), sender)
    expect(res.minutes).toEqual(['2026-11-14T00:00', '2026-11-14T00:01', '2026-11-14T00:02'])
    expect(calls[0].message.lotteryIds).toEqual(['zero', 'one'])
  })

  it('a repeated run in the same minute sends nothing more', async () => {
    await setup()
    await addLottery('l1', { time: '09:00', enabled: true })
    const { sender, calls } = stubSender()
    expect((await run(at('09:00'), sender)).sent).toBe(1)
    const again = await run(at('09:00') + 20_000, sender) // same Bangkok minute, 20 s later
    expect(again).toMatchObject({ skipped: 'no-new-minute', sent: 0, minutes: [] })
    // a clock that moved backwards behaves the same
    expect((await run(at('08:58'), sender)).skipped).toBe('no-new-minute')
    expect(calls).toHaveLength(1)
    // and the next minute does not resend the 09:00 reminder
    expect((await run(at('09:01'), sender)).sent).toBe(0)
    expect(calls).toHaveLength(1)
    expect(await readCursor()).toBe('2026-11-14T09:01')
  })

  it('two overlapping runs cannot both send: the compare-and-set lets one win', async () => {
    await setup()
    await writeCursor('2026-11-14T08:59')
    await addLottery('l1', { time: '09:00', enabled: true })
    const { sender, calls } = stubSender()
    const results = await Promise.all([run(at('09:00'), sender), run(at('09:00'), sender), run(at('09:00'), sender)])
    expect(calls).toHaveLength(1)
    expect(results.filter((r) => !r.skipped)).toHaveLength(1)
    // the others read the old cursor but lost the compare-and-set
    expect(results.filter((r) => r.skipped === 'cursor-taken').length).toBeGreaterThanOrEqual(1)
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1)
  })

  it('an unreadable cursor value is replaced and treated as a first run', async () => {
    await setup()
    await writeCursor('not-a-minute')
    await addLottery('l1', { time: '09:00', enabled: true })
    await addLottery('older', { time: '08:58', enabled: true })
    const { sender, calls } = stubSender()
    await run(at('09:00'), sender)
    expect(calls.map((c) => c.message.lotteryIds)).toEqual([['l1']])
    expect(await readCursor()).toBe('2026-11-14T09:00')
  })
})

// ---- delivery results ----------------------------------------------------------------------------

describe('runReminders: delivery', () => {
  it('deletes subscriptions answering 404 / 410, keeps the rest, and one failure stops nobody', async () => {
    await addLottery('l1', { time: '09:00', enabled: true })
    await addMember('m1')
    await addMember('m2')
    const m1 = await addDevices('m1', 5)
    await addDevices('m2', 1)
    const answers = new Map<string, number | Error>([
      [m1[0], 404],
      [m1[1], 410],
      [m1[2], 500],
      [m1[3], new Error('network down')],
      [m1[4], 201],
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sender, calls } = stubSender((t) => answers.get(t.endpoint) ?? 201)

    const res = await run(at('09:00'), sender)

    expect(calls).toHaveLength(6) // every device was tried
    expect(res).toMatchObject({ members: 2, sent: 2, failed: 2, removed: 2, dropped: 0 })
    const left = (await db.select().from(pushSubscriptions)).map((r) => r.endpoint).sort()
    expect(left).toEqual([m1[2], m1[3], m1[4], 'https://fcm.googleapis.com/fcm/send/m2-1'].sort())
    // the log names the push service, never the (secret) endpoint URL
    const logged = JSON.stringify(warn.mock.calls.map((c) => c.map(String)))
    expect(logged).toContain('fcm.googleapis.com')
    expect(logged).not.toContain('/fcm/send/')
  })

  it('stamps last_sent_day on the member lines that fired, and creates no rows', async () => {
    await addLottery('l-saved', { time: '09:00', enabled: true })
    await addLottery('l-default', { time: '09:00', enabled: true })
    await addLottery('l-later', { time: '12:00', enabled: true })
    await addMember('saver')
    await addMember('follower')
    await addDevices('saver')
    await addDevices('follower')
    await setLine('saver', 'l-saved', '09:00', true)
    await setLine('saver', 'l-later', '12:00', true)
    const { sender } = stubSender()

    await run(at('09:00'), sender)

    const rows = await db.select().from(memberNotifications)
    const byKey = new Map(rows.map((r) => [`${r.memberId}/${r.lotteryId}`, r]))
    expect(rows).toHaveLength(2) // nothing was created for anyone
    expect(byKey.get('saver/l-saved')!.lastSentDay).toBe('2026-11-14')
    expect(byKey.get('saver/l-later')!.lastSentDay).toBeNull() // not due yet
  })

  it('does not stamp last_sent_day when no device accepted the push', async () => {
    await addLottery('l1', { time: '09:00', enabled: true })
    await addMember('m1')
    await addDevices('m1')
    await setLine('m1', 'l1', '09:00', true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sender } = stubSender(() => 503)
    const res = await run(at('09:00'), sender)
    expect(res).toMatchObject({ sent: 0, failed: 1 })
    expect((await db.select().from(memberNotifications))[0].lastSentDay).toBeNull()
  })

  it('stamps more than one chunk of (member, lottery) pairs', async () => {
    await addMember('m1')
    await addDevices('m1')
    const ids = Array.from({ length: 100 }, (_, i) => `l${String(i).padStart(3, '0')}`)
    for (const id of ids) {
      await addLottery(id, { time: null })
      await setLine('m1', id, '09:00', true)
    }
    const { sender } = stubSender()
    const res = await run(at('09:00'), sender)
    expect(res.sent).toBe(1)
    const rows = await db.select().from(memberNotifications)
    expect(rows).toHaveLength(100)
    expect(rows.every((r) => r.lastSentDay === '2026-11-14')).toBe(true)
  })

  it('stops at the per-run cap and logs what was dropped', async () => {
    await addLottery('l1', { time: '09:00', enabled: true })
    for (let i = 1; i <= 5; i++) {
      await addMember(`m${i}`)
      await addDevices(`m${i}`, 1)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { sender, calls } = stubSender()
    const res = await run(at('09:00'), sender, { maxSends: 3 })
    expect(calls).toHaveLength(3)
    expect(res).toMatchObject({ members: 5, sent: 3, dropped: 2 })
    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
    expect(logged).toMatch(/send cap 3 reached, dropped 2/)
    // the dropped members are named in the log (rows come ordered by member id: m4, m5 are last)
    expect(logged).toContain('m4')
    expect(logged).toContain('m5')
    expect(logged).toContain('l1')
  })

  it('the default cap leaves room for the free plan subrequest limit', async () => {
    const { MAX_SENDS_PER_RUN, SEND_CONCURRENCY } = await import('../src/lib/reminders')
    expect(MAX_SENDS_PER_RUN).toBeLessThan(50)
    expect(SEND_CONCURRENCY).toBeLessThanOrEqual(6)
  })

  it('sends with bounded concurrency', async () => {
    await addLottery('l1', { time: '09:00', enabled: true })
    await addMember('m1')
    await addDevices('m1', 10)
    let inFlight = 0
    let peak = 0
    const sender: PushSender = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return { status: 201 }
    }
    const res = await run(at('09:00'), sender, { concurrency: 3 })
    expect(res.sent).toBe(10)
    expect(peak).toBe(3)

    await db.delete(siteSettings)
    peak = 0
    await run(at('09:00'), sender) // default concurrency
    expect(peak).toBeLessThanOrEqual(6)
    expect(peak).toBeGreaterThan(1)
  })
})

// ---- the cron entry point ------------------------------------------------------------------------

describe('scheduled', () => {
  const baseEnv = (): Bindings => ({
    TURSO_DATABASE_URL: DB_URL,
    SESSION_SECRET: 's',
    ASSET_SIGNING_SECRET: 's',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: 'x',
    WEB_URL: 'https://pnphoto.co',
    ASSETS: {} as Bindings['ASSETS'],
  })

  it('the app is still the default export with fetch / request, and carries the scheduled handler', async () => {
    expect(typeof app.request).toBe('function')
    expect(typeof app.fetch).toBe('function')
    expect(typeof (app as unknown as { scheduled: unknown }).scheduled).toBe('function')
    expect((await app.request('/health', {}, baseEnv())).status).toBe(200)
  })

  it('does nothing without VAPID keys (the cursor is not even created)', async () => {
    await addLottery('l1', { time: '09:00', enabled: true })
    await addMember('m1')
    await addDevices('m1')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      expect(await runScheduledReminders(baseEnv(), at('09:00'))).toBeNull()
      await (app as unknown as { scheduled: (c: { scheduledTime: number }, e: Bindings) => Promise<void> }).scheduled(
        { scheduledTime: at('09:00') },
        baseEnv(),
      )
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await readCursor()).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('end to end: DB -> payload -> encryption -> POST to the push service', async () => {
    // a real subscriber so the body can be decrypted
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const ua = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    const authSecret = crypto.getRandomValues(new Uint8Array(16))
    await addLottery('hanoi-regular', { name: 'ฮานอยปกติ', time: '09:00', enabled: true })
    await addMember('m1')
    await db.insert(pushSubscriptions).values({
      id: 'sub-e2e',
      memberId: 'm1',
      endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/e2e',
      p256dh: bytesToBase64Url(ua),
      auth: bytesToBase64Url(authSecret),
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const keys = await generateVapidKeyPair()
    const env: Bindings = { ...baseEnv(), VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }
    const posted: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      'fetch',
      async (url: string, init: RequestInit) => {
        posted.push({ url, init })
        return new Response(null, { status: 201 })
      },
    )
    try {
      // far in the future so Math.max(Date.now(), scheduledTime) picks the scheduled time
      const scheduledTime = at('09:00', '2090-01-01')
      await (app as unknown as { scheduled: (c: { scheduledTime: number }, e: Bindings) => Promise<void> }).scheduled(
        { scheduledTime },
        env,
      )
    } finally {
      vi.unstubAllGlobals()
    }

    expect(posted).toHaveLength(1)
    expect(posted[0].url).toBe('https://updates.push.services.mozilla.com/wpush/v2/e2e')
    const headers = new Headers(posted[0].init.headers)
    expect(headers.get('ttl')).toBe('600')
    expect(headers.get('urgency')).toBe('high')
    expect(headers.get('content-encoding')).toBe('aes128gcm')
    expect(headers.get('authorization')).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${keys.publicKey}$`))

    // decrypt like the browser would
    const body = posted[0].init.body as Uint8Array
    const asPublic = body.slice(21, 86)
    const asKey = await crypto.subtle.importKey('raw', asPublic as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, pair.privateKey, 256))
    const { cek, nonce } = await deriveContentKeys(ecdh, authSecret, ua, asPublic, body.slice(0, 16))
    const aes = await crypto.subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt'])
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource, tagLength: 128 }, aes, body.slice(86) as BufferSource),
    )
    expect(plain[plain.length - 1]).toBe(0x02)
    expect(JSON.parse(new TextDecoder().decode(plain.slice(0, -1)))).toEqual({
      title: 'ถึงเวลาลง ฮานอยปกติ',
      body: 'แตะเพื่อเปิดหวยนี้',
      lotteryIds: ['hanoi-regular'],
      url: 'https://pnphoto.co/?lottery=hanoi-regular',
    })
    expect(await readCursor()).toBe('2090-01-01T09:00')
  })
})
