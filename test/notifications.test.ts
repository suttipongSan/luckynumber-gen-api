// HTTP tests for the daily-reminder endpoints: GET/PUT /notifications (member), the admin defaults
// (GET/POST/PATCH /admin/lotteries and PUT /admin/notifications), GET /push/key and
// POST/DELETE /push/subscribe. Real libSQL file DB with the project's migrations.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { and, eq, inArray } from 'drizzle-orm'
import app from '../src/index'
import type { AdminLottery, AdminMember, AssetBucket, Bindings, Lottery, NotificationItem } from '../src/types'
import { MAX_NOTIFICATION_ITEMS, MAX_PUSH_DEVICES } from '../src/types'
import { hashPassword } from '../src/lib/crypto'
import { bytesToBase64Url } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import { LOTTERY_CATALOG } from '../src/db/catalog'
import { generateVapidKeyPair } from '../src/lib/webpush'
import {
  lotteries,
  memberNotifications,
  memberSessions,
  members,
  pushSubscriptions,
} from '../src/db/schema'

const DB_FILE = 'test-notify.db'
const DB_URL = `file:${DB_FILE}`

const fakeBucket: AssetBucket = {
  async put() {
    return {}
  },
  async get() {
    return null
  },
  async delete() {},
}

let env: Bindings
let vapidEnv: Bindings

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

beforeAll(async () => {
  removeDb()
  await runMigrations(DB_URL)
  const { client, db } = openDb(DB_URL)
  await db.insert(lotteries).values(
    LOTTERY_CATALOG.map((l) => ({
      id: l.id,
      name: l.name,
      shortName: l.shortName,
      groupKey: l.group,
      accent: l.accent,
      sortOrder: l.sortOrder,
      active: l.active,
    })),
  )
  client.close()
  env = {
    TURSO_DATABASE_URL: DB_URL,
    TURSO_AUTH_TOKEN: '',
    SESSION_SECRET: 'test-session-secret',
    ASSET_SIGNING_SECRET: 'test-asset-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: await hashPassword('admin1234', 1000),
    WEB_URL: 'http://localhost:5173',
    COOKIE_SECURE: 'false',
    ASSETS: fakeBucket,
  }
  const keys = await generateVapidKeyPair()
  vapidEnv = { ...env, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }
})

beforeEach(async () => {
  await resetLimiter(getDb(env))
})

afterAll(() => {
  try {
    removeDb()
  } catch {
    // file may still be held open on Windows; harmless
  }
})

// ---- helpers -------------------------------------------------------------------------------------

function call(method: string, path: string, cookie?: string, body?: unknown, e: Bindings = env) {
  const headers = new Headers()
  if (cookie) headers.set('Cookie', cookie)
  let payload: string | undefined
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body)
    headers.set('Content-Type', 'application/json')
  }
  return app.request(path, { method, headers, body: payload }, e)
}

function cookieFrom(res: Response, name: string): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = raw.match(new RegExp(`${name}=([^;]*)`))
  if (!m) throw new Error(`no ${name} cookie in: ${raw}`)
  return `${name}=${m[1]}`
}

async function adminCookie(): Promise<string> {
  const res = await call('POST', '/admin/login', undefined, { username: 'admin', password: 'admin1234' })
  expect(res.status).toBe(204)
  return cookieFrom(res, 'ng_admin')
}

/** Creates a member through the back office and claims the link. */
async function newMember(admin: string, name = 'ทดสอบ') {
  const res = await call('POST', '/admin/members', admin, {
    displayName: name,
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  })
  const m = (await res.json()) as AdminMember
  const sp = await call('POST', `/link/${m.linkToken}/set-password`, undefined, { password: 'password-123' })
  expect(sp.status).toBe(204)
  return { id: m.id, token: m.linkToken, cookie: cookieFrom(sp, 'ng_session') }
}

const getItems = async (cookie: string): Promise<NotificationItem[]> => {
  const res = await call('GET', '/notifications', cookie)
  expect(res.status).toBe(200)
  return ((await res.json()) as { items: NotificationItem[] }).items
}

const byId = (items: NotificationItem[], id: string) => items.find((i) => i.lotteryId === id)!

const line = (lotteryId: string, notifyTime: string | null, enabled: boolean) => ({ lotteryId, notifyTime, enabled })

async function setDefaults(admin: string, lines: ReturnType<typeof line>[]) {
  const res = await call('PUT', '/admin/notifications', admin, { items: lines })
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
}

async function addPrivate(cookie: string, name: string, group = 'other'): Promise<Lottery> {
  const res = await call('POST', '/lotteries', cookie, { name, group })
  expect(res.status).toBe(200)
  return (await res.json()) as Lottery
}

/** A real P-256 point and a 16 byte secret, base64url like PushSubscription.toJSON() gives them. */
async function newKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return {
    p256dh: bytesToBase64Url(publicRaw),
    auth: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
  }
}

let counter = 0
const fcm = (tag = `dev${++counter}`) => `https://fcm.googleapis.com/fcm/send/${tag}:APA91b${'x'.repeat(40)}`

async function subscribe(cookie: string, endpoint: string, keys?: { p256dh: string; auth: string }) {
  return call('POST', '/push/subscribe', cookie, { endpoint, keys: keys ?? (await newKeys()) })
}

const rowsFor = async (memberId: string) =>
  getDb(env).select().from(pushSubscriptions).where(eq(pushSubscriptions.memberId, memberId))

// ---- GET /push/key -------------------------------------------------------------------------------

describe('GET /push/key', () => {
  it('503 until the VAPID keys are configured (no auth needed either way)', async () => {
    const res = await call('GET', '/push/key')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('PUSH_DISABLED')
    expect(body.error.message).toEqual(expect.any(String))
    // a half configuration is not configured
    const half = await call('GET', '/push/key', undefined, undefined, { ...env, VAPID_PUBLIC_KEY: vapidEnv.VAPID_PUBLIC_KEY })
    expect(half.status).toBe(503)
    const junk = await call('GET', '/push/key', undefined, undefined, {
      ...env,
      VAPID_PUBLIC_KEY: 'AAAA',
      VAPID_PRIVATE_KEY: 'BBBB',
    })
    expect(junk.status).toBe(503)
  })

  it('200 with the base64url public key, and never the private one', async () => {
    const res = await call('GET', '/push/key', undefined, undefined, vapidEnv)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ publicKey: vapidEnv.VAPID_PUBLIC_KEY })
    expect(text).not.toContain(vapidEnv.VAPID_PRIVATE_KEY!)
  })
})

// ---- auth gates ----------------------------------------------------------------------------------

