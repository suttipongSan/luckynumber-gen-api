// Lottery results: PUT /results (robot key or admin; insert, replace, validation, lookup of the
// lottery by id or exact name), GET /results (what a member may see), GET /admin/results and
// DELETE /results/:id, migrations 0008 and 0009 (the official results of a database that had them
// before the personal results came). The members' own results (PUT / DELETE /results/mine, which
// of the two a member reads) are in memberResults.test.ts. Real libSQL file DB with the project's
// migrations.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import app from '../src/index'
import type { AdminLottery, AdminLotteryResult, AdminMember, AssetBucket, Bindings, Lottery, MemberLotteryResult } from '../src/types'
import { hashPassword } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import { LOTTERY_CATALOG } from '../src/db/catalog'
import { lotteries, lotteryResults } from '../src/db/schema'
import { resolveResultLottery } from '../src/lib/results'
import { isCalendarDay } from '../src/lib/time'

// Everything in lib/results is the real code; the wrapper only lets one test make the lottery lookup
// answer with an id that has just been deleted (see "between the lookup and the write").
vi.mock('../src/lib/results', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/results')>()
  return { ...actual, resolveResultLottery: vi.fn(actual.resolveResultLottery) }
})

const DB_FILE = 'test-results.db'
const DB_URL = `file:${DB_FILE}`
const KEY = 'test-results-key-0123456789abcdef0123456789abcdef'

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
let alice: { id: string; cookie: string }
let bob: { id: string; cookie: string }

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

interface CallOpts {
  cookie?: string
  /** value of the X-API-Key header (an empty string sends an empty header) */
  key?: string
  body?: unknown
  headers?: Record<string, string>
  env?: Bindings
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
  return app.request(path, { method, headers, body: payload }, o.env ?? env)
}

/** PUT /results; the robot key by default. */
const put = (body: unknown, o: CallOpts = { key: KEY }) => call('PUT', '/results', { ...o, body })

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
async function newMember(name: string) {
  const res = await call('POST', '/admin/members', {
    cookie: admin,
    body: { displayName: name, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
  })
  const m = (await res.json()) as AdminMember
  const sp = await call('POST', `/link/${m.linkToken}/set-password`, { body: { password: 'password-123' } })
  expect(sp.status).toBe(204)
  return { id: m.id, cookie: cookieFrom(sp, 'ng_session') }
}

const allResults = () => getDb(env).select().from(lotteryResults)

/** Runs raw SQL on the test database through a second connection (triggers that simulate races). */
async function sqlite(statement: string) {
  const { client } = openDb(DB_URL)
  try {
    await client.execute(statement)
  } finally {
    client.close()
  }
}

const getMemberResults = async (cookie: string, date: string) => {
  const res = await call('GET', `/results?date=${date}`, { cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as { date: string; results: MemberLotteryResult[] }
}

const setActive = (id: string, active: boolean) =>
  getDb(env).update(lotteries).set({ active }).where(eq(lotteries.id, id))

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
})

beforeEach(async () => {
  await resetLimiter(getDb(env))
  // every test starts without results (the catalog and the members stay)
  await getDb(env).delete(lotteryResults)
})

afterAll(() => {
  try {
    removeDb()
  } catch {
    // file may still be held open on Windows; harmless
  }
})

/** Rows of a read-only (or scratch) statement on the test database, through a second connection. */
const query = async (sqlText: string) => {
  const { client } = openDb(DB_URL)
  try {
    return (await client.execute(sqlText)).rows
  } finally {
    client.close()
  }
}
const indexColumns = async (index: string) =>
  (await query(`pragma index_info('${index}')`)).map((r) => String(r.name))
const indexes = async (table: string) =>
  new Map((await query(`pragma index_list('${table}')`)).map((r) => [String(r.name), { unique: Number(r.unique) === 1, origin: String(r.origin) }]))

// ---- migration 0008 ------------------------------------------------------------------------------

describe('migration 0008', () => {
  it('is registered after 0007 in the journal, with a snapshot that chains to the previous one', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[]
    }
    const entry = journal.entries[8]
    expect(entry).toMatchObject({ idx: 8, tag: '0008_add_results_and_draws' })
    expect(entry.when).toBeGreaterThan(journal.entries[7].when)
    const snap = (n: string) => JSON.parse(readFileSync(`drizzle/meta/${n}_snapshot.json`, 'utf8')) as { id: string; prevId: string; tables: Record<string, unknown> }
    expect(snap('0008').prevId).toBe(snap('0007').id)
    expect(Object.keys(snap('0008').tables)).toEqual(expect.arrayContaining(['lottery_results', 'member_draws']))
  })

  it('creates lottery_results with the draw columns and a foreign key to lotteries (0009 adds member_id and changes the indexes)', async () => {
    const cols = new Map((await query('pragma table_info(lottery_results)')).map((r) => [String(r.name), r]))
    // the ten columns of 0008 come first, in order; migration 0009 appends member_id after them
    expect([...cols.keys()].slice(0, 10)).toEqual(['id', 'lottery_id', 'draw_date', 'draw_time', 'top3', 'top2', 'bottom2', 'source', 'created_at', 'updated_at'])
    for (const name of ['id', 'lottery_id', 'draw_date', 'draw_time', 'created_at', 'updated_at']) {
      expect(cols.get(name), name).toMatchObject({ type: 'TEXT', notnull: 1 })
    }
    for (const name of ['top3', 'top2', 'bottom2', 'source']) expect(cols.get(name), name).toMatchObject({ type: 'TEXT', notnull: 0 })
    expect(cols.get('id')).toMatchObject({ pk: 1 })
    const fks = await query('pragma foreign_key_list(lottery_results)')
    expect(fks.map((r) => [r.from, r.table, r.on_delete])).toEqual([['lottery_id', 'lotteries', 'CASCADE']])
  })

  it('creates member_draws: the key (member, scope, lottery, card date), one index for the read and a foreign key to members only', async () => {
    const cols = await query('pragma table_info(member_draws)')
    expect(cols.map((r) => [String(r.name), String(r.type), Number(r.notnull), Number(r.pk)])).toEqual([
      ['member_id', 'TEXT', 1, 1],
      ['scope', 'TEXT', 1, 2],
      ['lottery_id', 'TEXT', 1, 3],
      ['card_date', 'TEXT', 1, 4],
      ['numbers', 'TEXT', 1, 0],
      ['updated_at', 'TEXT', 1, 0],
    ])
    // The table is write-heavy and D1 counts every index entry as a row written, so besides the
    // primary key (the automatic index) there is exactly one index, the one of GET /draws; there is
    // no foreign key to lotteries (it would need an index of its own, see schema.ts).
    const idx = await indexes('member_draws')
    expect([...idx.keys()].sort()).toEqual(['member_draws_member_date_idx', 'sqlite_autoindex_member_draws_1'])
    expect(idx.get('member_draws_member_date_idx')).toMatchObject({ unique: false, origin: 'c' })
    expect(idx.get('sqlite_autoindex_member_draws_1')).toMatchObject({ unique: true, origin: 'pk' })
    expect(await indexColumns('member_draws_member_date_idx')).toEqual(['member_id', 'card_date', 'scope', 'lottery_id'])
    expect(await indexColumns('sqlite_autoindex_member_draws_1')).toEqual(['member_id', 'scope', 'lottery_id', 'card_date'])
    const fks = await query('pragma foreign_key_list(member_draws)')
    expect(fks.map((r) => [r.from, r.table, r.on_delete])).toEqual([['member_id', 'members', 'CASCADE']])
  })

  it('the database itself refuses a second row for the same draw (the upsert key is a unique index)', async () => {
    const insert = (id: string, time: string) =>
      query(
        `insert into lottery_results (id, lottery_id, draw_date, draw_time, top3, created_at, updated_at)
         values ('${id}', 'hanoi-regular', '2026-11-19', '${time}', '123', 'x', 'x')`,
      )
    await insert('a', '')
    await expect(insert('b', '')).rejects.toThrow(/UNIQUE/i)
    await insert('c', '09:00') // another time is another draw
    expect(await allResults()).toHaveLength(2)
  })
})

