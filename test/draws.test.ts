// The member's last numbers: POST /render/numbers saves the drawn numbers when the request names a
// `scope`, GET /draws reads them back, the cron deletes rows older than 14 days, and deleting a
// set / member / lottery leaves none behind. Real libSQL file DB with the project's migrations.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { and, eq } from 'drizzle-orm'
import app from '../src/index'
import type { AdminLottery, AdminMember, AssetBucket, Bindings, CardNumbers, Lottery, LotterySet, Member, MemberDraw } from '../src/types'
import { DRAW_RETENTION_DAYS } from '../src/types'
import { hashPassword } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import { LOTTERY_CATALOG } from '../src/db/catalog'
import { lotteries, memberDraws, renderCounters } from '../src/db/schema'
import { DRAW_PRUNE_TIME, pruneMemberDraws, runScheduledPrune } from '../src/lib/draws'
import { runScheduledReminders } from '../src/lib/reminders'
import { bangkokDay, nowIso } from '../src/lib/time'

// The real reminders, wrapped so one test can make them fail (the cleanup must still run).
vi.mock('../src/lib/reminders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/reminders')>()
  return { ...actual, runScheduledReminders: vi.fn(actual.runScheduledReminders) }
})

const DB_FILE = 'test-draws.db'
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
let admin: string

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

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

/** A member made through the back office, link claimed. Every test uses its own, so rows never mix. */
async function newMember(name: string) {
  const res = await call('POST', '/admin/members', admin, {
    displayName: name,
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  })
  const m = (await res.json()) as AdminMember
  const sp = await call('POST', `/link/${m.linkToken}/set-password`, undefined, { password: 'password-123' })
  expect(sp.status).toBe(204)
  return { id: m.id, cookie: cookieFrom(sp, 'ng_session') }
}

interface RenderBody {
  results: { lotteryId: string; numbers: CardNumbers }[]
  rendersToday: number
  rendersLimit: number
  date: string
}

const render = (cookie: string, body: unknown) => call('POST', '/render/numbers', cookie, body)

async function renderOk(cookie: string, body: unknown): Promise<RenderBody> {
  const res = await render(cookie, body)
  expect(res.status).toBe(200)
  return (await res.json()) as RenderBody
}

const getSets = async (cookie: string) => (await (await call('GET', '/sets', cookie)).json()) as LotterySet[]

const getDraws = async (cookie: string, query: string) => {
  const res = await call('GET', `/draws?${query}`, cookie)
  expect(res.status).toBe(200)
  return (await res.json()) as { date: string; draws: MemberDraw[] }
}

const rowsOf = (memberId: string) => getDb(env).select().from(memberDraws).where(eq(memberDraws.memberId, memberId))

const rendersToday = async (cookie: string) => ((await (await call('GET', '/me', cookie)).json()) as Member).rendersToday

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

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
  admin = await adminCookie()
})