describe('auth gates', () => {
  const memberRoutes: [string, string, unknown?][] = [
    ['GET', '/notifications'],
    ['PUT', '/notifications', { items: [] }],
    ['POST', '/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'x', auth: 'y' } }],
    ['DELETE', '/push/subscribe', { endpoint: 'https://fcm.googleapis.com/fcm/send/x' }],
  ]

  it('member routes: 401 without a session, 403 EXPIRED / DISABLED for inactive members', async () => {
    for (const [method, path, body] of memberRoutes) {
      const res = await call(method, path, undefined, body)
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    }
    const admin = await adminCookie()
    const m = await newMember(admin, 'gate')
    const patch = (b: unknown) => call('PATCH', `/admin/members/${m.id}`, admin, b)

    await patch({ disabled: true })
    for (const [method, path, body] of memberRoutes) {
      const res = await call(method, path, m.cookie, body)
      expect(res.status, `disabled ${method} ${path}`).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'DISABLED' } })
    }
    await patch({ disabled: false, expiresAt: new Date(Date.now() - 1000).toISOString() })
    for (const [method, path, body] of memberRoutes) {
      const res = await call(method, path, m.cookie, body)
      expect(res.status, `expired ${method} ${path}`).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'EXPIRED' } })
    }
    // nothing was written on their behalf, and the public key stays reachable
    expect(await rowsFor(m.id)).toHaveLength(0)
    expect((await call('GET', '/push/key', m.cookie, undefined, vapidEnv)).status).toBe(200)
    // renewal restores access within the same session
    await patch({ expiresAt: new Date(Date.now() + 86400_000).toISOString() })
    expect((await call('GET', '/notifications', m.cookie)).status).toBe(200)
  })

  it('PUT /admin/notifications needs the admin session; a member session is not enough', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'not-admin')
    const body = { items: [line('hanoi-regular', '09:00', true)] }
    expect((await call('PUT', '/admin/notifications', undefined, body)).status).toBe(401)
    expect((await call('PUT', '/admin/notifications', m.cookie, body)).status).toBe(401)
    // an admin cookie is not accepted as a member session either
    expect((await call('GET', '/notifications', admin.replace('ng_admin', 'ng_session'))).status).toBe(401)
    expect((await call('GET', '/notifications', admin)).status).toBe(401)
    // and a foreign Origin cannot ride the cookie
    const forged = await app.request(
      '/admin/notifications',
      {
        method: 'PUT',
        headers: { Cookie: admin, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify(body),
      },
      env,
    )
    expect(forged.status).toBe(403)
    const forgedDelete = await app.request(
      '/push/subscribe',
      {
        method: 'DELETE',
        headers: { Cookie: m.cookie, 'Content-Type': 'application/json', Origin: 'https://evil.example' },
        body: JSON.stringify({ endpoint: fcm() }),
      },
      env,
    )
    expect(forgedDelete.status).toBe(403)
  })
})

// ---- GET /notifications --------------------------------------------------------------------------

describe('GET /notifications', () => {
  it('lists the lotteries of GET /lotteries, in the same order, with the documented fields', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'list')
    await addPrivate(m.cookie, 'หวยของฉัน ก', 'hanoi')
    await addPrivate(m.cookie, 'หวยของฉัน ข', 'stock')
    const lots = (await (await call('GET', '/lotteries', m.cookie)).json()) as Lottery[]
    const items = await getItems(m.cookie)
    expect(items.map((i) => i.lotteryId)).toEqual(lots.map((l) => l.id))
    expect(items.length).toBe(LOTTERY_CATALOG.length + 2)
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['enabled', 'groupKey', 'lotteryId', 'name', 'notifyTime', 'own', 'saved'])
    }
    const first = items[0]
    const lot = lots[0]
    expect(first).toEqual({
      lotteryId: lot.id,
      name: lot.name,
      groupKey: lot.group,
      own: false,
      notifyTime: null,
      enabled: false,
      saved: false,
    })
    // private lotteries: own, no admin default, not saved
    const mine = items.filter((i) => i.own)
    expect(mine.map((i) => i.name).sort()).toEqual(['หวยของฉัน ก', 'หวยของฉัน ข'])
    for (const i of mine) expect(i).toMatchObject({ notifyTime: null, enabled: false, saved: false })
    expect(items.filter((i) => !i.own)).toHaveLength(LOTTERY_CATALOG.length)
  })

  it('shows the admin default until the member saves, then the member\'s own values', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'defaults')
    await setDefaults(admin, [line('hanoi-regular', '09:30', true), line('hanoi-vip', '10:00', false)])

    let items = await getItems(m.cookie)
    expect(byId(items, 'hanoi-regular')).toMatchObject({ notifyTime: '09:30', enabled: true, saved: false })
    expect(byId(items, 'hanoi-vip')).toMatchObject({ notifyTime: '10:00', enabled: false, saved: false })
    expect(byId(items, 'hanoi-special')).toMatchObject({ notifyTime: null, enabled: false, saved: false })

    // the member overrides one line
    const put = await call('PUT', '/notifications', m.cookie, { items: [line('hanoi-regular', '21:15', true)] })
    expect(put.status).toBe(200)
    items = await getItems(m.cookie)
    expect(byId(items, 'hanoi-regular')).toMatchObject({ notifyTime: '21:15', enabled: true, saved: true })
    // the others still follow the default
    expect(byId(items, 'hanoi-vip')).toMatchObject({ notifyTime: '10:00', enabled: false, saved: false })

    // the admin changes the default: the saved line keeps the member's value, the rest follow
    await setDefaults(admin, [line('hanoi-regular', '07:00', true), line('hanoi-vip', '11:00', true)])
    items = await getItems(m.cookie)
    expect(byId(items, 'hanoi-regular')).toMatchObject({ notifyTime: '21:15', enabled: true, saved: true })
    expect(byId(items, 'hanoi-vip')).toMatchObject({ notifyTime: '11:00', enabled: true, saved: false })

    // another member is unaffected by the first one's lines
    const other = await newMember(admin, 'defaults-2')
    expect(byId(await getItems(other.cookie), 'hanoi-regular')).toMatchObject({
      notifyTime: '07:00',
      enabled: true,
      saved: false,
    })
    await setDefaults(admin, [line('hanoi-regular', null, false), line('hanoi-vip', null, false)])
  })

  it('hides inactive catalog lotteries and other members\' private lotteries', async () => {
    const admin = await adminCookie()
    const a = await newMember(admin, 'vis-a')
    const b = await newMember(admin, 'vis-b')
    const privA = await addPrivate(a.cookie, 'ส่วนตัวของ A')
    const privB = await addPrivate(b.cookie, 'ส่วนตัวของ B')
    await call('PATCH', '/admin/lotteries/malaysia', admin, { active: false })
    try {
      const forA = await getItems(a.cookie)
      expect(forA.map((i) => i.lotteryId)).toContain(privA.id)
      expect(forA.map((i) => i.lotteryId)).not.toContain(privB.id)
      expect(forA.map((i) => i.lotteryId)).not.toContain('malaysia')
      const forB = await getItems(b.cookie)
      expect(forB.map((i) => i.lotteryId)).toContain(privB.id)
      expect(forB.map((i) => i.lotteryId)).not.toContain(privA.id)
    } finally {
      await call('PATCH', '/admin/lotteries/malaysia', admin, { active: true })
    }
  })

  it('a stray admin default of "on without a time" is shown as off', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'stray')
    await getDb(env).update(lotteries).set({ notifyEnabled: true, notifyTime: null }).where(eq(lotteries.id, 'cambodia'))
    try {
      expect(byId(await getItems(m.cookie), 'cambodia')).toMatchObject({ notifyTime: null, enabled: false })
    } finally {
      await getDb(env).update(lotteries).set({ notifyEnabled: false }).where(eq(lotteries.id, 'cambodia'))
    }
  })

  it('does not change the member lottery shape', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'shape')
    const lots = (await (await call('GET', '/lotteries', m.cookie)).json()) as Record<string, unknown>[]
    expect(Object.keys(lots[0]).sort()).toEqual(['accent', 'active', 'custom', 'group', 'id', 'name', 'shortName', 'sortOrder'])
    const boot = (await (await call('GET', '/bootstrap', m.cookie)).json()) as { lotteries: Record<string, unknown>[] }
    expect(Object.keys(boot.lotteries[0]).sort()).toEqual(Object.keys(lots[0]).sort())
  })
})

