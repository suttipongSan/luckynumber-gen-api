// The back office side of the public results site: migration 0010, the admin endpoints (the
// publicEnabled switch, schedule rows with strict validation, the "no draw today" switch, status /
// kill switch / publish), the bulk import of old results (dry run, mixed rows, old dates, names, a
// member's lottery refused, one version bump, many rows), the future-date guard of PUT /results and the
// local read route. Real libSQL database, fake bucket.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import type { AdminPublicLottery, AdminSchedule, ImportReport, ImportRowReport, PublicStatus } from '../src/types'
import { lotteries, lotteryResults, lotterySchedules, siteSettings } from '../src/db/schema'
import { openDb, runMigrations } from '../scripts/db'
import { runPublishPass } from '../src/lib/publicPublish'
import { lotteryDrawsQuery, resultsOfDatesQuery } from '../src/lib/publicSnapshot'
import type { PublicDayFile, PublicLotteryFile, PublicTodayFile } from '../src/lib/publicSnapshot'
import { addDays } from '../src/lib/time'
import { createHarness, ROBOT_KEY, type Harness } from './helpers/publicHarness'

const DB_FILE = 'test-public-admin.db'
let h: Harness

beforeAll(async () => {
  h = await createHarness(DB_FILE)
})
beforeEach(async () => {
  await h.reset()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
afterAll(() => {
  try {
    h.close()
  } catch {
    // the file may still be held open on Windows; harmless
  }
})

const NOW = '2026-11-20T03:00:00Z' // 10:00 on the 20th in Bangkok
const at = (iso = NOW) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) })
const today = () => h.bucket.json<PublicTodayFile>('v1/today.json')
const lotteryFile = (id: string) => h.bucket.json<PublicLotteryFile>(`v1/lottery/${id}.json`)
const dayFile = (date: string) => h.bucket.json<PublicDayFile>(`v1/day/${date}.json`)
const json = async <T>(res: Response) => (await res.json()) as T
const errorOf = async (res: Response) => (await res.json()) as { error: { code: string; message: string } }

async function settle(nowMs = Date.now()) {
  for (let i = 0; i < 80; i++) {
    const run = await runPublishPass(h.env, { nowMs })
    if (run.status !== 'published') return
    if ((await h.marks()).length === 0) return
  }
  throw new Error('publishing never settled')
}

// ---- migration 0010 ---------------------------------------------------------------------------------

describe('migration 0010', () => {
  const query = async (url: string, sqlText: string, args: (string | number | null)[] = []) => {
    const { client } = openDb(url)
    try {
      return (await client.execute({ sql: sqlText, args })).rows
    } finally {
      client.close()
    }
  }
  const dbUrl = `file:${DB_FILE}`

  it('is registered after 0009 in the journal, with a snapshot that chains to the previous one', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[]
    }
    expect(journal.entries[10]).toMatchObject({ idx: 10, tag: '0010_add_public_results' })
    expect(journal.entries[10].when).toBeGreaterThan(journal.entries[9].when)
    expect(journal.entries).toHaveLength(11)
    const snap = (n: string) => JSON.parse(readFileSync(`drizzle/meta/${n}_snapshot.json`, 'utf8')) as { id: string; prevId: string; tables: Record<string, unknown> }
    expect(snap('0010').prevId).toBe(snap('0009').id)
    expect(Object.keys(snap('0010').tables)).toContain('lottery_schedules')
  })

  it('adds lotteries.public_enabled (integer, not null, default 1): every existing lottery starts public', async () => {
    const cols = new Map((await query(dbUrl, 'pragma table_info(lotteries)')).map((r) => [String(r.name), r]))
    expect(cols.get('public_enabled')).toMatchObject({ type: 'INTEGER', notnull: 1, dflt_value: 'true' })
    const rows = await query(dbUrl, 'select count(*) as n, sum(public_enabled) as s from lotteries')
    expect(Number(rows[0].n)).toBe(Number(rows[0].s))
  })

  it('creates lottery_schedules with the agreed columns, the key (lottery, draw time) and a cascading foreign key', async () => {
    const cols = await query(dbUrl, 'pragma table_info(lottery_schedules)')
    expect(cols.map((r) => [String(r.name), String(r.type), Number(r.notnull), r.dflt_value === null ? null : String(r.dflt_value), Number(r.pk)])).toEqual([
      ['lottery_id', 'TEXT', 1, null, 1],
      ['draw_time', 'TEXT', 1, null, 2],
      ['result_time', 'TEXT', 1, null, 0],
      ['days', 'TEXT', 1, "'1234567'", 0],
      ['expected_fields', 'TEXT', 1, "'top3,top2,bottom2'", 0],
      ['closed_date', 'TEXT', 0, null, 0],
    ])
    const fks = await query(dbUrl, 'pragma foreign_key_list(lottery_schedules)')
    expect(fks.map((r) => [r.from, r.table, r.on_delete])).toEqual([['lottery_id', 'lotteries', 'CASCADE']])
  })

  it('a schedule row dies with its lottery (the foreign key cascades)', async () => {
    await h.db.insert(lotteries).values({ id: 'cascade-test', name: 'c', shortName: 'c', groupKey: 'other', accent: '#000000' })
    await h.db.insert(lotterySchedules).values({ lotteryId: 'cascade-test', drawTime: '', resultTime: '10:00' })
    await h.db.delete(lotteries).where(eq(lotteries.id, 'cascade-test'))
    expect(await h.db.select().from(lotterySchedules).where(eq(lotterySchedules.lotteryId, 'cascade-test'))).toEqual([])
  })

  it('a schedule row takes the defaults: every day and the three fields', async () => {
    await h.db.insert(lotterySchedules).values({ lotteryId: 'hanoi-regular', drawTime: '', resultTime: '18:30' })
    const [row] = await h.db.select().from(lotterySchedules)
    expect(row).toEqual({ lotteryId: 'hanoi-regular', drawTime: '', resultTime: '18:30', days: '1234567', expectedFields: 'top3,top2,bottom2', closedDate: null })
    // the key is (lottery, draw time): the same pair twice is refused
    await expect(h.db.insert(lotterySchedules).values({ lotteryId: 'hanoi-regular', drawTime: '', resultTime: '19:00' })).rejects.toThrow()
  })

  it('seeds the version counter at 1 and keeps a value that is already there', async () => {
    const scratch = join(tmpdir(), 'numbergen-api-test-migrations-public')
    rmSync(scratch, { recursive: true, force: true })
    mkdirSync(join(scratch, 'meta'), { recursive: true })
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: { idx: number; tag: string }[] }
    const upTo9 = { ...journal, entries: journal.entries.filter((e) => e.idx <= 9) }
    writeFileSync(join(scratch, 'meta', '_journal.json'), JSON.stringify(upTo9))
    for (const e of upTo9.entries) copyFileSync(join('drizzle', `${e.tag}.sql`), join(scratch, `${e.tag}.sql`))
    const url = `file:${join(scratch, 'before-0010.db').split('\\').join('/')}`
    await runMigrations(url, scratch)
    await query(url, "insert into site_settings (key, value, updated_at) values ('results_version', '7', 'x')")
    await runMigrations(url) // applies 0010 only
    expect((await query(url, "select value from site_settings where key = 'results_version'")).map((r) => String(r.value))).toEqual(['7'])
    // and a database that never had the key gets 1
    const fresh = `file:${join(scratch, 'fresh.db').split('\\').join('/')}`
    await runMigrations(fresh)
    expect((await query(fresh, "select value from site_settings where key = 'results_version'")).map((r) => String(r.value))).toEqual(['1'])
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // still locked on Windows; it is in the temp dir
    }
  })

  it('"the official rows of one lottery, newest first" is served by lottery_results_official_idx without a sort', async () => {
    const cols = await query(dbUrl, "pragma index_info('lottery_results_official_idx')")
    expect(cols.map((r) => String(r.name))).toEqual(['lottery_id', 'member_id', 'draw_date', 'draw_time'])
    const { sql: text, params } = lotteryDrawsQuery(h.db, 'hanoi-regular', 120).toSQL()
    const plan = (await query(dbUrl, `explain query plan ${text}`, params as (string | number | null)[])).map((r) => String(r.detail)).join('\n')
    expect(plan).toContain('lottery_results_official_idx')
    expect(plan).not.toMatch(/TEMP B-TREE/i)
    expect(plan).not.toMatch(/SCAN lottery_results/)
  })

  it('the rows of a few dates are served by the (member, date) index, not a scan', async () => {
    const { sql: text, params } = resultsOfDatesQuery(h.db, ['2026-11-19', '2026-11-20']).toSQL()
    const plan = (await query(dbUrl, `explain query plan ${text}`, params as (string | number | null)[])).map((r) => String(r.detail)).join('\n')
    expect(plan).toContain('lottery_results_member_date_idx')
    expect(plan).not.toMatch(/SCAN lottery_results/)
  })

  it('an earlier migration is untouched: 0000-0009 are the files they were', () => {
    const expected = ['0000_init', '0001_auth_hardening', '0002_v2_features', '0003_add_lottery_id_indexes', '0004_add_site_settings_and_render_limit', '0005_add_push_reminders', '0006_add_landing_page', '0007_add_article_pages', '0008_add_results_and_draws', '0009_add_personal_results']
    for (const tag of expected) expect(existsSync(`drizzle/${tag}.sql`), tag).toBe(true)
  })
})

