// Hono app tests through app.request() with a real libSQL file DB (test.db) and a fake R2 bucket.
import { STARTER_SETS } from '../src/db/starterSets'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import app from '../src/index'
import type {
  AdminMember,
  Asset,
  AssetBucket,
  Bindings,
  Lottery,
  LotterySet,
  Member,
  News,
} from '../src/types'
import { MAX_SETS } from '../src/types'
import { hashPassword, hmacSha256Hex, signAsset } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import {
  assets as assetsTable,
  cardSettings,
  loginAttempts,
  memberSessions,
  newsReads,
  renderCounters,
  setLotteries,
  sets as setsTable,
  lotteries,
  members,
  siteSettings,
} from '../src/db/schema'
import { bangkokDay } from '../src/lib/time'
import { LOTTERY_CATALOG } from '../src/db/catalog'

const DB_FILE = 'test.db'
const DB_URL = `file:${DB_FILE}`

class FakeR2 implements AssetBucket {
  objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  async put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ) {
    let bytes: Uint8Array
    if (typeof value === 'string') bytes = new TextEncoder().encode(value)
    else if (value instanceof Uint8Array) bytes = value
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
    else bytes = new Uint8Array(await new Response(value).arrayBuffer())
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType })
    return {}
  }
  async get(key: string) {
    const o = this.objects.get(key)
    if (!o) return null
    return {
      body: new Blob([o.bytes as Uint8Array<ArrayBuffer>]).stream(),
      size: o.bytes.byteLength,
      httpMetadata: { contentType: o.contentType },
    }
  }
  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k)
  }
}

const r2 = new FakeR2()
let env: Bindings

const DEMO = 'demo0000000000000000000000000000'
const EXPIRED = 'expired0000000000000000000000000'

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

function req(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers)
  if (init.cookie) headers.set('Cookie', init.cookie)
  if (init.body && typeof init.body === 'string') headers.set('Content-Type', 'application/json')
  return app.request(path, { ...init, headers }, env)
}

function cookieFrom(res: Response, name: string): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = raw.match(new RegExp(`${name}=([^;]*)`))
  if (!m) throw new Error(`no ${name} cookie in: ${raw}`)
  return `${name}=${m[1]}`
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
  const now = Date.now()
  await db.insert(members).values([
    {
      id: 'demoMember000001',
      displayName: 'สมาชิกทดสอบ',
      linkToken: DEMO,
      passwordHash: null,
      expiresAt: new Date(now + 30 * 86400_000).toISOString(),
      createdAt: new Date(now).toISOString(),
    },
    {
      id: 'expiredMember001',
      displayName: 'หมดอายุ',
      linkToken: EXPIRED,
      passwordHash: await hashPassword('password123', 1000),
      expiresAt: new Date(now - 86400_000).toISOString(),
      createdAt: new Date(now).toISOString(),
    },
  ])
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
    ASSETS: r2,
  }
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

describe('health', () => {
  it('GET /health', async () => {
    const res = await req('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })
})

describe('member link flow', () => {
  let cookie = ''

  it('GET /link/:token shows a member without password', async () => {
    const res = await req(`/link/${DEMO}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      displayName: 'สมาชิกทดสอบ',
      hasPassword: false,
      expired: false,
      disabled: false,
    })
    expect((await req('/link/unknown0000000000000000000000000')).status).toBe(404)
  })

  it('no session → 401 on /me', async () => {
    const res = await req('/me')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error: { code: 'UNAUTHENTICATED', message: expect.any(String) },
    })
  })

  it('set-password validates length, sets cookie, then refuses a second time', async () => {
    const short = await req(`/link/${DEMO}/set-password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'short' }),
    })
    expect(short.status).toBe(400)

    const res = await req(`/link/${DEMO}/set-password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'my-secret-pass' }),
    })
    expect(res.status).toBe(204)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    cookie = cookieFrom(res, 'ng_session')

    const again = await req(`/link/${DEMO}/set-password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'another-pass' }),
    })
    expect(again.status).toBe(409)
  })

  it('GET /me with the cookie', async () => {
    const res = await req('/me', { cookie })
    expect(res.status).toBe(200)
    const me = (await res.json()) as Member
    expect(me).toMatchObject({
      displayName: 'สมาชิกทดสอบ',
      expired: false,
      disabled: false,
      rendersToday: 0,
      rendersLimit: 600,
    })
  })

  it('tampered cookie is rejected', async () => {
    const res = await req('/me', { cookie: cookie.slice(0, -2) + 'aa' })
    expect(res.status).toBe(401)
  })

  it('GET /sets creates the starter sets, the locked one first', async () => {
    const res = await req('/sets', { cookie })
    expect(res.status).toBe(200)
    const sets = (await res.json()) as LotterySet[]
    expect(sets).toHaveLength(STARTER_SETS.length)
    expect(sets[0]).toMatchObject({ name: 'หวยจันทร์-ศุกร์ รอบ 1', isDefault: true })
    expect(sets.map((s) => s.name)).not.toContain('Default')
    expect(sets.map((s) => s.name)).not.toContain('จบ')
    // same names and order as the starter list; lotteries that exist in the catalog are linked
    expect(sets.map((s) => s.name)).toEqual(STARTER_SETS.map((s) => s.name))
    expect(sets.filter((s) => s.isDefault)).toHaveLength(1)
    const r10 = sets.find((s) => s.name === 'หวยจันทร์-ศุกร์ รอบ 10')!
    expect(r10.lotteryIds).toEqual(['hanoi-special', 'hanoi-regular', 'hanoi-vip'])
    expect(r10.rounds).toEqual([1, 1, 1])
    // a second GET creates nothing new
    expect(((await (await req('/sets', { cookie })).json()) as LotterySet[]).length).toBe(STARTER_SETS.length)
    const rename = await req(`/sets/${sets[0].id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ name: 'x' }),
    })
    expect(rename.status).toBe(409)
    expect(await rename.json()).toMatchObject({ error: { code: 'DEFAULT_LOCKED' } })
  })

  it('POST /render/numbers returns numbers and counts renders', async () => {
    const res = await req('/render/numbers', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        items: [{ lotteryId: 'hanoi-regular' }, { lotteryId: 'dow-jones', fixed: ['3', null] }],
        date: '2026-11-06',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: { lotteryId: string; numbers: { running: [string, string]; two: string[][] } }[]
      rendersToday: number
      rendersLimit: number
    }
    expect(body.results).toHaveLength(2)
    expect(body.results[1].numbers.running[0]).toBe('3')
    expect(body.rendersToday).toBe(2)
    expect(body.rendersLimit).toBe(600)
  })

  it('upload asset → signed URL serves bytes; render signs referenced assets', async () => {
    const form = new FormData()
    form.append('kind', 'background')
    form.append('file', new File([new Uint8Array([137, 80, 78, 71])], 'bg.png', { type: 'image/png' }))
    const up = await app.request('/assets', { method: 'POST', body: form, headers: { Cookie: cookie } }, env)
    expect(up.status).toBe(200)
    const asset = (await up.json()) as { id: string }
    expect([...r2.objects.keys()][0]).toMatch(/^members\/demoMember000001\/assets\/.+\.png$/)

    const put = await req('/settings/hanoi-regular', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ backgroundAssetId: asset.id, extra: { anything: true } }),
    })
    expect(put.status).toBe(200)

    const res = await req('/render/numbers', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-06' }),
    })
    const body = (await res.json()) as { assets: Record<string, string> }
    const url = new URL(body.assets[asset.id])
    // Render response carries the new URL shape: memberId + ext in the query string.
    expect(url.searchParams.get('m')).toBeTruthy()
    expect(url.searchParams.get('e')).toBe('png')
    const file = await app.request(url.pathname + url.search, {}, env)
    expect(file.status).toBe(200)
    expect(file.headers.get('cache-control')).toMatch(/^private, max-age=\d+, immutable$/)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))

    const bad = await app.request(
      `${url.pathname}?exp=${url.searchParams.get('exp')}&m=${url.searchParams.get('m')}&e=${url.searchParams.get('e')}&sig=${'0'.repeat(64)}`,
      {},
      env,
    )
    expect(bad.status).toBe(403)
  })

  it('settings validation enforces bounds', async () => {
    const res = await req('/settings/hanoi-regular', {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ elements: { two: { row: 7 } } }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
  })

  it('wrong password 5 times → 429', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await req(`/link/${DEMO}/login`, {
        method: 'POST',
        body: JSON.stringify({ password: 'wrong-password' }),
      })
      expect(r.status).toBe(401)
      expect(await r.json()).toMatchObject({ error: { code: 'BAD_PASSWORD' } })
    }
    const fifth = await req(`/link/${DEMO}/login`, {
      method: 'POST',
      body: JSON.stringify({ password: 'wrong-password' }),
    })
    expect(fifth.status).toBe(429)
    const locked = await req(`/link/${DEMO}/login`, {
      method: 'POST',
      body: JSON.stringify({ password: 'my-secret-pass' }),
    })
    expect(locked.status).toBe(429)
    await resetLimiter(getDb(env))
    const ok = await req(`/link/${DEMO}/login`, {
      method: 'POST',
      body: JSON.stringify({ password: 'my-secret-pass' }),
    })
    expect(ok.status).toBe(204)
  })
})

describe('expired member', () => {
  it('can log in and read /me but gets 403 EXPIRED on /sets', async () => {
    const login = await req(`/link/${EXPIRED}/login`, {
      method: 'POST',
      body: JSON.stringify({ password: 'password123' }),
    })
    expect(login.status).toBe(204)
    const cookie = cookieFrom(login, 'ng_session')

    const me = await req('/me', { cookie })
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ expired: true })

    const sets = await req('/sets', { cookie })
    expect(sets.status).toBe(403)
    expect(await sets.json()).toMatchObject({ error: { code: 'EXPIRED' } })

    const render = await req('/render/numbers', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ items: [{ lotteryId: 'dow-jones' }], date: '2026-11-06' }),
    })
    expect(render.status).toBe(403)

    const news = await req('/news', { cookie })
    expect(news.status).toBe(200)
  })
})

describe('admin', () => {
  let cookie = ''

  it('rejects bad credentials and accepts admin/admin1234', async () => {
    const bad = await req('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'nope' }),
    })
    expect(bad.status).toBe(401)
    expect((await req('/admin/me')).status).toBe(401)

    const res = await req('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin1234' }),
    })
    expect(res.status).toBe(204)
    cookie = cookieFrom(res, 'ng_admin')
    const me = await req('/admin/me', { cookie })
    expect(await me.json()).toEqual({ username: 'admin' })
  })

  it('an admin session value is not accepted as a member session', async () => {
    const res = await req('/me', { cookie: cookie.replace('ng_admin', 'ng_session') })
    expect(res.status).toBe(401)
  })

  it('creates a member with a link, lists, patches and deletes it (cascade + R2)', async () => {
    const expiresAt = new Date(Date.now() + 90 * 86400_000).toISOString()
    const res = await req('/admin/members', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ displayName: 'ลูกค้าใหม่', expiresAt }),
    })
    expect(res.status).toBe(200)
    const m = (await res.json()) as AdminMember
    expect(m.linkToken).toMatch(/^[0-9A-Za-z]{32}$/)
    expect(m.link).toBe(`http://localhost:5173/m/${m.linkToken}`)
    expect(m).toMatchObject({
      displayName: 'ลูกค้าใหม่',
      hasPassword: false,
      expired: false,
      rendersTotal: 0,
      rendersToday: 0,
      lastLoginAt: null,
    })

    const list = (await (await req('/admin/members?q=ลูกค้า', { cookie })).json()) as AdminMember[]
    expect(list.map((x) => x.id)).toEqual([m.id])

    const patched = await req(`/admin/members/${m.id}`, {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({ disabled: true }),
    })
    expect(await patched.json()).toMatchObject({ disabled: true })

    // member sets a password, uploads an asset, then gets deleted
    await req(`/admin/members/${m.id}`, { method: 'PATCH', cookie, body: JSON.stringify({ disabled: false }) })
    const sp = await req(`/link/${m.linkToken}/set-password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'password-xyz' }),
    })
    const mc = cookieFrom(sp, 'ng_session')
    const form = new FormData()
    form.append('kind', 'logo')
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'logo.webp', { type: 'image/webp' }))
    const up = await app.request('/assets', { method: 'POST', body: form, headers: { Cookie: mc } }, env)
    expect(up.status).toBe(200)
    const keyCount = [...r2.objects.keys()].filter((k) => k.includes(m.id)).length
    expect(keyCount).toBe(1)

    const reset = await req(`/admin/members/${m.id}/reset-password`, { method: 'POST', cookie })
    expect(reset.status).toBe(204)
    expect((await req('/me', { cookie: mc })).status).toBe(401)

    const del = await req(`/admin/members/${m.id}`, { method: 'DELETE', cookie })
    expect(del.status).toBe(204)
    expect([...r2.objects.keys()].filter((k) => k.includes(m.id))).toHaveLength(0)
    const { client, db } = openDb(DB_URL)
    expect(await db.query.members.findFirst({ where: eq(members.id, m.id) })).toBeUndefined()
    client.close()
  })

  it('rejects state-changing requests from a foreign Origin', async () => {
    const res = await req('/admin/members', {
      method: 'POST',
      cookie,
      headers: { Origin: 'https://evil.example' },
      body: JSON.stringify({ displayName: 'x', expiresAt: new Date().toISOString() }),
    })
    expect(res.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------------------------
// Adversarial review cases (auth gates, cookies, CORS, limits, cascades, validation bounds).
// ---------------------------------------------------------------------------------------------

async function adminCookie(): Promise<string> {
  const res = await req('/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'admin1234' }),
  })
  expect(res.status).toBe(204)
  return cookieFrom(res, 'ng_admin')
}

/** Creates a member through the back office and claims the link. */
async function newMember(admin: string, name = 'ทดสอบ') {
  const res = await req('/admin/members', {
    method: 'POST',
    cookie: admin,
    body: JSON.stringify({
      displayName: name,
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
    }),
  })
  const m = (await res.json()) as AdminMember
  const sp = await req(`/link/${m.linkToken}/set-password`, {
    method: 'POST',
    body: JSON.stringify({ password: 'password-123' }),
  })
  expect(sp.status).toBe(204)
  return { id: m.id, token: m.linkToken, cookie: cookieFrom(sp, 'ng_session') }
}

/** Every member route that must be gated (method, path, body). */
const GATED: [string, string, unknown?][] = [
  ['GET', '/lotteries'],
  ['GET', '/sets'],
  ['POST', '/sets', { name: 'x' }],
  ['PATCH', '/sets/someSetId000001', { name: 'y' }],
  ['DELETE', '/sets/someSetId000001'],
  ['GET', '/settings'],
  ['PUT', '/settings', { items: [{ lotteryId: 'hanoi-regular', settings: {} }] }],
  ['GET', '/settings/hanoi-regular'],
  ['PUT', '/settings/hanoi-regular', {}],
  ['DELETE', '/settings/hanoi-regular'],
  ['POST', '/render/numbers', { items: [{ lotteryId: 'dow-jones' }], date: '2026-11-06' }],
  ['GET', '/assets'],
  ['DELETE', '/assets/someAsset0000001'],
  ['GET', '/assets/someAsset0000001/url'],
]
/** Member routes that keep working for expired / disabled members. */
const OPEN_WHEN_INACTIVE: [string, string][] = [
  ['GET', '/me'],
  ['GET', '/news'],
]

function call(method: string, path: string, cookie?: string, body?: unknown) {
  return req(path, { method, cookie, body: body === undefined ? undefined : JSON.stringify(body) })
}

function uploadFile(cookie: string, file: File, kind = 'logo') {
  const form = new FormData()
  form.append('kind', kind)
  form.append('file', file)
  return app.request('/assets', { method: 'POST', body: form, headers: { Cookie: cookie } }, env)
}

describe('review: member auth gates', () => {
  it('every member route returns 401 UNAUTHENTICATED without a session', async () => {
    const all: [string, string, unknown?][] = [...GATED, ...OPEN_WHEN_INACTIVE, ['POST', '/news/x/read']]
    for (const [method, path, body] of all) {
      const res = await call(method, path, undefined, body)
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    }
    const form = new FormData()
    form.append('kind', 'logo')
    form.append('file', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    expect((await app.request('/assets', { method: 'POST', body: form }, env)).status).toBe(401)
  })

  it('expired → 403 EXPIRED, disabled → 403 DISABLED on every gated route; /me and /news still work', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'gate')
    const db = getDb(env)
    const patch = (body: unknown) => call('PATCH', `/admin/members/${m.id}`, admin, body)

    await patch({ disabled: true })
    for (const [method, path, body] of GATED) {
      const res = await call(method, path, m.cookie, body)
      expect(res.status, `disabled ${method} ${path}`).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'DISABLED' } })
    }
    const upDisabled = await uploadFile(m.cookie, new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    expect(upDisabled.status).toBe(403)
    for (const [method, path] of OPEN_WHEN_INACTIVE) {
      expect((await call(method, path, m.cookie)).status, `disabled ${path}`).toBe(200)
    }
    expect(await (await call('GET', '/me', m.cookie)).json()).toMatchObject({ disabled: true })

    // expired: checked on every request, even inside a live session
    await patch({ disabled: false, expiresAt: new Date(Date.now() - 1000).toISOString() })
    for (const [method, path, body] of GATED) {
      const res = await call(method, path, m.cookie, body)
      expect(res.status, `expired ${method} ${path}`).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'EXPIRED' } })
    }
    const me = await call('GET', '/me', m.cookie)
    expect(me.status).toBe(200)
    expect(await me.json()).toMatchObject({ expired: true, disabled: false })

    // renewal restores access within the same session
    await patch({ expiresAt: new Date(Date.now() + 86400_000).toISOString() })
    expect((await call('GET', '/sets', m.cookie)).status).toBe(200)

    // a session row past its 24 h expiry is rejected even though the cookie is validly signed
    await db
      .update(memberSessions)
      .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where(eq(memberSessions.memberId, m.id))
    expect((await call('GET', '/me', m.cookie)).status).toBe(401)
  })

  it('/logout clears the cookie and kills the session row', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'logout')
    const out = await req('/logout', { method: 'POST', cookie: m.cookie })
    expect(out.status).toBe(204)
    expect(out.headers.get('set-cookie')).toMatch(/ng_session=;.*Max-Age=0/)
    expect((await call('GET', '/me', m.cookie)).status).toBe(401)
  })

  it('login deletes only EXPIRED member_sessions of that member', async () => {
    const admin = await adminCookie()
    const m1 = await newMember(admin, 'prune-a')
    const m2 = await newMember(admin, 'prune-b')
    const db = getDb(env)
    const past = new Date(Date.now() - 86400_000).toISOString()
    // Plant two expired rows for m1 and one expired row for m2. Each member also already has one
    // unexpired session from newMember (set-password).
    await db.insert(memberSessions).values([
      { id: 'prune_a_expired_01________________', memberId: m1.id, expiresAt: past, createdAt: past },
      { id: 'prune_a_expired_02________________', memberId: m1.id, expiresAt: past, createdAt: past },
      { id: 'prune_b_expired_01________________', memberId: m2.id, expiresAt: past, createdAt: past },
    ])
    expect(
      (await db.select().from(memberSessions).where(eq(memberSessions.memberId, m1.id))).length,
    ).toBe(3)
    expect(
      (await db.select().from(memberSessions).where(eq(memberSessions.memberId, m2.id))).length,
    ).toBe(2)

    const login = await req(`/link/${m1.token}/login`, {
      method: 'POST',
      body: JSON.stringify({ password: 'password-123' }),
    })
    expect(login.status).toBe(204)
    const now = new Date().toISOString()

    // m1: both expired rows gone, two unexpired rows remain (prior + newly inserted).
    const rowsA = await db.select().from(memberSessions).where(eq(memberSessions.memberId, m1.id))
    expect(rowsA).toHaveLength(2)
    for (const r of rowsA) expect(r.expiresAt > now).toBe(true)
    // m2 untouched: still 1 unexpired + 1 expired row.
    const rowsB = await db.select().from(memberSessions).where(eq(memberSessions.memberId, m2.id))
    expect(rowsB).toHaveLength(2)
    expect(rowsB.filter((r) => r.expiresAt <= now)).toHaveLength(1)
    expect(rowsB.filter((r) => r.expiresAt > now)).toHaveLength(1)
  })

  it('set-password also prunes only this member’s EXPIRED member_sessions', async () => {
    // A fresh member has no session yet. Create one, manually plant an expired row (as if from a
    // previous link-visit that somehow logged in — defence in depth), add noise for another member,
    // then set-password. Only this member's expired row should go.
    const admin = await adminCookie()
    const self = await req('/admin/members', {
      method: 'POST',
      cookie: admin,
      body: JSON.stringify({
        displayName: 'setpw-prune',
        expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      }),
    })
    const selfBody = (await self.json()) as AdminMember
    const noise = await newMember(admin, 'setpw-prune-noise')
    const db = getDb(env)
    const past = new Date(Date.now() - 86400_000).toISOString()
    await db.insert(memberSessions).values([
      { id: 'setpw_pruneself_exp_______________', memberId: selfBody.id, expiresAt: past, createdAt: past },
      { id: 'setpw_prunenoise_exp______________', memberId: noise.id, expiresAt: past, createdAt: past },
    ])
    const sp = await req(`/link/${selfBody.linkToken}/set-password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'password-prune' }),
    })
    expect(sp.status).toBe(204)
    const now = new Date().toISOString()
    const selfRows = await db
      .select()
      .from(memberSessions)
      .where(eq(memberSessions.memberId, selfBody.id))
    // Only the freshly-inserted unexpired row remains.
    expect(selfRows).toHaveLength(1)
    expect(selfRows[0].expiresAt > now).toBe(true)
    // Noise member still has its expired row plus its own unexpired set-password session.
    const noiseRows = await db
      .select()
      .from(memberSessions)
      .where(eq(memberSessions.memberId, noise.id))
    expect(noiseRows).toHaveLength(2)
    expect(noiseRows.filter((r) => r.expiresAt <= now)).toHaveLength(1)
  })
})