// ---- PUT /notifications --------------------------------------------------------------------------

describe('PUT /notifications', () => {
  it('stores every line as the member\'s own, replaces earlier values, leaves unlisted lines alone', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'put')
    const priv = await addPrivate(m.cookie, 'ส่วนตัว')

    const first = await call('PUT', '/notifications', m.cookie, {
      items: [line('hanoi-regular', '09:00', true), line('hanoi-vip', '09:05', false), line(priv.id, '23:59', true)],
    })
    expect(first.status).toBe(200)
    const body = (await first.json()) as { items: NotificationItem[] }
    expect(body.items).toEqual(await getItems(m.cookie)) // same shape and content as GET
    expect(byId(body.items, 'hanoi-regular')).toMatchObject({ notifyTime: '09:00', enabled: true, saved: true })
    expect(byId(body.items, 'hanoi-vip')).toMatchObject({ notifyTime: '09:05', enabled: false, saved: true })
    expect(byId(body.items, priv.id)).toMatchObject({ own: true, notifyTime: '23:59', enabled: true, saved: true })
    expect(body.items.filter((i) => i.saved)).toHaveLength(3)

    // a second save replaces the values of the lines it lists, and only those
    const second = await call('PUT', '/notifications', m.cookie, {
      items: [line('hanoi-regular', '00:00', false), line('hanoi-vip', null, false)],
    })
    const items = ((await second.json()) as { items: NotificationItem[] }).items
    expect(byId(items, 'hanoi-regular')).toMatchObject({ notifyTime: '00:00', enabled: false, saved: true })
    expect(byId(items, 'hanoi-vip')).toMatchObject({ notifyTime: null, enabled: false, saved: true })
    expect(byId(items, priv.id)).toMatchObject({ notifyTime: '23:59', enabled: true, saved: true })
    const rows = await getDb(env).select().from(memberNotifications).where(eq(memberNotifications.memberId, m.id))
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.updatedAt && r.lastSentDay === null)).toBe(true)
  })

  it('saving the whole list works (several insert chunks) and saving it again adds no rows', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'all')
    await addPrivate(m.cookie, 'ส่วนตัวหนึ่ง')
    const items = await getItems(m.cookie)
    expect(items.length).toBeGreaterThan(80)
    const lines = items.map((i, n) => line(i.lotteryId, `${String(n % 24).padStart(2, '0')}:${String((n * 7) % 60).padStart(2, '0')}`, n % 2 === 0))
    const put = await call('PUT', '/notifications', m.cookie, { items: lines })
    expect(put.status).toBe(200)
    const saved = ((await put.json()) as { items: NotificationItem[] }).items
    expect(saved.map((i) => i.lotteryId)).toEqual(items.map((i) => i.lotteryId))
    expect(saved.every((i) => i.saved)).toBe(true)
    lines.forEach((l, n) => {
      expect(saved[n]).toMatchObject({ notifyTime: l.notifyTime, enabled: l.enabled })
    })
    await call('PUT', '/notifications', m.cookie, { items: lines.map((l) => ({ ...l, enabled: !l.enabled })) })
    const rows = await getDb(env).select().from(memberNotifications).where(eq(memberNotifications.memberId, m.id))
    expect(rows).toHaveLength(items.length)
    expect(rows.filter((r) => r.enabled)).toHaveLength(lines.filter((l) => !l.enabled).length)
  })

  it('accepts an empty list and an off line without a time', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'empty')
    const empty = await call('PUT', '/notifications', m.cookie, { items: [] })
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as { items: NotificationItem[] }).items.every((i) => !i.saved)).toBe(true)
    const off = await call('PUT', '/notifications', m.cookie, { items: [line('hanoi-regular', null, false)] })
    expect(off.status).toBe(200)
    expect(byId(((await off.json()) as { items: NotificationItem[] }).items, 'hanoi-regular')).toMatchObject({
      notifyTime: null,
      enabled: false,
      saved: true,
    })
  })

  it('an off line overrides an admin default that is on (that is why every line is stored)', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'override-off')
    await setDefaults(admin, [line('vietnam', '08:00', true)])
    try {
      expect(byId(await getItems(m.cookie), 'vietnam')).toMatchObject({ enabled: true, saved: false })
      await call('PUT', '/notifications', m.cookie, { items: [line('vietnam', '08:00', false)] })
      expect(byId(await getItems(m.cookie), 'vietnam')).toMatchObject({ notifyTime: '08:00', enabled: false, saved: true })
    } finally {
      await setDefaults(admin, [line('vietnam', null, false)])
    }
  })

  describe('validation', () => {
    const put = async (cookie: string, body: unknown) => call('PUT', '/notifications', cookie, body)

    async function assertRejected(cookie: string, memberId: string, body: unknown, what: string) {
      const res = await put(cookie, body)
      expect(res.status, what).toBe(400)
      expect(await res.json(), what).toMatchObject({ error: { code: 'VALIDATION', message: expect.any(String) } })
      const rows = await getDb(env).select().from(memberNotifications).where(eq(memberNotifications.memberId, memberId))
      expect(rows, `${what}: nothing is written`).toHaveLength(0)
    }

    it('rejects malformed bodies and bad times, writing nothing', async () => {
      const admin = await adminCookie()
      const m = await newMember(admin, 'val')
      await assertRejected(m.cookie, m.id, 'not json', 'not JSON')
      await assertRejected(m.cookie, m.id, {}, 'no items')
      await assertRejected(m.cookie, m.id, { items: 'x' }, 'items not an array')
      await assertRejected(m.cookie, m.id, { items: [{ lotteryId: 'hanoi-regular', notifyTime: '09:00' }] }, 'enabled missing')
      await assertRejected(m.cookie, m.id, { items: [{ lotteryId: 'hanoi-regular', enabled: false }] }, 'notifyTime missing')
      await assertRejected(m.cookie, m.id, { items: [{ notifyTime: '09:00', enabled: true }] }, 'lotteryId missing')
      await assertRejected(m.cookie, m.id, { items: [{ lotteryId: 'hanoi-regular', notifyTime: '09:00', enabled: 'yes' }] }, 'enabled not boolean')
      for (const bad of ['9:00', '09:0', '9:5', '24:00', '25:00', '12:60', '09:00:00', ' 09:00', '09:00 ', '0900', '09-00', 'ab:cd', '', '٠٩:٠٠', '09:00\n']) {
        await assertRejected(m.cookie, m.id, { items: [line('hanoi-regular', bad, false)] }, `time ${JSON.stringify(bad)}`)
      }
      await assertRejected(m.cookie, m.id, { items: [{ lotteryId: 'hanoi-regular', notifyTime: 900, enabled: false }] }, 'time number')
    })

    it('enabled with no time is a 400, and so is the same lottery twice', async () => {
      const admin = await adminCookie()
      const m = await newMember(admin, 'val-2')
      await assertRejected(m.cookie, m.id, { items: [line('hanoi-regular', null, true)] }, 'enabled without time')
      await assertRejected(
        m.cookie,
        m.id,
        { items: [line('hanoi-vip', '09:00', true), line('hanoi-regular', null, true)] },
        'one bad line rejects the whole save',
      )
      await assertRejected(
        m.cookie,
        m.id,
        { items: [line('hanoi-regular', '09:00', true), line('hanoi-regular', '10:00', true)] },
        'duplicate lottery',
      )
    })

    it(`bounds the number of lines (${MAX_NOTIFICATION_ITEMS})`, async () => {
      const admin = await adminCookie()
      const m = await newMember(admin, 'val-max')
      const tooMany = Array.from({ length: MAX_NOTIFICATION_ITEMS + 1 }, (_, i) => line(`id-${i}`, '09:00', true))
      await assertRejected(m.cookie, m.id, { items: tooMany }, 'too many lines')
      const oversizedId = 'x'.repeat(65)
      await assertRejected(m.cookie, m.id, { items: [line(oversizedId, '09:00', true)] }, 'lotteryId too long')
    })

    it('a malformed line still rejects the whole save, even next to lines of lotteries that are gone', async () => {
      const admin = await adminCookie()
      const m = await newMember(admin, 'val-mixed')
      await assertRejected(
        m.cookie,
        m.id,
        { items: [line('hanoi-regular', '09:00', true), line('no-such-lottery', '09:00', true), line('hanoi-vip', null, true)] },
        'enabled without time',
      )
    })
  })

  // A lottery can disappear from the member's list while /notifications is open (the admin switches
  // it off, the member deletes their own on another device). Such lines are skipped; the rest of
  // the save goes through and the answer is the refreshed list.
  describe('lines of lotteries the member cannot see', () => {
    const put = (cookie: string, body: unknown) => call('PUT', '/notifications', cookie, body)
    const itemsOf = async (res: Response) => ((await res.json()) as { items: NotificationItem[] }).items
    const rowsOf = (memberId: string) =>
      getDb(env).select().from(memberNotifications).where(eq(memberNotifications.memberId, memberId))

    it('skips unknown, inactive and other members\' private lotteries and saves the rest', async () => {
      const admin = await adminCookie()
      const a = await newMember(admin, 'skip-a')
      const b = await newMember(admin, 'skip-b')
      const privB = await addPrivate(b.cookie, 'ของ B')
      await call('PATCH', '/admin/lotteries/indonesia', admin, { active: false })
      try {
        const res = await put(a.cookie, {
          items: [
            line('hanoi-regular', '09:00', true),
            line('no-such-lottery', '09:05', true),
            line(privB.id, '09:10', true),
            line('indonesia', '09:15', true),
            line('hanoi-vip', '09:20', false),
          ],
        })
        expect(res.status).toBe(200)
        const items = await itemsOf(res)
        expect(items).toEqual(await getItems(a.cookie)) // answers like GET: what A can see
        const ids = items.map((i) => i.lotteryId)
        for (const skipped of ['no-such-lottery', privB.id, 'indonesia']) expect(ids).not.toContain(skipped)
        expect(items.filter((i) => i.saved).map((i) => i.lotteryId).sort()).toEqual(['hanoi-regular', 'hanoi-vip'])
        expect(byId(items, 'hanoi-regular')).toMatchObject({ notifyTime: '09:00', enabled: true, saved: true })
        expect(byId(items, 'hanoi-vip')).toMatchObject({ notifyTime: '09:20', enabled: false, saved: true })
        // A has a row for the two lotteries they can see and none for the other three ...
        expect((await rowsOf(a.id)).map((r) => r.lotteryId).sort()).toEqual(['hanoi-regular', 'hanoi-vip'])
        // ... and nothing was written for B's private lottery or the unknown id on anyone's behalf
        const stray = await getDb(env)
          .select()
          .from(memberNotifications)
          .where(inArray(memberNotifications.lotteryId, ['no-such-lottery', privB.id]))
        expect(stray).toHaveLength(0)
      } finally {
        await call('PATCH', '/admin/lotteries/indonesia', admin, { active: true })
      }
      // the owner can still use their own private lottery
      expect((await put(b.cookie, { items: [line(privB.id, '09:00', true)] })).status).toBe(200)
    })

    it('a save in which no line is visible is a 200 that stores nothing', async () => {
      const admin = await adminCookie()
      const m = await newMember(admin, 'skip-all')
      const before = await getItems(m.cookie)
      const res = await put(m.cookie, { items: [line('no-such-lottery', '09:00', true), line('another-one', null, false)] })
      expect(res.status).toBe(200)
      expect(await itemsOf(res)).toEqual(before)
      expect(await rowsOf(m.id)).toHaveLength(0)
    })

    it('a lottery that vanishes while the list is open does not block the save', async () => {
      const admin = await adminCookie()
      const m = await newMember(admin, 'vanish')
      const gone = await addPrivate(m.cookie, 'จะหายไป')
      const stays = await addPrivate(m.cookie, 'อยู่ต่อ')
      // what the page loaded
      const opened = await getItems(m.cookie)
      expect(opened.map((i) => i.lotteryId)).toEqual(expect.arrayContaining(['malaysia', gone.id, stays.id]))

      // meanwhile the admin switches a catalog lottery off and the member deletes a private one
      await call('PATCH', '/admin/lotteries/malaysia', admin, { active: false })
      try {
        expect((await call('DELETE', `/lotteries/${gone.id}`, m.cookie)).status).toBe(204)

        // Save: the page sends the whole list it loaded, with two edits
        const edit: Record<string, ReturnType<typeof line>> = {
          'hanoi-regular': line('hanoi-regular', '21:15', true),
          [stays.id]: line(stays.id, '06:30', true),
        }
        const res = await put(m.cookie, {
          items: opened.map((i) => edit[i.lotteryId] ?? line(i.lotteryId, i.notifyTime, i.enabled)),
        })
        expect(res.status).toBe(200)
        const saved = await itemsOf(res)
        expect(saved).toEqual(await getItems(m.cookie))
        expect(saved.map((i) => i.lotteryId)).toEqual(
          opened.map((i) => i.lotteryId).filter((id) => id !== 'malaysia' && id !== gone.id),
        )
        expect(saved.every((i) => i.saved)).toBe(true)
        expect(byId(saved, 'hanoi-regular')).toMatchObject({ notifyTime: '21:15', enabled: true })
        expect(byId(saved, stays.id)).toMatchObject({ own: true, notifyTime: '06:30', enabled: true })
        const rows = await rowsOf(m.id)
        expect(rows).toHaveLength(opened.length - 2)
        expect(rows.map((r) => r.lotteryId)).not.toContain('malaysia')
        expect(rows.map((r) => r.lotteryId)).not.toContain(gone.id)
      } finally {
        await call('PATCH', '/admin/lotteries/malaysia', admin, { active: true })
      }
      // switched on again, the lottery the member never saved follows the admin default again
      expect(byId(await getItems(m.cookie), 'malaysia')).toMatchObject({ saved: false })
    })

    it('a lottery deleted after the check but before the write is skipped too, not a 500', async () => {
      const admin = await adminCookie()
      const m = await newMember(admin, 'race')
      const gone = await addPrivate(m.cookie, 'ถูกลบกลางทาง')
      const db = getDb(env)
      const realBatch = db.batch.bind(db) as (...args: unknown[]) => Promise<unknown>
      let calls = 0
      const spy = vi.spyOn(db, 'batch').mockImplementation(((...args: unknown[]) => {
        calls++
        if (calls > 1) return realBatch(...args)
        // the first write: the member deletes the lottery elsewhere just before it, so the
        // FOREIGN KEY fails and the whole batch rolls back
        return db
          .delete(lotteries)
          .where(eq(lotteries.id, gone.id))
          .then(() => realBatch(...args))
      }) as never)
      try {
        const res = await put(m.cookie, { items: [line('hanoi-regular', '09:00', true), line(gone.id, '10:00', true)] })
        expect(res.status).toBe(200)
        expect(calls).toBe(2) // the attempt that failed, then the save without the lottery
        const items = await itemsOf(res)
        expect(items).toEqual(await getItems(m.cookie))
        expect(items.map((i) => i.lotteryId)).not.toContain(gone.id)
        expect(byId(items, 'hanoi-regular')).toMatchObject({ notifyTime: '09:00', enabled: true, saved: true })
        expect((await rowsOf(m.id)).map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
      } finally {
        spy.mockRestore()
      }
    })

    it('a write that fails for another reason is still an error, and stores nothing', async () => {
      const admin = await adminCookie()
      const m = await newMember(admin, 'write-fails')
      const db = getDb(env)
      const spy = vi.spyOn(db, 'batch').mockRejectedValueOnce(new Error('database unavailable'))
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const res = await put(m.cookie, { items: [line('hanoi-regular', '09:00', true)] })
        expect(res.status).toBe(500)
        expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL' } })
        expect(spy).toHaveBeenCalledTimes(1) // nothing vanished, so there is no second attempt
        expect(await rowsOf(m.id)).toHaveLength(0)
      } finally {
        spy.mockRestore()
        logged.mockRestore()
      }
    })
  })

  it('a lottery deleted by its owner leaves no reminder line behind', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'del-own')
    const priv = await addPrivate(m.cookie, 'จะถูกลบ')
    await call('PUT', '/notifications', m.cookie, { items: [line(priv.id, '09:00', true), line('hanoi-regular', '09:00', true)] })
    expect((await call('DELETE', `/lotteries/${priv.id}`, m.cookie)).status).toBe(204)
    const rows = await getDb(env).select().from(memberNotifications).where(eq(memberNotifications.memberId, m.id))
    expect(rows.map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
    expect((await getItems(m.cookie)).map((i) => i.lotteryId)).not.toContain(priv.id)
  })
})