// ---- who may call the endpoints -----------------------------------------------------------------------

describe('the admin endpoints need the admin session', () => {
  const endpoints: [string, string, unknown][] = [
    ['GET', '/admin/public/lotteries', undefined],
    ['PATCH', '/admin/public/lotteries/hanoi-regular', { publicEnabled: false }],
    ['PUT', '/admin/public/lotteries/hanoi-regular/schedules', { drawTime: '', resultTime: '18:30', days: [1], expectedFields: ['top3'] }],
    ['DELETE', '/admin/public/lotteries/hanoi-regular/schedules?drawTime=', undefined],
    ['PUT', '/admin/public/lotteries/hanoi-regular/schedules/closed', { drawTime: '', closedDate: null }],
    ['GET', '/admin/public/status', undefined],
    ['PUT', '/admin/public/enabled', { enabled: false }],
    ['POST', '/admin/public/publish', {}],
    ['POST', '/admin/results/import', { csv: 'hanoi-regular,2026-11-10,,123,45,67' }],
  ]

  it.each(endpoints)('%s %s refuses no cookie, a member and the results key with 401', async (method, path, body) => {
    const member = await h.newMember('not-admin')
    for (const o of [{}, { cookie: member.cookie }, { key: ROBOT_KEY }]) {
      const res = await h.call(method, path, { ...o, body })
      expect(res.status, JSON.stringify(o)).toBe(401)
    }
    expect((await h.state()).version).toBe(0)
  })
})

// ---- the lotteries and the publicEnabled switch ---------------------------------------------------------

describe('GET /admin/public/lotteries', () => {
  it('lists the catalog lotteries with publicEnabled and their schedule rows, never a member\'s lottery', async () => {
    const member = await h.newMember('owner')
    const own = await h.call('POST', '/lotteries', { cookie: member.cookie, body: { name: 'ของฉัน', group: 'other' } })
    const ownId = (await json<{ id: string }>(own)).id
    await h.db.insert(lotterySchedules).values([
      { lotteryId: 'hanoi-regular', drawTime: '', resultTime: '18:30', days: '135', expectedFields: 'top2,bottom2', closedDate: '2026-11-21' },
      { lotteryId: 'hanoi-regular', drawTime: '09:00', resultTime: '09:05' },
    ])
    await h.db.update(lotteries).set({ publicEnabled: false }).where(eq(lotteries.id, 'hanoi-vip'))
    const res = await h.adm('GET', '/admin/public/lotteries')
    expect(res.status).toBe(200)
    const list = await json<AdminPublicLottery[]>(res)
    expect(list).toHaveLength(82)
    expect(list.some((l) => l.id === ownId)).toBe(false)
    const regular = list.find((l) => l.id === 'hanoi-regular')!
    expect(regular).toEqual({
      id: 'hanoi-regular',
      name: 'ฮานอย ปกติ',
      shortName: 'ฮานอยปกติ',
      group: 'hanoi',
      accent: expect.any(String),
      sortOrder: expect.any(Number),
      active: true,
      publicEnabled: true,
      schedules: [
        { drawTime: '', resultTime: '18:30', days: [1, 3, 5], expectedFields: ['top2', 'bottom2'], closedDate: '2026-11-21' },
        { drawTime: '09:00', resultTime: '09:05', days: [1, 2, 3, 4, 5, 6, 7], expectedFields: ['top3', 'top2', 'bottom2'], closedDate: null },
      ],
    })
    expect(list.find((l) => l.id === 'hanoi-vip')).toMatchObject({ publicEnabled: false, schedules: [] })
    // ordered like the catalog list: sortOrder, then name
    const orders = list.map((l) => l.sortOrder)
    expect([...orders].sort((a, b) => a - b)).toEqual(orders)
  })
})