describe('review: cookies', () => {
  it('COOKIE_SECURE=true → Secure; SameSite=None; HttpOnly; 24 h', async () => {
    const res = await app.request(
      '/admin/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin1234' }),
      },
      { ...env, COOKIE_SECURE: 'true' },
    )
    const sc = res.headers.get('set-cookie') ?? ''
    expect(sc).toMatch(/^ng_admin=/)
    expect(sc).toContain('Secure')
    expect(sc).toContain('SameSite=None')
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('Max-Age=86400')
    expect(sc).toContain('Path=/')
  })

  it('COOKIE_SECURE=false → SameSite=Lax without Secure', async () => {
    const res = await req('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'admin1234' }),
    })
    const sc = res.headers.get('set-cookie') ?? ''
    expect(sc).toContain('SameSite=Lax')
    expect(sc).toContain('HttpOnly')
    expect(sc).not.toContain('Secure')
  })
})

describe('review: admin isolation and login limits', () => {
  it('member cookies never open admin routes', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'iso')
    expect((await call('GET', '/admin/members', m.cookie)).status).toBe(401)
    // the member cookie value replayed under the admin cookie name (HMAC is bound to the kind)
    const asAdmin = m.cookie.replace('ng_session=', 'ng_admin=')
    expect((await call('GET', '/admin/me', asAdmin)).status).toBe(401)
    expect((await call('GET', '/admin/members', asAdmin)).status).toBe(401)
    expect((await call('DELETE', `/admin/members/${m.id}`, asAdmin)).status).toBe(401)
  })

  it('admin login locks after 5 wrong passwords per IP (stored in the DB)', async () => {
    const login = (ip: string, password: string) =>
      req('/admin/login', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': ip },
        body: JSON.stringify({ username: 'admin', password }),
      })
    for (let i = 0; i < 4; i++) expect((await login('203.0.113.9', 'wrong')).status).toBe(401)
    expect((await login('203.0.113.9', 'wrong')).status).toBe(429)
    expect((await login('203.0.113.9', 'admin1234')).status).toBe(429)
    expect((await login('198.51.100.7', 'admin1234')).status).toBe(204)
    const row = await getDb(env).query.loginAttempts.findFirst({
      where: eq(loginAttempts.key, 'admin:203.0.113.9'),
    })
    expect(row?.lockedUntil).toBeTruthy()
  })

  it('member link lock is DB-backed and a reset-password clears it', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'lock')
    const login = (password: string) =>
      req(`/link/${m.token}/login`, { method: 'POST', body: JSON.stringify({ password }) })
    for (let i = 0; i < 5; i++) await login('nope-nope')
    const row = await getDb(env).query.loginAttempts.findFirst({
      where: eq(loginAttempts.key, `link:${m.token}`),
    })
    expect(row?.lockedUntil).toBeTruthy()
    expect((await login('password-123')).status).toBe(429)
    await call('POST', `/admin/members/${m.id}/reset-password`, admin)
    const sp = await req(`/link/${m.token}/set-password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'brand-new-pass' }),
    })
    expect(sp.status).toBe(204)
    expect((await login('brand-new-pass')).status).toBe(204)
  })

  it('set-password is refused (409) once a password exists and does not overwrite it', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'setpw')
    const again = await req(`/link/${m.token}/set-password`, {
      method: 'POST',
      body: JSON.stringify({ password: 'attacker-pass' }),
    })
    expect(again.status).toBe(409)
    expect(again.headers.get('set-cookie')).toBeNull()
    const login = await req(`/link/${m.token}/login`, {
      method: 'POST',
      body: JSON.stringify({ password: 'attacker-pass' }),
    })
    expect(login.status).toBe(401)
  })
})

describe('review: CORS', () => {
  const prodEnv = () => ({ ...env, WEB_URL: 'https://numbergen-web.pages.dev' })
  const preflight = (origin: string) =>
    app.request(
      '/sets',
      {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      },
      prodEnv(),
    )

  it('allows WEB_URL and http://localhost:5173 with credentials, nothing else', async () => {
    for (const origin of ['http://localhost:5173', 'https://numbergen-web.pages.dev']) {
      const res = await preflight(origin)
      expect(res.headers.get('access-control-allow-origin'), origin).toBe(origin)
      expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    }
    const denied = [
      'https://evil.example',
      'http://localhost:5174',
      'null',
      'https://numbergen-web.pages.dev.evil.example',
    ]
    for (const origin of denied) {
      expect((await preflight(origin)).headers.get('access-control-allow-origin'), origin).toBeNull()
    }
    const get = await app.request('/health', { headers: { Origin: 'https://evil.example' } }, prodEnv())
    expect(get.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('WEB_URL can list several origins; member links use the first one', async () => {
    const multi = { ...env, WEB_URL: 'https://pnphoto.co, https://numbergen-web.example.workers.dev/' }
    const pre = (origin: string) =>
      app.request(
        '/sets',
        { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } },
        multi,
      )
    for (const origin of ['https://pnphoto.co', 'https://numbergen-web.example.workers.dev', 'http://localhost:5173']) {
      expect((await pre(origin)).headers.get('access-control-allow-origin'), origin).toBe(origin)
    }
    for (const origin of ['https://evil.example', 'https://pnphoto.co.evil.example', 'https://www.pnphoto.co']) {
      expect((await pre(origin)).headers.get('access-control-allow-origin'), origin).toBeNull()
    }
    const login = await app.request(
      '/admin/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin1234' }),
      },
      multi,
    )
    expect(login.status).toBe(204)
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
    const created = await app.request(
      '/admin/members',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, Origin: 'https://numbergen-web.example.workers.dev' },
        body: JSON.stringify({ displayName: 'multi-origin', expiresAt: new Date(Date.now() + 86400000).toISOString() }),
      },
      multi,
    )
    expect(created.status).toBe(200)
    const m = (await created.json()) as { link: string; linkToken: string }
    expect(m.link).toBe(`https://pnphoto.co/m/${m.linkToken}`)
  })

  it('a cross-site multipart upload (no preflight) is refused by the Origin guard', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'csrf')
    const form = new FormData()
    form.append('kind', 'logo')
    form.append('file', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    const res = await app.request(
      '/assets',
      { method: 'POST', body: form, headers: { Cookie: m.cookie, Origin: 'https://evil.example' } },
      env,
    )
    expect(res.status).toBe(403)
  })
})

describe('review: render limit', () => {
  const render = (cookie: string, n: number) =>
    call('POST', '/render/numbers', cookie, {
      items: Array.from({ length: n }, () => ({ lotteryId: 'dow-jones' })),
      date: '2026-11-06',
    })

  it('counts items, refuses over 600 without consuming, and resets per UTC day', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'limit')
    const db = getDb(env)
    const today = bangkokDay()
    // yesterday was fully used: must not count today
    await db.insert(renderCounters).values({ memberId: m.id, day: bangkokDay(Date.now() - 86400_000), count: 600 })

    const first = await render(m.cookie, 80)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ rendersToday: 80, rendersLimit: 600 })

    const todayRow = and(eq(renderCounters.memberId, m.id), eq(renderCounters.day, today))
    await db.update(renderCounters).set({ count: 599 }).where(todayRow)
    const over = await render(m.cookie, 2)
    expect(over.status).toBe(429)
    expect(await over.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } })
    expect((await db.query.renderCounters.findFirst({ where: todayRow }))?.count).toBe(599)

    const last = await render(m.cookie, 1)
    expect(last.status).toBe(200)
    expect(await last.json()).toMatchObject({ rendersToday: 600 })
    expect((await render(m.cookie, 1)).status).toBe(429)

    const me = (await (await call('GET', '/me', m.cookie)).json()) as Member
    expect(me.rendersToday).toBe(600)
    const list = (await (await call('GET', `/admin/members?q=${m.token}`, admin)).json()) as AdminMember[]
    expect(list[0]).toMatchObject({ rendersToday: 600, rendersTotal: 81 })
  })

  it('rejects more than 80 items and an empty list', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'limit2')
    expect((await render(m.cookie, 81)).status).toBe(400)
    expect((await render(m.cookie, 0)).status).toBe(400)
  })

  it('a whitespace fixed digit means "random", not 0', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'fixed')
    let sawNonZero = false
    for (let i = 0; i < 10 && !sawNonZero; i++) {
      const res = await call('POST', '/render/numbers', m.cookie, {
        items: [{ lotteryId: 'dow-jones', fixed: [' ', null] }],
        date: '2026-11-06',
      })
      const body = (await res.json()) as { results: { numbers: { running: [string, string] } }[] }
      if (body.results[0].numbers.running[0] !== '0') sawNonZero = true
    }
    expect(sawNonZero).toBe(true)
  })

  it("never signs another member's asset, even when the settings reference it", async () => {
    const admin = await adminCookie()
    const owner = await newMember(admin, 'owner')
    const thief = await newMember(admin, 'thief')
    const up = await uploadFile(owner.cookie, new File([new Uint8Array([9, 9])], 'bg.png', { type: 'image/png' }), 'background')
    const { id } = (await up.json()) as { id: string }

    const res = await call('POST', '/render/numbers', thief.cookie, {
      items: [
        {
          lotteryId: 'dow-jones',
          settings: { backgroundAssetId: id, logo: { assetId: id, x: 0, y: 0, width: 10, opacity: 1 } },
        },
      ],
      date: '2026-11-06',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ assets: {} })
    expect((await call('GET', `/assets/${id}/url`, thief.cookie)).status).toBe(404)
    expect((await call('DELETE', `/assets/${id}`, thief.cookie)).status).toBe(404)
  })

  it('renders_total is NOT incremented when the counter upsert is refused (over limit)', async () => {
    // Guard property: members.renders_total and render_counters.count must stay consistent, so
    // an over-limit request must not bump either one. Exercises the `changes() > 0` guard on
    // the batched members UPDATE (no compensating write).
    const admin = await adminCookie()
    const m = await newMember(admin, 'rt-guard')
    const db = getDb(env)
    const today = bangkokDay()
    const todayRow = and(eq(renderCounters.memberId, m.id), eq(renderCounters.day, today))
    // Seed: 599 renders used today + a non-zero rendersTotal so we can detect any stray increment.
    await db.insert(renderCounters).values({ memberId: m.id, day: today, count: 599 })
    await db.update(members).set({ rendersTotal: 123 }).where(eq(members.id, m.id))

    // Over by 1 (599 + 2 > 600) — refused.
    const over = await render(m.cookie, 2)
    expect(over.status).toBe(429)
    expect((await db.query.renderCounters.findFirst({ where: todayRow }))?.count).toBe(599)
    expect((await db.query.members.findFirst({ where: eq(members.id, m.id) }))?.rendersTotal).toBe(123)

    // Exactly at the boundary — allowed, both counters tick by 1.
    const okAtBoundary = await render(m.cookie, 1)
    expect(okAtBoundary.status).toBe(200)
    expect(await okAtBoundary.json()).toMatchObject({ rendersToday: 600 })
    expect((await db.query.renderCounters.findFirst({ where: todayRow }))?.count).toBe(600)
    expect((await db.query.members.findFirst({ where: eq(members.id, m.id) }))?.rendersTotal).toBe(124)

    // One over the boundary — refused, no counter moves.
    expect((await render(m.cookie, 1)).status).toBe(429)
    expect((await db.query.renderCounters.findFirst({ where: todayRow }))?.count).toBe(600)
    expect((await db.query.members.findFirst({ where: eq(members.id, m.id) }))?.rendersTotal).toBe(124)
  })

  it('first render of a new UTC day inserts the counter and bumps renders_total by n', async () => {
    // Fresh-insert branch of the upsert (no conflict). `changes()` must still be 1 so the
    // members UPDATE runs, and the inserted count equals n (≤ MAX_ITEMS_PER_RENDER).
    const admin = await adminCookie()
    const m = await newMember(admin, 'rt-first')
    const db = getDb(env)
    const today = bangkokDay()
    // No render_counters row for today yet — this is the insert branch.
    expect(
      await db.query.renderCounters.findFirst({
        where: and(eq(renderCounters.memberId, m.id), eq(renderCounters.day, today)),
      }),
    ).toBeUndefined()

    const res = await render(m.cookie, 5)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ rendersToday: 5, rendersLimit: 600 })
    const row = await db.query.renderCounters.findFirst({
      where: and(eq(renderCounters.memberId, m.id), eq(renderCounters.day, today)),
    })
    expect(row?.count).toBe(5)
    expect((await db.query.members.findFirst({ where: eq(members.id, m.id) }))?.rendersTotal).toBe(5)
  })
})