// ---- admin: defaults ----------------------------------------------------------------------------

describe('admin defaults', () => {
  it('GET /admin/lotteries returns notifyTime and notifyEnabled for every catalog lottery', async () => {
    const admin = await adminCookie()
    const list = (await (await call('GET', '/admin/lotteries', admin)).json()) as AdminLottery[]
    expect(list.length).toBeGreaterThanOrEqual(LOTTERY_CATALOG.length)
    for (const l of list) {
      expect(l).toHaveProperty('notifyTime')
      expect(l).toHaveProperty('notifyEnabled')
    }
    expect(list.find((l) => l.id === 'dow-jones')).toMatchObject({ notifyTime: null, notifyEnabled: false })
    await setDefaults(admin, [line('dow-jones', '04:30', true)])
    const after = (await (await call('GET', '/admin/lotteries', admin)).json()) as AdminLottery[]
    expect(after.find((l) => l.id === 'dow-jones')).toMatchObject({ notifyTime: '04:30', notifyEnabled: true })
    await setDefaults(admin, [line('dow-jones', null, false)])
  })

  it('PUT /admin/notifications sets, replaces and clears defaults; unlisted lotteries are untouched', async () => {
    const admin = await adminCookie()
    await setDefaults(admin, [line('lao-asean', '20:00', true), line('lao-victory', '20:30', false), line('lao-peace', '21:00', true)])
    const read = async () =>
      new Map(
        ((await (await call('GET', '/admin/lotteries', admin)).json()) as AdminLottery[]).map((l) => [l.id, l]),
      )
    let map = await read()
    expect(map.get('lao-asean')).toMatchObject({ notifyTime: '20:00', notifyEnabled: true })
    expect(map.get('lao-victory')).toMatchObject({ notifyTime: '20:30', notifyEnabled: false })
    expect(map.get('lao-peace')).toMatchObject({ notifyTime: '21:00', notifyEnabled: true })

    await setDefaults(admin, [line('lao-asean', '19:45', true), line('lao-victory', null, false)])
    map = await read()
    expect(map.get('lao-asean')).toMatchObject({ notifyTime: '19:45', notifyEnabled: true })
    expect(map.get('lao-victory')).toMatchObject({ notifyTime: null, notifyEnabled: false })
    expect(map.get('lao-peace')).toMatchObject({ notifyTime: '21:00', notifyEnabled: true }) // not in the second call

    await setDefaults(admin, [line('lao-asean', null, false), line('lao-peace', null, false)])
  })

  it('sets the whole catalog in one call (chunked updates) without touching other columns', async () => {
    const admin = await adminCookie()
    const before = (await (await call('GET', '/admin/lotteries', admin)).json()) as AdminLottery[]
    const lines = before.map((l, n) => line(l.id, `${String(n % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`, n % 3 !== 0))
    await setDefaults(admin, lines)
    const after = (await (await call('GET', '/admin/lotteries', admin)).json()) as AdminLottery[]
    expect(after).toHaveLength(before.length)
    after.forEach((l, n) => {
      expect(l).toMatchObject({ id: before[n].id, name: before[n].name, group: before[n].group, active: before[n].active })
      expect(l.notifyTime).toBe(lines[n].notifyTime)
      expect(l.notifyEnabled).toBe(lines[n].enabled)
    })
    await setDefaults(admin, before.map((l) => line(l.id, null, false)))
  })

  it('works on inactive lotteries too', async () => {
    const admin = await adminCookie()
    await call('PATCH', '/admin/lotteries/australia', admin, { active: false })
    try {
      await setDefaults(admin, [line('australia', '12:00', true)])
      const l = ((await (await call('GET', '/admin/lotteries', admin)).json()) as AdminLottery[]).find((x) => x.id === 'australia')
      expect(l).toMatchObject({ active: false, notifyTime: '12:00', notifyEnabled: true })
    } finally {
      await call('PATCH', '/admin/lotteries/australia', admin, { active: true })
      await setDefaults(admin, [line('australia', null, false)])
    }
  })

  it('rejects: on without a time, bad time, unknown id, a member\'s private lottery, duplicates, too many', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'admin-val')
    const priv = await addPrivate(m.cookie, 'ส่วนตัว')
    const put = (body: unknown) => call('PUT', '/admin/notifications', admin, body)
    for (const [what, body] of [
      ['not json', 'nope'],
      ['no items', {}],
      ['on without time', { items: [line('hanoi-regular', null, true)] }],
      ['bad time', { items: [line('hanoi-regular', '9:00', false)] }],
      ['unknown id', { items: [line('hanoi-regular', '09:00', true), line('nope', '09:00', true)] }],
      ['private lottery', { items: [line('hanoi-regular', '09:00', true), line(priv.id, '09:00', true)] }],
      ['duplicate', { items: [line('hanoi-regular', '09:00', true), line('hanoi-regular', '10:00', true)] }],
      ['too many', { items: Array.from({ length: MAX_NOTIFICATION_ITEMS + 1 }, (_, i) => line(`x${i}`, '09:00', true)) }],
    ] as [string, unknown][]) {
      const res = await put(body)
      expect(res.status, what).toBe(400)
      expect(await res.json(), what).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    // atomic: the valid line of the rejected requests was not applied; the private lottery is untouched
    const list = (await (await call('GET', '/admin/lotteries', admin)).json()) as AdminLottery[]
    expect(list.find((l) => l.id === 'hanoi-regular')).toMatchObject({ notifyTime: null, notifyEnabled: false })
    const row = await getDb(env).select().from(lotteries).where(eq(lotteries.id, priv.id))
    expect(row[0]).toMatchObject({ notifyTime: null, notifyEnabled: false })
  })

  describe('POST / PATCH /admin/lotteries', () => {
    const base = { name: 'หวยทดสอบ', shortName: 'ทดสอบ', group: 'other', accent: '#123456', sortOrder: 5, active: true }

    it('POST accepts optional notifyTime / notifyEnabled and defaults to off', async () => {
      const admin = await adminCookie()
      const plain = await call('POST', '/admin/lotteries', admin, base)
      expect(plain.status).toBe(200)
      expect(await plain.json()).toMatchObject({ name: 'หวยทดสอบ', notifyTime: null, notifyEnabled: false })

      const on = await call('POST', '/admin/lotteries', admin, { ...base, notifyTime: '09:15', notifyEnabled: true })
      expect(on.status).toBe(200)
      const created = (await on.json()) as AdminLottery
      expect(created).toMatchObject({ notifyTime: '09:15', notifyEnabled: true })
      const listed = ((await (await call('GET', '/admin/lotteries', admin)).json()) as AdminLottery[]).find((l) => l.id === created.id)
      expect(listed).toMatchObject({ notifyTime: '09:15', notifyEnabled: true })

      const timeOnly = await call('POST', '/admin/lotteries', admin, { ...base, notifyTime: '10:00' })
      expect(await timeOnly.json()).toMatchObject({ notifyTime: '10:00', notifyEnabled: false })

      for (const bad of [{ notifyEnabled: true }, { notifyEnabled: true, notifyTime: null }, { notifyTime: '9:15' }, { notifyEnabled: 'yes' }]) {
        expect((await call('POST', '/admin/lotteries', admin, { ...base, ...bad })).status, JSON.stringify(bad)).toBe(400)
      }
    })

    it('PATCH accepts notifyTime / notifyEnabled and validates the resulting state', async () => {
      const admin = await adminCookie()
      const created = (await (await call('POST', '/admin/lotteries', admin, base)).json()) as AdminLottery
      const patch = (b: unknown) => call('PATCH', `/admin/lotteries/${created.id}`, admin, b)

      const set = await patch({ notifyTime: '10:15', notifyEnabled: true })
      expect(set.status).toBe(200)
      expect(await set.json()).toMatchObject({ notifyTime: '10:15', notifyEnabled: true, name: 'หวยทดสอบ' })

      // other fields leave the reminder alone
      expect(await (await patch({ name: 'ชื่อใหม่' })).json()).toMatchObject({ name: 'ชื่อใหม่', notifyTime: '10:15', notifyEnabled: true })
      // the time can change while on
      expect(await (await patch({ notifyTime: '11:45' })).json()).toMatchObject({ notifyTime: '11:45', notifyEnabled: true })
      // clearing the time of a lottery that is on is refused, in either order of fields
      expect((await patch({ notifyTime: null })).status).toBe(400)
      expect((await patch({ notifyTime: null, notifyEnabled: true })).status).toBe(400)
      expect(await (await patch({})).json()).toMatchObject({ notifyTime: '11:45', notifyEnabled: true })
      // off first, then the time can go
      expect(await (await patch({ notifyEnabled: false })).json()).toMatchObject({ notifyTime: '11:45', notifyEnabled: false })
      expect(await (await patch({ notifyTime: null })).json()).toMatchObject({ notifyTime: null, notifyEnabled: false })
      // turning it on needs a time
      expect((await patch({ notifyEnabled: true })).status).toBe(400)
      expect(await (await patch({ notifyEnabled: true, notifyTime: '08:00' })).json()).toMatchObject({ notifyTime: '08:00', notifyEnabled: true })
      expect(await (await patch({ notifyTime: null, notifyEnabled: false })).json()).toMatchObject({ notifyTime: null, notifyEnabled: false })
      // bad values and unknown lotteries
      expect((await patch({ notifyTime: '24:00' })).status).toBe(400)
      expect((await patch({ notifyTime: '9:00' })).status).toBe(400)
      expect((await patch({ notifyEnabled: 'on' })).status).toBe(400)
      expect((await call('PATCH', '/admin/lotteries/does-not-exist', admin, { notifyTime: '09:00' })).status).toBe(404)
    })

    it('PATCH cannot reach a member\'s private lottery', async () => {
      const admin = await adminCookie()
      const m = await newMember(admin, 'patch-priv')
      const priv = await addPrivate(m.cookie, 'ส่วนตัว')
      const res = await call('PATCH', `/admin/lotteries/${priv.id}`, admin, { notifyTime: '09:00', notifyEnabled: true })
      expect(res.status).toBe(404)
      expect((await getDb(env).select().from(lotteries).where(eq(lotteries.id, priv.id)))[0]).toMatchObject({
        notifyTime: null,
        notifyEnabled: false,
      })
    })
  })
})

