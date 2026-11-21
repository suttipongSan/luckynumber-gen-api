// The members' own results: PUT /results/mine and DELETE /results/mine (create, replace, remove,
// validation, which lotteries a member may use, who may call them), which result a member reads
// from GET /results (their own wins over the official one of the lottery and date and the official
// one applies again after a delete), isolation between members, the back office and the robot never
// listing, deleting or being blocked by a personal result, and the cascades of a deleted member or
// lottery. Real libSQL file DB with the project's migrations. The official results themselves
// (PUT /results, GET /admin/results, DELETE /results/:id) and migration 0009 are in results.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { eq, sql } from 'drizzle-orm'
import app from '../src/index'
import type {
  AdminLottery,
  AdminLotteryResult,
  AdminMember,
  AssetBucket,
  Bindings,
  Lottery,
  MemberLotteryResult,
  MemberLotteryResultsOfDay,
} from '../src/types'
import { hashPassword } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import { LOTTERY_CATALOG } from '../src/db/catalog'
import { lotteries, lotteryResults } from '../src/db/schema'
import { requireVisibleLottery, resolveForMember, type ResultRow } from '../src/lib/results'

// Everything in lib/results is the real code; the wrapper only lets one test make the visibility
// check pass for a lottery that is gone by the time of the write (see "between the check and the write").
vi.mock('../src/lib/results', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/results')>()
  return { ...actual, requireVisibleLottery: vi.fn(actual.requireVisibleLottery) }
})

const DB_FILE = 'test-memberresults.db'
const DB_URL = `file:${DB_FILE}`
const KEY = 'test-memberresults-key-0123456789abcdef0123456789abcdef'
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const D = '2026-11-19'

const fakeBucket: AssetBucket = {
  async put() {
    return {}
  },
  async get() {
    return null
  },
  async delete() {},
}

type Member = { id: string; cookie: string }
let env: Bindings
let admin: string
let alice: Member
let bob: Member
/** A private lottery of each of them (a member may type results for these too). */
let aliceOwn: Lottery
let bobOwn: Lottery

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

interface CallOpts {
  cookie?: string
  /** value of the X-API-Key header */
  key?: string
  body?: unknown
  headers?: Record<string, string>
}

function call(method: string, path: string, o: CallOpts = {}) {
  const headers = new Headers(o.headers)
  if (o.cookie) headers.set('Cookie', o.cookie)
  if (o.key !== undefined) headers.set('X-API-Key', o.key)
  let payload: string | undefined
  if (o.body !== undefined) {
    payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
    headers.set('Content-Type', 'application/json')
  }
  return app.request(path, { method, headers, body: payload }, env)
}

/** PUT /results/mine as `cookie` (a member session). */
const putMine = (cookie: string | undefined, body: unknown, o: CallOpts = {}) => call('PUT', '/results/mine', { ...o, cookie, body })
/** DELETE /results/mine?... as `cookie`. */
const delMine = (cookie: string | undefined, params: Record<string, string>, o: CallOpts = {}) =>
  call('DELETE', `/results/mine?${new URLSearchParams(params)}`, { ...o, cookie })
/** PUT /results: the official result, by the robot key unless told otherwise. */
const putOfficial = (body: unknown, o: CallOpts = { key: KEY }) => call('PUT', '/results', { ...o, body })

function cookieFrom(res: Response, name: string): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = raw.match(new RegExp(`${name}=([^;]*)`))
  if (!m) throw new Error(`no ${name} cookie in: ${raw}`)
  return `${name}=${m[1]}`
}

async function adminCookie(): Promise<string> {
  const res = await call('POST', '/admin/login', { body: { username: 'admin', password: 'admin1234' } })
  expect(res.status).toBe(204)
  return cookieFrom(res, 'ng_admin')
}