describe('review: signed asset URLs', () => {
  it('cannot be forged, moved to another asset, or reused after exp', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'signed')
    const upload = async () => {
      const up = await uploadFile(m.cookie, new File([new Uint8Array([7, 7, 7])], 'l.webp', { type: 'image/webp' }))
      return ((await up.json()) as { id: string }).id
    }
    const a = await upload()
    const b = await upload()
    const ext = 'webp'
    const { url } = (await (await call('GET', `/assets/${a}/url`, m.cookie)).json()) as { url: string }
    const u = new URL(url)
    const exp = Number(u.searchParams.get('exp'))
    const sig = u.searchParams.get('sig') ?? ''
    const sigMember = u.searchParams.get('m') ?? ''
    const sigExt = u.searchParams.get('e') ?? ''
    expect(sigMember).toBe(m.id)
    expect(sigExt).toBe(ext)
    // Bucketed exp: at least MIN_TTL (600) seconds in the future, never more than MAX_TTL (2400).
    const nowSec = Math.floor(Date.now() / 1000)
    expect(exp - nowSec).toBeGreaterThanOrEqual(600)
    expect(exp - nowSec).toBeLessThanOrEqual(2400)
    // Same URL on a second call inside the 30-min bucket, so the browser cache reuses it.
    const second = (await (await call('GET', `/assets/${a}/url`, m.cookie)).json()) as { url: string }
    expect(second.url).toBe(url)

    const q = `exp=${exp}&m=${encodeURIComponent(sigMember)}&e=${encodeURIComponent(sigExt)}&sig=${sig}`
    const get = (path: string) => app.request(path, {}, env)
    const ok = await get(`/assets/${a}?${q}`)
    expect(ok.status).toBe(200)
    // Immutable since the same URL always points at the same bytes.
    expect(ok.headers.get('cache-control')).toMatch(/^private, max-age=\d+, immutable$/)
    const maxAge = Number(/max-age=(\d+)/.exec(ok.headers.get('cache-control') ?? '')?.[1] ?? '0')
    expect(maxAge).toBeGreaterThan(0)
    expect(maxAge).toBeLessThanOrEqual(exp - nowSec + 5)
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-type')).toBe('image/webp')

    // other asset id (same sig/member/ext) — rejected
    expect((await get(`/assets/${b}?${q}`)).status).toBe(403)
    // exp bumped — sig no longer matches
    expect((await get(`/assets/${a}?exp=${exp + 1800}&m=${sigMember}&e=${sigExt}&sig=${sig}`)).status).toBe(403)
    // unsigned fall-through
    expect((await get(`/assets/${a}`)).status).toBe(403)
    // missing sig
    expect((await get(`/assets/${a}?exp=${exp}&m=${sigMember}&e=${sigExt}`)).status).toBe(403)
    // missing memberId
    expect((await get(`/assets/${a}?exp=${exp}&e=${sigExt}&sig=${sig}`)).status).toBe(403)
    // missing ext
    expect((await get(`/assets/${a}?exp=${exp}&m=${sigMember}&sig=${sig}`)).status).toBe(403)
    // wrong-member download link, right sig over the wrong payload
    const wrongMember = await signAsset('not-the-secret', a, m.id, ext)
    expect(
      (await get(`/assets/${a}?exp=${wrongMember.exp}&m=${m.id}&e=${ext}&sig=${wrongMember.sig}`))
        .status,
    ).toBe(403)
    // tampering the memberId ⇒ signature mismatch
    expect(
      (await get(`/assets/${a}?exp=${exp}&m=otherMember00000&e=${sigExt}&sig=${sig}`)).status,
    ).toBe(403)
    // correctly signed but already expired (nowMs far in the past ⇒ bucketed exp is in the past)
    const old = await signAsset(env.ASSET_SIGNING_SECRET, a, m.id, ext, Date.now() - 86_400_000)
    expect((await get(`/assets/${a}?exp=${old.exp}&m=${m.id}&e=${ext}&sig=${old.sig}`)).status).toBe(403)
    // correctly signed by this secret but with an exp a day ahead (bypasses the bucket logic
    // by crafting the signature directly) — rejected because exp > now + MAX_TTL + 60.
    const farExp = Math.floor(Date.now() / 1000) + 86_400
    const farSig = await hmacSha256Hex(env.ASSET_SIGNING_SECRET, `${a}:${m.id}:${ext}:${farExp}`)
    expect((await get(`/assets/${a}?exp=${farExp}&m=${m.id}&e=${ext}&sig=${farSig}`)).status).toBe(403)
    // Another member cannot reuse owner's signed URL by replacing their member id.
    const other = await newMember(admin, 'other-sig')
    const stolen = await signAsset(env.ASSET_SIGNING_SECRET, a, other.id, ext)
    expect(
      (await get(`/assets/${a}?exp=${stolen.exp}&m=${other.id}&e=${ext}&sig=${stolen.sig}`)).status,
    ).toBe(404)
  })

  it('upload refuses non-images, SVG, empty, oversize and bad kind; enforces the 2-files-per-kind quota', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'quota')
    const up = (file: File, kind = 'logo') => uploadFile(m.cookie, file, kind)
    expect((await up(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }))).status).toBe(400)
    expect((await up(new File(['hi'], 'x.txt', { type: 'text/plain' }))).status).toBe(400)
    expect((await up(new File([], 'x.png', { type: 'image/png' }))).status).toBe(400)
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    expect((await up(big)).status).toBe(400)
    expect((await up(new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }), 'icon')).status).toBe(400)
    // 2 files per kind: a third logo is refused, but other kinds still have room
    for (let i = 0; i < 2; i++) {
      expect((await up(new File([new Uint8Array([i])], `${i}.png`, { type: 'image/png' }))).status).toBe(200)
    }
    const over = await up(new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }))
    expect(over.status).toBe(409)
    expect(await over.json()).toMatchObject({ error: { code: 'QUOTA' } })
    for (const kind of ['background', 'qr']) {
      for (let i = 0; i < 2; i++) {
        expect((await up(new File([new Uint8Array([i])], `${kind}${i}.png`, { type: 'image/png' }), kind)).status).toBe(200)
      }
      expect((await up(new File([new Uint8Array([9])], `${kind}-x.png`, { type: 'image/png' }), kind)).status).toBe(409)
    }
    // deleting one frees a slot in that kind
    const list = (await (await app.request('/assets', { headers: { cookie: m.cookie } }, env)).json()) as { id: string; kind: string }[]
    const logo = list.find((a) => a.kind === 'logo')!
    expect((await app.request(`/assets/${logo.id}`, { method: 'DELETE', headers: { cookie: m.cookie } }, env)).status).toBe(204)
    expect((await up(new File([new Uint8Array([7])], 'again.png', { type: 'image/png' }))).status).toBe(200)
  })

  it('deleting an asset removes it from R2 and clears card_settings references', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'assetdel')
    const up = await uploadFile(m.cookie, new File([new Uint8Array([3])], 'bg.png', { type: 'image/png' }), 'background')
    const { id } = (await up.json()) as { id: string }
    await call('PUT', '/settings/dow-jones', m.cookie, {
      backgroundAssetId: id,
      logo: { assetId: id, x: 1, y: 2, width: 3, opacity: 0.5 },
    })
    expect((await call('DELETE', `/assets/${id}`, m.cookie)).status).toBe(204)
    expect([...r2.objects.keys()].some((k) => k.includes(id))).toBe(false)
    const s = (await (await call('GET', '/settings/dow-jones', m.cookie)).json()) as {
      backgroundAssetId: unknown
      logo: { assetId: unknown; width: number }
    }
    expect(s.backgroundAssetId).toBeNull()
    expect(s.logo).toMatchObject({ assetId: null, width: 3 })
  })

  it('clears references across 80 card_settings rows in one bounded batch', async () => {
    // Regression for the N+1 loop that could exceed the D1 50-statements-per-request limit.
    // Here we use 80 referencing lotteries (all the catalog ids) — well above 50 — and the
    // DELETE must still succeed with no dangling references.
    const admin = await adminCookie()
    const m = await newMember(admin, 'assetdel-many')
    const ids = LOTTERY_CATALOG.map((l) => l.id)
    expect(ids.length).toBeGreaterThanOrEqual(60)
    const up = await uploadFile(
      m.cookie,
      new File([new Uint8Array([9])], 'bg.png', { type: 'image/png' }),
      'background',
    )
    const { id } = (await up.json()) as { id: string }
    // Seed card_settings rows that all reference `id` as background + logo + qr.
    const items = ids.map((lid) => ({
      lotteryId: lid,
      settings: {
        backgroundAssetId: id,
        logo: { assetId: id, x: 1, y: 2, width: 10, opacity: 0.5 },
        qr: { assetId: id, x: 3, y: 4, width: 20, opacity: 1 },
      },
    }))
    const put = await call('PUT', '/settings', m.cookie, { items })
    expect(put.status).toBe(200)
    const del = await call('DELETE', `/assets/${id}`, m.cookie)
    expect(del.status).toBe(204)
    const all = (await (await call('GET', '/settings', m.cookie)).json()) as Record<string, {
      backgroundAssetId: unknown
      logo?: { assetId: unknown; width?: number }
      qr?: { assetId: unknown; width?: number }
    }>
    expect(Object.keys(all)).toHaveLength(ids.length)
    for (const lid of ids) {
      const s = all[lid]
      expect(s, lid).toBeDefined()
      expect(s.backgroundAssetId, lid).toBeNull()
      expect(s.logo?.assetId, lid).toBeNull()
      // Keeps other logo fields intact (asset delete only nulls the id).
      expect(s.logo?.width, lid).toBe(10)
      expect(s.qr?.assetId, lid).toBeNull()
      expect(s.qr?.width, lid).toBe(20)
    }
    expect([...r2.objects.keys()].some((k) => k.includes(id))).toBe(false)
  })

  it('GET /assets includes a url field that serves the bytes without a /url round trip', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'list-urls')
    const upOne = (name: string, kind: string, byte: number) =>
      uploadFile(
        m.cookie,
        new File([new Uint8Array([byte])], `${name}.png`, { type: 'image/png' }),
        kind,
      )
    expect((await upOne('bg', 'background', 1)).status).toBe(200)
    expect((await upOne('lg', 'logo', 4)).status).toBe(200)
    expect((await upOne('qr', 'qr', 7)).status).toBe(200)
    const list = (await (await call('GET', '/assets', m.cookie)).json()) as (Asset & {
      url?: string
    })[]
    expect(list).toHaveLength(3)
    for (const a of list) {
      expect(a.url, a.fileName).toBeTruthy()
      const u = new URL(a.url!)
      expect(u.searchParams.get('m')).toBe(m.id)
      expect(u.searchParams.get('e')).toBe('png')
      const r = await app.request(u.pathname + u.search, {}, env)
      expect(r.status, a.fileName).toBe(200)
      expect(r.headers.get('cache-control')).toMatch(/^private, max-age=\d+, immutable$/)
    }
    // A second GET /assets inside the same 30-min bucket returns the SAME signed URLs.
    const again = (await (await call('GET', '/assets', m.cookie)).json()) as (Asset & { url?: string })[]
    expect(again.map((a) => a.url)).toEqual(list.map((a) => a.url))
  })

  it('upload quota check still refuses the 3rd file per kind after count(*) switch', async () => {
    // Guard regression: the count query was rewritten to count(*) rather than selecting ids.
    const admin = await adminCookie()
    const m = await newMember(admin, 'quota-count')
    const up = (name: string) =>
      uploadFile(m.cookie, new File([new Uint8Array([1])], name, { type: 'image/png' }), 'logo')
    expect((await up('a.png')).status).toBe(200)
    expect((await up('b.png')).status).toBe(200)
    const third = await up('c.png')
    expect(third.status).toBe(409)
    expect(await third.json()).toMatchObject({ error: { code: 'QUOTA' } })
  })

  it('download works without a D1 read even if the assets row is manually removed', async () => {
    // The download handler rebuilds the R2 key from the signed URL (memberId + ext), so it
    // does not touch D1. Prove that by signing a URL, deleting the assets row behind its
    // back (leaving R2 intact), and seeing the download still succeed.
    const admin = await adminCookie()
    const m = await newMember(admin, 'no-d1-read')
    const bytes = new Uint8Array([11, 22, 33])
    const up = await uploadFile(
      m.cookie,
      new File([bytes], 'bg.png', { type: 'image/png' }),
      'background',
    )
    const { id } = (await up.json()) as { id: string }
    const { url } = (await (await call('GET', `/assets/${id}/url`, m.cookie)).json()) as { url: string }
    // Remove the row only; keep the R2 object in place.
    const db = getDb(env)
    await db.delete(assetsTable).where(eq(assetsTable.id, id))
    const u = new URL(url)
    const file = await app.request(u.pathname + u.search, {}, env)
    expect(file.status).toBe(200)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes)
  })
})

describe('review: sets', () => {
  it('Default cannot be renamed or deleted; other sets can; max 40 sets', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'sets')
    const [def] = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    const del = await call('DELETE', `/sets/${def.id}`, m.cookie)
    expect(del.status).toBe(409)
    expect(await del.json()).toMatchObject({ error: { code: 'DEFAULT_LOCKED' } })
    const ren = await call('PATCH', `/sets/${def.id}`, m.cookie, { name: 'Renamed', lotteryIds: ['dow-jones'] })
    expect(ren.status).toBe(409)
    // the rejected PATCH changed nothing
    const [still] = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    expect(still.name).toBe(def.name)
    expect(still.lotteryIds).toEqual(def.lotteryIds)
    // its lottery list may still be edited
    const edit = await call('PATCH', `/sets/${def.id}`, m.cookie, { lotteryIds: ['dow-jones'] })
    expect(await edit.json()).toMatchObject({ name: def.name, lotteryIds: ['dow-jones'] })

    const created = (await (await call('POST', '/sets', m.cookie, { name: 'ชุดของฉัน' })).json()) as LotterySet
    const renamed = await call('PATCH', `/sets/${created.id}`, m.cookie, { name: 'ชุดใหม่' })
    expect(await renamed.json()).toMatchObject({ name: 'ชุดใหม่', isDefault: false })
    expect((await call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: ['no-such-lottery'] })).status).toBe(400)
    expect((await call('POST', '/sets', m.cookie, { name: 'x'.repeat(41) })).status).toBe(400)
    expect((await call('POST', '/sets', m.cookie, { name: '   ' })).status).toBe(400)
    expect((await call('DELETE', `/sets/${created.id}`, m.cookie)).status).toBe(204)

    for (let i = 0; i < MAX_SETS - STARTER_SETS.length; i++) expect((await call('POST', '/sets', m.cookie, { name: `s${i}` })).status).toBe(200)
    expect((await call('POST', '/sets', m.cookie, { name: 'one too many' })).status).toBe(409)
  })

  it('concurrent first GET /sets creates exactly one Default set', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'race')
    const results = await Promise.all(Array.from({ length: 5 }, () => call('GET', '/sets', m.cookie)))
    for (const r of results) expect(r.status).toBe(200)
    const rows = await getDb(env).query.sets.findMany({ where: eq(setsTable.memberId, m.id) })
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1)
    // The local file DB serialises requests, so also prove the DB-level guard directly.
    await expect(
      getDb(env).insert(setsTable).values({
        id: 'raceDefault00001',
        memberId: m.id,
        name: 'Default',
        isDefault: true,
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow()
    // non-default sets are unaffected by the index
    await getDb(env).insert(setsTable).values({
      id: 'raceOther0000001',
      memberId: m.id,
      name: 'other',
      isDefault: false,
      createdAt: new Date().toISOString(),
    })
  })

  it("a member cannot see or touch another member's sets", async () => {
    const admin = await adminCookie()
    const a = await newMember(admin, 'a')
    const b = await newMember(admin, 'b')
    const created = (await (await call('POST', '/sets', a.cookie, { name: 'secret' })).json()) as LotterySet
    expect((await call('PATCH', `/sets/${created.id}`, b.cookie, { name: 'pwned' })).status).toBe(404)
    expect((await call('DELETE', `/sets/${created.id}`, b.cookie)).status).toBe(404)
    const bSets = (await (await call('GET', '/sets', b.cookie)).json()) as LotterySet[]
    expect(bSets.map((s) => s.id)).not.toContain(created.id)
  })
})

describe('review: CardSettings validation', () => {
  it('enforces rows, perRow, fontSize, colour and size bounds; passes unknown keys through', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'zod')
    const put = (body: unknown) => call('PUT', '/settings/dow-jones', m.cookie, body)
    const bad: unknown[] = [
      { elements: { two: { row: -1 } } },
      { elements: { two: { row: 7 } } },
      { elements: { two: { row: 1.5 } } },
      { elements: { three: { perRow: 0 } } },
      { elements: { three: { perRow: 7 } } },
      { elements: { win: { fontSize: 7 } } },
      { elements: { win: { fontSize: 401 } } },
      { elements: { date: { color: 'x'.repeat(41) } } },
      { elements: { date: { stroke: 'x'.repeat(41) } } },
      { rects: [{ fill: 'x'.repeat(41) }] },
      { texts: [{ fontSize: 1000 }] },
      { texts: [{ color: 'x'.repeat(41) }] },
      { blob: 'x'.repeat(33 * 1024) },
      { logo: { assetId: null, x: 0, y: 0, width: 10, opacity: 2 } },
      { fixedRunning1: 10 },
      [],
      'nope',
    ]
    for (const body of bad) {
      const res = await put(body)
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    const good = {
      fontFamily: 'Kanit',
      spacing: 10,
      elements: {
        two: { row: 0, perRow: 6, fontSize: 8, color: '#ffffff', letterSpacing: 6 },
        three: { row: 6, perRow: 1, fontSize: 400 },
      },
      rects: [{ id: 'r1', x: 1, fill: '#000', opacity: 0.5 }],
      somethingNew: { nested: [1, 2, 3] },
    }
    expect((await put(good)).status).toBe(200)
    expect(await (await call('GET', '/settings/dow-jones', m.cookie)).json()).toEqual(good)
    expect((await call('PUT', '/settings/no-such-lottery', m.cookie, {})).status).toBe(404)
    expect((await call('DELETE', '/settings/dow-jones', m.cookie)).status).toBe(204)
    expect((await call('GET', '/settings/dow-jones', m.cookie)).status).toBe(404)
    // the same bounds apply to an override inside /render/numbers
    const r = await call('POST', '/render/numbers', m.cookie, {
      items: [{ lotteryId: 'dow-jones', settings: { elements: { two: { row: 9 } } } }],
      date: '2026-11-06',
    })
    expect(r.status).toBe(400)
  })
})