// ---- POST / DELETE /push/subscribe --------------------------------------------------------------

describe('POST /push/subscribe', () => {
  it('registers a device on each supported push service and stores canonical values', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'sub-ok')
    const endpoints = [
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAB',
      'https://autopush.push.services.mozilla.com/wpush/v2/zzz',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2f',
      'https://web.push.apple.com/QGx_Ao',
    ]
    for (const endpoint of endpoints) {
      const keys = await newKeys()
      const res = await subscribe(m.cookie, endpoint, keys)
      expect(res.status, endpoint).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }
    const rows = await rowsFor(m.id)
    expect(rows.map((r) => r.endpoint).sort()).toEqual(endpoints.map((e) => new URL(e).href).sort())
    for (const r of rows) {
      expect(r.id).toMatch(/^[0-9A-Za-z]{16}$/)
      expect(r.p256dh).toMatch(/^[A-Za-z0-9_-]{87}$/)
      expect(r.auth).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(r.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('refuses anything that is not an https URL of a known push service', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'sub-host')
    for (const endpoint of [
      'http://fcm.googleapis.com/fcm/send/x',
      'https://example.com/push',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/push',
      'https://fcm.googleapis.com.evil.example/fcm/send/x',
      'https://evilfcm.googleapis.com/x',
      'https://fcm.googleapis.com@evil.example/x',
      'https://evil.example\\@fcm.googleapis.com/x',
      'https://user:pass@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://notify.windows.com/x',
      'https://xpush.apple.com/x',
      'javascript:alert(1)',
      'ftp://fcm.googleapis.com/x',
      `https://fcm.googleapis.com/${'a'.repeat(2100)}`,
      '',
    ]) {
      const res = await subscribe(m.cookie, endpoint)
      expect(res.status, endpoint.slice(0, 60)).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    expect(await rowsFor(m.id)).toHaveLength(0)
  })

  it('refuses keys of the wrong size or alphabet, or a point that is not on the curve', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'sub-keys')
    const good = await newKeys()
    const endpoint = fcm()
    const offCurve = new Uint8Array(65).fill(9)
    offCurve[0] = 0x04
    const cases: [string, unknown][] = [
      ['no keys', { endpoint }],
      ['keys not an object', { endpoint, keys: 'x' }],
      ['p256dh missing', { endpoint, keys: { auth: good.auth } }],
      ['auth missing', { endpoint, keys: { p256dh: good.p256dh } }],
      ['p256dh 64 bytes', { endpoint, keys: { p256dh: bytesToBase64Url(new Uint8Array(64).fill(4)), auth: good.auth } }],
      ['p256dh 33 bytes (compressed)', { endpoint, keys: { p256dh: bytesToBase64Url(new Uint8Array(33).fill(2)), auth: good.auth } }],
      ['p256dh wrong prefix', { endpoint, keys: { p256dh: bytesToBase64Url(new Uint8Array(65).fill(5)), auth: good.auth } }],
      ['p256dh standard base64', { endpoint, keys: { p256dh: good.p256dh.replace(/-/g, '+').replace(/_/g, '/') + '!!', auth: good.auth } }],
      ['p256dh not on the curve', { endpoint, keys: { p256dh: bytesToBase64Url(offCurve), auth: good.auth } }],
      ['auth 15 bytes', { endpoint, keys: { p256dh: good.p256dh, auth: bytesToBase64Url(new Uint8Array(15)) } }],
      ['auth 17 bytes', { endpoint, keys: { p256dh: good.p256dh, auth: bytesToBase64Url(new Uint8Array(17)) } }],
      ['auth empty', { endpoint, keys: { p256dh: good.p256dh, auth: '' } }],
      ['auth not base64url', { endpoint, keys: { p256dh: good.p256dh, auth: 'not base64url!!!!!!!!!!!' } }],
      ['keys as numbers', { endpoint, keys: { p256dh: 1, auth: 2 } }],
      ['not json', 'nope'],
    ]
    for (const [what, body] of cases) {
      const res = await call('POST', '/push/subscribe', m.cookie, body)
      expect(res.status, what).toBe(400)
      expect(await res.json(), what).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    expect(await rowsFor(m.id)).toHaveLength(0)
    // padding is tolerated and the stored form is canonical
    const padded = await subscribe(m.cookie, endpoint, { p256dh: `${good.p256dh}=`, auth: `${good.auth}==` })
    expect(padded.status).toBe(200)
    expect((await rowsFor(m.id))[0]).toMatchObject({ p256dh: good.p256dh, auth: good.auth })
  })

  it('registering the same endpoint again refreshes its keys without a second row', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'sub-again')
    const endpoint = fcm()
    await subscribe(m.cookie, endpoint)
    const [before] = await rowsFor(m.id)
    await new Promise((r) => setTimeout(r, 5))
    const fresh = await newKeys()
    expect((await subscribe(m.cookie, endpoint, fresh)).status).toBe(200)
    const rows = await rowsFor(m.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: before.id, endpoint: before.endpoint, p256dh: fresh.p256dh, auth: fresh.auth })
    expect(rows[0].createdAt > before.createdAt).toBe(true)
  })

  it('an endpoint registered to another member moves to the member who registers it now', async () => {
    const admin = await adminCookie()
    const a = await newMember(admin, 'sub-a')
    const b = await newMember(admin, 'sub-b')
    const shared = fcm('shared')
    await subscribe(a.cookie, shared)
    await subscribe(a.cookie, fcm())
    expect(await rowsFor(a.id)).toHaveLength(2)
    expect((await subscribe(b.cookie, shared)).status).toBe(200)
    expect((await rowsFor(a.id)).map((r) => r.endpoint)).not.toContain(new URL(shared).href)
    expect(await rowsFor(a.id)).toHaveLength(1)
    expect((await rowsFor(b.id)).map((r) => r.endpoint)).toEqual([new URL(shared).href])
    const all = await getDb(env).select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, new URL(shared).href))
    expect(all).toHaveLength(1)
  })

  it(`keeps at most ${MAX_PUSH_DEVICES} devices per member and drops the oldest`, async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'sub-cap')
    const other = await newMember(admin, 'sub-cap-other')
    await subscribe(other.cookie, fcm())
    const db = getDb(env)
    // ten devices registered a while ago, oldest first
    const old = Array.from({ length: MAX_PUSH_DEVICES }, (_, i) => ({
      id: `old-${m.id}-${i}`,
      memberId: m.id,
      endpoint: `https://fcm.googleapis.com/fcm/send/old-${m.id}-${i}`,
      p256dh: 'k',
      auth: 'a',
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    }))
    await db.insert(pushSubscriptions).values(old)

    // an eleventh drops the oldest one
    expect((await subscribe(m.cookie, fcm('eleventh'))).status).toBe(200)
    let rows = await rowsFor(m.id)
    expect(rows).toHaveLength(MAX_PUSH_DEVICES)
    expect(rows.map((r) => r.id)).not.toContain(old[0].id)
    expect(rows.map((r) => r.id)).toContain(old[1].id)
    expect(rows.map((r) => r.endpoint)).toContain(new URL(fcm('eleventh')).href)

    // another one drops the next oldest
    expect((await subscribe(m.cookie, fcm('twelfth'))).status).toBe(200)
    rows = await rowsFor(m.id)
    expect(rows).toHaveLength(MAX_PUSH_DEVICES)
    expect(rows.map((r) => r.id)).not.toContain(old[1].id)

    // re-registering a device that is already registered never evicts anyone
    const keep = rows.map((r) => r.id).sort()
    expect((await subscribe(m.cookie, old[5].endpoint)).status).toBe(200)
    rows = await rowsFor(m.id)
    expect(rows.map((r) => r.id).sort()).toEqual(keep)

    // the cap is per member
    expect(await rowsFor(other.id)).toHaveLength(1)
  })

  it('parallel registrations still end at the cap', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'sub-race')
    const keys = await Promise.all(Array.from({ length: 14 }, () => newKeys()))
    const results = await Promise.all(keys.map((k, i) => subscribe(m.cookie, fcm(`race${i}`), k)))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(await rowsFor(m.id)).toHaveLength(MAX_PUSH_DEVICES)
  })
})

