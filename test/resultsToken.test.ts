// GET /admin/results-token: the short-lived token that the signed-in back office takes to the results API
// (numbergen-results-api) as `Authorization: Bearer <token>`. It needs the normal ng_admin session; the token is signed
// with the secret RESULTS_ADMIN_SECRET that both Workers hold (src/lib/adminToken.ts, whose format is pinned by the
// cross-check vector in test/adminToken.test.ts, identical in both repos). Without a usable secret the endpoint is 503
// RESULTS_TOKEN_NOT_CONFIGURED. Real libSQL file DB with the project's migrations.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import app from '../src/index'
import type { AdminMember, AssetBucket, Bindings } from '../src/types'
import { hashPassword } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import { signAdminTokenPayload, usableSecret, verifyAdminToken } from '../src/lib/adminToken'
import { resetTestStackCache } from '../src/middleware/testStack'
import { siteSettings } from '../src/db/schema'
import { eq } from 'drizzle-orm'

const DB_FILE = 'test-resultstoken.db'
const DB_URL = `file:${DB_FILE}`
const SECRET = 'test-results-admin-secret-0123456789abcdef0123456789abcdef'

const fakeAssets: AssetBucket = {
  async put() {
    return {}
  },
  async get() {
    return null
  },
  async delete() {},
}

let env: Bindings
let admin: string
let member: string

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

function call(method: string, path: string, o: { cookie?: string; headers?: Record<string, string>; env?: Bindings; body?: unknown } = {}) {
  const headers = new Headers(o.headers)
  if (o.cookie) headers.set('Cookie', o.cookie)
  let payload: string | undefined
  if (o.body !== undefined) {
    payload = JSON.stringify(o.body)
    headers.set('Content-Type', 'application/json')
  }
  return app.request(path, { method, headers, body: payload }, o.env ?? env)
}

function cookieFrom(res: Response, name: string): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = raw.match(new RegExp(`${name}=([^;]*)`))
  if (!m) throw new Error(`no ${name} cookie in: ${raw}`)
  return `${name}=${m[1]}`
}

const TOKEN = '/admin/results-token'
const getToken = (o: { cookie?: string; headers?: Record<string, string>; env?: Bindings } = {}) => call('GET', TOKEN, { cookie: admin, ...o })
const errorOf = async (res: Response) => (await res.json()) as { error: { code: string; message: string } }
const without = <K extends keyof Bindings>(e: Bindings, key: K): Bindings => {
  const copy = { ...e }
  delete copy[key]
  return copy
}

beforeAll(async () => {
  removeDb()
  await runMigrations(DB_URL)
  env = {
    TURSO_DATABASE_URL: DB_URL,
    TURSO_AUTH_TOKEN: '',
    SESSION_SECRET: 'test-session-secret',
    ASSET_SIGNING_SECRET: 'test-asset-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: await hashPassword('admin1234', 1000),
    WEB_URL: 'http://localhost:5173',
    COOKIE_SECURE: 'false',
    ASSETS: fakeAssets,
    RESULTS_ADMIN_SECRET: SECRET,
  }
  const login = await call('POST', '/admin/login', { body: { username: 'admin', password: 'admin1234' } })
  expect(login.status).toBe(204)
  admin = cookieFrom(login, 'ng_admin')
  const created = await call('POST', '/admin/members', { cookie: admin, body: { displayName: 'not-an-admin', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() } })
  const m = (await created.json()) as AdminMember
  const claimed = await call('POST', `/link/${m.linkToken}/set-password`, { body: { password: 'password-123' } })
  expect(claimed.status).toBe(204)
  member = cookieFrom(claimed, 'ng_session')
})

beforeEach(async () => {
  await resetLimiter(getDb(env))
  resetTestStackCache()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

afterAll(() => {
  try {
    removeDb()
  } catch {
    // file may still be held open on Windows; harmless
  }
})

describe('GET /admin/results-token: who may ask', () => {
  it('needs the admin session: 401 without a cookie, with a member session, with a damaged cookie and with a bearer token', async () => {
    for (const o of [
      { cookie: undefined },
      { cookie: member },
      { cookie: admin.slice(0, -1) + (admin.endsWith('0') ? '1' : '0') },
      { cookie: undefined, headers: { Authorization: 'Bearer anything' } },
    ]) {
      const res = await getToken(o)
      expect(res.status, JSON.stringify(o)).toBe(401)
      expect(await errorOf(res)).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    }
  })

  it('the answer to a stranger never says whether the secret is set (401 before 503)', async () => {
    const res = await getToken({ cookie: undefined, env: without(env, 'RESULTS_ADMIN_SECRET') })
    expect(res.status).toBe(401)
  })

  it('only GET: the other methods are 404', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect((await call(method, TOKEN, { cookie: admin })).status, method).toBe(404)
    }
  })

  it('a token is no way into this API: a bearer token does not replace the session cookie on any admin route', async () => {
    const { token } = (await (await getToken()).json()) as { token: string }
    for (const path of ['/admin/me', '/admin/lotteries', TOKEN]) {
      const res = await call('GET', path, { headers: { Authorization: `Bearer ${token}` } })
      expect(res.status, path).toBe(401)
    }
  })
})

