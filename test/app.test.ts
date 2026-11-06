// Hono app tests through app.request() with a real libSQL file DB (test.db) and a fake R2 bucket.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import app from '../src/index'
import type { AdminMember, AssetBucket, Bindings, LotterySet, Member } from '../src/types'
import { hashPassword, signAsset } from '../src/lib/crypto'
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
} from '../src/db/schema'
import { utcDay } from '../src/lib/time'
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

  it('GET /sets creates the Default set', async () => {
    const res = await req('/sets', { cookie })
    expect(res.status).toBe(200)
    const sets = (await res.json()) as LotterySet[]
    expect(sets).toHaveLength(1)
    expect(sets[0]).toMatchObject({ name: 'Default', isDefault: true })
    expect(sets[0].lotteryIds).toContain('hanoi-regular')
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
    const file = await app.request(url.pathname + url.search, {}, env)
    expect(file.status).toBe(200)
    expect(file.headers.get('cache-control')).toBe('private, max-age=600')
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]))

    const bad = await app.request(`${url.pathname}?exp=${url.searchParams.get('exp')}&sig=${'0'.repeat(64)}`, {}, env)
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
    const today = utcDay()
    // yesterday was fully used: must not count today
    await db.insert(renderCounters).values({ memberId: m.id, day: utcDay(Date.now() - 86400_000), count: 600 })

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
    const { url } = (await (await call('GET', `/assets/${a}/url`, m.cookie)).json()) as { url: string }
    const u = new URL(url)
    const exp = Number(u.searchParams.get('exp'))
    const sig = u.searchParams.get('sig') ?? ''
    expect(exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600)

    const get = (path: string) => app.request(path, {}, env)
    const ok = await get(`/assets/${a}?exp=${exp}&sig=${sig}`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('private, max-age=600')
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
    expect(ok.headers.get('content-type')).toBe('image/webp')

    expect((await get(`/assets/${b}?exp=${exp}&sig=${sig}`)).status).toBe(403) // other asset
    expect((await get(`/assets/${a}?exp=${exp + 3600}&sig=${sig}`)).status).toBe(403) // exp bumped
    expect((await get(`/assets/${a}`)).status).toBe(403) // unsigned
    expect((await get(`/assets/${a}?exp=${exp}`)).status).toBe(403) // no sig
    const wrong = await signAsset('not-the-secret', a, 300)
    expect((await get(`/assets/${a}?exp=${wrong.exp}&sig=${wrong.sig}`)).status).toBe(403)
    // correctly signed but already expired
    const old = await signAsset(env.ASSET_SIGNING_SECRET, a, 600, Date.now() - 601_000)
    expect((await get(`/assets/${a}?exp=${old.exp}&sig=${old.sig}`)).status).toBe(403)
    // correctly signed but valid far longer than the API ever issues
    const far = await signAsset(env.ASSET_SIGNING_SECRET, a, 86400)
    expect((await get(`/assets/${a}?exp=${far.exp}&sig=${far.sig}`)).status).toBe(403)
  })

  it('upload refuses non-images, SVG, empty, oversize and bad kind; enforces the 20-file quota', async () => {
    const admin = await adminCookie()
    const m = await newMember(admin, 'quota')
    const up = (file: File, kind = 'logo') => uploadFile(m.cookie, file, kind)
    expect((await up(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }))).status).toBe(400)
    expect((await up(new File(['hi'], 'x.txt', { type: 'text/plain' }))).status).toBe(400)
    expect((await up(new File([], 'x.png', { type: 'image/png' }))).status).toBe(400)
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })
    expect((await up(big)).status).toBe(400)
    expect((await up(new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }), 'icon')).status).toBe(400)
    for (let i = 0; i < 20; i++) {
      expect((await up(new File([new Uint8Array([i])], `${i}.png`, { type: 'image/png' }))).status).toBe(200)
    }
    const over = await up(new File([new Uint8Array([1])], 'x.png', { type: 'image/png' }))
    expect(over.status).toBe(409)
    expect(await over.json()).toMatchObject({ error: { code: 'QUOTA' } })
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
})

describe('review: sets', () => {
  it('Default cannot be renamed or deleted; other sets can; max 30 sets', async () => {
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
    expect(still.name).toBe('Default')
    expect(still.lotteryIds).toEqual(def.lotteryIds)
    // its lottery list may still be edited
    const edit = await call('PATCH', `/sets/${def.id}`, m.cookie, { lotteryIds: ['dow-jones'] })
    expect(await edit.json()).toMatchObject({ name: 'Default', lotteryIds: ['dow-jones'] })

    const created = (await (await call('POST', '/sets', m.cookie, { name: 'ชุดของฉัน' })).json()) as LotterySet
    const renamed = await call('PATCH', `/sets/${created.id}`, m.cookie, { name: 'ชุดใหม่' })
    expect(await renamed.json()).toMatchObject({ name: 'ชุดใหม่', isDefault: false })
    expect((await call('PATCH', `/sets/${created.id}`, m.cookie, { lotteryIds: ['no-such-lottery'] })).status).toBe(400)
    expect((await call('POST', '/sets', m.cookie, { name: 'x'.repeat(41) })).status).toBe(400)
    expect((await call('POST', '/sets', m.cookie, { name: '   ' })).status).toBe(400)
    expect((await call('DELETE', `/sets/${created.id}`, m.cookie)).status).toBe(204)

    for (let i = 0; i < 29; i++) expect((await call('POST', '/sets', m.cookie, { name: `s${i}` })).status).toBe(200)
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