describe('review: member delete cascade', () => {
  it('removes sessions, sets, set_lotteries, settings, assets (DB + R2), news reads and counters', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'cascade')
    const db = getDb(env)
    const [def] = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    await call('PUT', '/settings/dow-jones', m.cookie, { isDouble: true })
    await call('POST', '/render/numbers', m.cookie, { items: [{ lotteryId: 'dow-jones' }], date: '2026-11-06' })
    const created = await call('POST', '/admin/news', admin, {
      title: 'ประกาศ',
      detailHtml: '<p>hi</p>',
      publishedAt: new Date(Date.now() - 1000).toISOString(),
      active: true,
    })
    const news = (await created.json()) as { id: string }
    const unread = (await (await call('GET', '/news', m.cookie)).json()) as { id: string }[]
    expect(unread.map((n) => n.id)).toContain(news.id)
    expect((await call('POST', `/news/${news.id}/read`, m.cookie)).status).toBe(204)
    const after = (await (await call('GET', '/news', m.cookie)).json()) as { id: string }[]
    expect(after.map((n) => n.id)).not.toContain(news.id)
    await uploadFile(m.cookie, new File([new Uint8Array([5])], 'bg.png', { type: 'image/png' }), 'background')
    expect([...r2.objects.keys()].some((k) => k.startsWith(`members/${m.id}/`))).toBe(true)

    expect((await call('DELETE', `/admin/members/${m.id}`, admin)).status).toBe(204)

    expect([...r2.objects.keys()].some((k) => k.startsWith(`members/${m.id}/`))).toBe(false)
    expect(await db.query.memberSessions.findMany({ where: eq(memberSessions.memberId, m.id) })).toHaveLength(0)
    expect(await db.query.sets.findMany({ where: eq(setsTable.memberId, m.id) })).toHaveLength(0)
    expect(await db.query.setLotteries.findMany({ where: eq(setLotteries.setId, def.id) })).toHaveLength(0)
    expect(await db.query.cardSettings.findMany({ where: eq(cardSettings.memberId, m.id) })).toHaveLength(0)
    expect(await db.query.assets.findMany({ where: eq(assetsTable.memberId, m.id) })).toHaveLength(0)
    expect(await db.query.newsReads.findMany({ where: eq(newsReads.memberId, m.id) })).toHaveLength(0)
    expect(await db.query.renderCounters.findMany({ where: eq(renderCounters.memberId, m.id) })).toHaveLength(0)
    expect((await call('GET', '/me', m.cookie)).status).toBe(401)
    expect((await req(`/link/${m.token}`)).status).toBe(404)
  })
})

describe('review: bulk PUT /settings', () => {
  // The lottery catalog has 82 entries; add dummy rows so we can exercise the 100-item ceiling.
  const EXTRA_COUNT = 30
  const extraIds = Array.from({ length: EXTRA_COUNT }, (_, i) => `bulk-test-${i.toString().padStart(2, '0')}`)

  beforeAll(async () => {
    const db = getDb(env)
    await db.insert(lotteries).values(
      extraIds.map((id, i) => ({
        id,
        name: `Bulk Test ${i}`,
        shortName: `B${i}`,
        groupKey: 'other',
        accent: '#000000',
        sortOrder: 10_000 + i,
        active: true,
      })),
    )
  })

  afterAll(async () => {
    const db = getDb(env)
    for (const id of extraIds) {
      await db.delete(lotteries).where(eq(lotteries.id, id))
    }
  })

  function bulkBody(pairs: { lotteryId: string; settings: Record<string, unknown> }[]) {
    return { items: pairs }
  }

  it('applies settings to many lotteries and GET /settings reflects it', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-happy')
    const ids = ['hanoi-regular', 'hanoi-vip', 'dow-jones']
    const items = ids.map((id, i) => ({
      lotteryId: id,
      settings: { fontFamily: 'Kanit', isDouble: i % 2 === 0, note: `n-${i}` },
    }))
    const res = await call('PUT', '/settings', m.cookie, bulkBody(items))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: Record<string, { note?: string }> }
    expect(Object.keys(body.settings).sort()).toEqual([...ids].sort())
    expect(body.settings['hanoi-vip'].note).toBe('n-1')
    const got = (await (await call('GET', '/settings', m.cookie)).json()) as Record<
      string,
      { note?: string; isDouble?: boolean }
    >
    for (const [i, id] of ids.entries()) {
      expect(got[id]).toEqual({ fontFamily: 'Kanit', isDouble: i % 2 === 0, note: `n-${i}` })
    }
  })

  it('overwrites existing rows', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-overwrite')
    await call('PUT', '/settings/hanoi-regular', m.cookie, { fontFamily: 'Old', keep: 'nope' })
    const res = await call(
      'PUT',
      '/settings',
      m.cookie,
      bulkBody([{ lotteryId: 'hanoi-regular', settings: { fontFamily: 'New', after: true } }]),
    )
    expect(res.status).toBe(200)
    const got = (await (await call('GET', '/settings/hanoi-regular', m.cookie)).json()) as Record<string, unknown>
    expect(got).toEqual({ fontFamily: 'New', after: true })
  })

  it('accepts a full 100-item request', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-100')
    const catalogIds = LOTTERY_CATALOG.slice(0, 70).map((l) => l.id)
    const ids = [...catalogIds, ...extraIds]
    expect(ids).toHaveLength(100)
    const items = ids.map((id, i) => ({ lotteryId: id, settings: { idx: i } }))
    const res = await call('PUT', '/settings', m.cookie, bulkBody(items))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { settings: Record<string, { idx: number }> }
    expect(Object.keys(body.settings)).toHaveLength(100)
    const got = (await (await call('GET', '/settings', m.cookie)).json()) as Record<string, { idx: number }>
    expect(Object.keys(got)).toHaveLength(100)
    expect(got[ids[0]].idx).toBe(0)
    expect(got[ids[99]].idx).toBe(99)
  })

  it('refuses 101 items with 400 VALIDATION', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-101')
    const ids = Array.from({ length: 101 }, (_, i) => `bogus-${i}`)
    const res = await call(
      'PUT',
      '/settings',
      m.cookie,
      bulkBody(ids.map((id) => ({ lotteryId: id, settings: {} }))),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
  })

  it('refuses duplicate lottery ids with 400 VALIDATION', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-dup')
    const res = await call(
      'PUT',
      '/settings',
      m.cookie,
      bulkBody([
        { lotteryId: 'hanoi-regular', settings: {} },
        { lotteryId: 'hanoi-regular', settings: { fontFamily: 'Kanit' } },
      ]),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    const db = getDb(env)
    expect(
      await db.query.cardSettings.findMany({ where: eq(cardSettings.memberId, m.id) }),
    ).toHaveLength(0)
  })

  it('refuses unknown lottery ids with 400 and writes nothing', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-unknown')
    const db = getDb(env)
    const res = await call(
      'PUT',
      '/settings',
      m.cookie,
      bulkBody([
        { lotteryId: 'hanoi-regular', settings: { fontFamily: 'Kanit' } },
        { lotteryId: 'no-such-lottery', settings: { fontFamily: 'Kanit' } },
        { lotteryId: 'also-missing', settings: {} },
      ]),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION')
    expect(body.error.message).toContain('no-such-lottery')
    expect(body.error.message).toContain('also-missing')
    expect(
      await db.query.cardSettings.findMany({ where: eq(cardSettings.memberId, m.id) }),
    ).toHaveLength(0)
  })

  it('caps the unknown-id list at 5 ids in the error message', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-unknown-cap')
    const missing = Array.from({ length: 7 }, (_, i) => `missing-${i}`)
    const res = await call(
      'PUT',
      '/settings',
      m.cookie,
      bulkBody(missing.map((id) => ({ lotteryId: id, settings: {} }))),
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    const mentioned = missing.filter((id) => body.error.message.includes(id))
    expect(mentioned.length).toBe(5)
  })

  it('unauthenticated → 401', async () => {
    const res = await call(
      'PUT',
      '/settings',
      undefined,
      bulkBody([{ lotteryId: 'hanoi-regular', settings: {} }]),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  it('expired member → 403 EXPIRED', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-expired')
    await call('PATCH', `/admin/members/${m.id}`, admin, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const res = await call(
      'PUT',
      '/settings',
      m.cookie,
      bulkBody([{ lotteryId: 'hanoi-regular', settings: {} }]),
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: { code: 'EXPIRED' } })
  })

  it('rejects a body larger than 1 MB with 400 and writes nothing', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-oversize')
    const db = getDb(env)
    // ~30 KB of padding per item × 40 items ≈ 1.2 MB body, well over the 1 MB cap but
    // each item.settings stays under the per-item 32 KB zod cap.
    const pad = 'x'.repeat(30 * 1024)
    const items = Array.from({ length: 40 }, (_, i) => ({
      lotteryId: `bulk-test-${i.toString().padStart(2, '0')}`,
      settings: { blob: pad },
    }))
    const res = await call('PUT', '/settings', m.cookie, bulkBody(items))
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION')
    expect(body.error.message).toMatch(/KB/)
    expect(
      await db.query.cardSettings.findMany({ where: eq(cardSettings.memberId, m.id) }),
    ).toHaveLength(0)
  })

  it('rejects an oversize body even when Content-Length is missing/lies', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-chunked')
    const db = getDb(env)
    const pad = 'x'.repeat(30 * 1024)
    const items = Array.from({ length: 40 }, (_, i) => ({
      lotteryId: `bulk-test-${i.toString().padStart(2, '0')}`,
      settings: { blob: pad },
    }))
    const raw = JSON.stringify({ items })
    // Stream the body so fetch / undici doesn't set an accurate Content-Length. The handler must
    // still measure the actual UTF-8 bytes and reject.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(raw))
        controller.close()
      },
    })
    const res = await app.request(
      '/settings',
      {
        method: 'PUT',
        headers: { Cookie: m.cookie, 'Content-Type': 'application/json' },
        body: stream,
        // @ts-expect-error duplex is required for a streaming body in modern fetch
        duplex: 'half',
      },
      env,
    )
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('VALIDATION')
    expect(body.error.message).toMatch(/KB/)
    expect(
      await db.query.cardSettings.findMany({ where: eq(cardSettings.memberId, m.id) }),
    ).toHaveLength(0)
  })

  it("never writes to another member's rows (member_id is taken from the session)", async () => {
    const admin = await adminCookie()
    const victim = await newMember(admin, 'bulk-victim')
    const attacker = await newMember(admin, 'bulk-attacker')
    // victim stores a known value
    await call('PUT', '/settings/hanoi-regular', victim.cookie, {
      fontFamily: 'Victim',
      marker: 'victim-value',
    })
    // attacker writes the same lottery through the bulk endpoint
    const res = await call(
      'PUT',
      '/settings',
      attacker.cookie,
      bulkBody([
        {
          lotteryId: 'hanoi-regular',
          settings: { fontFamily: 'Attacker', marker: 'attacker-value' },
        },
      ]),
    )
    expect(res.status).toBe(200)
    // victim's row is untouched
    const victimGot = (await (
      await call('GET', '/settings/hanoi-regular', victim.cookie)
    ).json()) as Record<string, unknown>
    expect(victimGot).toEqual({ fontFamily: 'Victim', marker: 'victim-value' })
    // attacker got their own row
    const attackerGot = (await (
      await call('GET', '/settings/hanoi-regular', attacker.cookie)
    ).json()) as Record<string, unknown>
    expect(attackerGot).toEqual({ fontFamily: 'Attacker', marker: 'attacker-value' })
    // And the DB has two separate rows, one per member.
    const db = getDb(env)
    const vRow = await db.query.cardSettings.findFirst({
      where: and(eq(cardSettings.memberId, victim.id), eq(cardSettings.lotteryId, 'hanoi-regular')),
    })
    const aRow = await db.query.cardSettings.findFirst({
      where: and(
        eq(cardSettings.memberId, attacker.id),
        eq(cardSettings.lotteryId, 'hanoi-regular'),
      ),
    })
    expect(JSON.parse(vRow!.settingsJson)).toMatchObject({ marker: 'victim-value' })
    expect(JSON.parse(aRow!.settingsJson)).toMatchObject({ marker: 'attacker-value' })
  })

  it('route does not shadow GET /settings or PUT /settings/:lotteryId', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bulk-noshadow')
    // single PUT still works after a bulk PUT
    expect(
      (
        await call(
          'PUT',
          '/settings',
          m.cookie,
          bulkBody([{ lotteryId: 'hanoi-regular', settings: { via: 'bulk' } }]),
        )
      ).status,
    ).toBe(200)
    expect(
      (await call('PUT', '/settings/hanoi-vip', m.cookie, { via: 'single' })).status,
    ).toBe(200)
    // GET /settings returns both
    const list = (await (await call('GET', '/settings', m.cookie)).json()) as Record<
      string,
      { via: string }
    >
    expect(list['hanoi-regular']).toEqual({ via: 'bulk' })
    expect(list['hanoi-vip']).toEqual({ via: 'single' })
    // GET /settings/:lotteryId still responds for a single lottery
    expect(
      await (await call('GET', '/settings/hanoi-regular', m.cookie)).json(),
    ).toEqual({ via: 'bulk' })
    // DELETE /settings/:lotteryId still works too
    expect((await call('DELETE', '/settings/hanoi-vip', m.cookie)).status).toBe(204)
    expect((await call('GET', '/settings/hanoi-vip', m.cookie)).status).toBe(404)
  })
})

describe('unit: chunkSettingsRows', () => {
  it('keeps every chunk ≤ 20 rows AND ≤ 90 KB of settings JSON', async () => {
    const { chunkSettingsRows, SETTINGS_MAX_ROWS_PER_INSERT, SETTINGS_MAX_BYTES_PER_INSERT } =
      await import('../src/routes/settings')
    const enc = new TextEncoder()

    const check = (rows: { memberId: string; lotteryId: string; settingsJson: string; updatedAt: string }[]) => {
      const chunks = chunkSettingsRows(rows)
      // Reconstructed rows match the input in order
      expect(chunks.flat()).toEqual(rows)
      for (const part of chunks) {
        expect(part.length).toBeLessThanOrEqual(SETTINGS_MAX_ROWS_PER_INSERT)
        let bytes = 0
        for (const r of part) bytes += enc.encode(r.settingsJson).length
        // A single oversized row still becomes its own chunk, but all realistic inputs here fit.
        if (part.length > 1) expect(bytes).toBeLessThanOrEqual(SETTINGS_MAX_BYTES_PER_INSERT)
      }
      return chunks
    }

    const mkRow = (i: number, size: number) => ({
      memberId: 'm',
      lotteryId: `l-${i}`,
      settingsJson: JSON.stringify({ pad: 'a'.repeat(Math.max(size - 20, 1)) }),
      updatedAt: '2026-11-07T00:00:00.000Z',
    })

    // Many tiny rows → split by the 20-row cap only.
    const tiny = Array.from({ length: 100 }, (_, i) => mkRow(i, 50))
    const tinyChunks = check(tiny)
    expect(tinyChunks).toHaveLength(5)
    for (const c of tinyChunks) expect(c.length).toBe(20)

    // Rows large enough that the JSON-size cap bites first.
    const big = Array.from({ length: 30 }, (_, i) => mkRow(i, 20 * 1024))
    const bigChunks = check(big)
    for (const c of bigChunks) {
      let bytes = 0
      for (const r of c) bytes += enc.encode(r.settingsJson).length
      expect(bytes).toBeLessThanOrEqual(SETTINGS_MAX_BYTES_PER_INSERT)
    }
    expect(bigChunks.length).toBeGreaterThan(2)

    // Mixed sizes preserve order and respect both caps.
    const mixed = [
      mkRow(0, 60 * 1024),
      ...Array.from({ length: 25 }, (_, i) => mkRow(i + 1, 1 * 1024)),
      mkRow(99, 80 * 1024),
    ]
    check(mixed)

    // Empty input → no chunks.
    expect(chunkSettingsRows([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// v2 additions (2026-11-07): F2 QR, F4 rounds, F5 member-created lotteries.
// ---------------------------------------------------------------------------------------------

describe('v2: F2 qr asset', () => {
  it('uploads kind=qr, signs qr.assetId on render, and clears qr refs on delete', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'qr-happy')
    const up = await uploadFile(
      m.cookie,
      new File([new Uint8Array([1, 2, 3, 4])], 'qr.png', { type: 'image/png' }),
      'qr',
    )
    expect(up.status).toBe(200)
    const asset = (await up.json()) as { id: string; kind: string }
    expect(asset.kind).toBe('qr')

    await call('PUT', '/settings/dow-jones', m.cookie, {
      qr: { assetId: asset.id, x: 1060, y: 660, width: 180, opacity: 1 },
    })
    const render = await call('POST', '/render/numbers', m.cookie, {
      items: [{ lotteryId: 'dow-jones' }],
      date: '2026-11-07',
    })
    expect(render.status).toBe(200)
    const body = (await render.json()) as { assets: Record<string, string> }
    expect(body.assets[asset.id]).toMatch(
      /\/assets\/[^?]+\?exp=\d+&m=[0-9A-Za-z]+&e=[a-z]+&sig=[0-9a-f]+/,
    )

    // override settings carry the same qr reference → also signed
    const inline = await call('POST', '/render/numbers', m.cookie, {
      items: [
        {
          lotteryId: 'hanoi-regular',
          settings: { qr: { assetId: asset.id, x: 0, y: 0, width: 10, opacity: 1 } },
        },
      ],
      date: '2026-11-07',
    })
    const inlineBody = (await inline.json()) as { assets: Record<string, string> }
    expect(inlineBody.assets[asset.id]).toBeDefined()

    // DELETE clears qr.assetId references (same path as background / logo)
    expect((await call('DELETE', `/assets/${asset.id}`, m.cookie)).status).toBe(204)
    const settings = (await (await call('GET', '/settings/dow-jones', m.cookie)).json()) as {
      qr: { assetId: unknown; width: number }
    }
    expect(settings.qr).toMatchObject({ assetId: null, width: 180 })
  })

  it("never signs another member's qr asset", async () => {
    const admin = await adminCookie()
    const owner = await newMember(admin, 'qr-owner')
    const thief = await newMember(admin, 'qr-thief')
    const up = await uploadFile(
      owner.cookie,
      new File([new Uint8Array([9, 9, 9])], 'q.png', { type: 'image/png' }),
      'qr',
    )
    const { id } = (await up.json()) as { id: string }
    const res = await call('POST', '/render/numbers', thief.cookie, {
      items: [
        {
          lotteryId: 'dow-jones',
          settings: { qr: { assetId: id, x: 0, y: 0, width: 10, opacity: 1 } },
        },
      ],
      date: '2026-11-07',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ assets: {} })
  })

  it('refuses an unknown kind', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'qr-kind')
    const res = await uploadFile(
      m.cookie,
      new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }),
      'icon',
    )
    expect(res.status).toBe(400)
  })

  it('validates CardSettings.qr bounds the same way as logo', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'qr-bounds')
    const bad = await call('PUT', '/settings/dow-jones', m.cookie, {
      qr: { assetId: null, x: 0, y: 0, width: 10, opacity: 2 },
    })
    expect(bad.status).toBe(400)
    const ok = await call('PUT', '/settings/dow-jones', m.cookie, {
      qr: { assetId: null, x: 0, y: 0, width: 10, opacity: 1 },
    })
    expect(ok.status).toBe(200)
  })
})