// ---- migration 0009 ------------------------------------------------------------------------------

describe('migration 0009', () => {
  // Every scenario that needs a database "before 0009" gets its own scratch file under one directory
  // in the OS temp dir: Windows keeps a SQLite file locked for a while after the client was closed,
  // so one file cannot be deleted and recreated (same approach as the migration 0007 tests in
  // articles.test.ts). The directory is cleared when the suite starts and, as far as the OS allows,
  // when it ends.
  const SCRATCH = join(tmpdir(), 'numbergen-api-test-migrations-results')
  let seq = 0
  const clearScratch = () => {
    try {
      rmSync(SCRATCH, { recursive: true, force: true })
    } catch {
      // still locked; it is in the temp dir and is cleared by the next run
    }
  }
  beforeAll(clearScratch)
  afterAll(clearScratch)

  const tmp = () => {
    const dir = join(SCRATCH, String(++seq))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** A copy of drizzle/ that stops after migration `last` (so a database can be built "before 0009"). */
  function migrationsUpTo(last: number): string {
    const dir = tmp()
    mkdirSync(join(dir, 'meta'))
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; tag: string }[]
    }
    journal.entries = journal.entries.filter((e) => e.idx <= last)
    writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(journal))
    for (const e of journal.entries) copyFileSync(join('drizzle', `${e.tag}.sql`), join(dir, `${e.tag}.sql`))
    return dir
  }

  async function exec(url: string, sqlText: string, args: (string | null)[] = []) {
    const { client } = openDb(url)
    try {
      return (await client.execute({ sql: sqlText, args })).rows
    } finally {
      client.close()
    }
  }

  // Three official results as migration 0008 stored them (no member_id column yet): a robot row with
  // a draw time, a row with only one number and no source, and a lottery that draws once a day.
  const OLD_ROWS: (string | null)[][] = [
    ['old-1', 'hanoi-regular', '2026-11-18', '', '123', '45', '67', 'robot-1', '2026-11-18T10:00:00.000Z', '2026-11-18T10:05:00.000Z'],
    ['old-2', 'hanoi-regular', '2026-11-19', '16:30', null, '12', null, null, '2026-11-19T09:00:00.000Z', '2026-11-19T09:00:00.000Z'],
    ['old-3', 'dow-jones', '2026-11-19', '', '000', null, '99', 'manual', '2026-11-19T09:30:00.000Z', '2026-11-19T09:45:00.000Z'],
  ]
  const COLUMNS = ['id', 'lottery_id', 'draw_date', 'draw_time', 'top3', 'top2', 'bottom2', 'source', 'created_at', 'updated_at']

  /** A new database with migrations 0000..0008 applied and the OLD_ROWS in it, like production before this deploy. */
  async function before0009(): Promise<string> {
    const url = `file:${join(tmp(), 'before-0009.db').split('\\').join('/')}`
    await runMigrations(url, migrationsUpTo(8))
    const cols = await exec(url, 'pragma table_info(lottery_results)')
    expect(cols.map((r) => String(r.name))).toEqual(COLUMNS) // really the 0008 table
    await exec(
      url,
      `insert into lotteries (id, name, short_name, group_key, accent)
       values ('hanoi-regular', 'ฮานอย ปกติ', 'ฮานอยปกติ', 'hanoi', '#be123c'), ('dow-jones', 'ดาวโจนส์', 'ดาวโจนส์', 'stock', '#1e3a8a')`,
    )
    for (const row of OLD_ROWS) {
      await exec(url, `insert into lottery_results (${COLUMNS.join(', ')}) values (${COLUMNS.map(() => '?').join(', ')})`, row)
    }
    return url
  }

  it('is registered after 0008 in the journal, with a snapshot that chains to the previous one', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[]
    }
    const entry = journal.entries[9]
    expect(entry).toMatchObject({ idx: 9, tag: '0009_add_personal_results' })
    expect(entry.when).toBeGreaterThan(journal.entries[8].when)
    const snap = (n: string) =>
      JSON.parse(readFileSync(`drizzle/meta/${n}_snapshot.json`, 'utf8')) as {
        id: string
        prevId: string
        tables: { lottery_results: { columns: Record<string, unknown>; indexes: Record<string, { columns: string[]; isUnique: boolean }> } }
      }
    expect(snap('0009').prevId).toBe(snap('0008').id)
    const table = snap('0009').tables.lottery_results
    expect(Object.keys(table.columns)).toContain('member_id')
    expect(table.indexes.lottery_results_draw_unique_idx).toMatchObject({ columns: ['lottery_id', 'draw_date', 'draw_time', 'member_id'], isUnique: true })
    expect(table.indexes.lottery_results_member_date_idx).toMatchObject({ columns: ['member_id', 'draw_date'], isUnique: false })
    expect(Object.keys(table.indexes).sort()).toEqual(['lottery_results_draw_unique_idx', 'lottery_results_member_date_idx'])
  })

  it('leaves lottery_results with member_id (TEXT NOT NULL DEFAULT empty) and the two indexes of 0009 plus the primary key (and the one of 0010)', async () => {
    const cols = new Map((await query('pragma table_info(lottery_results)')).map((r) => [String(r.name), r]))
    expect(cols.get('member_id')).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 })
    const idx = await indexes('lottery_results')
    // lottery_results_official_idx is migration 0010's (the public results snapshots; see publicAdmin.test.ts)
    expect([...idx.keys()].sort()).toEqual(['lottery_results_draw_unique_idx', 'lottery_results_member_date_idx', 'lottery_results_official_idx', 'sqlite_autoindex_lottery_results_1'])
    expect(idx.get('lottery_results_draw_unique_idx')).toMatchObject({ unique: true, origin: 'c' })
    expect(await indexColumns('lottery_results_draw_unique_idx')).toEqual(['lottery_id', 'draw_date', 'draw_time', 'member_id'])
    expect(idx.get('lottery_results_member_date_idx')).toMatchObject({ unique: false, origin: 'c' })
    expect(await indexColumns('lottery_results_member_date_idx')).toEqual(['member_id', 'draw_date'])
    expect(idx.get('sqlite_autoindex_lottery_results_1')).toMatchObject({ unique: true, origin: 'pk' })
    // no foreign key on member_id: '' (an official result) is no member, so the member delete removes the rows itself
    const fks = await query('pragma foreign_key_list(lottery_results)')
    expect(fks.map((r) => [r.from, r.table, r.on_delete])).toEqual([['lottery_id', 'lotteries', 'CASCADE']])
  })

  it('the one index serves every reader: the member read, the back office list and the delete of a member rows', async () => {
    const plan = async (sqlText: string) => (await query(`explain query plan ${sqlText}`)).map((r) => String(r.detail)).join('\n')
    const usesIndex = (name: string) => new RegExp(`SEARCH lottery_results USING (COVERING )?INDEX ${name} `)
    expect(await plan("select * from lottery_results where draw_date = '2026-11-19' and member_id in ('', 'm1')")).toMatch(usesIndex('lottery_results_member_date_idx'))
    expect(await plan("select * from lottery_results where draw_date = '2026-11-19' and member_id = '' order by lottery_id, draw_time")).toMatch(usesIndex('lottery_results_member_date_idx'))
    expect(await plan("delete from lottery_results where member_id = 'm1'")).toMatch(usesIndex('lottery_results_member_date_idx'))
    // the key of the upsert is the unique index; the delete by lottery starts with lottery_id, which both the unique
    // index and (since migration 0010) lottery_results_official_idx do, so either one serves it
    expect(await plan("delete from lottery_results where lottery_id = 'hanoi-regular'")).toMatch(
      /SEARCH lottery_results USING (COVERING )?INDEX (lottery_results_draw_unique_idx|lottery_results_official_idx) /,
    )
    expect(
      await plan("select * from lottery_results where lottery_id = 'hanoi-regular' and draw_date = '2026-11-19' and draw_time = '' and member_id = 'm1'"),
    ).toMatch(usesIndex('lottery_results_draw_unique_idx'))
  })

  it('the database keeps one result per draw and kind: an official one and personal ones may sit side by side, never two alike', async () => {
    const insert = (id: string, memberId: string | null, time = '') =>
      query(
        memberId === null
          ? `insert into lottery_results (id, lottery_id, draw_date, draw_time, top3, created_at, updated_at)
             values ('${id}', 'hanoi-regular', '2026-11-19', '${time}', '123', 'x', 'x')`
          : `insert into lottery_results (id, lottery_id, draw_date, draw_time, member_id, top3, created_at, updated_at)
             values ('${id}', 'hanoi-regular', '2026-11-19', '${time}', '${memberId}', '123', 'x', 'x')`,
      )
    await insert('official', null) // a row that does not name a member is official
    await expect(insert('official-again', null)).rejects.toThrow(/UNIQUE/i)
    await expect(insert('official-explicit', '')).rejects.toThrow(/UNIQUE/i)
    await insert('alice', 'member-a')
    await insert('bob', 'member-b')
    await expect(insert('alice-again', 'member-a')).rejects.toThrow(/UNIQUE/i)
    await insert('alice-0900', 'member-a', '09:00') // another time is another draw
    expect((await allResults()).map((r) => `${r.id}|${r.memberId}|${r.drawTime}`).sort()).toEqual([
      'alice-0900|member-a|09:00',
      'alice|member-a|',
      'bob|member-b|',
      'official||',
    ])
    // NULL is no member: member_id is NOT NULL, so two NULLs can never slip past the unique index
    await expect(
      query(`insert into lottery_results (id, lottery_id, draw_date, draw_time, member_id, created_at, updated_at) values ('n', 'hanoi-regular', '2026-11-19', '', null, 'x', 'x')`),
    ).rejects.toThrow(/NOT NULL/i)
  })

  it('on a database that has official results from 0008 the rows survive untouched and are official', async () => {
    const url = await before0009()
    await runMigrations(url) // the real folder: applies only 0009
    const after = await exec(url, 'select * from lottery_results order by id')
    expect(after).toHaveLength(OLD_ROWS.length)
    for (const [i, row] of after.entries()) {
      for (const [c, name] of COLUMNS.entries()) expect(row[name], `${OLD_ROWS[i][0]}.${name}`).toEqual(OLD_ROWS[i][c])
      expect(row.member_id, `${OLD_ROWS[i][0]}.member_id`).toBe('')
    }
    // the new key works on them: the same draw typed by a member is a new row, the same official one is refused
    const insert = (id: string, memberId: string) =>
      exec(
        url,
        `insert into lottery_results (id, lottery_id, draw_date, draw_time, member_id, top3, created_at, updated_at)
         values (?, 'hanoi-regular', '2026-11-18', '', ?, '999', 'x', 'x')`,
        [id, memberId],
      )
    await insert('personal', 'member-a')
    await expect(insert('official-twin', '')).rejects.toThrow(/UNIQUE/i)
    await expect(insert('personal-twin', 'member-a')).rejects.toThrow(/UNIQUE/i)
    // migrating again changes nothing
    await runMigrations(url)
    expect(await exec(url, 'select count(*) as n from lottery_results')).toMatchObject([{ n: OLD_ROWS.length + 1 }])
  })

  it('works on an empty table too', async () => {
    const url = `file:${join(tmp(), 'empty-before-0009.db').split('\\').join('/')}`
    await runMigrations(url, migrationsUpTo(8))
    await runMigrations(url)
    expect(await exec(url, 'select count(*) as n from lottery_results')).toMatchObject([{ n: 0 }])
    expect((await exec(url, 'pragma table_info(lottery_results)')).map((r) => String(r.name))).toContain('member_id')
  })

  it('the API reads the old rows as official: the back office lists them, members read them as not mine, PUT /results replaces them in place', async () => {
    const url = await before0009()
    await runMigrations(url)
    const env2: Bindings = { ...env, TURSO_DATABASE_URL: url }

    const login = await call('POST', '/admin/login', { body: { username: 'admin', password: 'admin1234' }, env: env2 })
    expect(login.status).toBe(204)
    const adminCookie2 = cookieFrom(login, 'ng_admin')
    const created = await call('POST', '/admin/members', {
      cookie: adminCookie2,
      env: env2,
      body: { displayName: 'carol', expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
    })
    const carol = (await created.json()) as AdminMember
    const claimed = await call('POST', `/link/${carol.linkToken}/set-password`, { body: { password: 'password-123' }, env: env2 })
    expect(claimed.status).toBe(204)
    const carolCookie = cookieFrom(claimed, 'ng_session')

    const adminList = async (date: string) =>
      ((await (await call('GET', `/admin/results?date=${date}`, { cookie: adminCookie2, env: env2 })).json()) as { results: AdminLotteryResult[] }).results
    expect((await adminList('2026-11-19')).map((r) => r.id)).toEqual(['old-3', 'old-2'])
    expect((await adminList('2026-11-18')).map((r) => r.id)).toEqual(['old-1'])
    expect((await adminList('2026-11-19'))[1]).toMatchObject({ lotteryId: 'hanoi-regular', time: '16:30', top3: null, top2: '12', bottom2: null, source: null })

    const memberRead = async () =>
      ((await (await call('GET', '/results?date=2026-11-19', { cookie: carolCookie, env: env2 })).json()) as { results: MemberLotteryResult[] }).results
    expect(await memberRead()).toEqual([
      { lotteryId: 'dow-jones', date: '2026-11-19', time: '', top3: '000', top2: null, bottom2: '99', mine: false, official: null },
      { lotteryId: 'hanoi-regular', date: '2026-11-19', time: '16:30', top3: null, top2: '12', bottom2: null, mine: false, official: null },
    ])

    // the robot corrects the 16:30 draw: the old row is replaced in place (200, same id and created_at), not duplicated
    const robot = await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', time: '16:30', top3: '321', top2: '12' }, { key: KEY, env: env2 })
    expect(robot.status).toBe(200)
    expect(await robot.json()).toMatchObject({ id: 'old-2', createdAt: '2026-11-19T09:00:00.000Z', top3: '321', top2: '12', bottom2: null })
    expect(await adminList('2026-11-19')).toHaveLength(2)

    // a member now types their own result of the same draw: a row of its own next to the official one
    const mine = await call('PUT', '/results/mine', { cookie: carolCookie, env: env2, body: { lotteryId: 'hanoi-regular', date: '2026-11-19', time: '16:30', bottom2: '77' } })
    expect(mine.status).toBe(201)
    expect((await memberRead())[1]).toMatchObject({ lotteryId: 'hanoi-regular', mine: true, bottom2: '77', top3: null, official: { time: '16:30', top3: '321', top2: '12', bottom2: null } })
    const rows = await exec(url, "select id, member_id from lottery_results where draw_date = '2026-11-19' order by member_id, id")
    expect(rows.map((r) => `${r.id === 'old-2' || r.id === 'old-3' ? r.id : 'new'}|${r.member_id === '' ? 'official' : 'carol'}`)).toEqual(['old-2|official', 'old-3|official', 'new|carol'])
    expect(await adminList('2026-11-19')).toHaveLength(2) // the back office still sees only the official ones
    expect((await call('DELETE', '/results/old-3', { cookie: adminCookie2, env: env2 })).status).toBe(204)
  })
})