describe('DELETE /push/subscribe', () => {
  it('removes the member\'s own device; other people\'s and unknown endpoints are a quiet no-op', async () => {
    const admin = await adminCookie()
    const a = await newMember(admin, 'unsub-a')
    const b = await newMember(admin, 'unsub-b')
    const mine = fcm('mine')
    const mine2 = fcm('mine2')
    const theirs = fcm('theirs')
    await subscribe(a.cookie, mine)
    await subscribe(a.cookie, mine2)
    await subscribe(b.cookie, theirs)

    const del = await call('DELETE', '/push/subscribe', a.cookie, { endpoint: mine })
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })
    expect((await rowsFor(a.id)).map((r) => r.endpoint)).toEqual([new URL(mine2).href])

    // b's device cannot be removed by a, and the answer does not reveal it exists
    const foreign = await call('DELETE', '/push/subscribe', a.cookie, { endpoint: theirs })
    expect(foreign.status).toBe(200)
    expect(await foreign.json()).toEqual({ ok: true })
    expect(await rowsFor(b.id)).toHaveLength(1)

    // unknown endpoint, including ones that could never be registered
    for (const endpoint of [fcm('never'), 'https://example.com/x', 'garbage']) {
      const res = await call('DELETE', '/push/subscribe', a.cookie, { endpoint })
      expect(res.status, endpoint).toBe(200)
    }
    expect(await rowsFor(a.id)).toHaveLength(1)

    // a second delete of the same device is fine too
    expect((await call('DELETE', '/push/subscribe', a.cookie, { endpoint: mine })).status).toBe(200)
  })

  it('needs an endpoint in the body', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'unsub-val')
    for (const body of [{}, { endpoint: '' }, { endpoint: 5 }, 'nope']) {
      expect((await call('DELETE', '/push/subscribe', m.cookie, body)).status, JSON.stringify(body)).toBe(400)
    }
    expect((await call('DELETE', '/push/subscribe', m.cookie)).status).toBe(400)
  })
})