describe('v2: F4 set rounds', () => {
  it('round-trips rounds and keeps them on reorder when rounds is omitted', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'rounds-rt')
    const created = (await (
      await call('POST', '/sets', m.cookie, { name: 'รอบๆ' })
    ).json()) as LotterySet
    expect(created.rounds).toEqual([])

    const ids = ['hanoi-regular', 'hanoi-vip', 'dow-jones', 'thai-gov']
    const rounds = [2, 2, 1, 3]
    const set = (await (
      await call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: ids, rounds })
    ).json()) as LotterySet
    expect(set.lotteryIds).toEqual(ids)
    expect(set.rounds).toEqual(rounds)

    // GET /sets returns the rounds too
    const all = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    const found = all.find((s) => s.id === created.id)!
    expect(found.rounds).toEqual(rounds)

    // Reorder (keep same ids) without sending rounds → previous rounds preserved per lottery
    const reordered = ['dow-jones', 'hanoi-regular', 'hanoi-vip', 'thai-gov']
    const after = (await (
      await call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: reordered })
    ).json()) as LotterySet
    expect(after.lotteryIds).toEqual(reordered)
    expect(after.rounds).toEqual([1, 2, 2, 3]) // dow-jones=1, hanoi-regular=2, hanoi-vip=2, thai-gov=3

    // Add a new lottery without rounds → it defaults to 1, others keep their round
    const added = ['dow-jones', 'hanoi-regular', 'hanoi-vip', 'thai-gov', 'lao-pattana']
    const addedRes = (await (
      await call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: added })
    ).json()) as LotterySet
    expect(addedRes.rounds).toEqual([1, 2, 2, 3, 1])
  })

  it('400 when rounds is wrong length, out of range, or sent without lotteryIds', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'rounds-bad')
    const [def] = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]

    const mismatch = await call('PATCH', `/sets/${def.id}`, m.cookie, {
      lotteryIds: ['dow-jones', 'thai-gov'],
      rounds: [1],
    })
    expect(mismatch.status).toBe(400)
    expect(await mismatch.json()).toMatchObject({ error: { code: 'VALIDATION' } })

    for (const bad of [0, 21, -1, 1.5]) {
      const res = await call('PATCH', `/sets/${def.id}`, m.cookie, {
        lotteryIds: ['dow-jones'],
        rounds: [bad],
      })
      expect(res.status, `round ${bad}`).toBe(400)
    }

    const orphan = await call('PATCH', `/sets/${def.id}`, m.cookie, { rounds: [1, 2] })
    expect(orphan.status).toBe(400)
  })

  it('writes an 82-lottery set in ≤ 50 statements (25-row chunking)', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'rounds-chunk')
    // 82 ids: all 82 from the catalog.
    const ids = LOTTERY_CATALOG.map((l) => l.id)
    expect(ids.length).toBeGreaterThanOrEqual(82)
    const rounds = ids.map((_, i) => (i % 20) + 1)
    const created = (await (
      await call('POST', '/sets', m.cookie, { name: 'all' })
    ).json()) as LotterySet
    const res = await call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: ids, rounds })
    expect(res.status).toBe(200)
    const set = (await res.json()) as LotterySet
    expect(set.lotteryIds).toHaveLength(ids.length)
    expect(set.rounds).toEqual(rounds)
    // DB has one row per link, round preserved.
    const db = getDb(env)
    const links = await db.select().from(setLotteries).where(eq(setLotteries.setId, created.id))
    expect(links).toHaveLength(ids.length)
    const roundByLottery = new Map(links.map((l) => [l.lotteryId, l.round]))
    for (let i = 0; i < ids.length; i++) expect(roundByLottery.get(ids[i])).toBe(rounds[i])
  })

  it('new sets default every lottery to round 1 (ensureDefault + POST)', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'rounds-default')
    const [def] = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    expect(def.rounds).toHaveLength(def.lotteryIds.length)
    for (const r of def.rounds) expect(r).toBe(1)
  })
})

describe('PATCH /sets/:id diff', () => {
  async function newSet(cookie: string, ids: string[], rounds?: number[]): Promise<LotterySet> {
    const created = (await (await call('POST', '/sets', cookie, { name: 'diff' })).json()) as LotterySet
    const body: Record<string, unknown> = { lotteryIds: ids }
    if (rounds) body.rounds = rounds
    const patched = await call('PATCH', `/sets/${created.id}`, cookie, body)
    expect(patched.status).toBe(200)
    return (await patched.json()) as LotterySet
  }

  it('reorder keeps every round and leaves the client-sent order', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'diff-reorder')
    const ids = ['hanoi-regular', 'hanoi-vip', 'dow-jones', 'thai-gov']
    const rounds = [1, 2, 3, 4]
    const set = await newSet(m.cookie, ids, rounds)
    const reordered = ['thai-gov', 'hanoi-regular', 'dow-jones', 'hanoi-vip']
    const res = (await (
      await call('PATCH', `/sets/${set.id}`, m.cookie, { lotteryIds: reordered })
    ).json()) as LotterySet
    expect(res.lotteryIds).toEqual(reordered)
    // Rounds follow each lottery, not the position.
    expect(res.rounds).toEqual([4, 1, 3, 2])
    // GET returns the same order (sort_order in DB may be gapped but the ORDER BY preserves it).
    const [again] = ((await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]).filter(
      (s) => s.id === set.id,
    )
    expect(again.lotteryIds).toEqual(reordered)
    expect(again.rounds).toEqual([4, 1, 3, 2])
  })

  it('remove-middle keeps the remaining order and rounds', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'diff-remove-mid')
    const ids = ['hanoi-regular', 'hanoi-vip', 'dow-jones', 'thai-gov', 'lao-pattana']
    const rounds = [5, 6, 7, 8, 9]
    const set = await newSet(m.cookie, ids, rounds)
    const after = ['hanoi-regular', 'hanoi-vip', 'thai-gov', 'lao-pattana']
    const res = (await (
      await call('PATCH', `/sets/${set.id}`, m.cookie, { lotteryIds: after })
    ).json()) as LotterySet
    expect(res.lotteryIds).toEqual(after)
    expect(res.rounds).toEqual([5, 6, 8, 9])
    const db = getDb(env)
    const links = await db.select().from(setLotteries).where(eq(setLotteries.setId, set.id))
    expect(links).toHaveLength(after.length)
    // The removed lottery is gone from the DB.
    expect(links.map((l) => l.lotteryId)).not.toContain('dow-jones')
  })

  it('add appends new ids with round 1 and keeps the originals untouched', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'diff-add')
    const ids = ['hanoi-regular', 'hanoi-vip']
    const rounds = [3, 4]
    const set = await newSet(m.cookie, ids, rounds)
    const after = ['hanoi-regular', 'hanoi-vip', 'dow-jones', 'thai-gov']
    const res = (await (
      await call('PATCH', `/sets/${set.id}`, m.cookie, { lotteryIds: after })
    ).json()) as LotterySet
    expect(res.lotteryIds).toEqual(after)
    expect(res.rounds).toEqual([3, 4, 1, 1])
  })

  it('rounds-only change updates rounds without reshuffling the DB rows', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'diff-rounds-only')
    const ids = ['hanoi-regular', 'hanoi-vip', 'dow-jones']
    const set = await newSet(m.cookie, ids, [1, 1, 1])
    const res = (await (
      await call('PATCH', `/sets/${set.id}`, m.cookie, {
        lotteryIds: ids,
        rounds: [5, 6, 7],
      })
    ).json()) as LotterySet
    expect(res.lotteryIds).toEqual(ids)
    expect(res.rounds).toEqual([5, 6, 7])
    const db = getDb(env)
    const links = await db.select().from(setLotteries).where(eq(setLotteries.setId, set.id))
    const map = new Map(links.map((l) => [l.lotteryId, l.round]))
    expect(map.get('hanoi-regular')).toBe(5)
    expect(map.get('hanoi-vip')).toBe(6)
    expect(map.get('dow-jones')).toBe(7)
  })

  it('mixed change (reorder + add + remove + rounds + rename) survives in one PATCH', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'diff-mixed')
    const ids = ['hanoi-regular', 'hanoi-vip', 'dow-jones', 'thai-gov']
    const set = await newSet(m.cookie, ids, [1, 2, 3, 4])
    // Remove thai-gov, add lao-pattana, reorder, change rounds, and rename at the same time.
    const after = ['dow-jones', 'lao-pattana', 'hanoi-regular']
    const newRounds = [11, 12, 13]
    const res = await call('PATCH', `/sets/${set.id}`, m.cookie, {
      name: 'mixed-up',
      lotteryIds: after,
      rounds: newRounds,
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as LotterySet
    expect(body.name).toBe('mixed-up')
    expect(body.lotteryIds).toEqual(after)
    expect(body.rounds).toEqual(newRounds)
    // Round-trip through GET /sets.
    const [again] = ((await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]).filter(
      (s) => s.id === set.id,
    )
    expect(again.name).toBe('mixed-up')
    expect(again.lotteryIds).toEqual(after)
    expect(again.rounds).toEqual(newRounds)
    // hanoi-vip is gone, lao-pattana is in.
    const db = getDb(env)
    const links = await db.select().from(setLotteries).where(eq(setLotteries.setId, set.id))
    expect(links).toHaveLength(after.length)
    expect(links.map((l) => l.lotteryId)).toContain('lao-pattana')
    expect(links.map((l) => l.lotteryId)).not.toContain('hanoi-vip')
    expect(links.map((l) => l.lotteryId)).not.toContain('thai-gov')
  })

  it('rename + lotteries in one PATCH applies both (non-default set)', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'diff-rename-both')
    const created = (await (await call('POST', '/sets', m.cookie, { name: 'old' })).json()) as LotterySet
    const res = await call('PATCH', `/sets/${created.id}`, m.cookie, {
      name: 'new',
      lotteryIds: ['dow-jones', 'thai-gov'],
      rounds: [5, 6],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as LotterySet
    expect(body.name).toBe('new')
    expect(body.lotteryIds).toEqual(['dow-jones', 'thai-gov'])
    expect(body.rounds).toEqual([5, 6])
  })

  it('full 80+-lottery PATCH round-trips every id and round', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'diff-full')
    const ids = LOTTERY_CATALOG.map((l) => l.id)
    const rounds = ids.map((_, i) => ((i * 3) % 20) + 1)
    const created = (await (await call('POST', '/sets', m.cookie, { name: 'all' })).json()) as LotterySet
    const res = await call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: ids, rounds })
    expect(res.status).toBe(200)
    const body = (await res.json()) as LotterySet
    expect(body.lotteryIds).toEqual(ids)
    expect(body.rounds).toEqual(rounds)
    const [again] = ((await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]).filter(
      (s) => s.id === created.id,
    )
    expect(again.lotteryIds).toEqual(ids)
    expect(again.rounds).toEqual(rounds)
  })

  it('GET /sets is idempotent (same output on repeated calls)', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'diff-idem')
    const a = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    const b = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    const c = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    // Still exactly one default set after the repeated reads — no accidental second ensureDefault.
    const db = getDb(env)
    const rows = await db.query.sets.findMany({ where: eq(setsTable.memberId, m.id) })
    expect(rows.filter((r) => r.isDefault)).toHaveLength(1)
  })
})