// ---- upsert and replace --------------------------------------------------------------------------

describe('PUT /results: insert and replace', () => {
  it('stores a result (201) and answers the stored row', async () => {
    const res = await put({
      lotteryId: 'hanoi-regular',
      date: '2026-11-19',
      time: '16:30',
      top3: '042',
      top2: '57',
      bottom2: '08',
      source: 'robot-1',
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as AdminLotteryResult
    expect(body).toEqual({
      id: expect.stringMatching(/^[0-9A-Za-z]{16}$/),
      lotteryId: 'hanoi-regular',
      date: '2026-11-19',
      time: '16:30',
      top3: '042',
      top2: '57',
      bottom2: '08',
      source: 'robot-1',
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
      updatedAt: body.createdAt,
    })
    const rows = await allResults()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: body.id,
      lotteryId: 'hanoi-regular',
      drawDate: '2026-11-19',
      drawTime: '16:30',
      memberId: '', // an official result, whoever sent it
      top3: '042',
      top2: '57',
      bottom2: '08',
      source: 'robot-1',
      createdAt: body.createdAt,
      updatedAt: body.updatedAt,
    })
  })

  it('a second PUT for the same draw replaces it (200): same id and createdAt, one row', async () => {
    const first = (await (
      await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123', top2: '45', bottom2: '67', source: 'a' })
    ).json()) as AdminLotteryResult
    await new Promise((r) => setTimeout(r, 5))
    const res = await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '999', top2: '98', bottom2: '97', source: 'b' })
    expect(res.status).toBe(200)
    const second = (await res.json()) as AdminLotteryResult
    expect(second).toMatchObject({ id: first.id, createdAt: first.createdAt, top3: '999', top2: '98', bottom2: '97', source: 'b' })
    expect(second.updatedAt > first.updatedAt).toBe(true)
    const rows = await allResults()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: first.id, top3: '999', top2: '98', bottom2: '97', source: 'b', updatedAt: second.updatedAt })
  })

  it('replace means the stored draw becomes what was sent: a number that is left out is cleared', async () => {
    await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123', top2: '45', bottom2: '67', source: 'a' })
    const res = await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', bottom2: '10' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ top3: null, top2: null, bottom2: '10', source: null })
    expect(await allResults()).toHaveLength(1)
    // null means "not given" as well, and a blank source is no source
    const nulls = await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '321', top2: null, bottom2: null, source: '  ' })
    expect(await nulls.json()).toMatchObject({ top3: '321', top2: null, bottom2: null, source: null })
  })

  it('a result may hold just one of the three numbers', async () => {
    for (const [field, value, time] of [
      ['top3', '000', ''],
      ['top2', '00', '10:00'],
      ['bottom2', '99', '11:00'],
    ] as const) {
      const res = await put({ lotteryId: 'dow-jones', date: '2026-11-19', time, [field]: value })
      expect(res.status, field).toBe(201)
      expect(await res.json()).toMatchObject({ top3: null, top2: null, bottom2: null, [field]: value })
    }
  })

  it('keeps leading zeros (the numbers are strings)', async () => {
    const res = await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '007', top2: '05', bottom2: '00' })
    expect(await res.json()).toMatchObject({ top3: '007', top2: '05', bottom2: '00' })
    expect((await getMemberResults(alice.cookie, '2026-11-19')).results[0]).toMatchObject({ top3: '007', top2: '05', bottom2: '00' })
  })

  it('the draw is (lottery, date, time): another time, date or lottery is another row', async () => {
    const base = { top2: '12' }
    const make = async (extra: Record<string, unknown>) => {
      const res = await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', ...base, ...extra })
      return res.status
    }
    expect(await make({})).toBe(201) // time omitted = ''
    expect(await make({ time: '' })).toBe(200) // '' is the same draw
    expect(await make({ time: null })).toBe(200) // null too
    expect(await make({ time: '09:00' })).toBe(201)
    expect(await make({ time: '16:30' })).toBe(201)
    expect(await make({ time: '16:30' })).toBe(200)
    expect(await make({ date: '2026-11-20' })).toBe(201)
    expect((await put({ lotteryId: 'hanoi-vip', date: '2026-11-19', ...base })).status).toBe(201)
    const rows = await allResults()
    expect(rows).toHaveLength(5)
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
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: `${i}${i}${i}` })),
      )
    ).map((r) => r.status)
    expect(statuses.filter((s) => s === 201)).toHaveLength(1)
    expect(statuses.filter((s) => s === 200)).toHaveLength(5)
    const rows = await allResults()
    expect(rows).toHaveLength(1)
    expect(rows[0].top3).toMatch(/^(\d)\1\1$/)
  })

  it('source is up to 200 characters, trimmed', async () => {
    const ok = await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top2: '12', source: `  ${'x'.repeat(200)}  ` })
    expect(((await ok.json()) as AdminLotteryResult).source).toBe('x'.repeat(200))
    const long = await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top2: '12', source: 'x'.repeat(201) })
    expect(long.status).toBe(400)
  })
})