describe('PATCH /admin/public/lotteries/:id (the switch "แสดงบนเว็บผลหวย")', () => {
  it('switches it, answers the lottery with its schedules, and counts the change once', async () => {
    at()
    await h.db.insert(lotterySchedules).values({ lotteryId: 'hanoi-regular', drawTime: '', resultTime: '18:30' })
    const res = await h.adm('PATCH', '/admin/public/lotteries/hanoi-regular', { publicEnabled: false })
    expect(res.status).toBe(200)
    const body = await json<AdminPublicLottery>(res)
    expect(body).toMatchObject({ id: 'hanoi-regular', publicEnabled: false, active: true })
    expect(body.schedules).toHaveLength(1)
    expect((await h.db.select().from(lotteries).where(eq(lotteries.id, 'hanoi-regular')))[0].publicEnabled).toBe(false)
    expect((await h.state()).version).toBe(1)
    // the same value again changes nothing
    expect((await h.adm('PATCH', '/admin/public/lotteries/hanoi-regular', { publicEnabled: false })).status).toBe(200)
    expect((await h.state()).version).toBe(1)
    // back on
    expect((await h.adm('PATCH', '/admin/public/lotteries/hanoi-regular', { publicEnabled: true })).status).toBe(200)
    expect((await h.state()).version).toBe(2)
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.schedules).toHaveLength(1)
  })

  it('a lottery that is switched off (active = false) changes no file when this switch moves', async () => {
    await h.db.update(lotteries).set({ active: false }).where(eq(lotteries.id, 'hanoi-vip'))
    expect((await h.adm('PATCH', '/admin/public/lotteries/hanoi-vip', { publicEnabled: false })).status).toBe(200)
    expect((await h.adm('PATCH', '/admin/public/lotteries/hanoi-vip', { publicEnabled: true })).status).toBe(200)
    expect((await h.state()).version).toBe(0)
  })

  it('is 404 for an unknown lottery and for a member\'s own lottery; 400 for anything but { publicEnabled: boolean }', async () => {
    const member = await h.newMember('owner2')
    const ownId = (await json<{ id: string }>(await h.call('POST', '/lotteries', { cookie: member.cookie, body: { name: 'ของฉัน', group: 'other' } }))).id
    expect((await h.adm('PATCH', '/admin/public/lotteries/nope', { publicEnabled: false })).status).toBe(404)
    expect((await h.adm('PATCH', `/admin/public/lotteries/${ownId}`, { publicEnabled: false })).status).toBe(404)
    for (const bad of [{}, { publicEnabled: 'false' }, { publicEnabled: 0 }, { publicEnabled: null }, { publicEnabled: true, active: false }, { enabled: true }]) {
      const res = await h.adm('PATCH', '/admin/public/lotteries/hanoi-regular', bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    expect((await h.state()).version).toBe(0)
  })
})

// ---- schedules -----------------------------------------------------------------------------------------

describe('schedule rows', () => {
  const base = { drawTime: '18:30', resultTime: '18:31', days: [1, 2, 3, 4, 5, 6, 7], expectedFields: ['top3', 'top2', 'bottom2'] }
  const put = (id: string, body: unknown) => h.adm('PUT', `/admin/public/lotteries/${id}/schedules`, body)
  const del = (id: string, query: string) => h.adm('DELETE', `/admin/public/lotteries/${id}/schedules${query}`)
  const closed = (id: string, body: unknown) => h.adm('PUT', `/admin/public/lotteries/${id}/schedules/closed`, body)
  const rows = () => h.db.select().from(lotterySchedules)

  it('creates a row (201) with the days and fields normalised, replaces it (200) and keeps nothing else', async () => {
    const res = await put('hanoi-regular', { drawTime: '18:30', resultTime: '18:31', days: [5, 1, 3], expectedFields: ['bottom2', 'top3'] })
    expect(res.status).toBe(201)
    expect(await json<AdminSchedule>(res)).toEqual({ drawTime: '18:30', resultTime: '18:31', days: [1, 3, 5], expectedFields: ['top3', 'bottom2'], closedDate: null })
    expect(await rows()).toEqual([{ lotteryId: 'hanoi-regular', drawTime: '18:30', resultTime: '18:31', days: '135', expectedFields: 'top3,bottom2', closedDate: null }])
    const again = await put('hanoi-regular', { ...base, resultTime: '18:45' })
    expect(again.status).toBe(200)
    expect(await json<AdminSchedule>(again)).toMatchObject({ resultTime: '18:45', days: [1, 2, 3, 4, 5, 6, 7] })
    expect(await rows()).toHaveLength(1)
  })

  it('a lottery that draws once a day has the row with draw time ""', async () => {
    const res = await put('lao-vip', { ...base, drawTime: '' })
    expect(res.status).toBe(201)
    expect((await json<AdminSchedule>(res)).drawTime).toBe('')
    // another draw time of the same lottery is another row
    expect((await put('lao-vip', { ...base, drawTime: '09:00' })).status).toBe(201)
    expect((await rows()).map((r) => r.drawTime).sort()).toEqual(['', '09:00'])
  })

  it('re-saving the closed switch survives: the times are replaced, the "no draw today" date is kept', async () => {
    await put('hanoi-regular', base)
    await closed('hanoi-regular', { drawTime: '18:30', closedDate: '2026-11-21' })
    const res = await put('hanoi-regular', { ...base, resultTime: '18:50' })
    expect(await json<AdminSchedule>(res)).toMatchObject({ resultTime: '18:50', closedDate: '2026-11-21' })
  })

  it.each([
    ['drawTime 24:00', { ...base, drawTime: '24:00' }],
    ['drawTime 9:30', { ...base, drawTime: '9:30' }],
    ['drawTime 1830', { ...base, drawTime: '1830' }],
    ['drawTime number', { ...base, drawTime: 1830 }],
    ['drawTime null', { ...base, drawTime: null }],
    ['drawTime missing', { resultTime: '18:31', days: [1], expectedFields: ['top3'] }],
    ['resultTime missing', { drawTime: '', days: [1], expectedFields: ['top3'] }],
    ['resultTime empty', { ...base, resultTime: '' }],
    ['resultTime 25:00', { ...base, resultTime: '25:00' }],
    ['resultTime 18:60', { ...base, resultTime: '18:60' }],
    ['days empty', { ...base, days: [] }],
    ['days 0', { ...base, days: [0, 1] }],
    ['days 8', { ...base, days: [1, 8] }],
    ['days repeated', { ...base, days: [1, 1] }],
    ['days text', { ...base, days: ['1', '2'] }],
    ['days a string', { ...base, days: '1234567' }],
    ['days fractional', { ...base, days: [1.5] }],
    ['days missing', { drawTime: '', resultTime: '18:31', expectedFields: ['top3'] }],
    ['expectedFields empty', { ...base, expectedFields: [] }],
    ['expectedFields unknown', { ...base, expectedFields: ['top4'] }],
    ['expectedFields repeated', { ...base, expectedFields: ['top3', 'top3'] }],
    ['expectedFields text', { ...base, expectedFields: 'top3,top2' }],
    ['expectedFields missing', { drawTime: '', resultTime: '18:31', days: [1] }],
    ['closedDate in the body', { ...base, closedDate: '2026-11-21' }],
    ['an unknown key', { ...base, label: 'x' }],
  ])('refuses %s with 400 and writes nothing', async (_name, body) => {
    const res = await put('hanoi-regular', body)
    expect(res.status).toBe(400)
    expect((await errorOf(res)).error.code).toBe('VALIDATION')
    expect(await rows()).toEqual([])
    expect((await h.state()).version).toBe(0)
  })

  it('refuses a body that is not a JSON object', async () => {
    for (const raw of ['not json', '[]', 'null', '']) {
      expect((await put('hanoi-regular', raw)).status, raw).toBe(400)
    }
  })

  it('is 404 for an unknown lottery and for a member\'s own lottery', async () => {
    const member = await h.newMember('owner3')
    const ownId = (await json<{ id: string }>(await h.call('POST', '/lotteries', { cookie: member.cookie, body: { name: 'ของฉัน', group: 'other' } }))).id
    expect((await put('nope', base)).status).toBe(404)
    expect((await put(ownId, base)).status).toBe(404)
    expect((await closed(ownId, { drawTime: '', closedDate: null })).status).toBe(404)
    expect((await del(ownId, '?drawTime=')).status).toBe(404)
    expect(await rows()).toEqual([])
  })

  it('a lottery has at most 24 draw times (the 25th is 409 QUOTA)', async () => {
    for (let i = 0; i < 24; i++) {
      const res = await put('hanoi-regular', { ...base, drawTime: `${String(i).padStart(2, '0')}:00` })
      expect(res.status).toBe(201)
    }
    const over = await put('hanoi-regular', { ...base, drawTime: '23:30' })
    expect(over.status).toBe(409)
    expect((await errorOf(over)).error.code).toBe('QUOTA')
    // an existing row can still be replaced
    expect((await put('hanoi-regular', { ...base, drawTime: '05:00', resultTime: '05:10' })).status).toBe(200)
    // and another lottery is not affected
    expect((await put('lao-vip', base)).status).toBe(201)
  })

  it('deletes a row by its draw time (204), 404 the second time, 400 without the parameter', async () => {
    await put('hanoi-regular', base)
    await put('hanoi-regular', { ...base, drawTime: '' })
    expect((await del('hanoi-regular', '')).status).toBe(400) // drawTime is required, "" is a value
    expect((await del('hanoi-regular', '?drawTime=24:00')).status).toBe(400)
    expect((await del('hanoi-regular', '?drawTime=18:30')).status).toBe(204)
    expect((await rows()).map((r) => r.drawTime)).toEqual([''])
    expect((await del('hanoi-regular', '?drawTime=18:30')).status).toBe(404)
    expect((await del('hanoi-regular', '?drawTime=')).status).toBe(204)
    expect(await rows()).toEqual([])
  })

  it('"วันนี้งดออกผล": sets and clears the closed date of a row, which must exist', async () => {
    await put('hanoi-regular', base)
    const set = await closed('hanoi-regular', { drawTime: '18:30', closedDate: '2026-11-21' })
    expect(set.status).toBe(200)
    expect(await json<AdminSchedule>(set)).toMatchObject({ drawTime: '18:30', closedDate: '2026-11-21' })
    expect((await rows())[0].closedDate).toBe('2026-11-21')
    const clear = await closed('hanoi-regular', { drawTime: '18:30', closedDate: null })
    expect(clear.status).toBe(200)
    expect((await json<AdminSchedule>(clear)).closedDate).toBeNull()
    expect((await rows())[0].closedDate).toBeNull()
    // no such row, no row at all
    expect((await closed('hanoi-regular', { drawTime: '09:00', closedDate: '2026-11-21' })).status).toBe(404)
    expect((await closed('lao-vip', { drawTime: '', closedDate: null })).status).toBe(404)
  })

  it.each([
    ['not a day', { drawTime: '18:30', closedDate: '2026-02-30' }],
    ['another format', { drawTime: '18:30', closedDate: '21-11-2026' }],
    ['a date-time', { drawTime: '18:30', closedDate: '2026-11-21T00:00' }],
    ['empty', { drawTime: '18:30', closedDate: '' }],
    ['missing', { drawTime: '18:30' }],
    ['number', { drawTime: '18:30', closedDate: 20261121 }],
    ['no drawTime', { closedDate: '2026-11-21' }],
    ['an unknown key', { drawTime: '18:30', closedDate: null, extra: 1 }],
  ])('refuses a closed date that is %s with 400', async (_name, body) => {
    await put('hanoi-regular', base)
    expect((await closed('hanoi-regular', body)).status).toBe(400)
    expect((await rows())[0].closedDate).toBeNull()
  })

  it('a change counts once and reaches today.json and the lottery file; the same values again count nothing', async () => {
    at()
    expect((await put('hanoi-regular', base)).status).toBe(201)
    expect((await h.state()).version).toBe(1)
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.schedules).toEqual([
      { drawTime: '18:30', resultTime: '18:31', days: [1, 2, 3, 4, 5, 6, 7], expectedFields: ['top3', 'top2', 'bottom2'], closedDate: null },
    ])
    expect(lotteryFile('hanoi-regular').schedules).toHaveLength(1)
    expect((await put('hanoi-regular', { ...base, days: [7, 6, 5, 4, 3, 2, 1] })).status).toBe(200) // the same days
    expect((await h.state()).version).toBe(1)
    expect((await closed('hanoi-regular', { drawTime: '18:30', closedDate: '2026-11-21' })).status).toBe(200)
    expect((await h.state()).version).toBe(2)
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.schedules[0].closedDate).toBe('2026-11-21')
    expect((await closed('hanoi-regular', { drawTime: '18:30', closedDate: '2026-11-21' })).status).toBe(200)
    expect((await h.state()).version).toBe(2)
    expect((await del('hanoi-regular', '?drawTime=18:30')).status).toBe(204)
    expect((await h.state()).version).toBe(3)
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.schedules).toEqual([])
  })

  it('the expected fields decide final / partial in every file, old day files included', async () => {
    at()
    const D = '2026-11-19'
    // two draws without a 3-digit number: partial under the default three fields
    await h.put({ lotteryId: 'hanoi-regular', date: D, top2: '12', bottom2: '34' })
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-10', top2: '56', bottom2: '78' })
    expect(dayFile(D).results[0].state).toBe('partial')
    expect(dayFile('2026-11-10').results[0].state).toBe('partial')
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.results[0].state).toBe('partial')
    expect(lotteryFile('hanoi-regular').draws.map((d) => d.state)).toEqual(['partial', 'partial'])
    // the lottery publishes two numbers: both draws are final now, also the one of ten days ago
    expect((await put('hanoi-regular', { drawTime: '', resultTime: '18:30', days: [1, 2, 3, 4, 5, 6, 7], expectedFields: ['top2', 'bottom2'] })).status).toBe(201)
    await settle()
    expect(dayFile(D).results[0].state).toBe('final')
    expect(dayFile('2026-11-10').results[0].state).toBe('final')
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.results[0].state).toBe('final')
    expect(lotteryFile('hanoi-regular').draws.map((d) => d.state)).toEqual(['final', 'final'])
    // and back to the default by deleting the row
    expect((await del('hanoi-regular', '?drawTime=')).status).toBe(204)
    await settle()
    expect(dayFile(D).results[0].state).toBe('partial')
    expect(lotteryFile('hanoi-regular').draws.map((d) => d.state)).toEqual(['partial', 'partial'])
  })

  it('the schedule of a lottery that is not public is stored but changes no file and counts nothing', async () => {
    await h.db.update(lotteries).set({ publicEnabled: false }).where(eq(lotteries.id, 'hanoi-hd'))
    expect((await put('hanoi-hd', base)).status).toBe(201)
    expect((await closed('hanoi-hd', { drawTime: '18:30', closedDate: '2026-11-21' })).status).toBe(200)
    expect((await del('hanoi-hd', '?drawTime=18:30')).status).toBe(204)
    expect((await h.state()).version).toBe(0)
    expect(h.bucket.log).toEqual([])
  })

  it('deleting the lottery deletes its schedule rows', async () => {
    await put('hanoi-regular', base)
    expect((await h.adm('DELETE', '/admin/lotteries/hanoi-regular')).status).toBe(204)
    expect(await rows()).toEqual([])
  })
})