describe('GET /admin/results-token: the token', () => {
  it('answers 200 { token, expiresAt } and nothing else, never cached', async () => {
    const res = await getToken()
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'token'])
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(body.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/)
  })

  it('is signed with RESULTS_ADMIN_SECRET and valid for 10 minutes from now: iat now, exp +600 s, sub admin', async () => {
    const t0 = Date.parse('2026-11-20T03:00:00.250Z')
    vi.useFakeTimers({ toFake: ['Date'], now: t0 })
    const body = (await (await getToken()).json()) as { token: string; expiresAt: string }
    expect(body.expiresAt).toBe('2026-11-20T03:10:00.000Z')
    const check = await verifyAdminToken(SECRET, body.token, t0)
    expect(check).toEqual({ ok: true, payload: { sub: 'admin', iat: Math.floor(t0 / 1000), exp: Math.floor(t0 / 1000) + 600 } })
    // valid for 10 minutes and not a second longer
    expect(await verifyAdminToken(SECRET, body.token, t0 + 599_000)).toMatchObject({ ok: true })
    expect(await verifyAdminToken(SECRET, body.token, t0 + 600_000)).toMatchObject({ ok: false, reason: 'expired' })
    // another secret does not verify it
    expect(await verifyAdminToken(`${SECRET}x`, body.token, t0)).toMatchObject({ ok: false, reason: 'bad-signature' })
  })

  it('is exactly the token the shared module signs for that second (the format is the vector\'s: see adminToken.test.ts)', async () => {
    const t0 = Date.parse('2026-11-20T03:00:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'], now: t0 })
    const body = (await (await getToken()).json()) as { token: string }
    const iat = Math.floor(t0 / 1000)
    expect(body.token).toBe(await signAdminTokenPayload(SECRET, { sub: 'admin', iat, exp: iat + 600 }))
  })

  it('a new second is a new token; nothing is stored (no table, no session row)', async () => {
    const t0 = Date.parse('2026-11-20T03:00:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'], now: t0 })
    const before = await getDb(env).select().from(siteSettings)
    const a = ((await (await getToken()).json()) as { token: string }).token
    const same = ((await (await getToken()).json()) as { token: string }).token
    vi.setSystemTime(t0 + 1000)
    const b = ((await (await getToken()).json()) as { token: string }).token
    expect(same).toBe(a)
    expect(b).not.toBe(a)
    expect(await getDb(env).select().from(siteSettings)).toEqual(before)
  })

  it('the secret is trimmed like the results API trims it: a newline left by `wrangler secret put` changes nothing', async () => {
    const t0 = Date.parse('2026-11-20T03:00:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'], now: t0 })
    const padded = ((await (await getToken({ env: { ...env, RESULTS_ADMIN_SECRET: `${SECRET}\n` } })).json()) as { token: string }).token
    const clean = ((await (await getToken()).json()) as { token: string }).token
    expect(padded).toBe(clean)
    expect(usableSecret(`${SECRET}\n`)).toBe(SECRET)
  })

  it('the signed-in admin of the test Worker gets one too; its switch off (TESTSITE_OFF) is answered before anything else', async () => {
    const testEnv: Bindings = { ...env, TEST_STACK: 'true' }
    expect((await getToken({ env: testEnv })).status).toBe(200)
    await getDb(env).insert(siteSettings).values({ key: 'testsite_enabled', value: 'false', updatedAt: 'x' }).onConflictDoUpdate({ target: siteSettings.key, set: { value: 'false' } })
    resetTestStackCache()
    try {
      const off = await getToken({ env: testEnv })
      expect(off.status).toBe(503)
      expect(await errorOf(off)).toMatchObject({ error: { code: 'TESTSITE_OFF' } })
      // the live Worker is not the test Worker: the switch does not concern it
      expect((await getToken()).status).toBe(200)
    } finally {
      await getDb(env).delete(siteSettings).where(eq(siteSettings.key, 'testsite_enabled'))
      resetTestStackCache()
    }
  })
})

describe('GET /admin/results-token: no usable secret', () => {
  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['blank', '   \n'],
    ['31 characters', 'x'.repeat(31)],
  ])('%s: 503 RESULTS_TOKEN_NOT_CONFIGURED with a Thai message, and no token', async (_name, secret) => {
    const e = secret === undefined ? without(env, 'RESULTS_ADMIN_SECRET') : { ...env, RESULTS_ADMIN_SECRET: secret }
    const res = await getToken({ env: e })
    expect(res.status).toBe(503)
    const body = await errorOf(res)
    expect(body.error.code).toBe('RESULTS_TOKEN_NOT_CONFIGURED')
    expect(body.error.message).toContain('RESULTS_ADMIN_SECRET')
    expect(JSON.stringify(body)).not.toContain('token"')
    expect(res.headers.get('cache-control')).toBeNull()
  })

  it('32 characters are enough', async () => {
    expect((await getToken({ env: { ...env, RESULTS_ADMIN_SECRET: 'x'.repeat(32) } })).status).toBe(200)
  })
})

describe('GET /admin/results-token: CORS (the back office calls it with its cookie)', () => {
  it('from the web app\'s origin the answer carries the credentialed CORS headers, so the browser can read the token', async () => {
    const res = await getToken({ headers: { Origin: 'http://localhost:5173' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('from another origin it carries none: the page cannot read it', async () => {
    const res = await getToken({ headers: { Origin: 'https://evil.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('the 503 is readable by the web app too', async () => {
    const res = await getToken({ env: without(env, 'RESULTS_ADMIN_SECRET'), headers: { Origin: 'http://localhost:5173' } })
    expect(res.status).toBe(503)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
  })
})