// ---- validation ----------------------------------------------------------------------------------

describe('PUT /results: validation', () => {
  const good = { lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123', top2: '45', bottom2: '67' }
  const errorOf = async (body: unknown) => {
    const res = await put(body)
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
    expect(await allResults()).toHaveLength(0)
  })

  it('needs at least one of top3 / top2 / bottom2', async () => {
    await errorOf({ lotteryId: 'hanoi-regular', date: '2026-11-19' })
    await errorOf({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: null, top2: null, bottom2: null })
    expect(await allResults()).toHaveLength(0)
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
  ])('refuses date = %j', async (date) => {
    const { date: _drop, ...rest } = good
    void _drop
    await errorOf(date === undefined ? rest : { ...rest, date })
    expect(await allResults()).toHaveLength(0)
  })

  it('accepts a real leap day', async () => {
    // a past one: since the future-date guard (see publicAdmin.test.ts) a draw more than a day ahead is refused
    expect((await put({ ...good, date: '2024-02-29' })).status).toBe(201)
  })

  it.each([['24:00'], ['9:30'], ['09:5'], ['16:60'], ['16:30:00'], ['1630'], ['16-30'], ['abc'], [' 16:30'], ['16:30 '], ['4:30pm'], [1630], [true]])(
    'refuses time = %j',
    async (time) => {
      const message = await errorOf({ ...good, time })
      expect(message).toContain('time')
      expect(await allResults()).toHaveLength(0)
    },
  )

  it.each([['00:00'], ['00:01'], ['09:05'], ['12:00'], ['23:59']])('accepts time = %s', async (time) => {
    const res = await put({ ...good, time })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ time })
  })

  it('needs exactly one of lotteryId / lotteryName', async () => {
    const { lotteryId: _id, ...noLottery } = good
    void _id
    await errorOf(noLottery)
    await errorOf({ ...noLottery, lotteryId: null })
    await errorOf({ ...noLottery, lotteryId: '' })
    await errorOf({ ...noLottery, lotteryName: '   ' })
    await errorOf({ ...noLottery, lotteryName: '' })
    await errorOf({ ...noLottery, lotteryId: 'hanoi-regular', lotteryName: 'ฮานอย ปกติ' })
    await errorOf({ ...noLottery, lotteryId: 42 })
    await errorOf({ ...noLottery, lotteryName: 42 })
    await errorOf({ ...noLottery, lotteryName: 'x'.repeat(81) })
    expect(await allResults()).toHaveLength(0)
    // a null for the one that is not used is fine
    expect((await put({ ...noLottery, lotteryId: 'hanoi-regular', lotteryName: null })).status).toBe(201)
  })

  it('refuses unknown fields instead of dropping them silently', async () => {
    const message = await errorOf({ ...good, bottom_2: '67' })
    expect(message).toContain('bottom_2')
    await errorOf({ ...good, draw_date: '2026-11-19' })
    expect(await allResults()).toHaveLength(0)
  })

  it('refuses a body that is not a JSON object', async () => {
    // strings are sent as they are, so these are raw request bodies
    for (const body of ['not json', '[]', 'null', '"text"', '42', '']) {
      const res = await put(body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    expect(await allResults()).toHaveLength(0)
  })

  it('checks the body before looking up the lottery', async () => {
    // a bad digit and an unknown lottery: the validation error wins (400, not 404)
    const res = await put({ ...good, lotteryId: 'nope', top3: '12' })
    expect(res.status).toBe(400)
  })
})