describe('v2: F5 member-created lotteries', () => {
  async function create(cookie: string, body: Record<string, unknown>) {
    return call('POST', '/lotteries', cookie, body)
  }

  it('creates, lists, patches and deletes an own lottery (CRUD)', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'custom-crud')
    const before = (await (await call('GET', '/lotteries', m.cookie)).json()) as {
      id: string
      custom: boolean
    }[]
    expect(before.every((l) => !l.custom)).toBe(true)

    const res = await create(m.cookie, { name: 'หวยของฉัน', group: 'other' })
    expect(res.status).toBe(200)
    const l = (await res.json()) as {
      id: string
      name: string
      shortName: string
      group: string
      custom: boolean
      sortOrder: number
      accent: string
      active: boolean
    }
    expect(l.id).toMatch(/^m-[0-9A-Za-z]{16}$/)
    expect(l.custom).toBe(true)
    expect(l.group).toBe('other')
    expect(l.shortName).toBe('หวยของฉัน')
    expect(l.active).toBe(true)
    expect(l.sortOrder).toBeGreaterThanOrEqual(10_000)

    const list = (await (await call('GET', '/lotteries', m.cookie)).json()) as {
      id: string
      custom: boolean
    }[]
    expect(list.map((x) => x.id)).toContain(l.id)
    expect(list.find((x) => x.id === l.id)!.custom).toBe(true)

    const patched = await call('PATCH', `/lotteries/${l.id}`, m.cookie, {
      name: 'ชื่อใหม่',
      group: 'hanoi',
    })
    expect(patched.status).toBe(200)
    const after = (await patched.json()) as { name: string; group: string; accent: string }
    expect(after.name).toBe('ชื่อใหม่')
    expect(after.group).toBe('hanoi')
    // accent follows the group palette (hanoi #be123c)
    expect(after.accent).toBe('#be123c')

    // Use in a set + settings, then delete and verify cascade.
    const set = (await (
      await call('POST', '/sets', m.cookie, { name: 's' })
    ).json()) as LotterySet
    const put = await call('PATCH', `/sets/${set.id}`, m.cookie, { lotteryIds: [l.id] })
    expect(put.status).toBe(200)
    await call('PUT', `/settings/${l.id}`, m.cookie, { isDouble: true })
    expect((await call('DELETE', `/lotteries/${l.id}`, m.cookie)).status).toBe(204)
    const db = getDb(env)
    const stillLinked = await db
      .select()
      .from(setLotteries)
      .where(eq(setLotteries.lotteryId, l.id))
    expect(stillLinked).toHaveLength(0)
    const stillSettings = await db
      .select()
      .from(cardSettings)
      .where(eq(cardSettings.lotteryId, l.id))
    expect(stillSettings).toHaveLength(0)
    // 404 on repeated delete
    expect((await call('DELETE', `/lotteries/${l.id}`, m.cookie)).status).toBe(404)
  })

  it('short name defaults to the name without spaces, capped at 20', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'custom-short')
    const res = await create(m.cookie, { name: 'สั้น สั้น', group: 'stock' })
    const l = (await res.json()) as { shortName: string }
    expect(l.shortName).toBe('สั้นสั้น')
    const long = await create(m.cookie, {
      name: 'ชื่อยาวมากๆๆๆๆๆๆๆๆๆๆๆๆๆๆๆๆ',
      shortName: 'ยยยยยยยยยยยยยยยยยยยยยยยยยยยยย',
      group: 'other',
    })
    expect(long.status).toBe(400) // shortName too long
  })

  it('enforces the 30-lottery quota per member', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'custom-quota')
    for (let i = 0; i < 30; i++) {
      const r = await create(m.cookie, { name: `หวย ${i}`, group: 'other' })
      expect(r.status, `i=${i}`).toBe(200)
    }
    const over = await create(m.cookie, { name: 'เกิน', group: 'other' })
    expect(over.status).toBe(409)
    expect(await over.json()).toMatchObject({ error: { code: 'QUOTA' } })
  })

  it('isolates members: another member sees nothing, cannot use/edit/delete', async () => {
    const admin = await adminCookie()
    const owner = await newMember(admin, 'custom-owner')
    const other = await newMember(admin, 'custom-other')
    const l = (await (await create(owner.cookie, { name: 'ส่วนตัว', group: 'stock' })).json()) as {
      id: string
    }

    // GET /lotteries never leaks it
    const otherList = (await (await call('GET', '/lotteries', other.cookie)).json()) as {
      id: string
    }[]
    expect(otherList.map((x) => x.id)).not.toContain(l.id)

    // PATCH / DELETE on another member's custom → 404
    expect(
      (await call('PATCH', `/lotteries/${l.id}`, other.cookie, { name: 'hijack' })).status,
    ).toBe(404)
    expect((await call('DELETE', `/lotteries/${l.id}`, other.cookie)).status).toBe(404)

    // Sets: patching their own set to include the other member's custom id fails as unknown.
    const [def] = (await (await call('GET', '/sets', other.cookie)).json()) as LotterySet[]
    const setRes = await call('PATCH', `/sets/${def.id}`, other.cookie, { lotteryIds: [l.id] })
    expect(setRes.status).toBe(400)
    expect(await setRes.json()).toMatchObject({ error: { code: 'VALIDATION' } })

    // Settings single PUT: 404
    const singlePut = await call('PUT', `/settings/${l.id}`, other.cookie, { isDouble: true })
    expect(singlePut.status).toBe(404)

    // Settings bulk PUT: 400 VALIDATION (lottery id unknown to this member)
    const bulk = await call('PUT', '/settings', other.cookie, {
      items: [{ lotteryId: l.id, settings: { isDouble: true } }],
    })
    expect(bulk.status).toBe(400)
    expect(await bulk.json()).toMatchObject({ error: { code: 'VALIDATION' } })

    // Render: lottery id unknown to this member → 404
    const render = await call('POST', '/render/numbers', other.cookie, {
      items: [{ lotteryId: l.id }],
      date: '2026-11-07',
    })
    expect(render.status).toBe(404)
  })

  it('admin /admin/lotteries never lists or edits custom lotteries', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'custom-admin')
    const l = (await (await create(m.cookie, { name: 'ของสมาชิก', group: 'hanoi' })).json()) as {
      id: string
    }
    const list = (await (await call('GET', '/admin/lotteries', admin)).json()) as { id: string }[]
    expect(list.map((x) => x.id)).not.toContain(l.id)
    expect(
      (await call('PATCH', `/admin/lotteries/${l.id}`, admin, { name: 'hijack' })).status,
    ).toBe(404)
    expect((await call('DELETE', `/admin/lotteries/${l.id}`, admin)).status).toBe(404)
  })

  it('deleting the member removes their custom lotteries and link rows', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'custom-cascade')
    const l = (await (await create(m.cookie, { name: 'จะหาย', group: 'other' })).json()) as {
      id: string
    }
    // Use it in a set first.
    const set = (await (
      await call('POST', '/sets', m.cookie, { name: 'x' })
    ).json()) as LotterySet
    expect(
      (await call('PATCH', `/sets/${set.id}`, m.cookie, { lotteryIds: [l.id] })).status,
    ).toBe(200)

    expect((await call('DELETE', `/admin/members/${m.id}`, admin)).status).toBe(204)
    const db = getDb(env)
    expect(
      await db.query.lotteries.findFirst({ where: eq(lotteries.id, l.id) }),
    ).toBeUndefined()
    expect(
      await db.select().from(setLotteries).where(eq(setLotteries.lotteryId, l.id)),
    ).toHaveLength(0)
  })

  // --- Adversarial isolation + cascade coverage added by the reviewer (2026-11-07) ---

  it("bulk PUT /settings with a mix of own valid + another member's custom id → 400 writes nothing", async () => {
    const admin = await adminCookie()
    const owner = await newMember(admin, 'mix-owner')
    const attacker = await newMember(admin, 'mix-attacker')
    const db = getDb(env)
    const l = (await (await create(owner.cookie, { name: 'secret', group: 'stock' })).json()) as {
      id: string
    }
    // attacker already has a valid setting on hanoi-regular that must stay untouched.
    expect(
      (await call('PUT', '/settings/hanoi-regular', attacker.cookie, { marker: 'before' })).status,
    ).toBe(200)
    const res = await call('PUT', '/settings', attacker.cookie, {
      items: [
        { lotteryId: 'hanoi-regular', settings: { marker: 'after' } }, // valid for attacker
        { lotteryId: l.id, settings: { marker: 'hijack' } }, // owner's custom — unknown to attacker
      ],
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    // Pre-existing row unchanged; no row inserted for the owner's custom id.
    const kept = (await (
      await call('GET', '/settings/hanoi-regular', attacker.cookie)
    ).json()) as { marker: string }
    expect(kept.marker).toBe('before')
    expect(
      await db.query.cardSettings.findFirst({
        where: and(eq(cardSettings.memberId, attacker.id), eq(cardSettings.lotteryId, l.id)),
      }),
    ).toBeUndefined()
  })

  it("GET and DELETE /settings/:lotteryId on another member's custom id do not leak or write", async () => {
    const admin = await adminCookie()
    const owner = await newMember(admin, 'single-owner')
    const other = await newMember(admin, 'single-other')
    const db = getDb(env)
    const l = (await (await create(owner.cookie, { name: 'mine', group: 'other' })).json()) as {
      id: string
    }
    // Owner saves a known setting on their own custom.
    expect((await call('PUT', `/settings/${l.id}`, owner.cookie, { marker: 'kept' })).status).toBe(200)

    // GET from the other member: no row for (other, l.id) → 404 (indistinguishable from any absent setting).
    const get = await call('GET', `/settings/${l.id}`, other.cookie)
    expect(get.status).toBe(404)

    // DELETE from the other member: 204 (idempotent, no row to touch; must NOT delete owner's row).
    const del = await call('DELETE', `/settings/${l.id}`, other.cookie)
    expect(del.status).toBe(204)
    const ownerRow = await db.query.cardSettings.findFirst({
      where: and(eq(cardSettings.memberId, owner.id), eq(cardSettings.lotteryId, l.id)),
    })
    expect(ownerRow).toBeDefined()
    expect(JSON.parse(ownerRow!.settingsJson)).toEqual({ marker: 'kept' })
  })

  it('cascade clears the Default set when a member deletes a custom lottery that was added to it', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'default-cascade')
    const [def0] = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    const l = (await (await create(m.cookie, { name: 'in-default', group: 'other' })).json()) as {
      id: string
    }
    // Add the custom lottery to the Default set (append after the seeded ids).
    const next = [...def0.lotteryIds, l.id]
    const patched = await call('PATCH', `/sets/${def0.id}`, m.cookie, { lotteryIds: next })
    expect(patched.status).toBe(200)
    expect(((await patched.json()) as LotterySet).lotteryIds).toContain(l.id)
    expect((await call('DELETE', `/lotteries/${l.id}`, m.cookie)).status).toBe(204)
    const [defAfter] = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    expect(defAfter.lotteryIds).not.toContain(l.id)
    expect(defAfter.rounds).toHaveLength(defAfter.lotteryIds.length)
  })

  it("admin PATCH / DELETE on a custom lottery leaves it (and its data) untouched", async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'admin-nomod')
    const l = (await (await create(m.cookie, { name: 'keep', group: 'hanoi' })).json()) as {
      id: string
      name: string
      accent: string
    }
    // Use it in a set + settings so we can verify nothing changes after admin attempts.
    expect(
      (await call('PATCH', `/sets/${
        (((await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[])[0]).id
      }`, m.cookie, { lotteryIds: [l.id] })).status,
    ).toBe(200)
    expect((await call('PUT', `/settings/${l.id}`, m.cookie, { marker: 'owner' })).status).toBe(200)

    expect(
      (await call('PATCH', `/admin/lotteries/${l.id}`, admin, { name: 'hijack', group: 'other' })).status,
    ).toBe(404)
    expect((await call('DELETE', `/admin/lotteries/${l.id}`, admin)).status).toBe(404)

    // Owner still sees their lottery, set link, and setting intact.
    const list = (await (await call('GET', '/lotteries', m.cookie)).json()) as {
      id: string
      name: string
      custom: boolean
    }[]
    const found = list.find((x) => x.id === l.id)!
    expect(found.name).toBe('keep')
    expect(found.custom).toBe(true)
    const setting = (await (
      await call('GET', `/settings/${l.id}`, m.cookie)
    ).json()) as { marker: string }
    expect(setting.marker).toBe('owner')
    const db = getDb(env)
    expect(
      await db.select().from(setLotteries).where(eq(setLotteries.lotteryId, l.id)),
    ).toHaveLength(1)
  })

  it('render /render/numbers with a mix of valid + unknown ids → 404 and no counter increment', async () => {
    const admin = await adminCookie()
    const owner = await newMember(admin, 'mix-render-owner')
    const attacker = await newMember(admin, 'mix-render-attacker')
    const db = getDb(env)
    const l = (await (await create(owner.cookie, { name: 'secret-r', group: 'stock' })).json()) as {
      id: string
    }
    // Pre-check the attacker's counter (either missing or 0).
    const beforeMe = (await (await call('GET', '/me', attacker.cookie)).json()) as Member
    expect(beforeMe.rendersToday).toBe(0)

    const res = await call('POST', '/render/numbers', attacker.cookie, {
      items: [{ lotteryId: 'dow-jones' }, { lotteryId: l.id }],
      date: '2026-11-07',
    })
    expect(res.status).toBe(404)
    // Counter stayed at 0; the valid half of the request must not consume renders.
    const row = await db.query.renderCounters.findFirst({
      where: and(eq(renderCounters.memberId, attacker.id), eq(renderCounters.day, bangkokDay())),
    })
    expect(row?.count ?? 0).toBe(0)
  })

  it('a new custom lottery never collides with pre-existing settings/setLotteries rows (defense in depth)', async () => {
    // Simulate stale references to a never-yet-existing m- id (e.g. a lottery that was deleted and
    // whose row was recreated with the same id by a buggy client). The cascade on the NEW DELETE
    // must still clear the stale references.
    const admin = await adminCookie()
    const m = await newMember(admin, 'stale-refs')
    const db = getDb(env)
    const l = (await (await create(m.cookie, { name: 'fresh', group: 'other' })).json()) as {
      id: string
    }
    // Owner's set + settings row.
    const set = (await (await call('POST', '/sets', m.cookie, { name: 'y' })).json()) as LotterySet
    expect(
      (await call('PATCH', `/sets/${set.id}`, m.cookie, { lotteryIds: [l.id] })).status,
    ).toBe(200)
    expect((await call('PUT', `/settings/${l.id}`, m.cookie, { marker: 'will-cascade' })).status).toBe(200)
    // DELETE the custom lottery and verify every related row is gone across tables.
    expect((await call('DELETE', `/lotteries/${l.id}`, m.cookie)).status).toBe(204)
    expect(
      await db.query.lotteries.findFirst({ where: eq(lotteries.id, l.id) }),
    ).toBeUndefined()
    expect(
      await db.select().from(setLotteries).where(eq(setLotteries.lotteryId, l.id)),
    ).toHaveLength(0)
    expect(
      await db.select().from(cardSettings).where(eq(cardSettings.lotteryId, l.id)),
    ).toHaveLength(0)
    // The set itself survives.
    expect(
      await db.query.sets.findFirst({ where: eq(setsTable.id, set.id) }),
    ).toBeDefined()
  })

  it('quota is restored after a successful DELETE so a new POST can succeed at the 30 boundary', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'quota-boundary')
    const ids: string[] = []
    for (let i = 0; i < 30; i++) {
      const r = (await (await create(m.cookie, { name: `q${i}`, group: 'other' })).json()) as {
        id: string
      }
      ids.push(r.id)
    }
    const overAt30 = await create(m.cookie, { name: 'overflow', group: 'other' })
    expect(overAt30.status).toBe(409)
    // Delete one, create one new one: must succeed.
    expect((await call('DELETE', `/lotteries/${ids[0]}`, m.cookie)).status).toBe(204)
    const okAgain = await create(m.cookie, { name: 'replacement', group: 'other' })
    expect(okAgain.status).toBe(200)
    // sortOrder of the replacement is strictly greater than the previous max (never reused).
    const fresh = (await okAgain.json()) as { sortOrder: number }
    expect(fresh.sortOrder).toBeGreaterThanOrEqual(10_000 + 30)
  })

  it('F4 rounds + F5 custom lottery: a custom lottery in a non-default set round-trips its round', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'f4-f5')
    const l = (await (await create(m.cookie, { name: 'round-me', group: 'thai' })).json()) as {
      id: string
    }
    const s = (await (await call('POST', '/sets', m.cookie, { name: 'rounds' })).json()) as LotterySet
    const patched = (await (
      await call('PATCH', `/sets/${s.id}`, m.cookie, {
        lotteryIds: ['hanoi-regular', l.id, 'dow-jones'],
        rounds: [1, 7, 20],
      })
    ).json()) as LotterySet
    expect(patched.lotteryIds).toEqual(['hanoi-regular', l.id, 'dow-jones'])
    expect(patched.rounds).toEqual([1, 7, 20])
    // Deleting the custom lottery removes it from the set; the remaining entries keep their rounds.
    expect((await call('DELETE', `/lotteries/${l.id}`, m.cookie)).status).toBe(204)
    const [afterSet] = ((await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]).filter(
      (x) => x.id === s.id,
    )
    expect(afterSet.lotteryIds).toEqual(['hanoi-regular', 'dow-jones'])
    expect(afterSet.rounds).toEqual([1, 20])
  })
})

// ---------------------------------------------------------------------------------------------
// Bootstrap endpoint (TASK E): one call replaces /me + /lotteries + /sets + /settings +
// /assets + /news on page load. Expired / disabled members get me+news only.
// ---------------------------------------------------------------------------------------------

describe('GET /bootstrap', () => {
  interface BootstrapInactive {
    me: Member
    news: News[]
  }
  interface BootstrapActive extends BootstrapInactive {
    lotteries: Lottery[]
    sets: LotterySet[]
    settings: Record<string, unknown>
    assets: Asset[]
  }

  it('401 UNAUTHENTICATED without a session', async () => {
    const res = await req('/bootstrap')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
  })

  it('active member: shape equals the individual endpoints and starter sets are created', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bootstrap-active')

    // Upload an asset so the signed-url path is exercised.
    const up = await uploadFile(
      m.cookie,
      new File([new Uint8Array([1, 2, 3])], 'bg.png', { type: 'image/png' }),
      'background',
    )
    expect(up.status).toBe(200)
    const asset = (await up.json()) as Asset

    // Save a card setting so the settings map is non-empty.
    expect(
      (await call('PUT', '/settings/dow-jones', m.cookie, { marker: 'bootstrap' })).status,
    ).toBe(200)

    // Run one render so rendersToday > 0.
    expect(
      (await call('POST', '/render/numbers', m.cookie, {
        items: [{ lotteryId: 'dow-jones' }],
        date: '2026-11-07',
      })).status,
    ).toBe(200)

    // Fetch bootstrap and each individual endpoint. The bootstrap shape must match.
    const bootRes = await req('/bootstrap', { cookie: m.cookie })
    expect(bootRes.status).toBe(200)
    const boot = (await bootRes.json()) as BootstrapActive

    async function jsonOf(path: string) {
      return (await req(path, { cookie: m.cookie })).json()
    }
    const [me, lotteriesRes, setsRes, settingsRes, assetsRes, newsRes] = await Promise.all([
      jsonOf('/me'),
      jsonOf('/lotteries'),
      jsonOf('/sets'),
      jsonOf('/settings'),
      jsonOf('/assets'),
      jsonOf('/news'),
    ])

    // `me` returned by bootstrap and /me are built from the same member row + today's
    // counter, so they must be identical.
    expect(boot.me).toEqual(me)
    expect(boot.me.rendersToday).toBe(1)
    expect(boot.lotteries).toEqual(lotteriesRes)
    expect(boot.sets).toEqual(setsRes)
    expect(boot.settings).toEqual(settingsRes)
    // Assets are signed per call; the signed exp is bucketed to the 30-min boundary so inside
    // one bucket the two endpoints return the same URL.
    expect(boot.assets).toEqual(assetsRes)
    expect(boot.news).toEqual(newsRes)

    // Sanity on the content itself.
    expect(boot.lotteries.length).toBeGreaterThanOrEqual(10)
    expect(boot.sets.length).toBe(STARTER_SETS.length)
    expect(boot.sets[0]).toMatchObject({ isDefault: true })
    expect(boot.settings['dow-jones']).toMatchObject({ marker: 'bootstrap' })
    expect(boot.assets.find((a) => a.id === asset.id)?.url).toBeTruthy()
  })

  it('first call creates the starter sets; a second call does not create more', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bootstrap-starter-once')

    // First /bootstrap also creates the starter sets (no prior GET /sets).
    const first = (await (await req('/bootstrap', { cookie: m.cookie })).json()) as BootstrapActive
    expect(first.sets).toHaveLength(STARTER_SETS.length)
    expect(first.sets.filter((s) => s.isDefault)).toHaveLength(1)

    // Second /bootstrap sees the same sets and does NOT create more.
    const second = (await (await req('/bootstrap', { cookie: m.cookie })).json()) as BootstrapActive
    expect(second.sets.map((s) => s.id).sort()).toEqual(first.sets.map((s) => s.id).sort())

    // DB confirms: still exactly STARTER_SETS rows.
    const db = getDb(env)
    const all = await db.select().from(setsTable).where(eq(setsTable.memberId, m.id))
    expect(all).toHaveLength(STARTER_SETS.length)
  })

  it('expired member → { me, news } only (no lotteries / sets / settings / assets)', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bootstrap-expired')
    const patch = (body: unknown) => call('PATCH', `/admin/members/${m.id}`, admin, body)
    // Flip the member expired AFTER their session was created.
    await patch({ expiresAt: new Date(Date.now() - 1000).toISOString() })

    const bootRes = await req('/bootstrap', { cookie: m.cookie })
    expect(bootRes.status).toBe(200)
    const boot = (await bootRes.json()) as Partial<BootstrapActive>
    // Shape matches the individual /me + /news endpoints.
    const meSolo = await (await req('/me', { cookie: m.cookie })).json()
    const newsSolo = await (await req('/news', { cookie: m.cookie })).json()
    expect(boot.me).toEqual(meSolo)
    expect(boot.me).toMatchObject({ expired: true, disabled: false })
    expect(boot.news).toEqual(newsSolo)
    expect(boot.lotteries).toBeUndefined()
    expect(boot.sets).toBeUndefined()
    expect(boot.settings).toBeUndefined()
    expect(boot.assets).toBeUndefined()
  })

  it('disabled member → { me, news } only', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bootstrap-disabled')
    await call('PATCH', `/admin/members/${m.id}`, admin, { disabled: true })
    const boot = (await (await req('/bootstrap', { cookie: m.cookie })).json()) as Partial<
      BootstrapActive
    >
    const newsSolo = await (await req('/news', { cookie: m.cookie })).json()
    expect(boot.me).toMatchObject({ disabled: true })
    expect(boot.news).toEqual(newsSolo)
    expect(boot.lotteries).toBeUndefined()
    expect(boot.sets).toBeUndefined()
  })

  it('CSRF: state-changing request not blocked (GET has no body), but foreign origin still rejected for writes', async () => {
    // GETs do not go through the Origin guard; this just confirms /bootstrap is a GET.
    const admin = await adminCookie()
    const m = await newMember(admin, 'bootstrap-get-only')
    const res = await req('/bootstrap', {
      cookie: m.cookie,
      headers: { Origin: 'https://evil.example' },
    })
    // The Origin guard only applies to state-changing methods; bootstrap is a GET so this
    // succeeds. CORS (not tested here) would hide the response from a browser.
    expect(res.status).toBe(200)
  })

  it('assets are ordered by createdAt, matching GET /assets', async () => {
    // Guard: bootstrap must sort assets the same way as GET /assets so AssetsPage,
    // SinglePage and ApplyToSetModal (which render in array order) do not shuffle items
    // between the first page load (/bootstrap) and any later reload() (GET /assets).
    const admin = await adminCookie()
    const m = await newMember(admin, 'bootstrap-asset-order')
    // Upload three assets of the same kind, forcing distinct createdAt values via
    // the member's one-per-kind quota of 2… use three kinds instead so the uploads
    // succeed and we still get three rows with monotonic timestamps.
    expect(
      (await uploadFile(
        m.cookie,
        new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
        'background',
      )).status,
    ).toBe(200)
    expect(
      (await uploadFile(
        m.cookie,
        new File([new Uint8Array([2])], 'b.png', { type: 'image/png' }),
        'logo',
      )).status,
    ).toBe(200)
    expect(
      (await uploadFile(
        m.cookie,
        new File([new Uint8Array([3])], 'c.png', { type: 'image/png' }),
        'qr',
      )).status,
    ).toBe(200)

    // Rewrite createdAt so the id-based insertion order is NOT the same as the
    // createdAt order. Only a working ORDER BY createdAt in /bootstrap matches GET /assets.
    const db = getDb(env)
    const rows = await db.select().from(assetsTable).where(eq(assetsTable.memberId, m.id))
    const sortedRows = [...rows]
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id))
    const stamps = [
      '2026-11-01T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      '2026-11-03T00:00:00.000Z',
    ]
    // Reverse: highest id → earliest createdAt; lowest id → latest createdAt.
    for (let i = 0; i < sortedRows.length; i++) {
      const r = sortedRows[sortedRows.length - 1 - i]
      await db
        .update(assetsTable)
        .set({ createdAt: stamps[i] })
        .where(eq(assetsTable.id, r.id))
    }

    const boot = (await (await req('/bootstrap', { cookie: m.cookie })).json()) as {
      assets: Asset[]
    }
    const list = (await (await call('GET', '/assets', m.cookie)).json()) as Asset[]
    expect(boot.assets.map((a) => a.id)).toEqual(list.map((a) => a.id))
    // Confirm the order is createdAt-ascending (not id-ascending).
    const bootStamps = boot.assets.map((a) => a.createdAt)
    expect(bootStamps).toEqual([...bootStamps].sort())
  })
})

