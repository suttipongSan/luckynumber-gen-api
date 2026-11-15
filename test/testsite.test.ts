// Test site switch: the `testsiteEnabled` field of GET/PUT /admin/settings (stored as the
// `testsite_enabled` site_settings key) and the TEST_STACK middleware (src/middleware/testStack.ts)
// that makes the test Worker answer 503 TESTSITE_OFF while the switch is off.
// Real libSQL file DB with the project's migrations. `live` and `testStack` below are the two
// Workers: same code, same database, TEST_STACK set only on the second.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import app from '../src/index'
import type { AdminMember, AssetBucket, Bindings } from '../src/types'
import { hashPassword } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import { siteSettings } from '../src/db/schema'
import { parseTestsiteEnabled, TESTSITE_ENABLED } from '../src/lib/siteSettings'
import { resetTestStackCache, TEST_STACK_CACHE_MS } from '../src/middleware/testStack'

const DB_FILE = 'test-testsite.db'
const DB_URL = `file:${DB_FILE}`
/** WEB_URL of the test env, so CORS allows it. */
const ORIGIN = 'http://localhost:5173'
/** What the 503 must look like (the repo's standard error shape). */
const OFF_BODY = { error: { code: 'TESTSITE_OFF', message: 'เว็บทดสอบปิดอยู่' } }

const fakeBucket: AssetBucket = {
  async put() {
    return {}
  },
  async get() {
    return null
  },
  async delete() {},
}

let live: Bindings
let testStack: Bindings
let admin = ''
let member = { id: '', cookie: '' }

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function call(
  e: Bindings,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; origin?: string } = {},
) {
  const headers = new Headers()
  if (opts.cookie) headers.set('Cookie', opts.cookie)
  if (opts.origin) headers.set('Origin', opts.origin)
  let payload: string | undefined
  if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body)
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
  const res = await call(live, 'POST', '/admin/login', { body: { username: 'admin', password: 'admin1234' } })
  expect(res.status).toBe(204)
  return cookieFrom(res, 'ng_admin')
}