describe('unit: isCalendarDay', () => {
  it('accepts only real days written YYYY-MM-DD', () => {
    for (const ok of ['2026-11-19', '2028-02-29', '2000-02-29', '1000-01-01', '9999-12-31', '2026-12-31']) {
      expect(isCalendarDay(ok), ok).toBe(true)
    }
    for (const bad of ['', '2026-02-29', '2100-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '2026-1-1', '26-01-01', '0999-12-31', '2026-01-01T00:00', ' 2026-01-01', '2026-01-01 ', '٢٠٢٦-٠١-٠١', 'abcd-ef-gh']) {
      expect(isCalendarDay(bad), bad).toBe(false)
    }
  })
})

// ---- which lottery -------------------------------------------------------------------------------

describe('PUT /results: the lottery by id or exact name', () => {
  const draw = { date: '2026-11-19', top3: '123', top2: '45', bottom2: '67' }

  it('finds a catalog lottery by its exact name', async () => {
    const res = await put({ lotteryName: 'ฮานอย ปกติ', ...draw })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ lotteryId: 'hanoi-regular' })
    // the same draw by id is the same row
    const again = await put({ lotteryId: 'hanoi-regular', ...draw, top3: '999' })
    expect(again.status).toBe(200)
    expect(await allResults()).toHaveLength(1)
    // surrounding whitespace in the request is ignored, the name itself must match exactly
    expect((await put({ lotteryName: '  ฮานอย ปกติ\n', ...draw })).status).toBe(200)
    expect((await put({ lotteryName: 'ดาวโจนส์ VIP', ...draw })).status).toBe(201)
    expect((await allResults()).map((r) => r.lotteryId).sort()).toEqual(['dow-jones-vip', 'hanoi-regular'])
  })

  it.each([
    ['ฮานอย'], // part of a name
    ['ฮานอยปกติ'], // the short name
    ['ฮานอย  ปกติ'], // double space inside
    ['hanoi-regular'], // an id is not a name
    ['ดาวโจนส์ vip'], // other case
    ['ไม่มีหวยนี้'],
  ])('unknown name %j: 404 LOTTERY_NOT_FOUND and nothing is stored', async (name) => {
    const res = await put({ lotteryName: name, ...draw })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'LOTTERY_NOT_FOUND', message: expect.any(String) } })
    expect(await allResults()).toHaveLength(0)
  })

  it('unknown id: 404 LOTTERY_NOT_FOUND and nothing is stored', async () => {
    const res = await put({ lotteryId: 'no-such-lottery', ...draw })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'LOTTERY_NOT_FOUND' } })
    expect(await allResults()).toHaveLength(0)
  })

  it('a name that two catalog lotteries share is ambiguous (409 LOTTERY_AMBIGUOUS); the id still works', async () => {
    const twin = await call('POST', '/admin/lotteries', {
      cookie: admin,
      body: { name: 'ฮานอย ปกติ', shortName: 'ฮานอยปกติ2', group: 'hanoi', accent: '#be123c', sortOrder: 9999, active: true },
    })
    expect(twin.status).toBe(200)
    const twinId = ((await twin.json()) as AdminLottery).id
    try {
      const res = await put({ lotteryName: 'ฮานอย ปกติ', ...draw })
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: { code: 'LOTTERY_AMBIGUOUS', message: expect.stringContaining('lotteryId') } })
      expect(await allResults()).toHaveLength(0)
      expect((await put({ lotteryId: twinId, ...draw })).status).toBe(201)
      expect((await put({ lotteryId: 'hanoi-regular', ...draw })).status).toBe(201)
    } finally {
      expect((await call('DELETE', `/admin/lotteries/${twinId}`, { cookie: admin })).status).toBe(204)
    }
    // the twin's result went with it, and the name is unique again
    expect((await allResults()).map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
    expect((await put({ lotteryName: 'ฮานอย ปกติ', ...draw })).status).toBe(200)
  })

  it("a member's own lottery has no results: not by id, and its name does not make a catalog name ambiguous", async () => {
    const mine = await call('POST', '/lotteries', { cookie: alice.cookie, body: { name: 'ฮานอย ปกติ', group: 'hanoi' } })
    expect(mine.status).toBe(200)
    const own = (await mine.json()) as Lottery
    const solo = await call('POST', '/lotteries', { cookie: alice.cookie, body: { name: 'หวยของอลิซ', group: 'other' } })
    const soloId = ((await solo.json()) as Lottery).id
    try {
      const byId = await put({ lotteryId: own.id, ...draw })
      expect(byId.status).toBe(404)
      expect(await byId.json()).toMatchObject({ error: { code: 'LOTTERY_NOT_FOUND' } })
      expect((await put({ lotteryName: 'หวยของอลิซ', ...draw })).status).toBe(404)
      // the catalog lottery with the same name is still found
      const byName = await put({ lotteryName: 'ฮานอย ปกติ', ...draw })
      expect(byName.status).toBe(201)
      expect(await byName.json()).toMatchObject({ lotteryId: 'hanoi-regular' })
      expect(await allResults()).toHaveLength(1)
    } finally {
      await call('DELETE', `/lotteries/${own.id}`, { cookie: alice.cookie })
      await call('DELETE', `/lotteries/${soloId}`, { cookie: alice.cookie })
    }
  })

  it('a catalog lottery that is switched off can still be given a result', async () => {
    await setActive('hanoi-vip', false)
    try {
      expect((await put({ lotteryId: 'hanoi-vip', ...draw })).status).toBe(201)
      expect((await put({ lotteryName: 'ฮานอย VIP', ...draw })).status).toBe(200)
      expect(await allResults()).toHaveLength(1)
    } finally {
      await setActive('hanoi-vip', true)
    }
  })

  it('a lottery that is deleted by someone else between the lookup and the write is 404, not a 500', async () => {
    // The first lookup answers with an id that is gone by the time of the insert, exactly what an
    // admin deleting the lottery in between would cause: the FOREIGN KEY of the insert fails and the
    // route looks the lottery up again (the real lookup, which finds nothing).
    vi.mocked(resolveResultLottery).mockImplementationOnce(async () => 'deleted-meanwhile')
    const res = await put({ lotteryId: 'hanoi-regular', ...draw })
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'LOTTERY_NOT_FOUND', message: expect.stringContaining('deleted-meanwhile') } })
    expect(await allResults()).toHaveLength(0)
    // the stub was used up: the next request resolves the lottery for real
    expect((await put({ lotteryId: 'hanoi-regular', ...draw })).status).toBe(201)
  })

  it('any other failure of the write is a real error (500 INTERNAL), not a made-up 404', async () => {
    await sqlite(
      `CREATE TRIGGER boom BEFORE INSERT ON lottery_results WHEN NEW.draw_date = '2025-12-31'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    )
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await put({ lotteryId: 'hanoi-regular', ...draw, date: '2025-12-31' })
      expect(res.status).toBe(500)
      expect(await res.json()).toMatchObject({ error: { code: 'INTERNAL' } })
    } finally {
      log.mockRestore()
      await sqlite('DROP TRIGGER boom')
    }
    expect(await allResults()).toHaveLength(0)
    // and the endpoint works again once the cause is gone
    expect((await put({ lotteryId: 'hanoi-regular', ...draw, date: '2025-12-31' })).status).toBe(201)
  })
})

// ---- who may write -------------------------------------------------------------------------------

describe('PUT /results: the API key or an admin', () => {
  const body = { lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123' }
  const refused = async (res: Response) => {
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED', message: expect.any(String) } })
    expect(await allResults()).toHaveLength(0)
  }

  it('the key alone is enough (no cookie, no Origin)', async () => {
    const res = await put(body, { key: KEY })
    expect(res.status).toBe(201)
    // header names are case-insensitive
    const lower = await call('PUT', '/results', { headers: { 'x-api-key': KEY }, body })
    expect(lower.status).toBe(200)
  })

  it('a signed-in admin is enough (no key)', async () => {
    const res = await put(body, { cookie: admin })
    expect(res.status).toBe(201)
    // a wrong key does not matter when the admin cookie is good
    expect((await put(body, { cookie: admin, key: 'wrong' })).status).toBe(200)
  })

  it('neither: 401', async () => {
    await refused(await put(body, {}))
  })

  it('a wrong key: 401, whatever is different about it', async () => {
    for (const key of [
      'wrong',
      '',
      ' ',
      KEY.slice(0, -1), // one character short
      `${KEY}x`, // one too long
      `${KEY.slice(0, -1)}${KEY.endsWith('f') ? 'e' : 'f'}`, // last character differs
      KEY.toUpperCase(),
    ]) {
      const res = await put(body, { key })
      expect(res.status, JSON.stringify(key)).toBe(401)
    }
    expect(await allResults()).toHaveLength(0)
  })

  it('the key must be in X-API-Key: Authorization and query strings do not count', async () => {
    await refused(await call('PUT', '/results', { headers: { Authorization: `Bearer ${KEY}` }, body }))
    await refused(await call('PUT', `/results?key=${KEY}&api_key=${KEY}`, { body }))
    await refused(await call('PUT', '/results', { headers: { 'X-Api-Token': KEY }, body }))
  })

  it('a member session is not a writer, with or without a wrong key', async () => {
    await refused(await put(body, { cookie: alice.cookie }))
    await refused(await put(body, { cookie: alice.cookie, key: 'wrong' }))
  })

  it('refuses everything while the secret is unset (an empty header is not equal to an empty secret)', async () => {
    const { RESULTS_API_KEY: _drop, ...rest } = env
    void _drop
    const unset: Bindings = rest
    for (const key of [KEY, 'anything', '', ' ', 'undefined']) {
      const res = await put(body, { key, env: unset })
      expect(res.status, JSON.stringify(key)).toBe(401)
    }
    expect((await put(body, { env: unset })).status).toBe(401)
    for (const secret of ['', '   ', '\t\n']) {
      for (const key of ['', ' ', secret, KEY]) {
        const res = await put(body, { key, env: { ...env, RESULTS_API_KEY: secret } })
        expect(res.status, `secret ${JSON.stringify(secret)} key ${JSON.stringify(key)}`).toBe(401)
      }
    }
    expect(await allResults()).toHaveLength(0)
    // an admin can still write: only the key path is closed
    expect((await put(body, { cookie: admin, env: unset })).status).toBe(201)
  })

  it('a configured secret is compared after trimming it, so a stray newline from `secret put` does not lock the robot out', async () => {
    const res = await put(body, { key: KEY, env: { ...env, RESULTS_API_KEY: `${KEY}\n` } })
    expect(res.status).toBe(201)
  })

  it('from a foreign Origin a write is 403 even with the key (the robot sends no Origin); an allowed Origin passes', async () => {
    const forged = await put(body, { key: KEY, headers: { Origin: 'https://evil.example' } })
    expect(forged.status).toBe(403)
    expect(await allResults()).toHaveLength(0)
    const ok = await put(body, { cookie: admin, headers: { Origin: 'http://localhost:5173' } })
    expect(ok.status).toBe(201)
    const forgedAdmin = await put({ ...body, top3: '999' }, { cookie: admin, headers: { Origin: 'https://evil.example' } })
    expect(forgedAdmin.status).toBe(403)
    expect((await allResults())[0].top3).toBe('123')
  })
})

// ---- GET /results (member) -----------------------------------------------------------------------

describe('GET /results', () => {
  const seed = async () => {
    for (const r of [
      { lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123', top2: '45', bottom2: '67', source: 'secret-source' },
      { lotteryId: 'dow-jones', date: '2026-11-19', time: '21:00', top2: '08' },
      { lotteryId: 'dow-jones', date: '2026-11-19', time: '09:00', top2: '11' },
      { lotteryId: 'dow-jones', date: '2026-11-19', time: '', top3: '555' },
      { lotteryId: 'hanoi-regular', date: '2026-11-20', top3: '777' },
    ]) {
      expect((await put(r)).status).toBe(201)
    }
  }

  it('lists the results of the date, by lottery then draw time, in the member shape', async () => {
    await seed()
    const body = await getMemberResults(alice.cookie, '2026-11-19')
    expect(body.date).toBe('2026-11-19')
    // every row says whose it is: official results are `mine: false` and hide nothing (`official: null`)
    expect(body.results).toEqual([
      { lotteryId: 'dow-jones', date: '2026-11-19', time: '', top3: '555', top2: null, bottom2: null, mine: false, official: null },
      { lotteryId: 'dow-jones', date: '2026-11-19', time: '09:00', top3: null, top2: '11', bottom2: null, mine: false, official: null },
      { lotteryId: 'dow-jones', date: '2026-11-19', time: '21:00', top3: null, top2: '08', bottom2: null, mine: false, official: null },
      { lotteryId: 'hanoi-regular', date: '2026-11-19', time: '', top3: '123', top2: '45', bottom2: '67', mine: false, official: null },
    ])
    // members never get the id, the source, the timestamps or a member id
    const raw = await (await call('GET', '/results?date=2026-11-19', { cookie: alice.cookie })).text()
    expect(raw).not.toContain('secret-source')
    expect(raw).not.toContain('createdAt')
    expect(raw).not.toContain('"id"')
    expect(raw).not.toMatch(/member/i)
    expect((await getMemberResults(alice.cookie, '2026-11-20')).results).toEqual([
      { lotteryId: 'hanoi-regular', date: '2026-11-20', time: '', top3: '777', top2: null, bottom2: null, mine: false, official: null },
    ])
  })

  it('answers an empty list for a date without results', async () => {
    await seed()
    expect(await getMemberResults(alice.cookie, '2026-11-21')).toEqual({ date: '2026-11-21', results: [] })
  })

  it('every member sees the same results', async () => {
    await seed()
    expect(await getMemberResults(bob.cookie, '2026-11-19')).toEqual(await getMemberResults(alice.cookie, '2026-11-19'))
  })

  it('hides the results of a lottery that is switched off, and shows them again when it is on', async () => {
    await seed()
    await setActive('dow-jones', false)
    try {
      const hidden = await getMemberResults(alice.cookie, '2026-11-19')
      expect(hidden.results.map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
      // the back office still sees everything
      const adminList = await call('GET', '/admin/results?date=2026-11-19', { cookie: admin })
      expect(((await adminList.json()) as { results: unknown[] }).results).toHaveLength(4)
    } finally {
      await setActive('dow-jones', true)
    }
    expect((await getMemberResults(alice.cookie, '2026-11-19')).results).toHaveLength(4)
  })

  it('needs a valid date', async () => {
    for (const q of ['', '?date=', '?date=2026-02-30', '?date=19-11-2026', '?date=2026-11-19T00:00', '?day=2026-11-19', '?date=2026-11-19x']) {
      const res = await call('GET', `/results${q}`, { cookie: alice.cookie })
      expect(res.status, q).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
  })

  it('needs a member session: 401 without one (an admin cookie or the key do not count), 403 when expired or disabled', async () => {
    const path = '/results?date=2026-11-19'
    expect((await call('GET', path)).status).toBe(401)
    expect((await call('GET', path, { cookie: admin })).status).toBe(401)
    expect((await call('GET', path, { key: KEY })).status).toBe(401)
    // a damaged cookie (its signature is hex: change the last digit for sure)
    expect((await call('GET', path, { cookie: alice.cookie.slice(0, -1) + (alice.cookie.endsWith('0') ? '1' : '0') })).status).toBe(401)

    const carol = await newMember('carol')
    const patch = (b: unknown) => call('PATCH', `/admin/members/${carol.id}`, { cookie: admin, body: b })
    await patch({ disabled: true })
    const disabled = await call('GET', path, { cookie: carol.cookie })
    expect(disabled.status).toBe(403)
    expect(await disabled.json()).toMatchObject({ error: { code: 'DISABLED' } })
    await patch({ disabled: false, expiresAt: new Date(Date.now() - 1000).toISOString() })
    const expired = await call('GET', path, { cookie: carol.cookie })
    expect(expired.status).toBe(403)
    expect(await expired.json()).toMatchObject({ error: { code: 'EXPIRED' } })
  })

  it('a replaced result shows at once (no caching in the API)', async () => {
    await seed()
    await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '000' })
    const hanoi = (await getMemberResults(alice.cookie, '2026-11-19')).results.find((r) => r.lotteryId === 'hanoi-regular')
    expect(hanoi).toMatchObject({ top3: '000', top2: null, bottom2: null })
  })
})

// ---- GET /admin/results --------------------------------------------------------------------------

describe('GET /admin/results', () => {
  it('lists every result of the date with id, source and timestamps (the shape the form needs)', async () => {
    const a = (await (await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123', source: 'robot' })).json()) as AdminLotteryResult
    const b = (await (await put({ lotteryId: 'dow-jones', date: '2026-11-19', time: '21:00', top2: '08' })).json()) as AdminLotteryResult
    await put({ lotteryId: 'dow-jones', date: '2026-11-20', top2: '99' })
    const res = await call('GET', '/admin/results?date=2026-11-19', { cookie: admin })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ date: '2026-11-19', results: [b, a] })
    expect(((await (await call('GET', '/admin/results?date=2026-11-22', { cookie: admin })).json()) as { results: unknown[] }).results).toEqual([])
  })

  it('needs an admin session: not a member, not the key, not nothing', async () => {
    const path = '/admin/results?date=2026-11-19'
    expect((await call('GET', path)).status).toBe(401)
    expect((await call('GET', path, { cookie: alice.cookie })).status).toBe(401)
    expect((await call('GET', path, { key: KEY })).status).toBe(401)
  })

  it('needs a valid date', async () => {
    for (const q of ['', '?date=', '?date=2026-13-01', '?date=nope']) {
      const res = await call('GET', `/admin/results${q}`, { cookie: admin })
      expect(res.status, q).toBe(400)
    }
  })
})

// ---- DELETE /results/:id -------------------------------------------------------------------------

describe('DELETE /results/:id', () => {
  const draw = { lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123' }

  it('an admin deletes a result (204); it is gone for members and can be created again', async () => {
    const first = (await (await put(draw)).json()) as AdminLotteryResult
    expect((await getMemberResults(alice.cookie, '2026-11-19')).results).toHaveLength(1)
    const res = await call('DELETE', `/results/${first.id}`, { cookie: admin })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(await allResults()).toHaveLength(0)
    expect((await getMemberResults(alice.cookie, '2026-11-19')).results).toEqual([])
    const again = await put(draw)
    expect(again.status).toBe(201)
    expect(((await again.json()) as AdminLotteryResult).id).not.toBe(first.id)
  })

  it('deletes only that result', async () => {
    const a = (await (await put(draw)).json()) as AdminLotteryResult
    await put({ ...draw, time: '09:00' })
    await put({ ...draw, lotteryId: 'hanoi-vip' })
    expect((await call('DELETE', `/results/${a.id}`, { cookie: admin })).status).toBe(204)
    expect((await allResults()).map((r) => `${r.lotteryId}|${r.drawTime}`).sort()).toEqual(['hanoi-regular|09:00', 'hanoi-vip|'])
  })

  it('an unknown or already deleted id is 404', async () => {
    const first = (await (await put(draw)).json()) as AdminLotteryResult
    expect((await call('DELETE', `/results/${first.id}`, { cookie: admin })).status).toBe(204)
    const again = await call('DELETE', `/results/${first.id}`, { cookie: admin })
    expect(again.status).toBe(404)
    expect(await again.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect((await call('DELETE', '/results/nope', { cookie: admin })).status).toBe(404)
  })

  it('admin only: the key, a member and a stranger get 401 and the result stays', async () => {
    const first = (await (await put(draw)).json()) as AdminLotteryResult
    const path = `/results/${first.id}`
    expect((await call('DELETE', path, { key: KEY })).status).toBe(401)
    expect((await call('DELETE', path, { cookie: alice.cookie })).status).toBe(401)
    expect((await call('DELETE', path)).status).toBe(401)
    // not even from a foreign Origin with the admin cookie
    expect((await call('DELETE', path, { cookie: admin, headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    expect(await allResults()).toHaveLength(1)
  })
})

// ---- deleting a lottery --------------------------------------------------------------------------

describe('deleting a catalog lottery', () => {
  it('removes its results with it', async () => {
    const created = await call('POST', '/admin/lotteries', {
      cookie: admin,
      body: { name: 'หวยทดสอบผล', shortName: 'ทดสอบผล', group: 'other', accent: '#4c1d95', sortOrder: 9997, active: true },
    })
    const id = ((await created.json()) as AdminLottery).id
    expect((await put({ lotteryId: id, date: '2026-11-19', top3: '123' })).status).toBe(201)
    expect((await put({ lotteryId: id, date: '2026-11-19', time: '10:00', top2: '12' })).status).toBe(201)
    expect((await put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123' })).status).toBe(201)
    expect(await allResults()).toHaveLength(3)

    expect((await call('DELETE', `/admin/lotteries/${id}`, { cookie: admin })).status).toBe(204)
    const left = await allResults()
    expect(left.map((r) => r.lotteryId)).toEqual(['hanoi-regular'])
    expect(await getDb(env).select().from(lotteryResults).where(eq(lotteryResults.lotteryId, id))).toHaveLength(0)
  })
})