beforeEach(async () => {
  await resetLimiter(getDb(env))
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(() => {
  try {
    removeDb()
  } catch {
    // file may still be held open on Windows; harmless
  }
})

// ---- POST /render/numbers saves the draws ---------------------------------------------------------

describe('POST /render/numbers with a scope', () => {
  it('saves every returned card under (member, scope, lottery, card date), exactly as returned', async () => {
    const m = await newMember('save')
    const out = await renderOk(m.cookie, {
      items: [{ lotteryId: 'hanoi-regular' }, { lotteryId: 'dow-jones', fixed: ['3', null] }],
      date: '2026-11-19',
      scope: 'single',
    })
    const rows = await rowsOf(m.id)
    expect(rows).toHaveLength(2)
    for (const r of out.results) {
      const row = rows.find((x) => x.lotteryId === r.lotteryId)!
      expect(row).toMatchObject({ memberId: m.id, scope: 'single', cardDate: '2026-11-19' })
      expect(row.numbers).toBe(JSON.stringify(r.numbers))
      expect(row.updatedAt).toMatch(ISO)
    }
    // the response itself is the one it always was
    expect(Object.keys(out).sort()).toEqual(['assets', 'date', 'rendersLimit', 'rendersToday', 'results'])
    expect(out).toMatchObject({ date: '2026-11-19', rendersToday: 2 })
  })

  it('a new สุ่ม of the same card overwrites the saved numbers (one row, the latest numbers)', async () => {
    const m = await newMember('overwrite')
    // an older draw of the same card, with numbers that no generator would produce
    await getDb(env).insert(memberDraws).values({
      memberId: m.id,
      scope: 'single',
      lotteryId: 'hanoi-regular',
      cardDate: '2026-11-19',
      numbers: '{"old":true}',
      updatedAt: '2020-01-01T00:00:00.000Z',
    })
    const first = await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19', scope: 'single' })
    let rows = await rowsOf(m.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].numbers).toBe(JSON.stringify(first.results[0].numbers))
    expect(rows[0].updatedAt > '2020-01-01T00:00:00.000Z').toBe(true)
    // and again
    const second = await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19', scope: 'single' })
    rows = await rowsOf(m.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].numbers).toBe(JSON.stringify(second.results[0].numbers))
    expect(JSON.parse(rows[0].numbers)).toEqual((await getDraws(m.cookie, 'date=2026-11-19')).draws[0].numbers)
  })

  it('every (scope, lottery, card date) is its own row', async () => {
    const m = await newMember('keys')
    const [setA, setB] = await getSets(m.cookie)
    const call1 = (date: string, scope: string, lotteryId = 'hanoi-regular') =>
      renderOk(m.cookie, { items: [{ lotteryId }], date, scope })
    await call1('2026-11-19', 'single')
    await call1('2026-11-20', 'single') // another card date
    await call1('2026-11-19', setA.id) // another scope: a set of the multiple page
    await call1('2026-11-19', setB.id) // the same lottery in another set
    await call1('2026-11-19', 'single', 'hanoi-vip') // another lottery
    await call1('2026-11-19', 'single') // a repeat of the first: no new row
    const keys = (await rowsOf(m.id)).map((r) => `${r.scope === 'single' ? 'single' : r.scope === setA.id ? 'A' : 'B'}|${r.lotteryId}|${r.cardDate}`).sort()
    expect(keys).toEqual([
      'A|hanoi-regular|2026-11-19',
      'B|hanoi-regular|2026-11-19',
      'single|hanoi-regular|2026-11-19',
      'single|hanoi-regular|2026-11-20',
      'single|hanoi-vip|2026-11-19',
    ])
  })

  it('without a scope nothing is saved and the call is exactly as before (any YYYY-MM-DD-shaped date)', async () => {
    const m = await newMember('noscope')
    const out = await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19' })
    expect(out.results).toHaveLength(1)
    expect((await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-99-99' })).date).toBe('2026-99-99')
    expect(await rowsOf(m.id)).toHaveLength(0)
    expect((await getDraws(m.cookie, 'date=2026-11-19')).draws).toEqual([])
  })

  it('a scope that is the id of one of the member\'s sets is accepted; anything else is refused before anything is counted', async () => {
    const m = await newMember('scopes')
    const other = await newMember('scopes-other')
    const [mine] = await getSets(m.cookie)
    const [theirs] = await getSets(other.cookie)
    const body = (scope: unknown, extra: Record<string, unknown> = {}) => ({
      items: [{ lotteryId: 'hanoi-regular' }],
      date: '2026-11-19',
      scope,
      ...extra,
    })
    const before = await rendersToday(m.cookie)

    // not a set of this member (unknown, or somebody else's): 404, no render counted, nothing saved
    for (const scope of ['AbCdEfGhIjKlMnOp', theirs.id]) {
      const res = await render(m.cookie, body(scope))
      expect(res.status, scope).toBe(404)
      expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND', message: expect.stringContaining('ชุด') } })
    }
    // not a scope at all: 400 (this includes the web's own sentinel)
    for (const scope of ['__single__', '', 'a b', 'single!', 'x'.repeat(65), 42, null, ['single']]) {
      const res = await render(m.cookie, body(scope))
      expect(res.status, JSON.stringify(scope)).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION', message: expect.stringContaining('scope') } })
    }
    expect(await rendersToday(m.cookie)).toBe(before)
    expect(await rowsOf(m.id)).toHaveLength(0)
    expect(await rowsOf(other.id)).toHaveLength(0)

    expect((await render(m.cookie, body(mine.id))).status).toBe(200)
    expect((await render(m.cookie, body('single'))).status).toBe(200)
    expect(await rendersToday(m.cookie)).toBe(before + 2)
    expect((await rowsOf(m.id)).map((r) => r.scope).sort()).toEqual([mine.id, 'single'].sort())
  })

  it('with a scope the date must be a real day (without one the old, looser check stays)', async () => {
    const m = await newMember('baddate')
    for (const date of ['2026-02-30', '2026-13-01', '2026-00-00']) {
      const res = await render(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date, scope: 'single' })
      expect(res.status, date).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION', message: expect.stringContaining('date') } })
    }
    expect((await render(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: 'nope', scope: 'single' })).status).toBe(400)
    expect(await rowsOf(m.id)).toHaveLength(0)
    expect(await rendersToday(m.cookie)).toBe(0)
  })

  it('a call that fails saves nothing: an unknown lottery (404) and the daily limit (429)', async () => {
    const m = await newMember('fails')
    const first = await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19', scope: 'single' })
    const saved = await rowsOf(m.id)
    expect(saved).toHaveLength(1)

    const unknown = await render(m.cookie, {
      items: [{ lotteryId: 'hanoi-vip' }, { lotteryId: 'no-such-lottery' }],
      date: '2026-11-19',
      scope: 'single',
    })
    expect(unknown.status).toBe(404)
    expect(await rowsOf(m.id)).toEqual(saved)

    // at the limit: refused, and the earlier numbers of the card are not touched
    await getDb(env).update(renderCounters).set({ count: 600 }).where(and(eq(renderCounters.memberId, m.id), eq(renderCounters.day, bangkokDay())))
    const over = await render(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }, { lotteryId: 'hanoi-vip' }], date: '2026-11-19', scope: 'single' })
    expect(over.status).toBe(429)
    expect(await rowsOf(m.id)).toEqual(saved)
    expect(JSON.parse(saved[0].numbers)).toEqual(first.results[0].numbers)
  })

  it('a lottery listed twice in one call is saved once, with the numbers of its last item', async () => {
    const m = await newMember('twice')
    const out = await renderOk(m.cookie, {
      items: [
        { lotteryId: 'dow-jones', fixed: ['1', '2'] },
        { lotteryId: 'hanoi-regular' },
        { lotteryId: 'dow-jones', fixed: ['3', '4'] },
      ],
      date: '2026-11-19',
      scope: 'single',
    })
    const rows = await rowsOf(m.id)
    expect(rows).toHaveLength(2)
    const dow = rows.find((r) => r.lotteryId === 'dow-jones')!
    expect(JSON.parse(dow.numbers)).toEqual(out.results[2].numbers)
    expect(JSON.parse(dow.numbers).running).toEqual(['3', '4'])
  })

  it('a full call of 80 cards is saved completely', async () => {
    const m = await newMember('full')
    const items = LOTTERY_CATALOG.slice(0, 80).map((l) => ({ lotteryId: l.id }))
    const out = await renderOk(m.cookie, { items, date: '2026-11-19', scope: 'single' })
    expect(out.results).toHaveLength(80)
    const rows = await rowsOf(m.id)
    expect(rows).toHaveLength(80)
    const byLottery = new Map(rows.map((r) => [r.lotteryId, r.numbers]))
    for (const r of out.results) expect(byLottery.get(r.lotteryId)).toBe(JSON.stringify(r.numbers))
  })

  it('a failure to save never fails the render (the numbers are generated and counted already)', async () => {
    const m = await newMember('besteffort')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { client } = openDb(DB_URL)
    await client.execute('ALTER TABLE member_draws RENAME TO member_draws_off')
    try {
      const out = await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19', scope: 'single' })
      expect(out.results).toHaveLength(1)
      expect(out.rendersToday).toBe(1)
      expect(log).toHaveBeenCalledWith('render: saving the drawn numbers failed', expect.anything())
    } finally {
      await client.execute('ALTER TABLE member_draws_off RENAME TO member_draws')
      client.close()
    }
    expect(await rowsOf(m.id)).toHaveLength(0)
    expect(await rendersToday(m.cookie)).toBe(1)
    // and saving works again once the table is back
    await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19', scope: 'single' })
    expect(await rowsOf(m.id)).toHaveLength(1)
  })
})

