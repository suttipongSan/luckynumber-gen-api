// A change of the lottery catalogue (admin create / patch / delete of a lottery) is RECORDED in D1 for the public
// results site and published by nobody here: the record is results_version + 1 and the dirty marks, in the same batch as
// the change, and the cron of the results API (numbergen-results-api) builds and uploads the files within a minute.
// This API has no binding to the bucket and never calls it. These tests read the record straight from site_settings.
//
// The rows such a record leaves are a contract between the two Workers, so the SAME cross-check vector is pinned in
// both repos: numbergen-results-api/test/catalogueRecording.test.ts makes the changes with its own recordChangeStatements
// (the full copy of the minimal one that this repo has, src/lib/publicChange.ts); this file makes them through the admin
// routes, and both must leave exactly the rows in EXPECTED_ROWS. Around the vector: which changes count and which do not.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import app, { scheduled } from '../src/index'
import type { AdminLottery, AdminMember, AssetBucket, Bindings } from '../src/types'
import { hashPassword } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import { LOTTERY_CATALOG } from '../src/db/catalog'
import { lotteries, lotteryResults, lotterySchedules, siteSettings } from '../src/db/schema'

const DB_FILE = 'test-catalogue.db'
const DB_URL = `file:${DB_FILE}`

const fakeAssets: AssetBucket = {
  async put() {
    return {}
  },
  async get() {
    return null
  },
  async delete() {},
}

/** An R2 bucket that must never be touched: any property read or call fails the test that caused it. */
const touched: string[] = []
const forbiddenBucket = new Proxy(
  {},
  {
    get(_target, prop) {
      touched.push(String(prop))
      throw new Error(`numbergen-api touched the public results bucket (${String(prop)})`)
    },
  },
)

let env: Bindings
let admin: string
let member: { id: string; cookie: string }

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

interface CallOpts {
  cookie?: string
  body?: unknown
  headers?: Record<string, string>
  env?: Bindings
}