// ---- the future-date guard ---------------------------------------------------------------------------------

describe('PUT /results refuses a draw date more than a day ahead (Bangkok)', () => {
  const full = { lotteryId: 'hanoi-regular', top3: '123', top2: '45', bottom2: '67' }

  it('today, yesterday, any old date and tomorrow are fine; the day after tomorrow is 400', async () => {
    at('2026-11-20T10:00:00Z') // 17:00 on the 20th in Bangkok
    for (const date of ['2026-11-20', '2026-11-19', '2020-01-01', '2026-11-21']) {
      expect((await h.put({ ...full, date })).status, date).toBe(201)
    }
    const res = await h.put({ ...full, date: '2026-11-22' })
    expect(res.status).toBe(400)
    const { error } = await errorOf(res)
    expect(error.code).toBe('VALIDATION')
    expect(error.message).toContain('date')
    expect(error.message).toContain('2026-11-21') // the latest date accepted
    expect((await h.put({ ...full, date: '2099-01-01' })).status).toBe(400)
    expect(await h.officialRow('hanoi-regular', '2026-11-22')).toBeUndefined()
  })

  it('the day changes at Bangkok midnight, not at UTC midnight', async () => {
    at('2026-11-20T16:59:59Z') // 23:59:59 on the 20th in Bangkok
    expect((await h.put({ ...full, date: '2026-11-21' })).status).toBe(201)
    expect((await h.put({ ...full, date: '2026-11-22' })).status).toBe(400)
    at('2026-11-20T17:00:00Z') // 00:00:00 on the 21st in Bangkok
    expect((await h.put({ ...full, date: '2026-11-22' })).status).toBe(201)
    expect((await h.put({ ...full, date: '2026-11-23' })).status).toBe(400)
  })

  it('is checked before the lottery is looked up and for the admin as well as the robot', async () => {
    at()
    expect((await h.put({ lotteryId: 'nope', date: '2027-01-01', top3: '123' })).status).toBe(400)
    expect((await h.adm('PUT', '/results', { ...full, date: '2027-01-01' })).status).toBe(400)
    expect((await h.adm('PUT', '/results', { ...full, date: '2026-11-21' })).status).toBe(201)
  })

  it('does not apply to a member\'s own result', async () => {
    at()
    const member = await h.newMember('typist')
    const res = await h.call('PUT', '/results/mine', { cookie: member.cookie, body: { lotteryId: 'hanoi-regular', date: '2030-01-01', top3: '123' } })
    expect(res.status).toBe(201)
  })
})