// ---- GET /draws ----------------------------------------------------------------------------------

describe('GET /draws', () => {
  it('returns the saved numbers of the date for every scope, or only the scopes asked for', async () => {
    const m = await newMember('read')
    const [setA, setB] = await getSets(m.cookie)
    const single = await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }, { lotteryId: 'dow-jones' }], date: '2026-11-19', scope: 'single' })
    const inA = await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }, { lotteryId: 'hanoi-vip' }], date: '2026-11-19', scope: setA.id })
    const inB = await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19', scope: setB.id })
    await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-20', scope: 'single' }) // another date

    const expected = (scope: string, out: RenderBody): MemberDraw[] =>
      out.results.map((r) => ({ scope, lotteryId: r.lotteryId, numbers: r.numbers, updatedAt: expect.stringMatching(ISO) }))
    const sortDraws = (draws: MemberDraw[]) =>
      [...draws].sort((a, b) => (a.scope === b.scope ? (a.lotteryId < b.lotteryId ? -1 : 1) : a.scope < b.scope ? -1 : 1))

    const all = await getDraws(m.cookie, 'date=2026-11-19')
    expect(all.date).toBe('2026-11-19')
    // deterministic order: by scope, then lottery id (plain byte order)
    expect(all.draws).toEqual(sortDraws([...expected('single', single), ...expected(setA.id, inA), ...expected(setB.id, inB)]))
    expect(all.draws).toHaveLength(5)

    expect((await getDraws(m.cookie, 'date=2026-11-19&scope=single')).draws).toEqual(sortDraws(expected('single', single)))
    expect((await getDraws(m.cookie, `date=2026-11-19&scope=${setA.id}`)).draws).toEqual(sortDraws(expected(setA.id, inA)))
    expect((await getDraws(m.cookie, `date=2026-11-19&scope=single&scope=${setB.id}`)).draws).toEqual(
      sortDraws([...expected('single', single), ...expected(setB.id, inB)]),
    )
    // a scope that has nothing (or is not the member's) matches nothing; scopes are not "or everything"
    expect((await getDraws(m.cookie, 'date=2026-11-19&scope=AbCdEfGhIjKlMnOp')).draws).toEqual([])
    expect((await getDraws(m.cookie, 'date=2026-11-19&scope=AbCdEfGhIjKlMnOp&scope=single')).draws).toHaveLength(2)
    // another date and a date without draws
    expect((await getDraws(m.cookie, 'date=2026-11-20')).draws).toHaveLength(1)
    expect(await getDraws(m.cookie, 'date=2026-11-21')).toEqual({ date: '2026-11-21', draws: [] })
  })

  it('the numbers are exactly what the render call returned (a reload shows the same card)', async () => {
    const m = await newMember('exact')
    const out = await renderOk(m.cookie, {
      items: [{ lotteryId: 'hanoi-regular', settings: { singleDigits: 3, allowTriple: true, isDouble: true } }],
      date: '2026-11-19',
      scope: 'single',
    })
    const [draw] = (await getDraws(m.cookie, 'date=2026-11-19&scope=single')).draws
    expect(draw.numbers).toEqual(out.results[0].numbers)
    expect(Object.keys(draw.numbers).sort()).toEqual(['drill', 'running', 'single', 'three', 'top', 'two', 'win'])
    expect(draw.numbers.single).toHaveLength(3)
    // updatedAt is the moment of the draw
    expect(Math.abs(Date.parse(draw.updatedAt) - Date.now())).toBeLessThan(60_000)
  })

  it('a member only ever reads their own draws', async () => {
    const a = await newMember('iso-a')
    const b = await newMember('iso-b')
    await renderOk(a.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19', scope: 'single' })
    expect((await getDraws(a.cookie, 'date=2026-11-19')).draws).toHaveLength(1)
    expect((await getDraws(b.cookie, 'date=2026-11-19')).draws).toEqual([])
    const [bSet] = await getSets(b.cookie)
    await renderOk(b.cookie, { items: [{ lotteryId: 'hanoi-vip' }], date: '2026-11-19', scope: bSet.id })
    expect((await getDraws(a.cookie, `date=2026-11-19&scope=${bSet.id}`)).draws).toEqual([])
    expect((await getDraws(a.cookie, 'date=2026-11-19')).draws.map((d) => d.lotteryId)).toEqual(['hanoi-regular'])
  })

  it('a row whose JSON cannot be read is left out, the others are returned', async () => {
    const m = await newMember('garbage')
    await renderOk(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19', scope: 'single' })
    const now = nowIso()
    await getDb(env).insert(memberDraws).values([
      { memberId: m.id, scope: 'single', lotteryId: 'hanoi-vip', cardDate: '2026-11-19', numbers: '{not json', updatedAt: now },
      { memberId: m.id, scope: 'single', lotteryId: 'dow-jones', cardDate: '2026-11-19', numbers: '[1,2]', updatedAt: now },
      { memberId: m.id, scope: 'single', lotteryId: 'dow-jones-vip', cardDate: '2026-11-19', numbers: 'null', updatedAt: now },
    ])
    expect((await getDraws(m.cookie, 'date=2026-11-19')).draws.map((d) => d.lotteryId)).toEqual(['hanoi-regular'])
  })

  it('needs a valid date and valid scopes', async () => {
    const m = await newMember('query')
    const bad = [
      '',
      'date=',
      'date=2026-02-30',
      'date=19-11-2026',
      'date=2026-11-19T00:00',
      'scope=single',
      'date=2026-11-19&scope=',
      'date=2026-11-19&scope=__single__',
      'date=2026-11-19&scope=a%20b',
      `date=2026-11-19&scope=${'x'.repeat(65)}`,
      `date=2026-11-19${Array.from({ length: 51 }, (_, i) => `&scope=s${i}`).join('')}`,
    ]
    for (const q of bad) {
      const res = await call('GET', `/draws?${q}`, m.cookie)
      expect(res.status, q).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    // 50 scopes are fine
    const fifty = Array.from({ length: 50 }, (_, i) => `&scope=s${i}`).join('')
    expect((await call('GET', `/draws?date=2026-11-19${fifty}`, m.cookie)).status).toBe(200)
  })

  it('needs a member session: 401 without one (an admin cookie does not count), 403 when expired or disabled', async () => {
    const path = '/draws?date=2026-11-19'
    expect((await call('GET', path)).status).toBe(401)
    expect((await call('GET', path, admin)).status).toBe(401)
    const m = await newMember('gate')
    expect((await call('GET', path, m.cookie.slice(0, -2) + 'aa')).status).toBe(401)
    const patch = (b: unknown) => call('PATCH', `/admin/members/${m.id}`, admin, b)
    await patch({ disabled: true })
    const disabled = await call('GET', path, m.cookie)
    expect(disabled.status).toBe(403)
    expect(await disabled.json()).toMatchObject({ error: { code: 'DISABLED' } })
    await patch({ disabled: false, expiresAt: new Date(Date.now() - 1000).toISOString() })
    const expired = await call('GET', path, m.cookie)
    expect(expired.status).toBe(403)
    expect(await expired.json()).toMatchObject({ error: { code: 'EXPIRED' } })
  })
})

/// ---- the 14 day cleanup --------------------------------------------------------------------------

describe('cleanup of draws older than 14 days', () => {
  const DAY = 86_400_000
  // Everything is measured from the real clock: the cleanup deletes across the whole table, and rows
  // that other tests wrote a moment ago must count as fresh.
  const NOW = Date.now()
  const ago = (ms: number, from = NOW) => nowIso(from - ms)

  async function seedRows(memberId: string, rows: [cardDate: string, updatedAt: string][]) {
    await getDb(env).insert(memberDraws).values(
      rows.map(([cardDate, updatedAt]) => ({ memberId, scope: 'single', lotteryId: 'hanoi-regular', cardDate, numbers: '{}', updatedAt })),
    )
  }

  it('deletes rows last written more than 14 days ago, keeps the rest (by updated_at, not by card date)', async () => {
    expect(DRAW_RETENTION_DAYS).toBe(14)
    const m = await newMember('prune')
    await seedRows(m.id, [
      ['2026-01-01', ago(30 * DAY)], // old
      ['2026-01-02', ago(15 * DAY)], // old
      ['2026-01-03', ago(14 * DAY + 1)], // one millisecond too old
      ['2026-01-04', ago(14 * DAY)], // exactly 14 days: kept
      ['2026-01-05', ago(13 * DAY)], // fresh
      ['2001-01-01', ago(1000)], // a very old card date, drawn just now: kept
      ['2999-01-01', ago(0)], // a far future card date: kept
    ])
    const other = await newMember('prune-other')
    await seedRows(other.id, [['2026-01-01', ago(40 * DAY)]])
    expect(await pruneMemberDraws(getDb(env), NOW)).toBe(4)
    expect((await rowsOf(m.id)).map((r) => r.cardDate).sort()).toEqual(['2001-01-01', '2026-01-04', '2026-01-05', '2999-01-01'])
    expect(await rowsOf(other.id)).toHaveLength(0)
    // nothing left to do
    expect(await pruneMemberDraws(getDb(env), NOW)).toBe(0)
  })

  it('clears a large backlog in one run (a cron that was down for days)', async () => {
    const m = await newMember('backlog')
    const { client } = openDb(DB_URL)
    const total = 30_000
    try {
      await client.execute({
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
              INSERT INTO member_draws (member_id, scope, lottery_id, card_date, numbers, updated_at)
              SELECT ?, 'single', 'dow-jones', printf('bulk%06d', i), '{}', '2020-01-01T00:00:00.000Z' FROM n`,
        args: [total, m.id],
      })
    } finally {
      client.close()
    }
    await seedRows(m.id, [['2026-02-01', ago(1000)]]) // one fresh row between the expired ones
    expect((await rowsOf(m.id)).length).toBe(total + 1)
    expect(await pruneMemberDraws(getDb(env), NOW)).toBe(total)
    expect((await rowsOf(m.id)).map((r) => r.cardDate)).toEqual(['2026-02-01'])
  })

  describe('the cron', () => {
    const MINUTE = 60_000
    const scheduled = (scheduledTime: number, e: Bindings = env) =>
      (app as unknown as { scheduled: (c: { scheduledTime: number }, e: Bindings) => Promise<void> }).scheduled({ scheduledTime }, e)

    /** The latest 03:17 Bangkok time that is not in the future: the minute the cleanup is due. */
    function lastDueMinute(): number {
      const bangkokNow = new Date(Date.now() + 7 * 3600_000)
      let t = Date.UTC(bangkokNow.getUTCFullYear(), bangkokNow.getUTCMonth(), bangkokNow.getUTCDate(), 3, 17)
      if (t > bangkokNow.getTime()) t -= DAY
      return t - 7 * 3600_000
    }

    async function seedOldAndFresh(memberId: string) {
      await getDb(env).insert(memberDraws).values([
        { memberId, scope: 'single', lotteryId: 'hanoi-regular', cardDate: 'old', numbers: '{}', updatedAt: ago(20 * DAY, Date.now()) },
        { memberId, scope: 'single', lotteryId: 'hanoi-regular', cardDate: 'fresh', numbers: '{}', updatedAt: ago(5 * DAY, Date.now()) },
      ])
    }

    it('runs once a day, in the invocation due at 03:17 Bangkok time', async () => {
      expect(DRAW_PRUNE_TIME).toBe('03:17')
      const due = lastDueMinute()
      expect(new Date(due + 7 * 3600_000).toISOString().slice(11, 16)).toBe('03:17')
      const m = await newMember('cron')
      await seedOldAndFresh(m.id)
      // every other minute does nothing
      for (const other of [due - MINUTE, due + MINUTE, due + 12 * 3600_000, due - 3 * 3600_000, due - DAY + MINUTE]) {
        await scheduled(other)
        expect(await rowsOf(m.id), new Date(other).toISOString()).toHaveLength(2)
      }
      expect(await runScheduledPrune(env, due - MINUTE)).toBeNull()
      // the due minute does the cleanup
      await scheduled(due)
      expect((await rowsOf(m.id)).map((r) => r.cardDate)).toEqual(['fresh'])
      expect(await runScheduledPrune(env, due)).toBe(0)
    })

    it('uses the minute the trigger was due, so a late run still cleans up', async () => {
      const m = await newMember('cron-late')
      const due = lastDueMinute()
      await seedOldAndFresh(m.id)
      // the scheduler is 90 seconds late: the clock says 03:18:30, the trigger was due at 03:17
      expect(await runScheduledPrune(env, due, Date.now() + 90_000)).toBe(1)
      expect((await rowsOf(m.id)).map((r) => r.cardDate)).toEqual(['fresh'])
    })

    it('still runs when the reminders fail, and then reports the failure', async () => {
      const m = await newMember('cron-isolation')
      await seedOldAndFresh(m.id)
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(runScheduledReminders).mockRejectedValueOnce(new Error('reminders down'))
      await expect(scheduled(lastDueMinute())).rejects.toThrow('reminders down')
      expect((await rowsOf(m.id)).map((r) => r.cardDate)).toEqual(['fresh'])
      expect(log).toHaveBeenCalledWith('scheduled reminders failed', expect.any(Error))
    })

    it('a failing cleanup does not stop the reminders and is reported too', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const reminders = vi.mocked(runScheduledReminders)
      reminders.mockClear()
      reminders.mockResolvedValueOnce(null)
      // no database: the cleanup of the due minute throws
      const noDb: Bindings = { ...env, TURSO_DATABASE_URL: undefined, DB: undefined }
      await expect(scheduled(lastDueMinute(), noDb)).rejects.toThrow(/No database/)
      expect(reminders).toHaveBeenCalledTimes(1)
      expect(log).toHaveBeenCalledWith('scheduled draw cleanup failed', expect.any(Error))
      // any other minute does not touch the database for it
      reminders.mockResolvedValueOnce(null)
      await expect(scheduled(lastDueMinute() + MINUTE, noDb)).resolves.toBeUndefined()
    })

    it('the reminders still get the clock they always got', async () => {
      const reminders = vi.mocked(runScheduledReminders)
      reminders.mockClear()
      reminders.mockResolvedValueOnce(null)
      const future = Date.now() + 3 * DAY
      await scheduled(future)
      expect(reminders).toHaveBeenCalledTimes(1)
      expect(reminders.mock.calls[0][1]).toBe(future) // never behind the scheduled minute
      reminders.mockClear()
      reminders.mockResolvedValueOnce(null)
      await scheduled(Date.now() - 3 * DAY)
      expect(reminders.mock.calls[0][1]).toBeGreaterThan(Date.now() - 60_000) // never behind the real clock either
    })
  })
})

// ---- deleting a set / member / lottery leaves nothing behind ------------------------------------

describe('cascades', () => {
  const drawOf = (cookie: string, scope: string, lotteryId = 'hanoi-regular', date = '2026-11-19') =>
    renderOk(cookie, { items: [{ lotteryId }], date, scope })

  it('DELETE /sets/:id removes the draws of that set only', async () => {
    const m = await newMember('cascade-set')
    const other = await newMember('cascade-set-other')
    const sets = await getSets(m.cookie)
    const gone = sets.find((s) => !s.isDefault)!
    const kept = sets.filter((s) => !s.isDefault && s.id !== gone.id)[0]
    await drawOf(m.cookie, gone.id)
    await drawOf(m.cookie, gone.id, 'hanoi-vip', '2026-11-20')
    await drawOf(m.cookie, kept.id)
    await drawOf(m.cookie, 'single')
    await drawOf(m.cookie, sets[0].id) // the locked default set
    const [otherSet] = await getSets(other.cookie)
    await drawOf(other.cookie, otherSet.id)
    expect(await rowsOf(m.id)).toHaveLength(5)

    expect((await call('DELETE', `/sets/${gone.id}`, m.cookie)).status).toBe(204)
    expect((await rowsOf(m.id)).map((r) => r.scope).sort()).toEqual([kept.id, 'single', sets[0].id].sort())
    expect(await rowsOf(other.id)).toHaveLength(1)
    expect((await getDraws(m.cookie, 'date=2026-11-19')).draws.map((d) => d.scope)).not.toContain(gone.id)

    // the locked default set cannot be deleted, and its draws stay
    expect((await call('DELETE', `/sets/${sets[0].id}`, m.cookie)).status).toBe(409)
    expect(await rowsOf(m.id)).toHaveLength(3)
    // drawing for the deleted set is refused from now on
    expect((await render(m.cookie, { items: [{ lotteryId: 'hanoi-regular' }], date: '2026-11-19', scope: gone.id })).status).toBe(404)
  })

  it('deleting a member (back office) removes every draw of theirs and nobody else\'s', async () => {
    const m = await newMember('cascade-member')
    const other = await newMember('cascade-member-other')
    const [set] = await getSets(m.cookie)
    await drawOf(m.cookie, set.id)
    await drawOf(m.cookie, 'single')
    await drawOf(m.cookie, 'single', 'hanoi-vip', '2026-11-20')
    await drawOf(other.cookie, 'single')
    // a custom lottery of the member, drawn too
    const mine = (await (await call('POST', '/lotteries', m.cookie, { name: 'หวยของฉัน', group: 'other' })).json()) as Lottery
    await drawOf(m.cookie, 'single', mine.id)
    expect(await rowsOf(m.id)).toHaveLength(4)

    expect((await call('DELETE', `/admin/members/${m.id}`, admin)).status).toBe(204)
    expect(await rowsOf(m.id)).toHaveLength(0)
    expect(await rowsOf(other.id)).toHaveLength(1)
    expect(await getDb(env).select().from(memberDraws).where(eq(memberDraws.lotteryId, mine.id))).toHaveLength(0)
  })

  it('deleting a custom lottery of a member removes its draws, in every scope', async () => {
    const m = await newMember('cascade-own')
    const [set] = await getSets(m.cookie)
    const mine = (await (await call('POST', '/lotteries', m.cookie, { name: 'หวยลบทิ้ง', group: 'other' })).json()) as Lottery
    await drawOf(m.cookie, 'single', mine.id)
    await drawOf(m.cookie, set.id, mine.id)
    await drawOf(m.cookie, 'single', 'hanoi-regular')
    expect(await rowsOf(m.id)).toHaveLength(3)
    expect((await call('DELETE', `/lotteries/${mine.id}`, m.cookie)).status).toBe(204)
    expect((await rowsOf(m.id)).map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
  })

  it('deleting a catalog lottery (back office) removes the draws of every member for it', async () => {
    const a = await newMember('cascade-cat-a')
    const b = await newMember('cascade-cat-b')
    const created = await call('POST', '/admin/lotteries', admin, {
      name: 'หวยแคตตาล็อกชั่วคราว',
      shortName: 'ชั่วคราว',
      group: 'other',
      accent: '#4c1d95',
      sortOrder: 9996,
      active: true,
    })
    const id = ((await created.json()) as AdminLottery).id
    const [aSet] = await getSets(a.cookie)
    await drawOf(a.cookie, 'single', id)
    await drawOf(a.cookie, aSet.id, id)
    await drawOf(b.cookie, 'single', id)
    await drawOf(b.cookie, 'single', 'hanoi-regular')
    expect(await getDb(env).select().from(memberDraws).where(eq(memberDraws.lotteryId, id))).toHaveLength(3)

    expect((await call('DELETE', `/admin/lotteries/${id}`, admin)).status).toBe(204)
    expect(await getDb(env).select().from(memberDraws).where(eq(memberDraws.lotteryId, id))).toHaveLength(0)
    expect((await rowsOf(b.id)).map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
    expect((await rowsOf(a.id)).length).toBe(0)
  })
})