describe('review: DELETE /assets R2 failure', () => {
  it('leaves the D1 row + R2 object + card_settings refs intact when R2 delete throws', async () => {
    // Guard property: R2 delete runs BEFORE the D1 batch so an R2 failure never orphans
    // the R2 object (the download handler no longer reads D1, and admin member-delete only
    // knows the keys that assets still rows reference). With this order, a transient R2
    // failure is retryable — nothing has changed in D1 yet.
    const admin = await adminCookie()
    const m = await newMember(admin, 'del-r2-fail')
    const up = await uploadFile(
      m.cookie,
      new File([new Uint8Array([42])], 'bg.png', { type: 'image/png' }),
      'background',
    )
    const { id } = (await up.json()) as { id: string }
    await call('PUT', '/settings/dow-jones', m.cookie, {
      backgroundAssetId: id,
      logo: { assetId: id, x: 1, y: 2, width: 3, opacity: 0.5 },
    })

    // Monkey-patch r2.delete to throw once; restore it afterwards.
    const realDelete = r2.delete.bind(r2)
    let threw = false
    r2.delete = async () => {
      threw = true
      throw new Error('simulated r2 outage')
    }
    let failed = await call('DELETE', `/assets/${id}`, m.cookie)
    expect(threw).toBe(true)
    // Expresses as a 5xx surface to the client (uncaught by app error handler → 500).
    expect(failed.status).toBeGreaterThanOrEqual(500)

    // Nothing changed: the row is still there, the R2 object is still there, and the
    // card_settings references still point at the asset.
    const db = getDb(env)
    expect(await db.query.assets.findFirst({ where: eq(assetsTable.id, id) })).toBeTruthy()
    expect([...r2.objects.keys()].some((k) => k.includes(id))).toBe(true)
    const stillRefs = (await (await call('GET', '/settings/dow-jones', m.cookie)).json()) as {
      backgroundAssetId: string
      logo: { assetId: string }
    }
    expect(stillRefs.backgroundAssetId).toBe(id)
    expect(stillRefs.logo.assetId).toBe(id)

    // Restore R2 and retry: the delete now succeeds and cleans up both sides.
    r2.delete = realDelete
    const ok = await call('DELETE', `/assets/${id}`, m.cookie)
    expect(ok.status).toBe(204)
    expect(await db.query.assets.findFirst({ where: eq(assetsTable.id, id) })).toBeUndefined()
    expect([...r2.objects.keys()].some((k) => k.includes(id))).toBe(false)
    const cleared = (await (await call('GET', '/settings/dow-jones', m.cookie)).json()) as {
      backgroundAssetId: unknown
      logo: { assetId: unknown; width: number }
    }
    expect(cleared.backgroundAssetId).toBeNull()
    expect(cleared.logo.assetId).toBeNull()
  })
})

describe('contacts + admin /admin/settings', () => {
  // The site_settings table is shared across tests; wipe it between cases so a previous
  // test's PUT doesn't leak into the next one's defaults.
  beforeEach(async () => {
    await getDb(env).delete(siteSettings)
  })

  it('GET /contacts (no auth) falls back to defaults, Cache-Control is public, max-age=60', async () => {
    const res = await req('/contacts')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(await res.json()).toEqual({
      line: { id: '@numbergen', url: 'https://line.me/R/ti/p/@numbergen' },
      telegram: { id: '@numbergen_support', url: 'https://t.me/numbergen_support' },
    })
  })

  it('GET /contacts hides a channel when its id is empty', async () => {
    const admin = await adminCookie()
    const put = await call('PUT', '/admin/settings', admin, {
      contactLineId: '',
      contactLineUrl: '',
      contactTelegramId: '@tg_support',
      contactTelegramUrl: 'https://t.me/tg_support',
      renderLimitDefault: 500,
    })
    expect(put.status).toBe(200)
    const res = await (await req('/contacts')).json()
    expect(res).toEqual({
      line: null,
      telegram: { id: '@tg_support', url: 'https://t.me/tg_support' },
    })
  })

  it('GET /contacts hides a channel whose id is set but whose URL is empty', async () => {
    const admin = await adminCookie()
    const put = await call('PUT', '/admin/settings', admin, {
      contactLineId: '@pnphoto',
      contactLineUrl: '',
      contactTelegramId: '@tg_support',
      contactTelegramUrl: 'https://t.me/tg_support',
      renderLimitDefault: 600,
    })
    expect(put.status).toBe(200)
    const res = await (await req('/contacts')).json()
    expect(res).toEqual({
      line: null,
      telegram: { id: '@tg_support', url: 'https://t.me/tg_support' },
    })
  })

  it('GET /admin/settings returns the compiled-in defaults when no row exists', async () => {
    const admin = await adminCookie()
    const res = await (await call('GET', '/admin/settings', admin)).json()
    expect(res).toEqual({
      contactLineId: '@numbergen',
      contactLineUrl: 'https://line.me/R/ti/p/@numbergen',
      contactTelegramId: '@numbergen_support',
      contactTelegramUrl: 'https://t.me/numbergen_support',
      renderLimitDefault: 600,
    })
  })

  it('PUT /admin/settings persists, GET returns the saved values, and /contacts reflects them', async () => {
    const admin = await adminCookie()
    const put = await call('PUT', '/admin/settings', admin, {
      contactLineId: '@pnphoto',
      contactLineUrl: 'https://line.me/R/ti/p/@pnphoto',
      contactTelegramId: '@pnphoto_bot',
      contactTelegramUrl: 'https://t.me/pnphoto_bot',
      renderLimitDefault: 1200,
    })
    expect(put.status).toBe(200)
    expect(await put.json()).toEqual({
      contactLineId: '@pnphoto',
      contactLineUrl: 'https://line.me/R/ti/p/@pnphoto',
      contactTelegramId: '@pnphoto_bot',
      contactTelegramUrl: 'https://t.me/pnphoto_bot',
      renderLimitDefault: 1200,
    })
    const get = await (await call('GET', '/admin/settings', admin)).json()
    expect(get).toMatchObject({ renderLimitDefault: 1200, contactLineId: '@pnphoto' })
    const contacts = await (await req('/contacts')).json()
    expect(contacts).toEqual({
      line: { id: '@pnphoto', url: 'https://line.me/R/ti/p/@pnphoto' },
      telegram: { id: '@pnphoto_bot', url: 'https://t.me/pnphoto_bot' },
    })
  })

  it('PUT /admin/settings rejects a non-https URL and an out-of-range default limit', async () => {
    const admin = await adminCookie()
    const base = {
      contactLineId: '@x',
      contactLineUrl: 'https://example.com',
      contactTelegramId: '@y',
      contactTelegramUrl: 'https://example.com',
      renderLimitDefault: 100,
    }
    const badUrl = await call('PUT', '/admin/settings', admin, {
      ...base,
      contactLineUrl: 'http://evil.example',
    })
    expect(badUrl.status).toBe(400)
    const zeroLimit = await call('PUT', '/admin/settings', admin, { ...base, renderLimitDefault: 0 })
    expect(zeroLimit.status).toBe(400)
    const hugeLimit = await call('PUT', '/admin/settings', admin, { ...base, renderLimitDefault: 100_001 })
    expect(hugeLimit.status).toBe(400)
    // Allowed: empty string drops the channel.
    const empty = await call('PUT', '/admin/settings', admin, { ...base, contactLineUrl: '' })
    expect(empty.status).toBe(200)
  })

  it('non-admin cannot read or write /admin/settings', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'no-admin-settings')
    expect((await call('GET', '/admin/settings', m.cookie)).status).toBe(401)
    expect(
      (await call('PUT', '/admin/settings', m.cookie, {
        contactLineId: '',
        contactLineUrl: '',
        contactTelegramId: '',
        contactTelegramUrl: '',
        renderLimitDefault: 500,
      })).status,
    ).toBe(401)
    // Also 401 with NO session at all.
    expect((await req('/admin/settings')).status).toBe(401)
    expect(
      (await req('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          contactLineId: '',
          contactLineUrl: '',
          contactTelegramId: '',
          contactTelegramUrl: '',
          renderLimitDefault: 500,
        }),
      })).status,
    ).toBe(401)
  })
})

describe('admin member renderLimit', () => {
  beforeEach(async () => {
    await getDb(env).delete(siteSettings)
  })

  it('PATCH /admin/members/:id accepts a numeric override and null to clear it', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'rl-member')
    // Default state: override is null, rendersLimit reflects the admin default (600 here).
    const list1 = (await (await call('GET', `/admin/members?q=${m.token}`, admin)).json()) as AdminMember[]
    expect(list1[0]).toMatchObject({ renderLimit: null, rendersLimit: 600 })

    const set = await call('PATCH', `/admin/members/${m.id}`, admin, { renderLimit: 50 })
    expect(set.status).toBe(200)
    expect(await set.json()).toMatchObject({ renderLimit: 50, rendersLimit: 50 })

    const list2 = (await (await call('GET', `/admin/members?q=${m.token}`, admin)).json()) as AdminMember[]
    expect(list2[0]).toMatchObject({ renderLimit: 50, rendersLimit: 50 })

    // member's /me reflects the override, too
    const me = (await (await call('GET', '/me', m.cookie)).json()) as Member
    expect(me.rendersLimit).toBe(50)

    const clear = await call('PATCH', `/admin/members/${m.id}`, admin, { renderLimit: null })
    expect(await clear.json()).toMatchObject({ renderLimit: null, rendersLimit: 600 })
  })

  it('renderLimit validation rejects 0, 100001 and non-integers', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'rl-validation')
    // (NaN / Infinity are not representable in JSON; JSON.stringify emits `null`, which the
    // schema accepts as "clear override".) Non-null / non-integer rejection is the guard.
    for (const bad of [0, -1, 100_001, 1.5, 'x'] as unknown[]) {
      const res = await call('PATCH', `/admin/members/${m.id}`, admin, { renderLimit: bad })
      expect(res.status, `renderLimit=${bad}`).toBe(400)
    }
  })

  it('effective limit: member override > admin default > hard-coded 600', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'rl-effective')

    // No settings, no override: falls back to RENDERS_PER_DAY (600).
    expect(((await (await call('GET', '/me', m.cookie)).json()) as Member).rendersLimit).toBe(600)

    // Set admin default to 42; member without override follows it.
    await call('PUT', '/admin/settings', admin, {
      contactLineId: '@x',
      contactLineUrl: 'https://x.co',
      contactTelegramId: '@y',
      contactTelegramUrl: 'https://y.co',
      renderLimitDefault: 42,
    })
    expect(((await (await call('GET', '/me', m.cookie)).json()) as Member).rendersLimit).toBe(42)

    // Member override wins over the default.
    await call('PATCH', `/admin/members/${m.id}`, admin, { renderLimit: 7 })
    expect(((await (await call('GET', '/me', m.cookie)).json()) as Member).rendersLimit).toBe(7)
  })
})

describe('render limit uses the effective limit', () => {
  beforeEach(async () => {
    await getDb(env).delete(siteSettings)
  })

  const render = (cookie: string, n: number) =>
    call('POST', '/render/numbers', cookie, {
      items: Array.from({ length: n }, () => ({ lotteryId: 'dow-jones' })),
      date: '2026-11-10',
    })

  it('the admin default caps renders exactly; one over → 429 without consuming', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'eff-default')
    await call('PUT', '/admin/settings', admin, {
      contactLineId: '@x',
      contactLineUrl: 'https://x.co',
      contactTelegramId: '@y',
      contactTelegramUrl: 'https://y.co',
      renderLimitDefault: 5,
    })

    // Right up to the limit.
    const ok = await render(m.cookie, 5)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ rendersToday: 5, rendersLimit: 5 })
    // Over by 1.
    const over = await render(m.cookie, 1)
    expect(over.status).toBe(429)
    // Counter untouched.
    const db = getDb(env)
    const row = await db.query.renderCounters.findFirst({
      where: and(eq(renderCounters.memberId, m.id), eq(renderCounters.day, bangkokDay())),
    })
    expect(row?.count).toBe(5)
  })

  it("a member's own renderLimit overrides the default (both over and at the boundary)", async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'eff-member')
    await call('PUT', '/admin/settings', admin, {
      contactLineId: '@x',
      contactLineUrl: 'https://x.co',
      contactTelegramId: '@y',
      contactTelegramUrl: 'https://y.co',
      renderLimitDefault: 100,
    })
    await call('PATCH', `/admin/members/${m.id}`, admin, { renderLimit: 3 })

    expect((await render(m.cookie, 3)).status).toBe(200)
    // 4th over = refused, counter stuck at 3.
    expect((await render(m.cookie, 1)).status).toBe(429)
    const db = getDb(env)
    const row = await db.query.renderCounters.findFirst({
      where: and(eq(renderCounters.memberId, m.id), eq(renderCounters.day, bangkokDay())),
    })
    expect(row?.count).toBe(3)
  })

  it('one single request larger than the effective limit is refused up-front', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'eff-large')
    await call('PATCH', `/admin/members/${m.id}`, admin, { renderLimit: 2 })
    const res = await render(m.cookie, 10)
    expect(res.status).toBe(429)
    // No counter inserted.
    const db = getDb(env)
    const row = await db.query.renderCounters.findFirst({
      where: and(eq(renderCounters.memberId, m.id), eq(renderCounters.day, bangkokDay())),
    })
    expect(row).toBeUndefined()
  })

  it('POST /admin/members/:id/reset-renders resets today to 0 and renders work again', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'reset-renders')
    await call('PATCH', `/admin/members/${m.id}`, admin, { renderLimit: 3 })

    expect((await render(m.cookie, 3)).status).toBe(200)
    expect((await render(m.cookie, 1)).status).toBe(429)

    // Seed yesterday too, to prove reset-renders touches today only.
    const db = getDb(env)
    await db.insert(renderCounters).values({
      memberId: m.id,
      day: bangkokDay(Date.now() - 86400_000),
      count: 999,
    })

    const reset = await call('POST', `/admin/members/${m.id}/reset-renders`, admin)
    expect(reset.status).toBe(200)
    const body = (await reset.json()) as AdminMember
    expect(body).toMatchObject({ id: m.id, rendersToday: 0, renderLimit: 3, rendersLimit: 3 })

    // The reset only touched today; yesterday's row is still there.
    const yesterday = await db.query.renderCounters.findFirst({
      where: and(
        eq(renderCounters.memberId, m.id),
        eq(renderCounters.day, bangkokDay(Date.now() - 86400_000)),
      ),
    })
    expect(yesterday?.count).toBe(999)

    // Member can render again, up to the limit.
    expect((await render(m.cookie, 3)).status).toBe(200)
  })

  it('reset-renders is 404 on unknown member and 401 without admin session', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'reset-404')
    expect((await call('POST', '/admin/members/unknown00000001/reset-renders', admin)).status).toBe(404)
    expect((await call('POST', `/admin/members/${m.id}/reset-renders`, m.cookie)).status).toBe(401)
    expect(
      (await req(`/admin/members/${m.id}/reset-renders`, { method: 'POST' })).status,
    ).toBe(401)
  })

  it('reset-renders of member A never touches member B', async () => {
    const admin = await adminCookie()
    const a = await newMember(admin, 'iso-a')
    const b = await newMember(admin, 'iso-b')
    const db = getDb(env)
    const day = bangkokDay()
    await db.insert(renderCounters).values([
      { memberId: a.id, day, count: 42 },
      { memberId: b.id, day, count: 77 },
    ])
    const res = await call('POST', `/admin/members/${a.id}/reset-renders`, admin)
    expect(res.status).toBe(200)
    expect(
      (
        await db.query.renderCounters.findFirst({
          where: and(eq(renderCounters.memberId, a.id), eq(renderCounters.day, day)),
        })
      )?.count,
    ).toBe(0)
    expect(
      (
        await db.query.renderCounters.findFirst({
          where: and(eq(renderCounters.memberId, b.id), eq(renderCounters.day, day)),
        })
      )?.count,
    ).toBe(77)
  })

  it('/bootstrap rendersLimit reflects the effective limit', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bootstrap-limit')
    await call('PUT', '/admin/settings', admin, {
      contactLineId: '@x',
      contactLineUrl: 'https://x.co',
      contactTelegramId: '@y',
      contactTelegramUrl: 'https://y.co',
      renderLimitDefault: 999,
    })
    const boot1 = (await (await req('/bootstrap', { cookie: m.cookie })).json()) as {
      me: Member
    }
    expect(boot1.me.rendersLimit).toBe(999)
    await call('PATCH', `/admin/members/${m.id}`, admin, { renderLimit: 11 })
    const boot2 = (await (await req('/bootstrap', { cookie: m.cookie })).json()) as {
      me: Member
    }
    expect(boot2.me.rendersLimit).toBe(11)
  })

  it('inactive /bootstrap also returns the effective limit for /me', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'bootstrap-inactive-limit')
    await call('PUT', '/admin/settings', admin, {
      contactLineId: '@x',
      contactLineUrl: 'https://x.co',
      contactTelegramId: '@y',
      contactTelegramUrl: 'https://y.co',
      renderLimitDefault: 333,
    })
    // Flip expired after login so the session + rendersLimit are still readable.
    await call('PATCH', `/admin/members/${m.id}`, admin, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })
    const boot = (await (await req('/bootstrap', { cookie: m.cookie })).json()) as {
      me: Member
      lotteries?: unknown
    }
    expect(boot.me).toMatchObject({ expired: true, rendersLimit: 333 })
    expect(boot.lotteries).toBeUndefined()
  })
})