function call(method: string, path: string, o: CallOpts = {}) {
  const headers = new Headers(o.headers)
  if (o.cookie) headers.set('Cookie', o.cookie)
  let payload: string | undefined
  if (o.body !== undefined) {
    payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
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

const adm = (method: string, path: string, body?: unknown) => call(method, path, { cookie: admin, body })
const db = () => getDb(env)

async function sql(statement: string) {
  const { client } = openDb(DB_URL)
  try {
    return (await client.execute(statement)).rows
  } finally {
    client.close()
  }
}

/** The rows of site_settings that belong to the public results (version and marks), sorted by key. */
const resultsRows = async () =>
  (await db().select().from(siteSettings))
    .filter((r) => r.key.startsWith('results_'))
    .sort((a, b) => (a.key < b.key ? -1 : 1))

const SEED_VERSION = { key: 'results_version', value: '1', updatedAt: '2026-11-21T00:00:00.000Z' }

beforeAll(async () => {
  removeDb()
  await runMigrations(DB_URL)
  const { client, db: seed } = openDb(DB_URL)
  await seed.insert(lotteries).values(
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
    ASSETS: fakeAssets,
    // not in the type any more: if the code ever reached for it, this would fail the test
    ...({ PUBLIC_RESULTS: forbiddenBucket } as object),
  }
  const login = await call('POST', '/admin/login', { body: { username: 'admin', password: 'admin1234' } })
  expect(login.status).toBe(204)
  admin = cookieFrom(login, 'ng_admin')
  const created = await adm('POST', '/admin/members', { displayName: 'recorder', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() })
  const m = (await created.json()) as AdminMember
  const claimed = await call('POST', `/link/${m.linkToken}/set-password`, { body: { password: 'password-123' } })
  expect(claimed.status).toBe(204)
  member = { id: m.id, cookie: cookieFrom(claimed, 'ng_session') }
})

beforeEach(async () => {
  await resetLimiter(db())
  // the catalogue as seeded, no results, no schedules, and migration 0010's version counter as it is on a fresh database
  await db().delete(lotteryResults)
  await db().delete(lotterySchedules)
  await db().delete(siteSettings).where(eq(siteSettings.key, 'results_version'))
  for (const row of await db().select().from(siteSettings)) {
    if (row.key.startsWith('results_')) await db().delete(siteSettings).where(eq(siteSettings.key, row.key))
  }
  await db().insert(siteSettings).values(SEED_VERSION)
  await db().delete(lotteries).where(eq(lotteries.id, 'vector-new'))
  for (const l of LOTTERY_CATALOG) {
    await db().insert(lotteries).values({ id: l.id, name: l.name, shortName: l.shortName, groupKey: l.group, accent: l.accent, sortOrder: l.sortOrder, active: l.active }).onConflictDoNothing()
    await db().update(lotteries).set({ name: l.name, shortName: l.shortName, groupKey: l.group, accent: l.accent, sortOrder: l.sortOrder, active: l.active, publicEnabled: true, notifyTime: null, notifyEnabled: false }).where(eq(lotteries.id, l.id))
  }
  // a lottery made in an earlier test goes
  for (const row of await db().select({ id: lotteries.id, owner: lotteries.ownerMemberId }).from(lotteries)) {
    if (!LOTTERY_CATALOG.some((l) => l.id === row.id) && row.owner === null) await db().delete(lotteries).where(eq(lotteries.id, row.id))
  }
  touched.length = 0
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

// ---- THE VECTOR (identical in numbergen-results-api/test/catalogueRecording.test.ts) ---------------------------------
// Start: results_version = 1 (seeded by migration 0010), the official results below, one personal result and the
// official result of a lottery that is never touched.
const OFFICIAL = [
  ['hanoi-regular', '2026-11-18', ''],
  ['hanoi-regular', '2026-11-19', '09:00'],
  ['hanoi-regular', '2026-11-19', '16:30'], // a second draw on the same date: one mark for the date
  ['lao-vip', '2026-11-17', ''],
  ['dow-jones', '2026-11-15', ''], // a lottery that no step touches
] as const
const PERSONAL = ['hanoi-regular', '2026-11-16', 'member-vector'] as const // a member's own result: never marked
const T1 = '2026-11-20T03:00:01.000Z'
const T2 = '2026-11-20T03:00:02.000Z'
const T3 = '2026-11-20T03:00:03.000Z'
const T4 = '2026-11-20T03:00:04.000Z'
// Steps: T1 a new active lottery; T2 'hanoi-regular' renamed; T3 'hanoi-regular' switched off (active = false);
// T4 'lao-vip' deleted. Afterwards site_settings holds exactly these results_* rows (key, value, updated_at):
const EXPECTED_ROWS = [
  { key: 'results_dirty:d:2026-11-17', value: '5', updatedAt: T4 },
  { key: 'results_dirty:d:2026-11-18', value: '4', updatedAt: T3 },
  { key: 'results_dirty:d:2026-11-19', value: '4', updatedAt: T3 },
  { key: 'results_dirty:l:hanoi-regular', value: '4', updatedAt: T3 },
  { key: 'results_dirty:l:lao-vip', value: '5', updatedAt: T4 },
  { key: 'results_dirty:l:vector-new', value: '2', updatedAt: T1 },
  { key: 'results_version', value: '5', updatedAt: T4 },
]
// ------------------------------------------------------------------------------------------------------------------------

const row = (lotteryId: string, drawDate: string, drawTime: string, memberId = '') => ({
  id: `${lotteryId}|${drawDate}|${drawTime}|${memberId}`,
  lotteryId,
  drawDate,
  drawTime,
  memberId,
  top3: '123',
  top2: '45',
  bottom2: '67',
  source: null,
  createdAt: 'x',
  updatedAt: '2026-11-19T10:00:00.000Z',
})

async function seedResults() {
  await db().insert(lotteryResults).values([...OFFICIAL.map(([l, d, t]) => row(l, d, t)), row(PERSONAL[0], PERSONAL[1], '', PERSONAL[2])])
}

/** An admin PATCH of a catalog lottery. */
const patch = async (id: string, body: object) => {
  const res = await adm('PATCH', `/admin/lotteries/${id}`, body)
  expect(res.status).toBe(200)
  return (await res.json()) as AdminLottery
}
const newLottery = async (over: object = {}) => {
  const res = await adm('POST', '/admin/lotteries', { name: 'หวยเวกเตอร์', shortName: 'เวกเตอร์', group: 'other', accent: '#445566', sortOrder: 99999, active: true, ...over })
  expect(res.status).toBe(200)
  return (await res.json()) as AdminLottery
}

describe('the cross-check vector', () => {
  it('four admin changes leave exactly the rows that the results API\'s recordChangeStatements leaves for them', async () => {
    await seedResults()
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse(T1) })
    // T1: a new active lottery (POST /admin/lotteries)
    const created = await newLottery()
    vi.setSystemTime(Date.parse(T2))
    // T2: a rename
    await patch('hanoi-regular', { name: 'ฮานอย ปกติ (เวกเตอร์)' })
    vi.setSystemTime(Date.parse(T3))
    // T3: switched off: its file goes and every date it has official results on
    await patch('hanoi-regular', { active: false })
    vi.setSystemTime(Date.parse(T4))
    // T4: deleted: the record comes first in the batch, the marks read the dates that the deletes remove
    expect((await adm('DELETE', '/admin/lotteries/lao-vip')).status).toBe(204)
    // the new lottery's id is random: the vector names it 'vector-new'
    const rows = (await resultsRows()).map((r) => ({ ...r, key: r.key.replace(created.id, 'vector-new') })).sort((a, b) => (a.key < b.key ? -1 : 1))
    expect(rows).toEqual(EXPECTED_ROWS)
    expect(touched).toEqual([])
  })
})

describe('which catalogue changes are recorded (and which are not)', () => {
  beforeEach(seedResults)

  it('a new lottery that is active counts: version +1 and the mark of its file', async () => {
    const created = await newLottery()
    expect(await resultsRows()).toMatchObject([
      { key: `results_dirty:l:${created.id}`, value: '2' },
      { key: 'results_version', value: '2' },
    ])
  })

  it('a new lottery that is inactive is not public: nothing is recorded', async () => {
    await newLottery({ active: false })
    expect(await resultsRows()).toEqual([SEED_VERSION])
  })

  it.each([
    ['name', { name: 'ชื่อใหม่' }],
    ['shortName', { shortName: 'ชื่อสั้นใหม่' }],
    ['group', { group: 'lao' }],
    ['accent', { accent: '#112233' }],
    ['sortOrder', { sortOrder: 5 }],
  ])('a change of the %s of a public lottery counts once and marks its file only (no date)', async (_field, body) => {
    await patch('hanoi-regular', body)
    expect((await resultsRows()).map((r) => [r.key, r.value])).toEqual([
      ['results_dirty:l:hanoi-regular', '2'],
      ['results_version', '2'],
    ])
  })

  it('the same values again, an empty patch and the reminder default count nothing', async () => {
    await patch('hanoi-regular', { name: 'ฮานอย ปกติ', sortOrder: 10 }) // what it already is (src/db/catalog.ts)
    await patch('hanoi-regular', {})
    await patch('hanoi-regular', { notifyTime: '09:30', notifyEnabled: true })
    await patch('hanoi-regular', { notifyTime: null, notifyEnabled: false })
    const res = await adm('PUT', '/admin/notifications', { items: [{ lotteryId: 'hanoi-regular', notifyTime: '10:00', enabled: true }] })
    expect(res.status).toBe(200)
    expect(await resultsRows()).toEqual([SEED_VERSION])
  })

  it('switching a lottery off or on counts and marks every date it has official results on (not the other lotteries\', not a member\'s)', async () => {
    await patch('hanoi-regular', { active: false })
    expect((await resultsRows()).map((r) => [r.key, r.value])).toEqual([
      ['results_dirty:d:2026-11-18', '2'],
      ['results_dirty:d:2026-11-19', '2'],
      ['results_dirty:l:hanoi-regular', '2'],
      ['results_version', '2'],
    ])
    await patch('hanoi-regular', { active: true })
    expect((await resultsRows()).map((r) => [r.key, r.value])).toEqual([
      ['results_dirty:d:2026-11-18', '3'],
      ['results_dirty:d:2026-11-19', '3'],
      ['results_dirty:l:hanoi-regular', '3'],
      ['results_version', '3'],
    ])
  })

  it('a lottery that is not public before or after counts nothing: hidden with public_enabled = 0, or inactive and staying so', async () => {
    await db().update(lotteries).set({ publicEnabled: false }).where(eq(lotteries.id, 'hanoi-hd'))
    await patch('hanoi-hd', { name: 'ฮานอย HD ใหม่', sortOrder: 5 })
    await patch('hanoi-hd', { active: false })
    await patch('hanoi-hd', { active: true }) // active again, still hidden by the other switch
    await patch('hanoi-vip', { active: false }) // a lottery that was public: counts (this is the one change)
    const afterOne = await resultsRows()
    expect(afterOne.map((r) => [r.key, r.value])).toEqual([
      ['results_dirty:l:hanoi-vip', '2'],
      ['results_version', '2'],
    ])
    await patch('hanoi-vip', { name: 'ฮานอย VIP ใหม่', accent: '#000000' }) // inactive and staying inactive
    expect(await resultsRows()).toEqual(afterOne)
  })

  it('switching on a lottery that is hidden by public_enabled = 0 counts nothing either', async () => {
    await db().update(lotteries).set({ publicEnabled: false, active: false }).where(eq(lotteries.id, 'hanoi-hd'))
    await patch('hanoi-hd', { active: true })
    expect(await resultsRows()).toEqual([SEED_VERSION])
  })

  it('deleting a public lottery counts: its file and every date it has results on are marked, and its rows go', async () => {
    await sql("insert into lottery_schedules (lottery_id, draw_time, result_time) values ('lao-vip', '', '18:30')")
    expect((await adm('DELETE', '/admin/lotteries/lao-vip')).status).toBe(204)
    expect((await resultsRows()).map((r) => [r.key, r.value])).toEqual([
      ['results_dirty:d:2026-11-17', '2'],
      ['results_dirty:l:lao-vip', '2'],
      ['results_version', '2'],
    ])
    expect(await db().select().from(lotteryResults).where(eq(lotteryResults.lotteryId, 'lao-vip'))).toEqual([])
    expect(await db().select().from(lotterySchedules).where(eq(lotterySchedules.lotteryId, 'lao-vip'))).toEqual([]) // its schedule rows went with it
    expect(await db().select().from(lotteries).where(eq(lotteries.id, 'lao-vip'))).toEqual([])
    // the other lotteries' results are untouched
    expect((await db().select().from(lotteryResults)).filter((r) => r.lotteryId === 'dow-jones')).toHaveLength(1)
  })

  it('deleting a lottery that is not public records nothing, but still deletes its rows', async () => {
    await db().update(lotteries).set({ active: false }).where(eq(lotteries.id, 'lao-vip'))
    await sql("insert into lottery_schedules (lottery_id, draw_time, result_time) values ('lao-vip', '', '18:30')")
    expect((await adm('DELETE', '/admin/lotteries/lao-vip')).status).toBe(204)
    expect(await resultsRows()).toEqual([SEED_VERSION])
    expect(await db().select().from(lotteryResults).where(eq(lotteryResults.lotteryId, 'lao-vip'))).toEqual([])
    expect(await db().select().from(lotterySchedules).where(eq(lotterySchedules.lotteryId, 'lao-vip'))).toEqual([])
  })

  it('an unknown or a member\'s own lottery is 404 and records nothing', async () => {
    expect((await adm('PATCH', '/admin/lotteries/nope', { name: 'x' })).status).toBe(404)
    expect((await adm('DELETE', '/admin/lotteries/nope')).status).toBe(404)
    const own = await call('POST', '/lotteries', { cookie: member.cookie, body: { name: 'ของฉัน', group: 'other' } })
    const ownId = ((await own.json()) as { id: string }).id
    expect((await adm('PATCH', `/admin/lotteries/${ownId}`, { name: 'x' })).status).toBe(404)
    expect((await adm('DELETE', `/admin/lotteries/${ownId}`)).status).toBe(404)
    // the member's own lottery is created, renamed and deleted by the member: never recorded, never public
    expect((await call('PATCH', `/lotteries/${ownId}`, { cookie: member.cookie, body: { name: 'ใหม่' } })).status).toBe(200)
    expect((await call('DELETE', `/lotteries/${ownId}`, { cookie: member.cookie })).status).toBe(204)
    expect(await resultsRows()).toEqual([SEED_VERSION])
  })

  it('a refused request records nothing (validation, no session)', async () => {
    expect((await adm('PATCH', '/admin/lotteries/hanoi-regular', { sortOrder: 'x' })).status).toBe(400)
    expect((await adm('POST', '/admin/lotteries', { name: '' })).status).toBe(400)
    expect((await call('PATCH', '/admin/lotteries/hanoi-regular', { body: { name: 'x' } })).status).toBe(401)
    expect((await call('DELETE', '/admin/lotteries/hanoi-regular')).status).toBe(401)
    expect(await resultsRows()).toEqual([SEED_VERSION])
  })

  it('a version of a database that never had the counter row starts at 1 (the record creates it)', async () => {
    await db().delete(siteSettings).where(eq(siteSettings.key, 'results_version'))
    await patch('hanoi-regular', { name: 'ชื่อใหม่' })
    expect((await resultsRows()).map((r) => [r.key, r.value])).toEqual([
      ['results_dirty:l:hanoi-regular', '1'],
      ['results_version', '1'],
    ])
  })
})

describe('what is not a change of the public results', () => {
  beforeEach(seedResults)

  it('a member typing, replacing and removing their own result records nothing', async () => {
    const body = { lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '555', top2: '55', bottom2: '55' }
    expect((await call('PUT', '/results/mine', { cookie: member.cookie, body })).status).toBe(201)
    expect((await call('PUT', '/results/mine', { cookie: member.cookie, body: { ...body, top3: '666' } })).status).toBe(200)
    expect((await call('DELETE', '/results/mine?lotteryId=hanoi-regular&date=2026-11-19', { cookie: member.cookie })).status).toBe(200)
    expect(await resultsRows()).toEqual([SEED_VERSION])
  })

  it('the contact, render limit and test site settings do not touch the record, and the public results rows are not in /admin/settings', async () => {
    const before = await adm('GET', '/admin/settings')
    const settings = (await before.json()) as Record<string, unknown>
    expect(Object.keys(settings).sort()).toEqual(['contactLineId', 'contactLineUrl', 'contactTelegramId', 'contactTelegramUrl', 'renderLimitDefault', 'testsiteEnabled'])
    expect((await adm('PUT', '/admin/settings', settings)).status).toBe(200)
    await patch('hanoi-regular', { name: 'ชื่อใหม่' }) // a recorded change: still not in the settings
    const after = (await (await adm('GET', '/admin/settings')).json()) as Record<string, unknown>
    expect(Object.keys(after).sort()).toEqual(Object.keys(settings).sort())
    expect((await resultsRows()).map((r) => r.key)).toEqual(['results_dirty:l:hanoi-regular', 'results_version'])
  })

  it('deleting a member deletes their personal results and records nothing', async () => {
    const m = await adm('POST', '/admin/members', { displayName: 'leaver', expiresAt: new Date(Date.now() + 86400_000).toISOString() })
    const leaver = (await m.json()) as AdminMember
    await db().insert(lotteryResults).values(row('hanoi-regular', '2026-11-12', '', leaver.id))
    expect((await adm('DELETE', `/admin/members/${leaver.id}`)).status).toBe(204)
    expect((await db().select().from(lotteryResults)).filter((r) => r.memberId === leaver.id)).toEqual([])
    expect(await resultsRows()).toEqual([SEED_VERSION])
  })
})

describe('this API never touches the public results bucket', () => {
  it('nothing in src/ mentions the bucket outside comments, and wrangler.toml declares no binding for it (the test stack has no schedule either)', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) walk(path)
        else if (entry.name.endsWith('.ts')) files.push(path)
      }
    }
    walk('src')
    expect(files.length).toBeGreaterThan(30)
    // comments may talk about the bucket (src/lib/publicChange.ts says THIS API NEVER TOUCHES IT); code may not
    const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'))
      expect(code, file).not.toMatch(/PUBLIC_RESULTS|publicPublish|publicSnapshot|runScheduledPublish/)
    }
    const toml = readFileSync('wrangler.toml', 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(toml).not.toMatch(/PUBLIC_RESULTS|pnresult-public/)
    // the test Worker has no schedule: only production sends the reminders and cleans up the draws
    expect(toml).toMatch(/\[env\.test\.triggers\]\s*crons = \[\]/)
    expect(toml).toMatch(/^\[triggers\]\s*crons = \["\* \* \* \* \*"\]/m)
  })

  it('every kind of catalogue change, with the trap in the environment, never reaches for it', async () => {
    await seedResults()
    const created = await newLottery()
    await patch(created.id, { name: 'เปลี่ยนชื่อ' })
    await patch('hanoi-regular', { active: false })
    expect((await adm('DELETE', `/admin/lotteries/${created.id}`)).status).toBe(204)
    expect((await adm('DELETE', '/admin/lotteries/lao-vip')).status).toBe(204)
    expect((await adm('GET', '/admin/lotteries')).status).toBe(200)
    expect(touched).toEqual([])
  })

  it('the cron neither reads nor writes it, even with a version that is not published and the test stack switched on', async () => {
    await patch('hanoi-regular', { name: 'ชื่อใหม่' }) // results_version 2, nothing published
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const noisy = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const extra of [{}, { TEST_STACK: 'true' }]) {
      await expect(scheduled({ scheduledTime: Date.parse('2026-11-20T03:00:00Z') }, { ...env, ...extra })).resolves.toBeUndefined()
    }
    expect(touched).toEqual([])
    expect(log).not.toHaveBeenCalledWith('public snapshots', expect.anything())
    expect(noisy).not.toHaveBeenCalled()
    // and the record is as the change left it: nobody here consumes it
    expect((await resultsRows()).map((r) => [r.key, r.value])).toEqual([
      ['results_dirty:l:hanoi-regular', '2'],
      ['results_version', '2'],
    ])
  })

  it('GET /public-data/* and the results API\'s routes are not served here', async () => {
    for (const [method, path] of [
      ['GET', '/public-data/v1/today.json'],
      ['GET', '/public-data/v1/version.json'],
      ['GET', '/admin/public/status'],
      ['POST', '/admin/public/publish'],
      ['GET', '/admin/public/lotteries'],
      ['POST', '/admin/results/import'],
      ['GET', '/admin/results?date=2026-11-19'],
    ] as const) {
      const res = await call(method, path, { cookie: admin })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
    expect(touched).toEqual([])
  })
})