/** Creates a member through the back office and claims the link. */
async function newMember(adminCk: string) {
  const res = await call(live, 'POST', '/admin/members', {
    cookie: adminCk,
    body: { displayName: 'สมาชิกสวิตช์', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
  })
  const m = (await res.json()) as AdminMember
  const sp = await call(live, 'POST', `/link/${m.linkToken}/set-password`, { body: { password: 'password-123' } })
  expect(sp.status).toBe(204)
  return { id: m.id, cookie: cookieFrom(sp, 'ng_session') }
}

/** The five fields every PUT /admin/settings has always required. */
const BASE = {
  contactLineId: '@x',
  contactLineUrl: 'https://x.co',
  contactTelegramId: '@y',
  contactTelegramUrl: 'https://y.co',
  renderLimitDefault: 100,
}

/** PUT /admin/settings on the live Worker, like the back office does. */
const putSettings = (extra: Record<string, unknown> = {}, cookie = admin) =>
  call(live, 'PUT', '/admin/settings', { cookie, body: { ...BASE, ...extra } })

const getSettings = async () => (await call(live, 'GET', '/admin/settings', { cookie: admin })).json()

const storedRow = () =>
  getDb(live).query.siteSettings.findFirst({ where: eq(siteSettings.key, TESTSITE_ENABLED) })

const OLD_STAMP = '2026-01-01T00:00:00.000Z'

/** Writes the raw stored text straight into the DB (like editing the row by hand). */
async function setRow(value: string) {
  await getDb(live)
    .insert(siteSettings)
    .values({ key: TESTSITE_ENABLED, value, updatedAt: OLD_STAMP })
    .onConflictDoUpdate({ target: [siteSettings.key], set: { value, updatedAt: OLD_STAMP } })
}

/** A D1 binding whose every statement fails; `prepare` counts how often the code tried to use it. */
function brokenD1() {
  const fail = async () => {
    throw new Error('D1_ERROR: simulated outage')
  }
  const prepare = vi.fn(() => ({ bind: () => ({ all: fail, raw: fail, run: fail, first: fail }) }))
  return { prepare, binding: { prepare, batch: fail } as unknown as NonNullable<Bindings['DB']> }
}

// ---- setup ---------------------------------------------------------------------------------------

beforeAll(async () => {
  removeDb()
  await runMigrations(DB_URL)
  live = {
    TURSO_DATABASE_URL: DB_URL,
    TURSO_AUTH_TOKEN: '',
    SESSION_SECRET: 'test-session-secret',
    ASSET_SIGNING_SECRET: 'test-asset-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: await hashPassword('admin1234', 1000),
    WEB_URL: ORIGIN,
    COOKIE_SECURE: 'false',
    ASSETS: fakeBucket,
  }
  testStack = { ...live, TEST_STACK: 'true' }
  admin = await adminCookie()
  member = await newMember(admin)
})

beforeEach(async () => {
  await resetLimiter(getDb(live))
  await getDb(live).delete(siteSettings)
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

// ---- GET/PUT /admin/settings ---------------------------------------------------------------------

describe('GET/PUT /admin/settings testsiteEnabled', () => {
  it('is true by default (no row) and the other fields are unchanged', async () => {
    expect(await getSettings()).toEqual({
      contactLineId: '@numbergen',
      contactLineUrl: 'https://line.me/R/ti/p/@numbergen',
      contactTelegramId: '@numbergen_support',
      contactTelegramUrl: 'https://t.me/numbergen_support',
      renderLimitDefault: 600,
      testsiteEnabled: true,
    })
    expect(await storedRow()).toBeUndefined()
  })

  it('PUT false then true round-trips through the response, GET and the stored row', async () => {
    const off = await putSettings({ testsiteEnabled: false })
    expect(off.status).toBe(200)
    expect(await off.json()).toMatchObject({ ...BASE, testsiteEnabled: false })
    expect(await getSettings()).toMatchObject({ testsiteEnabled: false })
    expect((await storedRow())?.value).toBe('false')

    const on = await putSettings({ testsiteEnabled: true })
    expect(on.status).toBe(200)
    expect(await on.json()).toMatchObject({ ...BASE, testsiteEnabled: true })
    expect(await getSettings()).toMatchObject({ testsiteEnabled: true })
    expect((await storedRow())?.value).toBe('true')
  })

  it('PUT without the field leaves the stored value untouched, whichever way it is set', async () => {
    for (const stored of ['false', 'true']) {
      await setRow(stored)
      const res = await putSettings({ renderLimitDefault: 250 })
      expect(res.status).toBe(200)
      // the rest of the body is saved ...
      expect(await res.json()).toMatchObject({ renderLimitDefault: 250, testsiteEnabled: stored === 'true' })
      // ... and the switch row was not even rewritten
      expect(await storedRow()).toEqual({ key: TESTSITE_ENABLED, value: stored, updatedAt: OLD_STAMP })
    }
  })

  it('PUT without the field does not create a row: the default stays true', async () => {
    expect((await putSettings()).status).toBe(200)
    expect(await storedRow()).toBeUndefined()
    expect(await getSettings()).toMatchObject({ testsiteEnabled: true })
  })

  it('rejects a non-boolean testsiteEnabled with 400 VALIDATION and changes nothing', async () => {
    await setRow('false')
    for (const bad of ['true', 'false', 'yes', 0, 1, null, {}, []] as unknown[]) {
      const res = await putSettings({ testsiteEnabled: bad })
      expect(res.status, `testsiteEnabled=${JSON.stringify(bad)}`).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    expect(await storedRow()).toEqual({ key: TESTSITE_ENABLED, value: 'false', updatedAt: OLD_STAMP })
    expect(await getSettings()).toMatchObject({ renderLimitDefault: 600, testsiteEnabled: false })
  })

  it('the five required fields are still required, and a rejected PUT does not flip the switch', async () => {
    for (const key of Object.keys(BASE)) {
      const { [key]: _omitted, ...rest } = BASE as Record<string, unknown>
      const res = await call(live, 'PUT', '/admin/settings', {
        cookie: admin,
        body: { ...rest, testsiteEnabled: false },
      })
      expect(res.status, `missing ${key}`).toBe(400)
    }
    // the switch alone is not a valid body either
    expect((await call(live, 'PUT', '/admin/settings', { cookie: admin, body: { testsiteEnabled: false } })).status).toBe(400)
    // a bad URL next to a valid switch: the whole request is refused
    expect((await putSettings({ contactLineUrl: 'http://evil.example', testsiteEnabled: false })).status).toBe(400)
    expect(await storedRow()).toBeUndefined()
    expect(await getSettings()).toMatchObject({ testsiteEnabled: true })
  })

  it('a member or an anonymous caller cannot flip the switch', async () => {
    expect((await putSettings({ testsiteEnabled: false }, member.cookie)).status).toBe(401)
    expect((await call(live, 'PUT', '/admin/settings', { body: { ...BASE, testsiteEnabled: false } })).status).toBe(401)
    expect((await call(live, 'GET', '/admin/settings', { cookie: member.cookie })).status).toBe(401)
    expect(await storedRow()).toBeUndefined()
  })

  it('only the exact text "false" reads as off; any other stored text reads as on', async () => {
    expect(parseTestsiteEnabled('false')).toBe(false)
    for (const v of ['true', undefined, null, '', 'FALSE', 'False', ' false', '0', 'off', 'no']) {
      expect(parseTestsiteEnabled(v), `${JSON.stringify(v)}`).toBe(true)
    }
    await setRow('off')
    expect(await getSettings()).toMatchObject({ testsiteEnabled: true })
    await setRow('false')
    expect(await getSettings()).toMatchObject({ testsiteEnabled: false })
  })

  it('public GET /contacts is unchanged and does not expose the switch', async () => {
    await putSettings({ testsiteEnabled: false })
    const res = await call(live, 'GET', '/contacts')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(await res.json()).toEqual({
      line: { id: '@x', url: 'https://x.co' },
      telegram: { id: '@y', url: 'https://y.co' },
    })
  })
})

// ---- TEST_STACK middleware -----------------------------------------------------------------------

describe('TEST_STACK middleware', () => {
  it('with TEST_STACK unset, the switch being off blocks nothing', async () => {
    expect((await putSettings({ testsiteEnabled: false })).status).toBe(200)
    expect((await call(live, 'GET', '/health')).status).toBe(200)
    expect((await call(live, 'GET', '/contacts')).status).toBe(200)
    expect((await call(live, 'GET', '/me', { cookie: member.cookie })).status).toBe(200)
    expect((await call(live, 'GET', '/admin/settings', { cookie: admin })).status).toBe(200)
    // only the exact text 'true' turns the gate on
    for (const v of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true']) {
      const res = await call({ ...live, TEST_STACK: v }, 'GET', '/contacts')
      expect(res.status, `TEST_STACK=${JSON.stringify(v)}`).toBe(200)
    }
  })

  it('with TEST_STACK not true it reads nothing from the database; with it true it reads', async () => {
    const d1 = brokenD1()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const v of [undefined, '', 'false', 'TRUE']) {
      const res = await call({ ...live, DB: d1.binding, TEST_STACK: v }, 'GET', '/health')
      expect(res.status, `TEST_STACK=${JSON.stringify(v)}`).toBe(200)
    }
    expect(d1.prepare).not.toHaveBeenCalled()

    const res = await call({ ...live, DB: d1.binding, TEST_STACK: 'true' }, 'GET', '/health')
    expect(res.status).toBe(200)
    expect(d1.prepare).toHaveBeenCalledTimes(1)
  })

  it('with TEST_STACK=true and no row, or any text but "false", the test site is served', async () => {
    expect((await call(testStack, 'GET', '/contacts')).status).toBe(200)
    for (const v of ['true', 'off', '0', 'FALSE', '']) {
      await setRow(v)
      resetTestStackCache()
      expect((await call(testStack, 'GET', '/contacts')).status, `stored ${JSON.stringify(v)}`).toBe(200)
    }
  })

  it('with TEST_STACK=true and the switch off: 503 TESTSITE_OFF on public, member and admin routes, with CORS', async () => {
    // The back office of the LIVE Worker flips it; the test Worker follows through the shared DB.
    expect((await putSettings({ testsiteEnabled: false })).status).toBe(200)
    const cases: [string, string, { cookie?: string; body?: unknown }][] = [
      ['GET', '/health', {}],
      ['GET', '/contacts', {}], // public
      ['GET', '/me', { cookie: member.cookie }], // member, with a valid session
      ['GET', '/me', {}], // member route, no session: the gate runs before auth
      ['GET', '/admin/settings', { cookie: admin }], // admin, with a valid session
      ['GET', '/admin/settings', {}], // admin route, no session
      ['POST', '/admin/login', { body: { username: 'admin', password: 'admin1234' } }],
      ['GET', '/no/such/route', {}],
    ]
    for (const [method, path, opts] of cases) {
      const res = await call(testStack, method, path, { ...opts, origin: ORIGIN })
      const label = `${method} ${path}${opts.cookie ? ' (session)' : ''}`
      expect(res.status, label).toBe(503)
      expect(await res.json(), label).toEqual(OFF_BODY)
      expect(res.headers.get('content-type'), label).toContain('application/json')
      expect(res.headers.get('access-control-allow-origin'), label).toBe(ORIGIN)
      expect(res.headers.get('access-control-allow-credentials'), label).toBe('true')
    }
    // CORS still applies its allow-list: a foreign origin gets the 503 but no permission to read it,
    // and the gate answers before the CSRF guard, so a foreign-origin write is 503 too (not 403).
    const foreign = await call(testStack, 'POST', '/admin/members', {
      cookie: admin,
      body: { displayName: 'x', expiresAt: new Date().toISOString() },
      origin: 'https://evil.example',
    })
    expect(foreign.status).toBe(503)
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
    // The same requests on the live Worker are untouched.
    expect((await call(live, 'GET', '/contacts', { origin: ORIGIN })).status).toBe(200)
    expect((await call(live, 'GET', '/me', { cookie: member.cookie, origin: ORIGIN })).status).toBe(200)
    expect((await call(live, 'GET', '/admin/settings', { cookie: admin, origin: ORIGIN })).status).toBe(200)
  })

  it('the CORS preflight is still answered while the switch is off, so the browser can read the 503', async () => {
    await setRow('false')
    const res = await app.request(
      '/admin/settings',
      {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
      },
      testStack,
    )
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
  })

  it('switching it on again serves the test Worker again (public, member and admin routes)', async () => {
    expect((await putSettings({ testsiteEnabled: false })).status).toBe(200)
    expect((await call(testStack, 'GET', '/contacts')).status).toBe(503)

    expect((await putSettings({ testsiteEnabled: true })).status).toBe(200)
    resetTestStackCache() // stands in for the <= 15 s wait, which the next test covers
    const pub = await call(testStack, 'GET', '/contacts', { origin: ORIGIN })
    expect(pub.status).toBe(200)
    expect(await pub.json()).toMatchObject({ line: { id: '@x' } })
    expect(pub.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    const mem = await call(testStack, 'GET', '/me', { cookie: member.cookie })
    expect(mem.status).toBe(200)
    expect(await mem.json()).toMatchObject({ displayName: 'สมาชิกสวิตช์' })
    const adm = await call(testStack, 'GET', '/admin/settings', { cookie: admin })
    expect(adm.status).toBe(200)
    expect(await adm.json()).toMatchObject({ testsiteEnabled: true })
    // and no session is still a plain 401 from the route, not the gate
    expect((await call(testStack, 'GET', '/me')).status).toBe(401)
  })

  it('remembers the switch for less than 15 seconds, then reads it again', async () => {
    expect(TEST_STACK_CACHE_MS).toBe(15_000)
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    const status = async () => (await call(testStack, 'GET', '/contacts')).status

    expect(await status()).toBe(200) // no row = on, remembered at t0
    await setRow('false') // flipped behind the Worker's back
    vi.setSystemTime(t0 + TEST_STACK_CACHE_MS - 1)
    expect(await status()).toBe(200) // still the remembered "on"
    vi.setSystemTime(t0 + TEST_STACK_CACHE_MS)
    expect(await status()).toBe(503) // 15 s old: read again, now off

    await setRow('true')
    vi.setSystemTime(t0 + 2 * TEST_STACK_CACHE_MS - 1)
    expect(await status()).toBe(503) // remembered "off" (read at t0 + 15 s)
    vi.setSystemTime(t0 + 2 * TEST_STACK_CACHE_MS)
    expect(await status()).toBe(200) // and on again
  })

  it('does not trust a remembered value stamped in the future (clock moved back)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    const status = async () => (await call(testStack, 'GET', '/contacts')).status
    expect(await status()).toBe(200) // remembered "on" at t0
    await setRow('false')
    vi.setSystemTime(t0 - 1000)
    expect(await status()).toBe(503)
  })

  it('treats a failed database read as ON, logs it, and does not remember the failure', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const d1 = brokenD1()
    const broken: Bindings = { ...testStack, DB: d1.binding }

    const first = await call(broken, 'GET', '/health', { origin: ORIGIN })
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ ok: true })
    expect(first.headers.get('access-control-allow-origin')).toBe(ORIGIN)
    expect(d1.prepare).toHaveBeenCalledTimes(1) // it did try to read
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('test stack switch'), expect.any(Error))

    // not remembered: the next request tries the database again
    expect((await call(broken, 'GET', '/health')).status).toBe(200)
    expect(d1.prepare).toHaveBeenCalledTimes(2)

    // and a working database that says "off" is believed straight away
    await setRow('false')
    expect((await call(testStack, 'GET', '/health')).status).toBe(503)
  })

  it('a failed read beats a remembered "off" that has expired (fails open)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    await setRow('false')
    expect((await call(testStack, 'GET', '/health')).status).toBe(503) // remembered "off" at t0

    vi.setSystemTime(t0 + 1000)
    const broken: Bindings = { ...testStack, DB: brokenD1().binding }
    expect((await call(broken, 'GET', '/health')).status).toBe(503) // still within 15 s: the memory wins

    vi.setSystemTime(t0 + TEST_STACK_CACHE_MS)
    expect((await call(broken, 'GET', '/health')).status).toBe(200) // expired + read failed = on
  })
})