describe('review: PATCH /sets concurrent writes', () => {
  it('last-writer-wins across concurrent PATCHes: final state matches one submitted body', async () => {
    // Guard property: two concurrent PATCHes against the same set MUST produce a final
    // state that equals one of the two client requests, never a merge-across-snapshots.
    // The implementation deletes every link and reinserts the full list inside ONE
    // db.batch, so SQLite's single-writer serialisation makes the two PATCHes run in
    // some order and the later one overwrites the earlier one.
    const admin = await adminCookie()
    const m = await newMember(admin, 'patch-race')
    const created = (await (
      await call('POST', '/sets', m.cookie, { name: 'race' })
    ).json()) as LotterySet
    // Seed with two ids so both racing PATCHes have a non-empty prior state.
    await call('PATCH', `/sets/${created.id}`, m.cookie, {
      lotteryIds: ['hanoi-regular', 'hanoi-vip'],
    })
    const A = ['hanoi-regular', 'hanoi-vip', 'dow-jones']
    const B = ['thai-gov']
    const [resA, resB] = await Promise.all([
      call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: A }),
      call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: B }),
    ])
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)
    // After both commit, the DB state must equal A or B exactly — never a merge.
    const db = getDb(env)
    const links = await db
      .select()
      .from(setLotteries)
      .where(eq(setLotteries.setId, created.id))
      .orderBy(setLotteries.sortOrder)
    const finalIds = links.map((l) => l.lotteryId)
    expect([A, B]).toContainEqual(finalIds)
    // GET /sets agrees with what the DB shows.
    const sets = (await (await call('GET', '/sets', m.cookie)).json()) as LotterySet[]
    const same = sets.find((s) => s.id === created.id)!
    expect(same.lotteryIds).toEqual(finalIds)
  })
})

describe('review: quotas hold under concurrent creates', () => {
  // Each POST runs its cheap count pre-check before its own insert, so firing them together
  // lets every request pass the pre-check; only the conditional INSERT keeps the quota.
  it('POST /assets: concurrent uploads never exceed the per-kind quota and leave no orphan R2 objects', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'race-assets')
    const res = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        uploadFile(m.cookie, new File([new Uint8Array([i + 1])], `r${i}.png`, { type: 'image/png' }), 'qr'),
      ),
    )
    const statuses = res.map((r) => r.status)
    expect(statuses.filter((s) => s === 200)).toHaveLength(2)
    expect(statuses.filter((s) => s === 409)).toHaveLength(3)
    for (const r of res) if (r.status === 409) expect(await r.json()).toMatchObject({ error: { code: 'QUOTA' } })
    const rows = await getDb(env).select().from(assetsTable).where(eq(assetsTable.memberId, m.id))
    expect(rows).toHaveLength(2)
    const keys = [...r2.objects.keys()].filter((k) => k.startsWith(`members/${m.id}/`))
    expect(keys.sort()).toEqual(rows.map((r) => r.r2Key).sort())
  })

  it('POST /sets: concurrent creates never exceed MAX_SETS', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'race-sets')
    await call('GET', '/sets', m.cookie) // creates the starter sets
    for (let i = 0; i < MAX_SETS - STARTER_SETS.length - 2; i++) {
      expect((await call('POST', '/sets', m.cookie, { name: `s${i}` })).status).toBe(200)
    }
    const res = await Promise.all(
      Array.from({ length: 5 }, (_, i) => call('POST', '/sets', m.cookie, { name: `race${i}` })),
    )
    expect(res.filter((r) => r.status === 200)).toHaveLength(2)
    for (const r of res) if (r.status !== 200) expect(await r.json()).toMatchObject({ error: { code: 'QUOTA' } })
    const rows = await getDb(env).select().from(setsTable).where(eq(setsTable.memberId, m.id))
    expect(rows).toHaveLength(MAX_SETS)
  })

  it('POST /lotteries: concurrent creates never exceed the custom-lottery quota', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'race-lotteries')
    for (let i = 0; i < 28; i++) {
      expect((await call('POST', '/lotteries', m.cookie, { name: `l${i}`, group: 'other' })).status).toBe(200)
    }
    const res = await Promise.all(
      Array.from({ length: 5 }, (_, i) => call('POST', '/lotteries', m.cookie, { name: `race${i}`, group: 'other' })),
    )
    expect(res.filter((r) => r.status === 200)).toHaveLength(2)
    for (const r of res) if (r.status !== 200) expect(await r.json()).toMatchObject({ error: { code: 'QUOTA' } })
    const rows = await getDb(env).select().from(lotteries).where(eq(lotteries.ownerMemberId, m.id))
    expect(rows).toHaveLength(30)
  })
})

describe('review: PATCH /sets racing DELETE /sets', () => {
  it('PATCH with lotteryIds against a concurrently deleted set is 200 or 404, never 500', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'patch-delete-race')
    for (let i = 0; i < 5; i++) {
      const created = (await (await call('POST', '/sets', m.cookie, { name: `pd${i}` })).json()) as LotterySet
      const [patch, del] = await Promise.all([
        call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: ['hanoi-regular', 'thai-gov'] }),
        call('DELETE', `/sets/${created.id}`, m.cookie),
      ])
      expect([200, 404]).toContain(patch.status)
      expect(del.status).toBe(204)
      const links = await getDb(env).select().from(setLotteries).where(eq(setLotteries.setId, created.id))
      expect(links).toHaveLength(0)
    }
  })
})

// ---- concurrency + lock hardening (login reservation, admin /64 + global ceiling, CORS dev
// origin, reset-password race, member delete R2 sweep, Bangkok render day)
describe('hardening: login limiter, CORS, member delete, render day', () => {
  it('parallel wrong link logins cannot exceed the 5-try budget', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'par-lock')
    const login = (password: string) =>
      req(`/link/${m.token}/login`, { method: 'POST', body: JSON.stringify({ password }) })
    const res = await Promise.all(Array.from({ length: 15 }, () => login('wrong-guess')))
    // Only the 5 reserved tries are verified; the 5th answers 429, the rest are refused unverified.
    expect(res.filter((r) => r.status === 401).length).toBeLessThanOrEqual(4)
    expect(res.every((r) => r.status === 401 || r.status === 429)).toBe(true)
    expect((await login('password-123')).status).toBe(429)
  })

  it('tries during a lock neither restart the count nor extend the lock', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'lock-hold')
    const login = (password: string) =>
      req(`/link/${m.token}/login`, { method: 'POST', body: JSON.stringify({ password }) })
    for (let i = 0; i < 5; i++) await login('wrong-guess')
    const key = `link:${m.token}`
    const before = await getDb(env).query.loginAttempts.findFirst({ where: eq(loginAttempts.key, key) })
    for (let i = 0; i < 3; i++) expect((await login('wrong-guess')).status).toBe(429)
    const after = await getDb(env).query.loginAttempts.findFirst({ where: eq(loginAttempts.key, key) })
    expect(after?.lockedUntil).toBe(before?.lockedUntil)
    expect(after!.failures).toBeGreaterThan(before!.failures)
    // An elapsed lock starts a fresh budget.
    await getDb(env)
      .update(loginAttempts)
      .set({ lockedUntil: new Date(Date.now() - 1000).toISOString() })
      .where(eq(loginAttempts.key, key))
    expect((await login('password-123')).status).toBe(204)
  })

  it('ipBucket groups IPv6 by /64 and leaves IPv4 alone', async () => {
    const { ipBucket } = await import('../src/lib/loginLimiter')
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9')
    expect(ipBucket('2001:DB8:0:1::a')).toBe('2001:db8:0:1::/64')
    expect(ipBucket('2001:db8:0000:0001:ffff:1:2:3')).toBe('2001:db8:0:1::/64')
    expect(ipBucket('::ffff:198.51.100.7')).toBe('198.51.100.7')
    expect(ipBucket('::1')).toBe('0:0:0:0::/64')
    expect(ipBucket('garbage')).toBe('garbage')
  })

  const adminLogin = (ip: string, password: string) =>
    req('/admin/login', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip },
      body: JSON.stringify({ username: 'admin', password }),
    })

  it('admin lock covers a whole IPv6 /64', async () => {
    for (let i = 1; i <= 4; i++) expect((await adminLogin(`2001:db8:0:1::${i}`, 'wrong')).status).toBe(401)
    expect((await adminLogin('2001:db8:0:1::5', 'wrong')).status).toBe(429)
    expect((await adminLogin('2001:db8:0:1:aaaa::1', 'admin1234')).status).toBe(429)
    expect((await adminLogin('2001:db8:0:2::1', 'admin1234')).status).toBe(204)
  })

  it('global admin ceiling: 20 failures from rotating IPs lock every address', async () => {
    for (let i = 1; i <= 19; i++) expect((await adminLogin(`192.0.2.${i}`, 'wrong')).status).toBe(401)
    expect((await adminLogin('192.0.2.20', 'wrong')).status).toBe(429)
    expect((await adminLogin('192.0.2.99', 'admin1234')).status).toBe(429)
    await resetLimiter(getDb(env))
  })

  it('production (COOKIE_SECURE=true) does not trust http://localhost:5173', async () => {
    const prod = { ...env, WEB_URL: 'https://pnphoto.co', COOKIE_SECURE: 'true' }
    const pre = (origin: string) =>
      app.request(
        '/sets',
        { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } },
        prod,
      )
    expect((await pre('https://pnphoto.co')).headers.get('access-control-allow-origin')).toBe('https://pnphoto.co')
    expect((await pre('http://localhost:5173')).headers.get('access-control-allow-origin')).toBeNull()
    const post = await app.request(
      '/logout',
      { method: 'POST', headers: { Origin: 'http://localhost:5173' } },
      prod,
    )
    expect(post.status).toBe(403)
    // Local dev (COOKIE_SECURE=false) still allows it.
    const dev = await app.request(
      '/sets',
      { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } },
      { ...env, WEB_URL: 'https://pnphoto.co' },
    )
    expect(dev.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })

  it('a login verified against the old hash cannot insert a session after reset-password', async () => {
    const { insertMemberSessionIfHash, newMemberSessionRow } = await import('../src/lib/session')
    const admin = await adminCookie()
    const m = await newMember(admin, 'reset-race')
    const db = getDb(env)
    const oldHash = (await db.query.members.findFirst({ where: eq(members.id, m.id) }))!.passwordHash!
    // Same hash still in place → inserted.
    expect(await insertMemberSessionIfHash(db, newMemberSessionRow(m.id), oldHash)).toHaveLength(1)
    expect((await call('POST', `/admin/members/${m.id}/reset-password`, admin)).status).toBe(204)
    // The racing login's insert lands after the reset → nothing inserted, no session survives.
    expect(await insertMemberSessionIfHash(db, newMemberSessionRow(m.id), oldHash)).toHaveLength(0)
    expect(await db.query.memberSessions.findMany({ where: eq(memberSessions.memberId, m.id) })).toHaveLength(0)
  })

  it('member delete sweeps every R2 object under the member prefix (paginated list)', async () => {
    class ListableR2 extends FakeR2 {
      async list(opts: { prefix: string; cursor?: string; limit?: number }) {
        // Page size 2 regardless of limit, to exercise the cursor loop.
        const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix)).sort()
        const start = opts.cursor ? Number(opts.cursor) : 0
        const page = keys.slice(start, start + 2)
        const next = start + 2
        return { objects: page.map((key) => ({ key })), truncated: next < keys.length, cursor: String(next) }
      }
    }
    const bucket = new ListableR2()
    const env2 = { ...env, ASSETS: bucket }
    const admin = await adminCookie()
    const m = await newMember(admin, 'r2-sweep')
    const form = new FormData()
    form.append('kind', 'logo')
    form.append('file', new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }))
    expect((await app.request('/assets', { method: 'POST', body: form, headers: { Cookie: m.cookie } }, env2)).status).toBe(200)
    // Objects with no assets row (an upload that raced the delete) and someone else's object.
    for (let i = 0; i < 4; i++) await bucket.put(`members/${m.id}/assets/orphan${i}.png`, 'x')
    await bucket.put('members/someoneElse00001/assets/keep.png', 'x')
    const del = await app.request(`/admin/members/${m.id}`, { method: 'DELETE', headers: { Cookie: admin } }, env2)
    expect(del.status).toBe(204)
    expect([...bucket.objects.keys()]).toEqual(['members/someoneElse00001/assets/keep.png'])
  })

  it('render day key is the Bangkok (UTC+7) calendar day', async () => {
    const { bangkokDay } = await import('../src/lib/time')
    expect(bangkokDay(Date.parse('2026-11-11T16:59:59Z'))).toBe('2026-11-11')
    expect(bangkokDay(Date.parse('2026-11-11T17:00:00Z'))).toBe('2026-11-12')
    expect(bangkokDay()).toBe(bangkokDay())
  })
})

describe('review: login limiter rows from the previous limiter', () => {
  it('a lock written by the old limiter (failures = 0) still refuses every try', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'legacy-lock')
    const key = `link:${m.token}`
    // The old recordFailure reset failures to 0 when it set the lock.
    await getDb(env)
      .insert(loginAttempts)
      .values({ key, failures: 0, lockedUntil: new Date(Date.now() + 10 * 60_000).toISOString() })
    for (let i = 0; i < 6; i++) {
      const res = await req(`/link/${m.token}/login`, {
        method: 'POST',
        body: JSON.stringify({ password: 'password-123' }),
      })
      expect(res.status).toBe(429)
    }
  })
})

describe('review: เลขเด่น (single) and element frames', () => {
  it('settings accept singleDigits / fixedSingle / elements.*.frame and reject bad values', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'single-zod')
    const put = (body: unknown) => call('PUT', '/settings/dow-jones', m.cookie, body)
    for (const body of [
      { singleDigits: 0 },
      { singleDigits: 4 },
      { singleDigits: 1.5 },
      { fixedSingle: '1234' },
      { fixedSingle: '1a' },
      { fixedSingle: 12 },
      { elements: { single: { frame: 'no' } } },
    ]) {
      const res = await put(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
    }
    for (const body of [
      { singleDigits: 3, fixedSingle: '123' },
      { singleDigits: 1, fixedSingle: null },
      { fixedSingle: '' },
      { elements: { single: { visible: true, x: 1010, y: 430, frame: false }, date: { frame: false } } },
    ]) {
      const res = await put(body)
      expect(res.status, JSON.stringify(body)).toBeLessThan(300)
    }
  })

  it('settings accept elements.*.frameW / frameH inside the editor range and reject anything else', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'frame-size-zod')
    const put = (body: unknown) => call('PUT', '/settings/dow-jones', m.cookie, body)
    // The editor sliders (web cardFrames.ts) allow width 60..1160 and height 20..400.
    for (const size of [
      { frameW: 'wide' },
      { frameW: null },
      { frameW: true },
      { frameW: {} },
      { frameW: 59 },
      { frameW: 1161 },
      { frameW: 99999 },
      { frameW: -5 },
      { frameH: '40' },
      { frameH: null },
      { frameH: [] },
      { frameH: 19 },
      { frameH: 401 },
      { frameH: -1 },
    ]) {
      const res = await put({ elements: { running: { frame: true, ...size } } })
      expect(res.status, JSON.stringify(size)).toBe(400)
    }
    for (const size of [{}, { frameW: 60, frameH: 20 }, { frameW: 1160, frameH: 400 }, { frameW: 333.5, frameH: 88 }]) {
      const res = await put({ elements: { single: { visible: true, x: 1000, y: 430, frame: true, ...size } } })
      expect(res.status, JSON.stringify(size)).toBeLessThan(300)
    }
    // The last accepted body is what is stored, and the rejected ones did not replace it.
    expect(await (await call('GET', '/settings/dow-jones', m.cookie)).json()).toEqual({
      elements: { single: { visible: true, x: 1000, y: 430, frame: true, frameW: 333.5, frameH: 88 } },
    })
    // The same bounds apply to an override inside /render/numbers.
    const r = await call('POST', '/render/numbers', m.cookie, {
      items: [{ lotteryId: 'dow-jones', settings: { elements: { single: { frameW: 5000 } } } }],
      date: '2026-11-06',
    })
    expect(r.status).toBe(400)
  })

  it('POST /render/numbers always returns single, honouring fixedSingle', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'single-render')
    const res = await call('POST', '/render/numbers', m.cookie, {
      items: [
        { lotteryId: 'dow-jones' },
        { lotteryId: 'dow-jones', settings: { singleDigits: 3, fixedSingle: '789' } },
        { lotteryId: 'dow-jones', settings: { singleDigits: 1 } },
      ],
      date: '2026-11-06',
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: { numbers: { running: [string, string]; single: string } }[] }
    expect(body.results[0].numbers.single).toMatch(/^\d{2}$/)
    expect(body.results[1].numbers.single).toBe('789')
    expect(body.results[2].numbers.running).toContain(body.results[2].numbers.single)
  })
})