// ---- deleting members and lotteries -------------------------------------------------------------

describe('deletes clean up reminder data', () => {
  it('deleting a member removes their lines, devices and private lotteries\' lines; others are untouched', async () => {
    const admin = await adminCookie()
    const a = await newMember(admin, 'del-a')
    const b = await newMember(admin, 'del-b')
    const privA = await addPrivate(a.cookie, 'ส่วนตัว A')
    await call('PUT', '/notifications', a.cookie, { items: [line('hanoi-regular', '09:00', true), line(privA.id, '10:00', true)] })
    await call('PUT', '/notifications', b.cookie, { items: [line('hanoi-regular', '11:00', true)] })
    await subscribe(a.cookie, fcm())
    await subscribe(a.cookie, fcm())
    await subscribe(b.cookie, fcm())
    // a corrupt line of b pointing at a's private lottery must not survive a's deletion either
    const db = getDb(env)
    await db.insert(memberNotifications).values({ memberId: b.id, lotteryId: privA.id, notifyTime: '12:00', enabled: true, updatedAt: new Date().toISOString() })

    expect((await call('DELETE', `/admin/members/${a.id}`, admin)).status).toBe(204)

    expect(await db.select().from(memberNotifications).where(eq(memberNotifications.memberId, a.id))).toHaveLength(0)
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.memberId, a.id))).toHaveLength(0)
    expect(await db.select().from(memberNotifications).where(eq(memberNotifications.lotteryId, privA.id))).toHaveLength(0)
    expect(await db.select().from(lotteries).where(eq(lotteries.ownerMemberId, a.id))).toHaveLength(0)
    expect(await db.select().from(memberNotifications).where(eq(memberNotifications.memberId, b.id))).toHaveLength(1)
    expect(await rowsFor(b.id)).toHaveLength(1)
    expect(await db.select().from(memberSessions).where(eq(memberSessions.memberId, a.id))).toHaveLength(0)
    expect(await db.select().from(members).where(inArray(members.id, [a.id]))).toHaveLength(0)
  })

  it('deleting a catalog lottery removes every member\'s line for it', async () => {
    const admin = await adminCookie()
    const created = (await (
      await call('POST', '/admin/lotteries', admin, {
        name: 'จะถูกลบ',
        shortName: 'ลบ',
        group: 'other',
        accent: '#000000',
        sortOrder: 1,
        active: true,
        notifyTime: '09:00',
        notifyEnabled: true,
      })
    ).json()) as AdminLottery
    const a = await newMember(admin, 'del-lot-a')
    const b = await newMember(admin, 'del-lot-b')
    await call('PUT', '/notifications', a.cookie, { items: [line(created.id, '10:00', true), line('hanoi-regular', '10:00', true)] })
    await call('PUT', '/notifications', b.cookie, { items: [line(created.id, '11:00', false)] })
    const db = getDb(env)
    expect(await db.select().from(memberNotifications).where(eq(memberNotifications.lotteryId, created.id))).toHaveLength(2)

    expect((await call('DELETE', `/admin/lotteries/${created.id}`, admin)).status).toBe(204)

    expect(await db.select().from(memberNotifications).where(eq(memberNotifications.lotteryId, created.id))).toHaveLength(0)
    const kept = await db
      .select()
      .from(memberNotifications)
      .where(and(eq(memberNotifications.memberId, a.id), eq(memberNotifications.lotteryId, 'hanoi-regular')))
    expect(kept).toHaveLength(1)
    expect((await getItems(a.cookie)).map((i) => i.lotteryId)).not.toContain(created.id)
  })
})
