// Migration 0010 (the public results site: lotteries.public_enabled, lottery_schedules, the index for "the official rows
// of one lottery, newest first" and the seed of the version counter). The migration belongs to this repo: the schema is
// owned here and the results API (numbergen-results-api) only copies its SQL, so the tests of the migration itself are
// here; the results API has its own test that what it describes is what this migration creates.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { lotteries, lotterySchedules } from '../src/db/schema'
import { LOTTERY_CATALOG } from '../src/db/catalog'
import { openDb, runMigrations } from '../scripts/db'

const DB_FILE = 'test-migration0010.db'
const dbUrl = `file:${DB_FILE}`
let handle: ReturnType<typeof openDb>

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

beforeAll(async () => {
  removeDb()
  await runMigrations(dbUrl)
  handle = openDb(dbUrl)
  await handle.db.insert(lotteries).values(
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
})
afterAll(() => {
  try {
    handle.client.close()
    removeDb()
  } catch {
    // the file may still be held open on Windows; harmless
  }
})

const query = async (url: string, sqlText: string, args: (string | number | null)[] = []) => {
  const { client } = openDb(url)
  try {
    return (await client.execute({ sql: sqlText, args })).rows
  } finally {
    client.close()
  }
}

describe('migration 0010', () => {
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
    const { db } = handle
    await db.insert(lotteries).values({ id: 'cascade-test', name: 'c', shortName: 'c', groupKey: 'other', accent: '#000000' })
    await db.insert(lotterySchedules).values({ lotteryId: 'cascade-test', drawTime: '', resultTime: '10:00' })
    await db.delete(lotteries).where(eq(lotteries.id, 'cascade-test'))
    expect(await db.select().from(lotterySchedules).where(eq(lotterySchedules.lotteryId, 'cascade-test'))).toEqual([])
  })

  it('a schedule row takes the defaults: every day and the three fields', async () => {
    const { db } = handle
    await db.delete(lotterySchedules)
    await db.insert(lotterySchedules).values({ lotteryId: 'hanoi-regular', drawTime: '', resultTime: '18:30' })
    const [row] = await db.select().from(lotterySchedules)
    expect(row).toEqual({ lotteryId: 'hanoi-regular', drawTime: '', resultTime: '18:30', days: '1234567', expectedFields: 'top3,top2,bottom2', closedDate: null })
    // the key is (lottery, draw time): the same pair twice is refused
    await expect(db.insert(lotterySchedules).values({ lotteryId: 'hanoi-regular', drawTime: '', resultTime: '19:00' })).rejects.toThrow()
    await db.delete(lotterySchedules)
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

  // The two plan tests below are the same as the results API's, which asks SQLite about its own query builders
  // (numbergen-results-api/test/publicAdmin.test.ts); here the equivalent plain statements are asked, so the index
  // that the migration creates is shown to serve them.
  it('"the official rows of one lottery, newest first" is served by lottery_results_official_idx without a sort', async () => {
    const cols = await query(dbUrl, "pragma index_info('lottery_results_official_idx')")
    expect(cols.map((r) => String(r.name))).toEqual(['lottery_id', 'member_id', 'draw_date', 'draw_time'])
    const plan = (
      await query(
        dbUrl,
        `explain query plan select draw_date, draw_time, top3, top2, bottom2, updated_at from lottery_results
         where lottery_id = ? and member_id = '' order by draw_date desc, draw_time desc limit 120`,
        ['hanoi-regular'],
      )
    )
      .map((r) => String(r.detail))
      .join('\n')
    expect(plan).toContain('lottery_results_official_idx')
    expect(plan).not.toMatch(/TEMP B-TREE/i)
    expect(plan).not.toMatch(/SCAN lottery_results/)
  })

  it('the rows of a few dates are served by the (member, date) index, not a scan', async () => {
    const plan = (
      await query(
        dbUrl,
        `explain query plan select lottery_id, draw_date, draw_time from lottery_results
         where member_id = '' and draw_date in (?, ?) order by lottery_id, draw_date, draw_time`,
        ['2026-11-19', '2026-11-20'],
      )
    )
      .map((r) => String(r.detail))
      .join('\n')
    expect(plan).toContain('lottery_results_member_date_idx')
    expect(plan).not.toMatch(/SCAN lottery_results/)
  })

  it('an earlier migration is untouched: 0000-0009 are the files they were', () => {
    const expected = ['0000_init', '0001_auth_hardening', '0002_v2_features', '0003_add_lottery_id_indexes', '0004_add_site_settings_and_render_limit', '0005_add_push_reminders', '0006_add_landing_page', '0007_add_article_pages', '0008_add_results_and_draws', '0009_add_personal_results']
    for (const tag of expected) expect(existsSync(`drizzle/${tag}.sql`), tag).toBe(true)
  })
})