// ---- the bulk import -------------------------------------------------------------------------------------------

describe('POST /admin/results/import', () => {
  const imp = (body: unknown) => h.adm('POST', '/admin/results/import', body)
  const report = async (body: unknown, status = 200) => {
    const res = await imp(body)
    expect(res.status).toBe(status)
    return json<ImportReport>(res)
  }
  const byLine = (r: ImportReport) => new Map(r.rows.map((x) => [x.line, x] as const))
  const count = async () => (await h.db.select().from(lotteryResults)).filter((r) => r.memberId === '').length

  const MIXED = [
    'lottery,date,time,top3,top2,bottom2', // 1: the header line is skipped
    'hanoi-regular,2026-11-10,,123,45,67', // 2: new
    'ฮานอย ปกติ,2026-11-11,,234,56,78', // 3: new, by the exact name
    'hanoi-regular,2026-11-12,16:30,,12,', // 4: new, one number and a draw time
    'hanoi-regular,2026-02-30,,123,45,67', // 5: no such day
    'hanoi-regular,2026-11-13,,12,45,67', // 6: top3 of two digits
    'nope,2026-11-13,,123,45,67', // 7: unknown lottery
    'ฮานอย VIP,2026-11-13,,123,45,67', // 8: two lotteries have this name
    'PRIVATE,2026-11-13,,123,45,67', // 9: a member's own lottery (replaced below)
    'hanoi-regular,2026-11-10,,999,99,99', // 10: the draw of line 2 again
    'hanoi-regular,2030-01-01,,123,45,67', // 11: too far ahead
    'hanoi-regular,2026-11-14,25:00,123,45,67', // 12: no such time
    'hanoi-regular,2026-11-14,,,,', // 13: no number at all
    '', // 14: blank
    'hanoi-regular,1999-12-31,,123,45,67', // 15: older than 2000
    'hanoi-regular,2015-06-01,,000,00,00', // 16: an old date is fine
  ]

  let privateId: string
  beforeEach(async () => {
    at()
    const member = await h.newMember('importer')
    privateId = (await json<{ id: string }>(await h.call('POST', '/lotteries', { cookie: member.cookie, body: { name: 'หวยของสมาชิก', group: 'other' } }))).id
    // two catalog lotteries with one name (ambiguous)
    await h.db.update(lotteries).set({ name: 'ฮานอย VIP' }).where(eq(lotteries.id, 'lao-vip'))
  })
  const mixedCsv = () => MIXED.join('\n').replace('PRIVATE', privateId)

  it('a dry run reports every row and writes nothing (no row, no version, no file)', async () => {
    const r = await report({ csv: mixedCsv(), dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(r.saved).toBe(0)
    expect(r.summary).toEqual({ total: 14, new: 4, changed: 0, same: 0, errors: 10 })
    expect(await count()).toBe(0)
    expect((await h.state()).version).toBe(0)
    expect(h.bucket.log).toEqual([])
    expect(await h.marks()).toEqual([])
  })

  it('reports each row with its own line, status, lottery and the reason it was refused', async () => {
    const rows = byLine(await report({ csv: mixedCsv(), dryRun: true }))
    expect([...rows.keys()]).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16]) // the header and the blank line have no row
    const ok = (line: number, expected: Partial<ImportRowReport>) => expect(rows.get(line), `line ${line}`).toMatchObject({ status: 'new', error: null, previous: null, ...expected })
    ok(2, { lotteryId: 'hanoi-regular', lotteryName: 'ฮานอย ปกติ', date: '2026-11-10', time: '', top3: '123', top2: '45', bottom2: '67' })
    ok(3, { lotteryId: 'hanoi-regular', date: '2026-11-11', top3: '234', top2: '56', bottom2: '78' })
    ok(4, { date: '2026-11-12', time: '16:30', top3: null, top2: '12', bottom2: null })
    ok(16, { date: '2015-06-01', top3: '000', top2: '00', bottom2: '00' })
    const bad = (line: number, text: string) => {
      const r = rows.get(line)!
      expect(r.status, `line ${line}`).toBe('error')
      expect(r.error, `line ${line}`).toContain(text)
    }
    bad(5, 'วันที่')
    bad(6, '3 ตัวบน')
    bad(7, 'ไม่พบหวย')
    bad(8, 'มากกว่าหนึ่งรายการ')
    bad(9, 'ไม่พบหวย') // a member's own lottery is "not found" for the import
    bad(10, 'ซ้ำกับบรรทัด 2')
    bad(11, 'ล่วงหน้า')
    bad(12, 'เวลา')
    bad(13, 'อย่างน้อยหนึ่งช่อง')
    bad(15, 'เก่าเกินไป')
    expect(rows.get(9)).toMatchObject({ lotteryId: null }) // never resolved
    expect(rows.get(7)).toMatchObject({ lotteryId: null })
  })

  it('the real run saves the valid rows, skips the bad ones, bumps the version ONCE and publishes', async () => {
    const r = await report({ csv: mixedCsv() })
    expect(r.dryRun).toBe(false)
    expect(r.saved).toBe(4)
    expect(r.summary).toEqual({ total: 14, new: 4, changed: 0, same: 0, errors: 10 })
    expect(await count()).toBe(4)
    expect(await h.officialRow('hanoi-regular', '2026-11-10')).toMatchObject({ top3: '123', top2: '45', bottom2: '67', source: 'นำเข้า', createdAt: '2026-11-20T03:00:00.000Z', updatedAt: '2026-11-20T03:00:00.000Z' })
    expect(await h.officialRow('hanoi-regular', '2026-11-12', '16:30')).toMatchObject({ top3: null, top2: '12', bottom2: null })
    expect(await h.officialRow('hanoi-regular', '2015-06-01')).toMatchObject({ top3: '000' })
    expect(await h.officialRow('hanoi-regular', '2026-11-13')).toBeUndefined() // the refused rows are not there
    expect((await h.state()).version).toBe(1) // one import, one version
    await settle()
    expect(await h.state()).toMatchObject({ version: 1, published: 1 })
    // the files: four dates, one lottery
    for (const d of ['2026-11-10', '2026-11-11', '2026-11-12', '2015-06-01']) expect(dayFile(d).results).toHaveLength(1)
    expect(h.bucket.has('v1/day/2026-11-13.json')).toBe(false)
    expect(lotteryFile('hanoi-regular').draws.map((d) => d.date)).toEqual(['2026-11-12', '2026-11-11', '2026-11-10', '2015-06-01'])
    expect(lotteryFile('hanoi-regular').draws[0]).toMatchObject({ time: '16:30', state: 'partial' })
  })

  it('accepts tab, semicolon and comma separated text, quotes, CRLF, a BOM, blank lines and a Thai header', async () => {
    const text = '\uFEFFหวย\tวันที่\tเวลา\ttop3\ttop2\tbottom2\r\n' +
      'hanoi-regular\t2026-11-01\t\t111\t11\t11\r\n' +
      '\r\n' +
      'hanoi-vip;2026-11-02;;222;22;22\n' +
      '"ฮานอย ปกติ","2026-11-03","09:00","333","33","33"\n' +
      '  hanoi-regular , 2026-11-04 ,, 444 , 44 , 44 \n' +
      '"hanoi-regular",2026-11-05,,"555",55,55'
    const r = await report({ csv: text, dryRun: true })
    expect(r.summary).toEqual({ total: 5, new: 5, changed: 0, same: 0, errors: 0 })
    expect(r.rows.map((x) => x.line)).toEqual([2, 4, 5, 6, 7])
    expect(r.rows.map((x) => [x.lotteryId, x.date, x.time, x.top3])).toEqual([
      ['hanoi-regular', '2026-11-01', '', '111'],
      ['hanoi-vip', '2026-11-02', '', '222'],
      ['hanoi-regular', '2026-11-03', '09:00', '333'],
      ['hanoi-regular', '2026-11-04', '', '444'],
      ['hanoi-regular', '2026-11-05', '', '555'],
    ])
  })

  it('a line that cannot be read is an error row, not a failure of the call', async () => {
    const r = await report({ csv: 'hanoi-regular,2026-11-01,,123,45,67\n"hanoi-regular,2026-11-02,,123,45,67\na,b,c,d,e,f,g\nhanoi-regular,2026-11-03,,123,45', dryRun: true })
    const rows = byLine(r)
    expect(rows.get(1)!.status).toBe('new')
    expect(rows.get(2)).toMatchObject({ status: 'error', error: expect.stringContaining('เครื่องหมายคำพูด') })
    expect(rows.get(3)).toMatchObject({ status: 'error', error: expect.stringContaining('6 ช่อง') })
    expect(rows.get(4)!.status).toBe('new') // trailing empty columns may be left out
  })

  it('rows can be sent as objects as well (lottery = an id or an exact name)', async () => {
    const r = await report({
      dryRun: true,
      rows: [
        { lottery: 'hanoi-regular', date: '2026-11-10', top3: '123', top2: '45', bottom2: '67' },
        { lottery: 'ฮานอย ปกติ', date: '2026-11-11', time: '09:00', top2: '12' },
        { lottery: 'hanoi-regular', date: '2026-11-12', top3: 123 },
        { lottery: 'hanoi-regular', date: '2026-11-13', top3: '123', color: 'red' },
        'a text',
        null,
        [],
      ],
    })
    expect(r.rows.map((x) => [x.line, x.status])).toEqual([[1, 'new'], [2, 'new'], [3, 'error'], [4, 'error'], [5, 'error'], [6, 'error'], [7, 'error']])
    expect(r.rows[2].error).toContain('3 ตัวบน')
    expect(r.rows[3].error).toContain('color')
  })

  it('needs exactly one of csv / rows and nothing else', async () => {
    for (const bad of [{}, { csv: 'x', rows: [] }, { csv: 5 }, { rows: 'x' }, { rows: {} }, { csv: 'x', extra: 1 }, { dryRun: 'yes', csv: 'x' }, { dryRun: true }]) {
      expect((await imp(bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await imp('not json')).status).toBe(400)
    expect((await imp('[]')).status).toBe(400)
    expect(await count()).toBe(0)
  })

  it('an empty text or list is an empty report (nothing to import is not an error)', async () => {
    for (const body of [{ csv: '' }, { csv: '\n\n  \n' }, { csv: 'lottery,date,time,top3,top2,bottom2' }, { rows: [] }]) {
      const r = await report(body)
      expect(r).toMatchObject({ saved: 0, summary: { total: 0, new: 0, changed: 0, same: 0, errors: 0 }, rows: [] })
    }
    expect((await h.state()).version).toBe(0)
  })

  it('takes 2000 rows and refuses the 2001st (the whole call is 400, nothing is read of it)', async () => {
    const line = (i: number) => `hanoi-regular,${addDays('2020-01-01', i)},,123,45,67`
    const ok = await report({ csv: Array.from({ length: 2000 }, (_, i) => line(i)).join('\n'), dryRun: true })
    expect(ok.summary).toMatchObject({ total: 2000, new: 2000, errors: 0 })
    const tooMany = await imp({ csv: Array.from({ length: 2001 }, (_, i) => line(i)).join('\n'), dryRun: true })
    expect(tooMany.status).toBe(400)
    expect((await errorOf(tooMany)).error.message).toContain('2000')
    const asRows = await imp({ rows: Array.from({ length: 2001 }, (_, i) => ({ lottery: 'hanoi-regular', date: addDays('2020-01-01', i), top3: '123' })), dryRun: true })
    expect(asRows.status).toBe(400)
    // the header and blank lines do not count
    const withNoise = ['lottery,date,time,top3,top2,bottom2', '', ...Array.from({ length: 2000 }, (_, i) => line(i)), ''].join('\n')
    expect((await report({ csv: withNoise, dryRun: true })).summary.total).toBe(2000)
  })

  it('a row that holds exactly the stored numbers is "same": nothing is written, nothing counted, updatedAt stays', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-10', top3: '123', top2: '45', bottom2: '67', source: 'robot' })
    const before = await h.officialRow('hanoi-regular', '2026-11-10')
    const versionBefore = (await h.state()).version
    at('2026-11-20T05:00:00Z')
    const r = await report({ csv: 'hanoi-regular,2026-11-10,,123,45,67' })
    expect(r.rows[0]).toMatchObject({ status: 'same', previous: null })
    expect(r).toMatchObject({ saved: 0, summary: { same: 1, new: 0, changed: 0 } })
    expect(await h.officialRow('hanoi-regular', '2026-11-10')).toEqual(before)
    expect((await h.state()).version).toBe(versionBefore)
  })

  it('a row with other numbers is "changed" and says what it replaces; the draw becomes exactly the row (replace semantics)', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-10', top3: '123', top2: '45', bottom2: '67' })
    const before = await h.officialRow('hanoi-regular', '2026-11-10')
    const versionBefore = (await h.state()).version
    at('2026-11-20T05:00:00Z')
    const dry = await report({ csv: 'hanoi-regular,2026-11-10,,123,99,', dryRun: true })
    expect(dry.rows[0]).toMatchObject({ status: 'changed', top2: '99', bottom2: null, previous: { top3: '123', top2: '45', bottom2: '67' } })
    expect(await h.officialRow('hanoi-regular', '2026-11-10')).toEqual(before)
    const real = await report({ csv: 'hanoi-regular,2026-11-10,,123,99,' })
    expect(real).toMatchObject({ saved: 1, summary: { changed: 1 } })
    const after = await h.officialRow('hanoi-regular', '2026-11-10')
    expect(after).toMatchObject({ id: before!.id, createdAt: before!.createdAt, top3: '123', top2: '99', bottom2: null, source: 'นำเข้า', updatedAt: '2026-11-20T05:00:00.000Z' })
    expect((await h.state()).version).toBe(versionBefore + 1)
    expect(dayFile('2026-11-10').results[0]).toMatchObject({ top2: '99', bottom2: null })
  })

  it('importing the same text twice: the second time every row is "same" and nothing changes', async () => {
    const csv = 'hanoi-regular,2026-11-10,,123,45,67\nlao-vip,2026-11-10,,234,56,78'
    expect((await report({ csv })).saved).toBe(2)
    const version = (await h.state()).version
    const again = await report({ csv })
    expect(again).toMatchObject({ saved: 0, summary: { same: 2, new: 0 } })
    expect((await h.state()).version).toBe(version)
  })

  it('rows of a lottery that is not public are saved but count nothing and publish nothing', async () => {
    await h.db.update(lotteries).set({ publicEnabled: false }).where(eq(lotteries.id, 'hanoi-hd'))
    await h.db.update(lotteries).set({ active: false }).where(eq(lotteries.id, 'hanoi-vip'))
    const r = await report({ csv: 'hanoi-hd,2026-11-10,,123,45,67\nhanoi-vip,2026-11-10,,123,45,67' })
    expect(r.saved).toBe(2)
    expect(await count()).toBe(2)
    expect((await h.state()).version).toBe(0)
    expect(h.bucket.log).toEqual([])
  })

  it('the batch is all or nothing: a failure leaves no row, no version and no mark', async () => {
    const { client } = openDb(`file:${DB_FILE}`)
    try {
      await client.execute("create trigger boom before insert on lottery_results when new.draw_date = '2019-05-05' begin select raise(abort, 'boom'); end")
    } finally {
      client.close()
    }
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await imp({ csv: 'hanoi-regular,2026-11-10,,123,45,67\nhanoi-regular,2019-05-05,,123,45,67' })
      expect(res.status).toBe(500)
    } finally {
      log.mockRestore()
      const { client: c2 } = openDb(`file:${DB_FILE}`)
      try {
        await c2.execute('drop trigger boom')
      } finally {
        c2.close()
      }
    }
    expect(await count()).toBe(0)
    expect((await h.state()).version).toBe(0)
    expect(await h.marks()).toEqual([])
  })

  it('2000 old results at once: one version, every row stored, the files follow a few at a time and the statistics appear', async () => {
    const lots = Array.from({ length: 20 }, (_, i) => LOTS[i])
    const csv = lots.flatMap((id) => Array.from({ length: 100 }, (_, d) => `${id},${addDays('2026-11-19', -d)},,${String(100 + (d % 9) * 11)},${String(10 + (d % 80))},${String(20 + ((d * 7) % 70))}`)).join('\n')
    const r = await report({ csv })
    expect(r).toMatchObject({ saved: 2000, summary: { total: 2000, new: 2000, errors: 0 } })
    expect(await count()).toBe(2000)
    expect((await h.state()).version).toBe(1)
    // the request itself started a build of a few files; the rest is marked for the cron
    const left = (await h.marks()).length
    expect(left).toBeGreaterThan(100)
    expect(left).toBeLessThanOrEqual(20 + 100)
    await settle()
    expect(await h.marks()).toEqual([])
    expect(await h.state()).toMatchObject({ version: 1, published: 1 })
    const f = lotteryFile(LOTS[0])
    expect(f.draws).toHaveLength(90)
    expect(f.stats?.map((w) => w.draws)).toEqual([30, 60, 90])
    expect(dayFile('2026-11-19').results).toHaveLength(20)
    expect(h.bucket.has(`v1/day/${addDays('2026-11-19', -99)}.json`)).toBe(true)
    expect(today().lotteries.find((l) => l.id === LOTS[0])!.results.map((x) => x.date)).toEqual(['2026-11-19'])
  })
})