/** A member made through the back office, link claimed. */
async function newMember(name: string): Promise<Member> {
  const res = await call('POST', '/admin/members', {
    cookie: admin,
    body: { displayName: name, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
  })
  const m = (await res.json()) as AdminMember
  const sp = await call('POST', `/link/${m.linkToken}/set-password`, { body: { password: 'password-123' } })
  expect(sp.status).toBe(204)
  return { id: m.id, cookie: cookieFrom(sp, 'ng_session') }
}

async function newOwnLottery(member: Member, name: string): Promise<Lottery> {
  const res = await call('POST', '/lotteries', { cookie: member.cookie, body: { name, group: 'other' } })
  expect(res.status).toBe(200)
  return (await res.json()) as Lottery
}

const allRows = () => getDb(env).select().from(lotteryResults)
const rowsOf = (memberId: string) => getDb(env).select().from(lotteryResults).where(eq(lotteryResults.memberId, memberId))
const rowsOfLottery = (lotteryId: string) => getDb(env).select().from(lotteryResults).where(eq(lotteryResults.lotteryId, lotteryId))

const readDay = async (cookie: string, date: string) => {
  const res = await call('GET', `/results?date=${date}`, { cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as { date: string; results: MemberLotteryResult[] }
}

/** What GET /results lists for one lottery. */
const readLottery = async (cookie: string, lotteryId: string, date = D) =>
  (await readDay(cookie, date)).results.filter((r) => r.lotteryId === lotteryId)

const setActive = (id: string, active: boolean) => getDb(env).update(lotteries).set({ active }).where(eq(lotteries.id, id))

/** Runs raw SQL on the test database through a second connection (triggers that simulate failures). */
async function sqlite(statement: string) {
  const { client } = openDb(DB_URL)
  try {
    await client.execute(statement)
  } finally {
    client.close()
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
    RESULTS_API_KEY: KEY,
  }
  admin = await adminCookie()
  alice = await newMember('alice')
  bob = await newMember('bob')
  aliceOwn = await newOwnLottery(alice, 'หวยของอลิซ')
  bobOwn = await newOwnLottery(bob, 'หวยของบ๊อบ')
})

beforeEach(async () => {
  await resetLimiter(getDb(env))
  // every test starts without results (the catalog, the members and their own lotteries stay)
  await getDb(env).delete(lotteryResults)
})

afterAll(() => {
  try {
    removeDb()
  } catch {
    // file may still be held open on Windows; harmless
  }
})

// ---- PUT /results/mine: create and replace -------------------------------------------------------

describe('PUT /results/mine: create and replace', () => {
  const draw = { lotteryId: 'hanoi-regular', date: D }

  it("stores the result as the caller's own (201) and answers what the member now reads", async () => {
    const res = await putMine(alice.cookie, { ...draw, top3: '042', top2: '57', bottom2: '08' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      date: D,
      lotteryId: 'hanoi-regular',
      results: [{ lotteryId: 'hanoi-regular', date: D, time: '', top3: '042', top2: '57', bottom2: '08', mine: true, official: null }],
    })
    const rows = await allRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: expect.stringMatching(/^[0-9A-Za-z]{16}$/),
      lotteryId: 'hanoi-regular',
      drawDate: D,
      drawTime: '',
      memberId: alice.id, // never '' (official) and never somebody else
      top3: '042',
      top2: '57',
      bottom2: '08',
      source: null, // no source on a personal result
      createdAt: expect.stringMatching(ISO),
      updatedAt: rows[0].createdAt,
    })
  })

  it('a second PUT of the same draw replaces it (200): same id and createdAt, one row, and the numbers become exactly what was sent', async () => {
    await putMine(alice.cookie, { ...draw, top3: '123', top2: '45', bottom2: '67' })
    const [first] = await allRows()
    await new Promise((r) => setTimeout(r, 5))
    const res = await putMine(alice.cookie, { ...draw, bottom2: '10' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as MemberLotteryResultsOfDay
    expect(body.results).toEqual([{ lotteryId: 'hanoi-regular', date: D, time: '', top3: null, top2: null, bottom2: '10', mine: true, official: null }])
    const rows = await allRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: first.id, createdAt: first.createdAt, memberId: alice.id, top3: null, top2: null, bottom2: '10' })
    expect(rows[0].updatedAt > first.updatedAt).toBe(true)
    // null means "not given" as well
    const nulls = await putMine(alice.cookie, { ...draw, top3: '321', top2: null, bottom2: null })
    expect(nulls.status).toBe(200)
    expect(((await nulls.json()) as MemberLotteryResultsOfDay).results[0]).toMatchObject({ top3: '321', top2: null, bottom2: null })
    expect(await allRows()).toHaveLength(1)
  })

  it('a result may hold just one of the three numbers, and leading zeros survive', async () => {
    for (const [field, value, time] of [
      ['top3', '007', ''],
      ['top2', '05', '10:00'],
      ['bottom2', '00', '11:00'],
    ] as const) {
      const res = await putMine(alice.cookie, { ...draw, time, [field]: value })
      expect(res.status, field).toBe(201)
      const mine = ((await res.json()) as MemberLotteryResultsOfDay).results.find((r) => r.time === time)
      expect(mine, field).toMatchObject({ top3: null, top2: null, bottom2: null, [field]: value, mine: true })
    }
  })

  it('the draw is (lottery, date, time): another time, date or lottery is another row; "", null and no time are the same draw', async () => {
    const make = async (extra: Record<string, unknown>) => (await putMine(alice.cookie, { ...draw, top2: '12', ...extra })).status
    expect(await make({})).toBe(201) // time omitted = ''
    expect(await make({ time: '' })).toBe(200)
    expect(await make({ time: null })).toBe(200)
    expect(await make({ time: '09:00' })).toBe(201)
    expect(await make({ time: '16:30' })).toBe(201)
    expect(await make({ time: '16:30' })).toBe(200)
    expect(await make({ date: '2026-11-20' })).toBe(201)
    expect((await putMine(alice.cookie, { lotteryId: 'hanoi-vip', date: D, top2: '12' })).status).toBe(201)
    const rows = await allRows()
    expect(rows).toHaveLength(5)
    expect(rows.every((r) => r.memberId === alice.id)).toBe(true)
    expect(rows.map((r) => `${r.lotteryId}|${r.drawDate}|${r.drawTime}`).sort()).toEqual([
      'hanoi-regular|2026-11-19|',
      'hanoi-regular|2026-11-19|09:00',
      'hanoi-regular|2026-11-19|16:30',
      'hanoi-regular|2026-11-20|',
      'hanoi-vip|2026-11-19|',
    ])
  })

  it('writers racing for one draw leave one row (exactly one of them inserted it)', async () => {
    const statuses = (
      await Promise.all(Array.from({ length: 6 }, (_, i) => putMine(alice.cookie, { ...draw, top3: `${i}${i}${i}` })))
    ).map((r) => r.status)
    expect(statuses.filter((s) => s === 201)).toHaveLength(1)
    expect(statuses.filter((s) => s === 200)).toHaveLength(5)
    const rows = await allRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].top3).toMatch(/^(\d)\1\1$/)
  })

  it('answers the rows of that lottery only, as GET /results lists them', async () => {
    await putMine(alice.cookie, { lotteryId: 'hanoi-vip', date: D, top2: '99' })
    const res = await putMine(alice.cookie, { ...draw, top2: '12' })
    const body = (await res.json()) as MemberLotteryResultsOfDay
    expect(body.results.map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
    expect((await readDay(alice.cookie, D)).results.map((r) => r.lotteryId)).toEqual(['hanoi-regular', 'hanoi-vip'])
  })

  it('the numbers show at once in GET /results (no caching)', async () => {
    await putMine(alice.cookie, { ...draw, top3: '111' })
    expect((await readLottery(alice.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '111', mine: true })
    await putMine(alice.cookie, { ...draw, top3: '222' })
    expect((await readLottery(alice.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '222', mine: true })
  })
})

// ---- validation ----------------------------------------------------------------------------------

describe('PUT /results/mine: validation', () => {
  const good = { lotteryId: 'hanoi-regular', date: D, top3: '123', top2: '45', bottom2: '67' }
  const errorOf = async (body: unknown) => {
    const res = await putMine(alice.cookie, body)
    expect(res.status, JSON.stringify(body)).toBe(400)
    const json = (await res.json()) as { error: { code: string; message: string } }
    expect(json.error.code).toBe('VALIDATION')
    expect(json.error.message).toEqual(expect.any(String))
    return json.error.message
  }

  it.each([
    ['top3', '12'],
    ['top3', '1234'],
    ['top3', 'abc'],
    ['top3', '12a'],
    ['top3', ' 123'],
    ['top3', '123 '],
    ['top3', '1 3'],
    ['top3', '-12'],
    ['top3', '1.5'],
    ['top3', '๑๒๓'], // Thai digits
    ['top3', '١٢٣'], // Arabic-Indic digits
    ['top3', '１２３'], // full-width digits
    ['top3', 123],
    ['top3', true],
    ['top3', ['1', '2', '3']],
    ['top2', '5'],
    ['top2', '123'],
    ['top2', 'x1'],
    ['top2', '4 '],
    ['top2', 45],
    ['bottom2', ''],
    ['bottom2', '1'],
    ['bottom2', '100'],
    ['bottom2', '٠١'],
    ['bottom2', 7],
  ])('refuses %s = %j and stores nothing', async (field, value) => {
    const message = await errorOf({ ...good, [field]: value })
    expect(message).toContain(field)
    expect(await allRows()).toHaveLength(0)
  })

  it('needs at least one of top3 / top2 / bottom2', async () => {
    await errorOf({ lotteryId: 'hanoi-regular', date: D })
    await errorOf({ lotteryId: 'hanoi-regular', date: D, top3: null, top2: null, bottom2: null })
    await errorOf({ lotteryId: 'hanoi-regular', date: D, time: '09:00' })
    expect(await allRows()).toHaveLength(0)
  })

  it.each([
    [undefined],
    [null],
    [''],
    ['2026-13-01'],
    ['2026-00-10'],
    ['2026-02-30'],
    ['2025-02-29'],
    ['2026-11-31'],
    ['2026-1-9'],
    ['26-11-19'],
    ['2026/11/19'],
    ['19-11-2026'],
    [' 2026-11-19'],
    ['2026-11-19 '],
    ['2026-11-19T10:00'],
    ['2026-11-19T00:00:00Z'],
    ['Nov 19 2026'],
    ['today'],
    [20261119],
  ])('refuses date = %j (it has to be a real day written YYYY-MM-DD)', async (date) => {
    const { date: _drop, ...rest } = good
    void _drop
    await errorOf(date === undefined ? rest : { ...rest, date })
    expect(await allRows()).toHaveLength(0)
  })

  it('accepts a real leap day', async () => {
    expect((await putMine(alice.cookie, { ...good, date: '2028-02-29' })).status).toBe(201)
  })

  it.each([['24:00'], ['9:30'], ['09:5'], ['16:60'], ['16:30:00'], ['1630'], ['16-30'], ['abc'], [' 16:30'], ['16:30 '], ['4:30pm'], [1630], [true]])(
    'refuses time = %j',
    async (time) => {
      const message = await errorOf({ ...good, time })
      expect(message).toContain('time')
      expect(await allRows()).toHaveLength(0)
    },
  )

  it.each([['00:00'], ['00:01'], ['09:05'], ['12:00'], ['23:59']])('accepts time = %s', async (time) => {
    const res = await putMine(alice.cookie, { ...good, time })
    expect(res.status).toBe(201)
    expect(((await res.json()) as MemberLotteryResultsOfDay).results[0]).toMatchObject({ time })
  })

  it('needs the lottery by id', async () => {
    const { lotteryId: _id, ...noLottery } = good
    void _id
    await errorOf(noLottery)
    await errorOf({ ...noLottery, lotteryId: null })
    await errorOf({ ...noLottery, lotteryId: '' })
    await errorOf({ ...noLottery, lotteryId: 42 })
    await errorOf({ ...noLottery, lotteryId: ['hanoi-regular'] })
    await errorOf({ ...noLottery, lotteryId: 'x'.repeat(65) })
    // a name is not an id here (a member's own lottery names may repeat a catalog name)
    await errorOf({ ...noLottery, lotteryName: 'ฮานอย ปกติ' })
    await errorOf({ ...good, lotteryName: 'ฮานอย ปกติ' })
    expect(await allRows()).toHaveLength(0)
  })

  it('refuses every key it does not know, in particular anything that says whose result it is', async () => {
    for (const extra of [
      { source: 'robot' },
      { memberId: bob.id },
      { member_id: bob.id },
      { mine: true },
      { official: null },
      { id: 'abc' },
      { bottom_2: '67' },
      { draw_date: D },
    ]) {
      const message = await errorOf({ ...good, ...extra })
      expect(message).toContain(Object.keys(extra)[0])
    }
    expect(await allRows()).toHaveLength(0)
  })

  it('refuses a body that is not a JSON object', async () => {
    // strings are sent as they are, so these are raw request bodies
    for (const body of ['not json', '[]', 'null', '"text"', '42', '']) {
      const res = await putMine(alice.cookie, body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    expect(await allRows()).toHaveLength(0)
  })

  it('refuses a body over 1 KB (a real one is under 150 bytes) without reading it further', async () => {
    const res = await putMine(alice.cookie, { ...good, padding: 'x'.repeat(2000) })
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: { code: string; message: string } }
    expect(json.error.code).toBe('VALIDATION')
    expect(json.error.message).toContain('1 KB')
    expect(await allRows()).toHaveLength(0)
    // the limit counts bytes, not characters: 400 Thai characters are 1200 bytes
    const thai = await putMine(alice.cookie, `{"lotteryId":"hanoi-regular","date":"${D}","top3":"123","x":"${'ก'.repeat(400)}"}`)
    expect(thai.status).toBe(400)
    expect(((await thai.json()) as { error: { message: string } }).error.message).toContain('1 KB')
  })

  it('checks the body before looking up the lottery (400, not 404)', async () => {
    expect((await putMine(alice.cookie, { ...good, lotteryId: 'nope', top3: '12' })).status).toBe(400)
  })
})

// ---- which lotteries a member may use ------------------------------------------------------------

describe('which lotteries a member may use', () => {
  const draw = (lotteryId: string) => ({ lotteryId, date: D, top3: '123' })
  const notFound = async (res: Response) => {
    expect(res.status).toBe(404)
    const json = (await res.json()) as { error: { code: string; message: string } }
    expect(json.error.code).toBe('LOTTERY_NOT_FOUND')
    expect(json.error.message).toEqual(expect.any(String))
    return json.error.message
  }

  it('an active catalog lottery: yes', async () => {
    expect((await putMine(alice.cookie, draw('hanoi-regular'))).status).toBe(201)
    expect((await putMine(bob.cookie, draw('hanoi-regular'))).status).toBe(201)
  })

  it('the own lottery of the member: yes, and nobody else reads it', async () => {
    const res = await putMine(alice.cookie, { ...draw(aliceOwn.id), top2: '42' })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ lotteryId: aliceOwn.id, results: [{ lotteryId: aliceOwn.id, top3: '123', top2: '42', bottom2: null, mine: true, official: null }] })
    expect(await readLottery(alice.cookie, aliceOwn.id)).toHaveLength(1)
    expect(await readLottery(bob.cookie, aliceOwn.id)).toEqual([])
    expect((await rowsOfLottery(aliceOwn.id))[0]).toMatchObject({ memberId: alice.id })
  })

  it("another member's own lottery is 404, for the write and for the delete, and nothing is stored", async () => {
    await notFound(await putMine(alice.cookie, draw(bobOwn.id)))
    await notFound(await delMine(alice.cookie, { lotteryId: bobOwn.id, date: D }))
    expect(await allRows()).toHaveLength(0)
    // bob's own result of it is not reachable for alice, and it stays
    expect((await putMine(bob.cookie, draw(bobOwn.id))).status).toBe(201)
    await notFound(await delMine(alice.cookie, { lotteryId: bobOwn.id, date: D }))
    expect(await rowsOf(bob.id)).toHaveLength(1)
  })

  it('a catalog lottery that is switched off is 404 too, even with an official result; the member row waits until it is on again', async () => {
    expect((await putMine(alice.cookie, draw('hanoi-vip'))).status).toBe(201)
    expect((await putOfficial({ lotteryId: 'hanoi-vip', date: D, top2: '11' })).status).toBe(201)
    await setActive('hanoi-vip', false)
    try {
      await notFound(await putMine(alice.cookie, draw('hanoi-vip')))
      await notFound(await delMine(alice.cookie, { lotteryId: 'hanoi-vip', date: D }))
      // not listed while the lottery is off, but nothing was deleted
      expect(await readLottery(alice.cookie, 'hanoi-vip')).toEqual([])
      expect(await rowsOf(alice.id)).toHaveLength(1)
    } finally {
      await setActive('hanoi-vip', true)
    }
    expect(await readLottery(alice.cookie, 'hanoi-vip')).toMatchObject([{ mine: true, top3: '123' }])
  })

  it('an unknown id is 404, and the three kinds of "no" answer alike (nothing tells that a lottery exists)', async () => {
    await setActive('hanoi-vip', false)
    try {
      const answers = [] as string[]
      for (const id of ['no-such-lottery', 'hanoi-vip', bobOwn.id]) {
        const message = await notFound(await putMine(alice.cookie, draw(id)))
        answers.push(message.replace(id, '<id>'))
        const del = await notFound(await delMine(alice.cookie, { lotteryId: id, date: D }))
        expect(del.replace(id, '<id>')).toBe(message.replace(id, '<id>'))
      }
      expect(new Set(answers).size).toBe(1)
    } finally {
      await setActive('hanoi-vip', true)
    }
    expect(await allRows()).toHaveLength(0)
  })

  it('a lottery that is deleted between the check and the write is 404, not a 500', async () => {
    // The check answers "fine" for an id that is gone by the time of the insert, exactly what an
    // admin deleting the lottery in between would cause: the FOREIGN KEY of the insert fails and the
    // route checks again (the real check, which finds nothing).
    vi.mocked(requireVisibleLottery).mockImplementationOnce(async () => {})
    const res = await putMine(alice.cookie, draw('deleted-meanwhile'))
    expect(await notFound(res)).toContain('deleted-meanwhile')
    expect(await allRows()).toHaveLength(0)
    // the stub was used up: the next request is checked for real
    await notFound(await putMine(alice.cookie, draw('deleted-meanwhile')))
    expect((await putMine(alice.cookie, draw('hanoi-regular'))).status).toBe(201)
  })

  it('any other failure of the write is a real error (500 INTERNAL), not a made-up 404', async () => {
    await sqlite(
      `CREATE TRIGGER boom BEFORE INSERT ON lottery_results WHEN NEW.draw_date = '2026-12-31'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await putMine(alice.cookie, { ...draw('hanoi-regular'), date: '2026-12-31' })
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL' } })
    } finally {
      log.mockRestore()
      await sqlite('DROP TRIGGER boom')
    }
    expect(await allRows()).toHaveLength(0)
    expect((await putMine(alice.cookie, { ...draw('hanoi-regular'), date: '2026-12-31' })).status).toBe(201)
  })
})

// ---- who may call it -----------------------------------------------------------------------------

describe('PUT / DELETE /results/mine: members only', () => {
  const body = { lotteryId: 'hanoi-regular', date: D, top3: '123' }
  const del = { lotteryId: 'hanoi-regular', date: D }
  const unauthenticated = async (res: Response) => {
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED', message: expect.any(String) } })
  }

  it('no session: 401, and neither the admin cookie nor the results key stands in for a member', async () => {
    for (const o of [{}, { cookie: admin }, { key: KEY }, { cookie: admin, key: KEY }]) {
      await unauthenticated(await call('PUT', '/results/mine', { ...o, body }))
      await unauthenticated(await call('DELETE', `/results/mine?${new URLSearchParams(del)}`, o))
    }
    // a damaged member cookie is no session either (its signature is hex: change the last digit for sure)
    await unauthenticated(await putMine(alice.cookie.slice(0, -1) + (alice.cookie.endsWith('0') ? '1' : '0'), body))
    expect(await allRows()).toHaveLength(0)
  })

  it('"mine" is never read as the id of DELETE /results/:id (that one is the back office)', async () => {
    // if the admin route caught it, an admin cookie would get 404 NOT_FOUND from there
    const res = await call('DELETE', '/results/mine', { cookie: admin })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    // and the other way round: an id still reaches the admin route
    const official = (await (await putOfficial(body)).json()) as AdminLotteryResult
    expect((await call('DELETE', `/results/${official.id}`, { cookie: admin })).status).toBe(204)
    expect((await call('DELETE', `/results/${official.id}`, { cookie: alice.cookie })).status).toBe(401)
  })

  it('a disabled or expired member gets 403', async () => {
    const carol = await newMember('carol')
    const patch = (b: unknown) => call('PATCH', `/admin/members/${carol.id}`, { cookie: admin, body: b })
    expect((await putMine(carol.cookie, body)).status).toBe(201)
    await patch({ disabled: true })
    for (const res of [await putMine(carol.cookie, body), await delMine(carol.cookie, del)]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'DISABLED' } })
    }
    await patch({ disabled: false, expiresAt: new Date(Date.now() - 1000).toISOString() })
    for (const res of [await putMine(carol.cookie, body), await delMine(carol.cookie, del)]) {
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ error: { code: 'EXPIRED' } })
    }
    expect(await rowsOf(carol.id)).toHaveLength(1) // the row from before is still there
  })

  it('from a foreign Origin the write is 403 (the CSRF guard); an allowed Origin passes', async () => {
    const evil = { Origin: 'https://evil.example' }
    expect((await putMine(alice.cookie, body, { headers: evil })).status).toBe(403)
    expect((await delMine(alice.cookie, del, { headers: evil })).status).toBe(403)
    expect(await allRows()).toHaveLength(0)
    const ok = { Origin: 'http://localhost:5173' }
    expect((await putMine(alice.cookie, body, { headers: ok })).status).toBe(201)
    expect((await delMine(alice.cookie, del, { headers: evil })).status).toBe(403)
    expect(await allRows()).toHaveLength(1)
    expect((await delMine(alice.cookie, del, { headers: ok })).status).toBe(200)
    expect(await allRows()).toHaveLength(0)
  })

  it('PUT /results (robot key or admin) cannot write a personal result: a member id is refused', async () => {
    for (const o of [{ key: KEY }, { cookie: admin }]) {
      const res = await putOfficial({ ...body, memberId: alice.id }, o)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('memberId')
    }
    expect(await allRows()).toHaveLength(0)
  })
})

// ---- DELETE /results/mine ------------------------------------------------------------------------

describe('DELETE /results/mine', () => {
  const draw = { lotteryId: 'hanoi-regular', date: D, top3: '123', top2: '45' }
  const params = { lotteryId: 'hanoi-regular', date: D }

  it('removes the own result of that draw (200) and answers what the member reads now', async () => {
    await putMine(alice.cookie, draw)
    const res = await delMine(alice.cookie, params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ date: D, lotteryId: 'hanoi-regular', results: [] })
    expect(await allRows()).toHaveLength(0)
    expect(await readLottery(alice.cookie, 'hanoi-regular')).toEqual([])
  })

  it('is idempotent: 200 again when there is nothing to remove', async () => {
    expect((await delMine(alice.cookie, params)).status).toBe(200)
    await putMine(alice.cookie, draw)
    expect((await delMine(alice.cookie, params)).status).toBe(200)
    const again = await delMine(alice.cookie, params)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ date: D, lotteryId: 'hanoi-regular', results: [] })
  })

  it('removes exactly the draw named by lottery, date and time and nothing else', async () => {
    await putMine(alice.cookie, draw)
    await putMine(alice.cookie, { ...draw, time: '09:00' })
    await putMine(alice.cookie, { ...draw, time: '16:30' })
    await putMine(alice.cookie, { ...draw, date: '2026-11-20' })
    await putMine(alice.cookie, { ...draw, lotteryId: 'hanoi-vip' })
    await delMine(alice.cookie, { ...params, time: '09:00' })
    const left = (await allRows()).map((r) => `${r.lotteryId}|${r.drawDate}|${r.drawTime}`).sort()
    expect(left).toEqual(['hanoi-regular|2026-11-19|', 'hanoi-regular|2026-11-19|16:30', 'hanoi-regular|2026-11-20|', 'hanoi-vip|2026-11-19|'])
    // no time = '' (the draw without a time); `time=` is the same
    await delMine(alice.cookie, params)
    expect((await allRows()).some((r) => r.lotteryId === 'hanoi-regular' && r.drawDate === D && r.drawTime === '')).toBe(false)
    await putMine(alice.cookie, draw)
    await delMine(alice.cookie, { ...params, time: '' })
    expect((await allRows()).some((r) => r.lotteryId === 'hanoi-regular' && r.drawDate === D && r.drawTime === '')).toBe(false)
    expect(await allRows()).toHaveLength(3)
  })

  it('the answer lists what is left of that lottery and date: the other draws of the member', async () => {
    await putMine(alice.cookie, draw)
    await putMine(alice.cookie, { ...draw, time: '09:00', top3: '999' })
    const res = await delMine(alice.cookie, params)
    expect(((await res.json()) as MemberLotteryResultsOfDay).results).toEqual([
      { lotteryId: 'hanoi-regular', date: D, time: '09:00', top3: '999', top2: '45', bottom2: null, mine: true, official: null },
    ])
  })

  it('needs lotteryId and a real date; time is HH:MM or empty; other parameters are ignored', async () => {
    const bad = async (query: string) => {
      const res = await call('DELETE', `/results/mine${query}`, { cookie: alice.cookie })
      expect(res.status, query).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    await putMine(alice.cookie, draw)
    await bad('')
    await bad('?lotteryId=hanoi-regular')
    await bad(`?date=${D}`)
    await bad(`?lotteryId=&date=${D}`)
    await bad(`?lotteryId=${'x'.repeat(65)}&date=${D}`)
    await bad('?lotteryId=hanoi-regular&date=')
    await bad('?lotteryId=hanoi-regular&date=2026-02-30')
    await bad('?lotteryId=hanoi-regular&date=19-11-2026')
    await bad(`?lotteryId=hanoi-regular&date=${D}&time=9:30`)
    await bad(`?lotteryId=hanoi-regular&date=${D}&time=24:00`)
    await bad(`?lotteryId=hanoi-regular&date=${D}&time=16:30:00`)
    expect(await allRows()).toHaveLength(1) // nothing was deleted by a bad request
    // the query cannot name a member: such a parameter is ignored and the caller's own row is the target
    const res = await call('DELETE', `/results/mine?lotteryId=hanoi-regular&date=${D}&memberId=${bob.id}&member_id=`, { cookie: alice.cookie })
    expect(res.status).toBe(200)
    expect(await allRows()).toHaveLength(0)
  })

  it('an unknown lottery is 404 (more in "which lotteries a member may use")', async () => {
    const res = await delMine(alice.cookie, { lotteryId: 'no-such-lottery', date: D })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'LOTTERY_NOT_FOUND' } })
  })
})

// ---- which result a member reads -----------------------------------------------------------------

describe('GET /results: the own result wins over the official one', () => {
  const draw = { lotteryId: 'hanoi-regular', date: D }
  const officialNumbers = { top3: '123', top2: '45', bottom2: '67' }
  const row = (lotteryId: string, time: string, numbers: Partial<Record<'top3' | 'top2' | 'bottom2', string>>, mine: boolean, official: MemberLotteryResult['official'] = null): MemberLotteryResult => ({
    lotteryId,
    date: D,
    time,
    top3: null,
    top2: null,
    bottom2: null,
    ...numbers,
    mine,
    official,
  })

  it('without an own result a member reads the official one (mine: false)', async () => {
    await putOfficial({ ...draw, ...officialNumbers })
    expect((await readDay(alice.cookie, D)).results).toEqual([row('hanoi-regular', '', officialNumbers, false)])
  })

  it('an own result of the draw wins; the others still read the official one; official says what is behind it', async () => {
    await putOfficial({ ...draw, ...officialNumbers })
    const res = await putMine(alice.cookie, { ...draw, top3: '999', top2: '98', bottom2: '97' })
    // the answer of the write is already the winning row, with what it hides
    expect(((await res.json()) as MemberLotteryResultsOfDay).results).toEqual([
      row('hanoi-regular', '', { top3: '999', top2: '98', bottom2: '97' }, true, { time: '', ...officialNumbers }),
    ])
    expect((await readDay(alice.cookie, D)).results).toEqual([
      row('hanoi-regular', '', { top3: '999', top2: '98', bottom2: '97' }, true, { time: '', ...officialNumbers }),
    ])
    expect((await readDay(bob.cookie, D)).results).toEqual([row('hanoi-regular', '', officialNumbers, false)])
    // the official row itself was not touched
    expect((await rowsOf('')).map((r) => [r.top3, r.top2, r.bottom2])).toEqual([['123', '45', '67']])
  })

  it('removing it falls back to the official result, which was never touched', async () => {
    const official = (await (await putOfficial({ ...draw, ...officialNumbers })).json()) as AdminLotteryResult
    await putMine(alice.cookie, { ...draw, top3: '999' })
    const res = await delMine(alice.cookie, draw)
    expect(((await res.json()) as MemberLotteryResultsOfDay).results).toEqual([row('hanoi-regular', '', officialNumbers, false)])
    expect((await readDay(alice.cookie, D)).results).toEqual([row('hanoi-regular', '', officialNumbers, false)])
    expect(await rowsOf('')).toMatchObject([{ id: official.id, top3: '123', top2: '45', bottom2: '67' }])
  })

  it('the own result replaces the official one as a whole: a number the member left out is not borrowed from the official result', async () => {
    await putOfficial({ ...draw, ...officialNumbers })
    await putMine(alice.cookie, { ...draw, top3: '999' })
    const [mine] = await readLottery(alice.cookie, 'hanoi-regular')
    expect(mine).toMatchObject({ mine: true, top3: '999', top2: null, bottom2: null })
  })

  it('it hides the official results of that lottery and date whatever their draw time, so the own numbers always win', async () => {
    await putOfficial({ ...draw, time: '09:00', top2: '11' })
    await putOfficial({ ...draw, time: '21:00', top2: '22', bottom2: '33' })
    // typed without a time, as the web app does
    await putMine(alice.cookie, { ...draw, top2: '55' })
    expect(await readLottery(alice.cookie, 'hanoi-regular')).toEqual([row('hanoi-regular', '', { top2: '55' }, true, { time: '21:00', top2: '22', bottom2: '33', top3: null })])
    // the others read both draws
    expect((await readLottery(bob.cookie, 'hanoi-regular')).map((r) => [r.time, r.mine])).toEqual([
      ['09:00', false],
      ['21:00', false],
    ])
    // and so does alice once her own result is removed
    await delMine(alice.cookie, draw)
    expect((await readLottery(alice.cookie, 'hanoi-regular')).map((r) => [r.time, r.mine])).toEqual([
      ['09:00', false],
      ['21:00', false],
    ])
  })

  it('an own result of one draw time hides the official results of the other times too', async () => {
    await putOfficial({ ...draw, top2: '10' }) // the draw without a time
    await putOfficial({ ...draw, time: '16:30', top2: '20' })
    await putMine(alice.cookie, { ...draw, time: '16:30', top2: '77' })
    expect(await readLottery(alice.cookie, 'hanoi-regular')).toEqual([row('hanoi-regular', '16:30', { top2: '77' }, true, { time: '16:30', top2: '20', top3: null, bottom2: null })])
  })

  it('several own draws of one lottery and date are listed by time, each saying which official draw is behind them', async () => {
    await putOfficial({ ...draw, time: '09:00', top2: '11' })
    await putMine(alice.cookie, { ...draw, time: '16:30', top2: '30' })
    await putMine(alice.cookie, { ...draw, top2: '10' })
    const rows = await readLottery(alice.cookie, 'hanoi-regular')
    expect(rows.map((r) => [r.time, r.top2, r.mine])).toEqual([
      ['', '10', true],
      ['16:30', '30', true],
    ])
    for (const r of rows) expect(r.official).toEqual({ time: '09:00', top3: null, top2: '11', bottom2: null })
  })

  it('an own result without any official one says official: null', async () => {
    await putMine(alice.cookie, { ...draw, top3: '321' })
    expect(await readLottery(alice.cookie, 'hanoi-regular')).toEqual([row('hanoi-regular', '', { top3: '321' }, true, null)])
  })

  it('the official result behind an own one follows the corrections of the robot, the own numbers stay', async () => {
    await putOfficial({ ...draw, top3: '111' })
    await putMine(alice.cookie, { ...draw, top3: '222' })
    await putOfficial({ ...draw, top3: '333', top2: '44' }) // the robot corrects it
    expect(await readLottery(alice.cookie, 'hanoi-regular')).toEqual([
      row('hanoi-regular', '', { top3: '222' }, true, { time: '', top3: '333', top2: '44', bottom2: null }),
    ])
    expect(await readLottery(bob.cookie, 'hanoi-regular')).toEqual([row('hanoi-regular', '', { top3: '333', top2: '44' }, false)])
  })

  it('other lotteries and other dates are unaffected by an own result', async () => {
    await putOfficial({ ...draw, top3: '111' })
    await putOfficial({ lotteryId: 'hanoi-vip', date: D, top3: '222' })
    await putOfficial({ ...draw, date: '2026-11-20', top3: '333' })
    await putMine(alice.cookie, { ...draw, top3: '999' })
    expect((await readDay(alice.cookie, D)).results).toEqual([
      row('hanoi-regular', '', { top3: '999' }, true, { time: '', top3: '111', top2: null, bottom2: null }),
      row('hanoi-vip', '', { top3: '222' }, false),
    ])
    expect((await readDay(alice.cookie, '2026-11-20')).results).toEqual([{ ...row('hanoi-regular', '', { top3: '333' }, false), date: '2026-11-20' }])
    expect((await readDay(alice.cookie, '2026-11-21')).results).toEqual([])
  })

  it('lists lotteries by id and draws by time, own and official ones together', async () => {
    await putOfficial({ lotteryId: 'dow-jones', date: D, time: '21:00', top2: '08' })
    await putOfficial({ lotteryId: 'dow-jones', date: D, time: '09:00', top2: '11' })
    await putOfficial({ lotteryId: 'nikkei-morning', date: D, top3: '555' })
    await putMine(alice.cookie, { lotteryId: 'hanoi-regular', date: D, top3: '123' })
    await putMine(alice.cookie, { lotteryId: aliceOwn.id, date: D, top2: '42' })
    const ids = (await readDay(alice.cookie, D)).results.map((r) => `${r.lotteryId}|${r.time}`)
    // by lottery id ("m-..." is her own lottery), then by time
    expect(ids).toEqual(['dow-jones|09:00', 'dow-jones|21:00', 'hanoi-regular|', `${aliceOwn.id}|`, 'nikkei-morning|'])
  })

  it('an own result of a lottery that is switched off is not listed, and is again when it is back on', async () => {
    await putMine(alice.cookie, { lotteryId: 'hanoi-vip', date: D, top3: '111' })
    await putMine(alice.cookie, { ...draw, top3: '222' })
    await setActive('hanoi-vip', false)
    try {
      expect((await readDay(alice.cookie, D)).results.map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
    } finally {
      await setActive('hanoi-vip', true)
    }
    expect((await readDay(alice.cookie, D)).results.map((r) => r.lotteryId)).toEqual(['hanoi-regular', 'hanoi-vip'])
  })

  it('never lists an id, a source, a time stamp, a member id or the numbers of another member', async () => {
    await putOfficial({ ...draw, top3: '111', source: 'secret-source' })
    await putMine(alice.cookie, { ...draw, top3: '222' })
    await putMine(bob.cookie, { lotteryId: 'hanoi-vip', date: D, top3: '333', top2: '34' })
    const raw = await (await call('GET', `/results?date=${D}`, { cookie: alice.cookie })).text()
    for (const secret of ['secret-source', 'createdAt', 'updatedAt', '"id"', 'source', 'memberId', 'member_id', alice.id, bob.id, '333', '34']) {
      expect(raw, secret).not.toContain(secret)
    }
    expect(Object.keys(JSON.parse(raw).results[0]).sort()).toEqual(['bottom2', 'date', 'lotteryId', 'mine', 'official', 'time', 'top2', 'top3'])
  })
})

// ---- isolation -----------------------------------------------------------------------------------

describe('isolation between members', () => {
  const draw = { lotteryId: 'hanoi-regular', date: D }

  it('two members type their own result of the same draw: each reads theirs, the official one is unchanged', async () => {
    await putOfficial({ ...draw, top3: '111' })
    expect((await putMine(alice.cookie, { ...draw, top3: '222' })).status).toBe(201)
    expect((await putMine(bob.cookie, { ...draw, top3: '333' })).status).toBe(201) // 201: bob has no result of his own yet
    expect((await readLottery(alice.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '222', mine: true })
    expect((await readLottery(bob.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '333', mine: true })
    const carol = await newMember('carol-isolation')
    expect((await readLottery(carol.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '111', mine: false })
    const rows = await allRows()
    expect(rows.map((r) => [r.memberId, r.top3]).sort()).toEqual([['', '111'], [alice.id, '222'], [bob.id, '333']].sort())
  })

  it("a member's write or delete never reaches the row of another member", async () => {
    await putMine(alice.cookie, { ...draw, top3: '222' })
    const [aliceRow] = await rowsOf(alice.id)
    // bob replaces his own result: alice's row is the same row
    await putMine(bob.cookie, { ...draw, top3: '333' })
    await putMine(bob.cookie, { ...draw, top3: '444' })
    expect((await rowsOf(alice.id))[0]).toEqual(aliceRow)
    // bob deletes "the" result of that draw: only his own goes
    expect((await delMine(bob.cookie, draw)).status).toBe(200)
    expect(await rowsOf(bob.id)).toEqual([])
    expect((await rowsOf(alice.id))[0]).toEqual(aliceRow)
    expect((await readLottery(alice.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '222', mine: true })
  })

  it('a member can never write or delete an official row', async () => {
    const official = (await (await putOfficial({ ...draw, top3: '111' })).json()) as AdminLotteryResult
    // writing the same draw makes a row of the member, the official row is not replaced
    const res = await putMine(alice.cookie, { ...draw, top3: '999' })
    expect(res.status).toBe(201)
    expect(await rowsOf('')).toMatchObject([{ id: official.id, top3: '111', memberId: '' }])
    // deleting with the same parameters removes the own row only, and again: nothing, the official row stays
    expect((await delMine(alice.cookie, draw)).status).toBe(200)
    const again = await delMine(alice.cookie, draw)
    expect(again.status).toBe(200)
    expect(((await again.json()) as MemberLotteryResultsOfDay).results).toEqual([
      { lotteryId: 'hanoi-regular', date: D, time: '', top3: '111', top2: null, bottom2: null, mine: false, official: null },
    ])
    expect(await rowsOf('')).toMatchObject([{ id: official.id, top3: '111' }])
    // the id of the official row is no way in either
    expect((await call('DELETE', `/results/${official.id}`, { cookie: alice.cookie })).status).toBe(401)
    expect(await rowsOf('')).toHaveLength(1)
  })
})

// ---- the back office and the robot ---------------------------------------------------------------

describe('the back office and the robot next to personal results', () => {
  const draw = { lotteryId: 'hanoi-regular', date: D }

  it('GET /admin/results lists the official results only', async () => {
    const official = (await (await putOfficial({ ...draw, top3: '111' })).json()) as AdminLotteryResult
    await putMine(alice.cookie, { ...draw, top3: '222' })
    await putMine(bob.cookie, { ...draw, time: '09:00', top2: '33' })
    await putMine(alice.cookie, { lotteryId: aliceOwn.id, date: D, top2: '44' })
    const res = await call('GET', `/admin/results?date=${D}`, { cookie: admin })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ date: D, results: [official] })
    const raw = JSON.stringify(official)
    expect(raw).not.toContain('222')
    expect(raw).not.toContain(alice.id)
  })

  it('a date that only has personal results is an empty list for the back office', async () => {
    await putMine(alice.cookie, { ...draw, top3: '222' })
    const res = await call('GET', `/admin/results?date=${D}`, { cookie: admin })
    expect(await res.json()).toEqual({ date: D, results: [] })
  })

  it('DELETE /results/:id cannot remove a personal result: its id is "not found", and the row stays', async () => {
    await putMine(alice.cookie, { ...draw, top3: '222' })
    const [personal] = await rowsOf(alice.id)
    const res = await call('DELETE', `/results/${personal.id}`, { cookie: admin })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect(await rowsOf(alice.id)).toEqual([personal])
    // an official result is removed and the personal one next to it stays
    const official = (await (await putOfficial({ ...draw, top3: '111' })).json()) as AdminLotteryResult
    expect((await call('DELETE', `/results/${official.id}`, { cookie: admin })).status).toBe(204)
    expect(await allRows()).toEqual([personal])
    expect((await readLottery(alice.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '222', mine: true, official: null })
  })

  it('PUT /results writes the official row next to a personal one for the same draw: 201 (a new row), the personal one is untouched', async () => {
    await putMine(alice.cookie, { ...draw, top3: '222' })
    const [personal] = await rowsOf(alice.id)
    for (const [who, o] of [['the robot key', { key: KEY }], ['an admin', { cookie: admin }]] as const) {
      await getDb(env).delete(lotteryResults).where(eq(lotteryResults.memberId, ''))
      const first = await putOfficial({ ...draw, top3: '111' }, o)
      expect(first.status, who).toBe(201)
      expect(((await first.json()) as AdminLotteryResult).top3).toBe('111')
      const second = await putOfficial({ ...draw, top3: '112' }, o)
      expect(second.status, who).toBe(200) // replaces the official row, not the personal one
      expect(await rowsOf('')).toMatchObject([{ top3: '112', memberId: '' }])
      expect((await rowsOf(alice.id))[0], who).toEqual(personal)
    }
    // alice keeps reading her own numbers, bob reads the official ones
    expect((await readLottery(alice.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '222', mine: true, official: { time: '', top3: '112', top2: null, bottom2: null } })
    expect((await readLottery(bob.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '112', mine: false })
    // and the official result applies to her again as soon as hers is removed
    await delMine(alice.cookie, draw)
    expect((await readLottery(alice.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '112', mine: false })
  })

  it('the official PUT by lotteryName and the personal PUT by id can name the same draw', async () => {
    await putMine(alice.cookie, { ...draw, top3: '222' })
    const res = await putOfficial({ lotteryName: 'ฮานอย ปกติ', date: D, top3: '111' })
    expect(res.status).toBe(201)
    expect(await allRows()).toHaveLength(2)
  })
})

// ---- cascades ------------------------------------------------------------------------------------

// D1 enforces foreign keys, so the FOREIGN KEY of lottery_results.lottery_id cascades a lottery
// delete by itself; the routes delete the rows explicitly anyway (the style of the repo, and
// member_id has no foreign key at all). The second run switches the enforcement off on the
// connection the app uses, so that only the explicit deletes can do the work.
describe.each([
  ['foreign keys enforced, as on D1', 1],
  ['foreign keys not enforced, only the explicit deletes work', 0],
] as const)('what is deleted with a member or a lottery: %s', (_label, enforced) => {
  beforeEach(async () => {
    await getDb(env).run(enforced ? sql`PRAGMA foreign_keys = ON` : sql`PRAGMA foreign_keys = OFF`)
  })
  afterEach(async () => {
    await getDb(env).run(sql`PRAGMA foreign_keys = ON`)
  })

  it('runs with the foreign key setting it says', async () => {
    const rows = await getDb(env).all<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)
    expect(rows[0].foreign_keys).toBe(enforced)
  })

  it("deleting a member (back office) deletes the member's personal results, those of their own lotteries included, and nobody else's", async () => {
    const dave = await newMember('dave')
    const daveOwn = await newOwnLottery(dave, 'หวยของเดฟ')
    const official = (await (await putOfficial({ lotteryId: 'hanoi-regular', date: D, top3: '111' })).json()) as AdminLotteryResult
    await putMine(dave.cookie, { lotteryId: 'hanoi-regular', date: D, top3: '222' })
    await putMine(dave.cookie, { lotteryId: 'hanoi-regular', date: D, time: '09:00', top3: '223' })
    await putMine(dave.cookie, { lotteryId: daveOwn.id, date: D, top2: '33' })
    await putMine(alice.cookie, { lotteryId: 'hanoi-regular', date: D, top3: '444' })
    // defence in depth: a stray official row on his private lottery (the API cannot make one)
    await getDb(env).insert(lotteryResults).values({
      id: 'stray-official',
      lotteryId: daveOwn.id,
      drawDate: D,
      drawTime: '',
      memberId: '',
      top3: '000',
      source: null,
      createdAt: 'x',
      updatedAt: 'x',
    })
    expect(await allRows()).toHaveLength(6)

    const res = await call('DELETE', `/admin/members/${dave.id}`, { cookie: admin })
    expect(res.status).toBe(204)
    const left = await allRows()
    expect(left.map((r) => r.id).sort()).toEqual([official.id, (await rowsOf(alice.id))[0].id].sort())
    expect(await rowsOf(dave.id)).toEqual([])
    expect(await rowsOfLottery(daveOwn.id)).toEqual([])
    // everybody else still reads what they read before
    expect((await readLottery(alice.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '444', mine: true })
    expect((await readLottery(bob.cookie, 'hanoi-regular'))[0]).toMatchObject({ top3: '111', mine: false })
  })

  it("deleting an own lottery (member) deletes the results typed for it, and the member's other results stay", async () => {
    const own = await newOwnLottery(bob, 'หวยที่จะลบ')
    await putMine(bob.cookie, { lotteryId: own.id, date: D, top3: '111' })
    await putMine(bob.cookie, { lotteryId: own.id, date: D, time: '10:00', top2: '22' })
    await putMine(bob.cookie, { lotteryId: 'hanoi-regular', date: D, top3: '333' })
    await putMine(bob.cookie, { lotteryId: bobOwn.id, date: D, top3: '444' })
    expect(await rowsOfLottery(own.id)).toHaveLength(2)
    expect((await call('DELETE', `/lotteries/${own.id}`, { cookie: bob.cookie })).status).toBe(204)
    expect(await rowsOfLottery(own.id)).toEqual([])
    expect((await rowsOf(bob.id)).map((r) => r.lotteryId).sort()).toEqual(['hanoi-regular', bobOwn.id].sort())
  })

  it("deleting a catalog lottery (back office) deletes its official result and every member's personal result of it", async () => {
    const created = await call('POST', '/admin/lotteries', {
      cookie: admin,
      body: { name: 'หวยทดสอบผลส่วนตัว', shortName: 'ทดสอบผล', group: 'other', accent: '#4c1d95', sortOrder: 9996, active: true },
    })
    const id = ((await created.json()) as AdminLottery).id
    expect((await putOfficial({ lotteryId: id, date: D, top3: '111' })).status).toBe(201)
    expect((await putMine(alice.cookie, { lotteryId: id, date: D, top3: '222' })).status).toBe(201)
    expect((await putMine(bob.cookie, { lotteryId: id, date: D, time: '09:00', top2: '33' })).status).toBe(201)
    await putMine(alice.cookie, { lotteryId: 'hanoi-regular', date: D, top3: '999' })
    expect(await rowsOfLottery(id)).toHaveLength(3)

    expect((await call('DELETE', `/admin/lotteries/${id}`, { cookie: admin })).status).toBe(204)
    expect(await rowsOfLottery(id)).toEqual([])
    expect((await allRows()).map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
    expect((await readDay(alice.cookie, D)).results.map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
  })
})

// ---- unit: resolveForMember ----------------------------------------------------------------------

describe('unit: resolveForMember', () => {
  const r = (lotteryId: string, drawTime: string, memberId: string, top2: string): ResultRow => ({
    id: `${lotteryId}|${drawTime}|${memberId}`,
    lotteryId,
    drawDate: D,
    drawTime,
    memberId,
    top3: null,
    top2,
    bottom2: null,
    source: null,
    createdAt: 'x',
    updatedAt: 'x',
  })
  const summary = (rows: MemberLotteryResult[]) => rows.map((x) => `${x.lotteryId}|${x.time}|${x.top2}|${x.mine ? 'mine' : 'official'}|${x.official ? `${x.official.time}:${x.official.top2}` : '-'}`)

  it('keeps official rows as they are when the member has none of their own', () => {
    expect(summary(resolveForMember([r('a', '', '', '11'), r('a', '09:00', '', '12'), r('b', '', '', '13')], 'm1'))).toEqual([
      'a||11|official|-',
      'a|09:00|12|official|-',
      'b||13|official|-',
    ])
  })

  it('lists only the own rows of a lottery that has some, with the latest official draw behind them', () => {
    const rows = [r('a', '', '', '11'), r('a', '09:00', '', '12'), r('a', '09:00', 'm1', '99'), r('b', '', '', '13')]
    expect(summary(resolveForMember(rows, 'm1'))).toEqual(['a|09:00|99|mine|09:00:12', 'b||13|official|-'])
    // the latest by time, not by position in the list
    const shuffled = [r('a', '21:00', '', '14'), r('a', '09:00', '', '12'), r('a', '', 'm1', '99')]
    expect(summary(resolveForMember(shuffled, 'm1'))).toEqual(['a||99|mine|21:00:14'])
    // "" is the smallest time: with only an untimed official row it is the one behind
    expect(summary(resolveForMember([r('a', '', '', '11'), r('a', '', 'm1', '99')], 'm1'))).toEqual(['a||99|mine|:11'])
  })

  it("never lists a row of another member, whatever the query returned", () => {
    const rows = [r('a', '', 'm2', '55'), r('a', '', '', '11'), r('b', '', 'm2', '66'), r('c', '', 'm1', '77')]
    expect(summary(resolveForMember(rows, 'm1'))).toEqual(['a||11|official|-', 'c||77|mine|-'])
    expect(resolveForMember([r('a', '', 'm2', '55')], 'm1')).toEqual([])
    expect(resolveForMember([], 'm1')).toEqual([])
  })

  it('keeps the order of lotteries and times it was given', () => {
    const rows = [r('a', '', '', '1'), r('b', '', 'm1', '2'), r('b', '09:00', 'm1', '3'), r('c', '', '', '4')]
    expect(summary(resolveForMember(rows, 'm1'))).toEqual(['a||1|official|-', 'b||2|mine|-', 'b|09:00|3|mine|-', 'c||4|official|-'])
  })
})