/** The first catalog lotteries, for tests that need many. */
const LOTS = [
  'dow-jones', 'dow-jones-vip', 'dow-jones-star', 'nikkei-morning', 'nikkei-morning-vip', 'nikkei-afternoon', 'nikkei-afternoon-vip',
  'china-morning', 'china-morning-vip', 'china-afternoon', 'hanoi-regular', 'hanoi-special', 'hanoi-vip', 'hanoi-hd', 'hanoi-hdx',
  'lao-pattana', 'lao-vip', 'lao-star', 'lao-hd', 'lao-tv',
]

// ---- status, the kill switch, publish -------------------------------------------------------------------------

describe('status, the kill switch and publish', () => {
  it('GET /admin/public/status', async () => {
    expect(await json<PublicStatus>(await h.adm('GET', '/admin/public/status'))).toEqual({ enabled: true, bucketBound: true, version: 0, publishedVersion: 0, pending: 0 })
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123' })
    expect(await json<PublicStatus>(await h.adm('GET', '/admin/public/status'))).toEqual({ enabled: true, bucketBound: true, version: 1, publishedVersion: 1, pending: 0 })
    const bare = await h.call('GET', '/admin/public/status', { cookie: h.admin, env: { ...h.env, PUBLIC_RESULTS: undefined } })
    expect((await json<PublicStatus>(bare)).bucketBound).toBe(false)
  })

  it('PUT /admin/public/enabled takes a boolean only', async () => {
    const off = await h.adm('PUT', '/admin/public/enabled', { enabled: false })
    expect(off.status).toBe(200)
    expect((await json<PublicStatus>(off)).enabled).toBe(false)
    expect((await json<PublicStatus>(await h.adm('PUT', '/admin/public/enabled', { enabled: true }))).enabled).toBe(true)
    for (const bad of [{}, { enabled: 'false' }, { enabled: 0 }, { enabled: null }, { enabled: true, x: 1 }]) {
      expect((await h.adm('PUT', '/admin/public/enabled', bad)).status, JSON.stringify(bad)).toBe(400)
    }
    expect((await h.db.select().from(siteSettings).where(eq(siteSettings.key, 'public_results_enabled')))[0].value).toBe('true')
  })

  it('the switch is not part of /admin/settings (that shape does not change)', async () => {
    const res = await h.adm('GET', '/admin/settings')
    expect(Object.keys(await json<object>(res)).sort()).toEqual(['contactLineId', 'contactLineUrl', 'contactTelegramId', 'contactTelegramUrl', 'renderLimitDefault', 'testsiteEnabled'])
  })

  it('POST /admin/public/publish with rebuild marks everything and counts a version; each call runs one bounded pass', async () => {
    at()
    const first = await h.adm('POST', '/admin/public/publish', { rebuild: true })
    expect(first.status).toBe(200)
    const a = await json<PublicStatus & { run: { status: string; written: string[]; more: boolean } }>(first)
    expect(a).toMatchObject({ enabled: true, bucketBound: true, version: 1, publishedVersion: 0 })
    expect(a.run).toMatchObject({ status: 'published', more: true })
    expect(a.pending).toBeGreaterThan(70)
    let status = a
    for (let i = 0; i < 30 && status.pending > 0; i++) {
      status = await json(await h.adm('POST', '/admin/public/publish', {}))
    }
    expect(status).toMatchObject({ pending: 0, version: 1, publishedVersion: 1 })
    expect(h.bucket.keys().filter((k) => k.startsWith('v1/lottery/'))).toHaveLength(82)
    // nothing left: the next call is idle
    expect((await json<{ run: { status: string } }>(await h.adm('POST', '/admin/public/publish', {}))).run.status).toBe('idle')
  })

  it('`passes` runs several passes in one call (local development) and stops when nothing is left', async () => {
    at()
    const res = await h.adm('POST', '/admin/public/publish', { rebuild: true, passes: 30 })
    const body = await json<PublicStatus & { passes: number; run: { status: string } }>(res)
    expect(body).toMatchObject({ pending: 0, version: 1, publishedVersion: 1, run: { status: 'published' } })
    expect(body.passes).toBeGreaterThanOrEqual(10)
    expect(body.passes).toBeLessThan(30)
    expect(h.bucket.keys().filter((k) => k.startsWith('v1/lottery/'))).toHaveLength(82)
    // without it one pass is run, and the answer says so
    expect((await json<{ passes: number }>(await h.adm('POST', '/admin/public/publish', {}))).passes).toBe(1)
    for (const bad of [0, 31, 1.5, '3', null]) {
      expect((await h.adm('POST', '/admin/public/publish', { passes: bad })).status, String(bad)).toBe(400)
    }
  })

  it('the body may be empty; rubbish in it is a 400', async () => {
    expect((await h.adm('POST', '/admin/public/publish', '')).status).toBe(200)
    for (const bad of ['not json', '[]', '"x"', JSON.stringify({ rebuild: 'yes' }), JSON.stringify({ other: 1 })]) {
      expect((await h.adm('POST', '/admin/public/publish', bad)).status, bad).toBe(400)
    }
  })

  it('without the bucket it only reports', async () => {
    const bare = { ...h.env, PUBLIC_RESULTS: undefined }
    const res = await h.call('POST', '/admin/public/publish', { cookie: h.admin, env: bare, body: { rebuild: true } })
    expect(res.status).toBe(200)
    expect(await json<{ bucketBound: boolean; run: { status: string } }>(res)).toMatchObject({ bucketBound: false, run: { status: 'no-bucket' } })
  })
})

// ---- the local read route -------------------------------------------------------------------------------------

describe('GET /public-data/* (local development)', () => {
  beforeEach(async () => {
    at()
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123', top2: '45', bottom2: '67' })
  })

  it('streams a published file with the stored content type and cache headers, an ETag and CORS *', async () => {
    const res = await h.call('GET', '/public-data/v1/today.json', { headers: { Origin: 'http://localhost:4000' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=10')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('etag')).toMatch(/^"etag-\d+"$/)
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(((await res.json()) as PublicTodayFile).v).toBe(1)
    for (const [path, cache] of [['v1/version.json', 'public, max-age=5'], ['v1/day/2026-11-19.json', 'public, max-age=60'], ['v1/lottery/hanoi-regular.json', 'public, max-age=60']] as const) {
      const r = await h.call('GET', `/public-data/${path}`)
      expect(r.status, path).toBe(200)
      expect(r.headers.get('cache-control'), path).toBe(cache)
    }
  })

  it('needs no login and no cookie, and a request from any origin is answered (no CSRF / CORS gate)', async () => {
    const res = await h.call('GET', '/public-data/v1/version.json', { headers: { Origin: 'http://evil.example' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('answers 304 to a matching If-None-Match', async () => {
    const first = await h.call('GET', '/public-data/v1/version.json')
    const etag = first.headers.get('etag')!
    const again = await h.call('GET', '/public-data/v1/version.json', { headers: { 'If-None-Match': etag } })
    expect(again.status).toBe(304)
    expect(await again.text()).toBe('')
    expect((await h.call('GET', '/public-data/v1/version.json', { headers: { 'If-None-Match': '"other"' } })).status).toBe(200)
  })

  it('is 404 for a file that is not there, for paths that are not a snapshot file and for traversal', async () => {
    for (const p of ['v1/day/2020-01-01.json', 'v1/lottery/nope.json', 'v1/other.json', 'v2/today.json', 'v1/lottery/..%2Fversion.json', 'v1/lottery/a/b.json', 'v1/today.json/', 'v1/day/2026-11-19', 'v1/', '', 'v1/lottery/hanoi-regular.json.bak', 'v1/TODAY.JSON']) {
      const r = await h.call('GET', `/public-data/${p}`)
      expect(r.status, p).toBe(404)
    }
    expect((await errorOf(await h.call('GET', '/public-data/v1/lottery/nope.json'))).error.code).toBe('NOT_FOUND')
  })

  it('never serves anything but the snapshot files: another object of the bucket is not reachable', async () => {
    await h.bucket.put('v1/private-note.txt', 'secret', {})
    await h.bucket.put('other/today.json', '{}', {})
    expect((await h.call('GET', '/public-data/v1/private-note.txt')).status).toBe(404)
    expect((await h.call('GET', '/public-data/other/today.json')).status).toBe(404)
  })

  it('does not exist in production: COOKIE_SECURE = "true" is a plain 404', async () => {
    const live = { ...h.env, COOKIE_SECURE: 'true' }
    const res = await h.call('GET', '/public-data/v1/today.json', { env: live })
    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('is a 404 without the bucket binding', async () => {
    const res = await h.call('GET', '/public-data/v1/today.json', { env: { ...h.env, PUBLIC_RESULTS: undefined } })
    expect(res.status).toBe(404)
  })

  it('answers HEAD without a body', async () => {
    const res = await h.call('HEAD', '/public-data/v1/version.json')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('answers a preflight with CORS * locally and leaves it to the normal CORS rules in production', async () => {
    const res = await h.call('OPTIONS', '/public-data/v1/today.json', {
      headers: { Origin: 'http://localhost:4000', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'cache-control' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
    expect(res.headers.get('access-control-allow-headers')).toBe('cache-control')
    const live = await h.call('OPTIONS', '/public-data/v1/today.json', {
      env: { ...h.env, COOKIE_SECURE: 'true' },
      headers: { Origin: 'http://localhost:4000', 'Access-Control-Request-Method': 'GET' },
    })
    expect(live.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('POST and other methods are not served', async () => {
    expect((await h.call('POST', '/public-data/v1/today.json', { body: {} })).status).toBe(404)
    expect((await h.call('DELETE', '/public-data/v1/today.json')).status).toBe(404)
  })
})
