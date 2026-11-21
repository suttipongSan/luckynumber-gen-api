// Tests for landing ARTICLES as full articles: migration 0007 (slug, content_html, published_at),
// the public article page GET /landing/articles/:slug, and the slug / contentHtml / publishedAt
// rules of POST and PATCH /admin/landing/items. Real libSQL file DBs with the project's migrations
// and a fake R2 bucket. The sanitizer itself has its own file (sanitizeHtml.test.ts); here it is
// checked that every write goes through it. The older landing behaviour is in landing.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, like } from 'drizzle-orm'
import app from '../src/index'
import type {
  AdminLanding,
  AdminLandingItem,
  AssetBucket,
  Bindings,
  LandingArticleDetail,
  LandingResponse,
} from '../src/types'
import {
  LANDING_SLUG_MAX,
  LANDING_SLUG_MIN,
  MAX_LANDING_CONTENT_HTML,
  MAX_LANDING_CONTENT_INPUT,
  MAX_LANDING_ITEMS_PER_KIND,
} from '../src/types'
import { hashPassword } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import { landingItems, siteSettings } from '../src/db/schema'
import { isLandingSlug, isSlugConflict, newArticleSlug } from '../src/lib/landing'
import { sanitizeHtml } from '../src/lib/sanitizeHtml'
import { parseIsoDateTime } from '../src/lib/time'

const DB_FILE = 'test-articles.db'
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
let admin = ''
/** The rows migration 0006 + 0007 seeded, captured once so every test can start from them again. */
let seedRows: (typeof landingItems.$inferSelect)[] = []

function removeFiles(file: string) {
  for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    try {
      if (existsSync(f)) rmSync(f)
    } catch {
      // still held open on Windows; harmless
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------------

function call(
  method: string,
  path: string,
  cookie?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const h = new Headers(headers)
  if (cookie) h.set('Cookie', cookie)
  let payload: string | undefined
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body)
    h.set('Content-Type', 'application/json')
  }
  return app.request(path, { method, headers: h, body: payload }, env)
}

function cookieFrom(res: Response, name: string): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = raw.match(new RegExp(`${name}=([^;]*)`))
  if (!m) throw new Error(`no ${name} cookie in: ${raw}`)
  return `${name}=${m[1]}`
}

async function adminLogin(): Promise<string> {
  const res = await call('POST', '/admin/login', undefined, { username: 'admin', password: 'admin1234' })
  expect(res.status).toBe(204)
  return cookieFrom(res, 'ng_admin')
}

const publicGet = (path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers }, env)

async function getDoc(): Promise<AdminLanding> {
  const res = await call('GET', '/admin/landing', admin)
  expect(res.status).toBe(200)
  return (await res.json()) as AdminLanding
}

async function getList(): Promise<LandingResponse> {
  const res = await publicGet('/landing')
  expect(res.status).toBe(200)
  return (await res.json()) as LandingResponse
}

async function getArticle(slug: string): Promise<Response> {
  return publicGet(`/landing/articles/${slug}`)
}

/** POST /admin/landing/items, returns the raw response. */
const post = (body: Record<string, unknown>) => call('POST', '/admin/landing/items', admin, body)
const patch = (id: string, body: unknown) => call('PATCH', `/admin/landing/items/${id}`, admin, body)

async function createArticle(extra: Record<string, unknown> = {}, title = 'บทความ'): Promise<AdminLandingItem> {
  const res = await post({ kind: 'article', title, body: 'สรุป', ...extra })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
  return (await res.json()) as AdminLandingItem
}

type ErrorBody = { error: { code: string; message: string } }
const errorOf = async (res: Response) => ((await res.json()) as ErrorBody).error

const row = async (id: string) =>
  (await getDb(env).select().from(landingItems).where(eq(landingItems.id, id)))[0]

async function resetLanding() {
  const db = getDb(env)
  await db.delete(landingItems)
  await db.delete(siteSettings).where(like(siteSettings.key, 'landing_%'))
  await db.insert(landingItems).values(seedRows)
  r2.objects.clear()
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const AUTO_SLUG_RE = /^a-[0-9a-f]{8}$/
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

// ---- setup ---------------------------------------------------------------------------------------

beforeAll(async () => {
  removeFiles(DB_FILE)
  await runMigrations(DB_URL)
  const { client, db } = openDb(DB_URL)
  seedRows = await db.select().from(landingItems)
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
  admin = await adminLogin()
})

beforeEach(async () => {
  await resetLimiter(getDb(env))
  await resetLanding()
})

afterAll(() => {
  removeFiles(DB_FILE)
})

// ---- migration 0007 ------------------------------------------------------------------------------

describe('migration 0007', () => {
  // Every scenario gets its own scratch database under one directory in the OS temp dir: Windows
  // keeps a SQLite file locked for a while after the client was closed, so one file cannot be
  // deleted and recreated. The directory is cleared when the suite starts (the process that locked
  // the files is gone by then) and, as far as the OS allows, when it ends, so nothing piles up.
  const SCRATCH = join(tmpdir(), 'numbergen-api-test-migrations')
  let seq = 0
  let migrationDb = ''
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

  /** A copy of drizzle/ that stops after migration `last` (so a database can be built "before 0007"). */
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

  async function exec(sqlText: string, args: (string | number | null)[] = []) {
    const { client } = openDb(migrationDb)
    try {
      return await client.execute({ sql: sqlText, args })
    } finally {
      client.close()
    }
  }

  /** A new database with migrations 0000..0006 applied, like production before this deploy. */
  const fresh = async () => {
    migrationDb = `file:${join(tmp(), 'before-0007.db').split('\\').join('/')}`
    await runMigrations(migrationDb, migrationsUpTo(6))
  }
  const insertItem = (
    id: string,
    kind: string,
    sortOrder: number,
    createdAt: string,
    extra: { active?: number; imageKey?: string | null; updatedAt?: string } = {},
  ) =>
    exec(
      `insert into landing_items (id, kind, title, body, image_key, sort_order, active, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, kind, `title ${id}`, `body ${id}`, extra.imageKey ?? null, sortOrder, extra.active ?? 1, createdAt, extra.updatedAt ?? createdAt],
    )
  const items = async () => {
    const res = await exec('select * from landing_items order by id')
    return new Map(res.rows.map((r) => [String(r.id), r]))
  }

  it('is registered after 0006 in the journal with a snapshot that chains to the previous one', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: { idx: number; tag: string; when: number }[]
    }
    // by position, not "the last entry": later migrations (0008 ...) come after it
    const entry = journal.entries[7]
    expect(entry.tag).toBe('0007_add_article_pages')
    expect(entry.idx).toBe(7)
    expect(entry.when).toBeGreaterThan(journal.entries[6].when)
    const snap = (n: string) => JSON.parse(readFileSync(`drizzle/meta/${n}_snapshot.json`, 'utf8')) as { id: string; prevId: string }
    expect(snap('0007').prevId).toBe(snap('0006').id)
    const cols = (JSON.parse(readFileSync('drizzle/meta/0007_snapshot.json', 'utf8')) as {
      tables: { landing_items: { columns: Record<string, unknown> } }
    }).tables.landing_items.columns
    expect(Object.keys(cols)).toEqual(expect.arrayContaining(['slug', 'content_html', 'published_at']))
  })

  it('adds slug, content_html and published_at plus a partial unique index on slug', async () => {
    const probe = openDb(DB_URL)
    const cols = await probe.client.execute('pragma table_info(landing_items)')
    probe.client.close()
    const byName = new Map(cols.rows.map((r) => [String(r.name), r]))
    expect(byName.get('slug')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
    expect(byName.get('content_html')).toMatchObject({ type: 'TEXT', notnull: 1, dflt_value: "''" })
    expect(byName.get('published_at')).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
    // the old columns are all still there
    for (const c of ['id', 'kind', 'title', 'body', 'image_key', 'sort_order', 'active', 'created_at', 'updated_at']) {
      expect(byName.has(c), c).toBe(true)
    }

    const { client } = openDb(DB_URL)
    try {
      const idx = await client.execute(
        "select name, sql from sqlite_master where type = 'index' and tbl_name = 'landing_items'",
      )
      const slugIdx = idx.rows.find((r) => r.name === 'landing_items_slug_unique_idx')
      expect(slugIdx, 'slug index').toBeDefined()
      expect(String(slugIdx?.sql).replace(/[`"]/g, '')).toMatch(/UNIQUE INDEX .*\(slug\)\s+WHERE slug IS NOT NULL/i)
      expect(idx.rows.map((r) => String(r.name))).toContain('landing_items_kind_sort_idx')
      // behaviour: any number of NULL slugs, but never two equal ones
      await client.execute("insert into landing_items (id, kind, title, body, sort_order, active, created_at, updated_at) values ('n1','howto','t','b',50,1,'x','x')")
      await client.execute("insert into landing_items (id, kind, title, body, sort_order, active, created_at, updated_at) values ('n2','howto','t','b',51,1,'x','x')")
      await client.execute("insert into landing_items (id, kind, title, body, sort_order, active, created_at, updated_at, slug) values ('s1','article','t','b',50,1,'x','x','same-slug')")
      await expect(
        client.execute("insert into landing_items (id, kind, title, body, sort_order, active, created_at, updated_at, slug) values ('s2','article','t','b',51,1,'x','x','same-slug')"),
      ).rejects.toThrow(/UNIQUE constraint failed: landing_items\.slug/)
    } finally {
      await client.execute("delete from landing_items where id in ('n1','n2','s1','s2')")
      client.close()
    }
  })

  it('gives the three starter articles their addresses and leaves the steps alone', async () => {
    expect(seedRows).toHaveLength(6)
    const byId = new Map(seedRows.map((r) => [r.id, r]))
    expect(byId.get('landing-article-1')?.slug).toBe('all-lotteries')
    expect(byId.get('landing-article-2')?.slug).toBe('customize-card')
    expect(byId.get('landing-article-3')?.slug).toBe('notify-time')
    for (const r of seedRows) {
      if (r.kind === 'article') {
        expect(r.publishedAt, r.id).toBe(r.createdAt)
        expect(r.publishedAt, r.id).toMatch(ISO_RE)
      } else {
        expect(r.slug, r.id).toBeNull()
        expect(r.publishedAt, r.id).toBeNull()
      }
      expect(r.contentHtml, r.id).toBe('')
    }
    for (const r of seedRows.filter((x) => x.kind === 'article')) expect(isLandingSlug(r.slug as string)).toBe(true)
  })

  it('on a database edited by an admin after 0006: seeded slugs, random slugs for the rest, published_at backfilled, steps untouched', async () => {
    await fresh()
    // what an admin may have done before this deploy
    await exec("update landing_items set title = 'edited headline', body = 'edited summary' where id = 'landing-article-2'")
    await exec("update landing_items set active = 0 where id = 'landing-article-1'")
    await exec("delete from landing_items where id = 'landing-article-3'")
    await exec("delete from landing_items where id = 'landing-howto-2'")
    await insertItem('extra-a1', 'article', 3, '2026-01-02T03:04:05.678Z', { imageKey: 'abcdefgh12345678.png', updatedAt: '2026-02-02T00:00:00.000Z' })
    await insertItem('extra-a2', 'article', 4, '2025-12-31T23:59:59.999Z', { active: 0 })
    await insertItem('extra-h1', 'howto', 3, '2026-01-03T00:00:00.000Z', { imageKey: 'zzzzzzzz12345678.webp' })
    const before = await items()

    await runMigrations(migrationDb) // the real folder: applies only 0007
    const after = await items()

    expect([...after.keys()].sort()).toEqual(
      ['extra-a1', 'extra-a2', 'extra-h1', 'landing-article-1', 'landing-article-2', 'landing-howto-1', 'landing-howto-3'],
    )
    // the deleted row stays deleted
    expect(after.has('landing-article-3')).toBe(false)
    expect(after.has('landing-howto-2')).toBe(false)
    // the starter articles get their address even though one is inactive and one was edited
    expect(after.get('landing-article-1')?.slug).toBe('all-lotteries')
    expect(after.get('landing-article-2')?.slug).toBe('customize-card')
    expect(after.get('landing-article-2')).toMatchObject({ title: 'edited headline', body: 'edited summary' })
    // articles an admin added get a random one
    const randomSlugs = ['extra-a1', 'extra-a2'].map((id) => String(after.get(id)?.slug))
    for (const s of randomSlugs) expect(s).toMatch(AUTO_SLUG_RE)
    expect(new Set(randomSlugs).size).toBe(2)
    // every article: published_at = created_at, no long text yet
    for (const [id, r] of after) {
      if (r.kind !== 'article') continue
      expect(r.published_at, id).toBe(r.created_at)
      expect(r.content_html, id).toBe('')
    }
    expect(after.get('extra-a1')?.published_at).toBe('2026-01-02T03:04:05.678Z')
    expect(after.get('extra-a2')?.published_at).toBe('2025-12-31T23:59:59.999Z')
    // steps: nothing new
    for (const id of ['landing-howto-1', 'landing-howto-3', 'extra-h1']) {
      expect(after.get(id), id).toMatchObject({ kind: 'howto', slug: null, content_html: '', published_at: null })
    }
    // and no pre-existing column moved
    const same = ['id', 'kind', 'title', 'body', 'image_key', 'sort_order', 'active', 'created_at', 'updated_at']
    for (const [id, r] of after) {
      const old = before.get(id)
      for (const c of same) expect(r[c], `${id}.${c}`).toEqual(old?.[c])
    }
  })

  it('the starter slugs go only to a row that is still an article without a slug', async () => {
    await fresh()
    // a hand-edit nobody should do, but the data step must not trust it
    await exec("update landing_items set kind = 'howto' where id = 'landing-article-1'")
    await runMigrations(migrationDb)
    const after = await items()
    expect(after.get('landing-article-1')).toMatchObject({ kind: 'howto', slug: null, published_at: null })
    expect(after.get('landing-article-2')?.slug).toBe('customize-card')
    // running the migrations again changes nothing
    const again = await items()
    await runMigrations(migrationDb)
    expect(await items()).toEqual(again)
  })

  it('works when every starter row was deleted, and with many articles (all addresses distinct)', async () => {
    await fresh()
    await exec('delete from landing_items')
    for (let i = 0; i < 60; i++) await insertItem(`bulk-${i}`, 'article', i, `2026-03-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`)
    await runMigrations(migrationDb)
    const after = [...(await items()).values()]
    expect(after).toHaveLength(60)
    const slugs = after.map((r) => String(r.slug))
    for (const s of slugs) expect(s).toMatch(AUTO_SLUG_RE)
    expect(new Set(slugs).size).toBe(60)
    for (const r of after) expect(r.published_at).toBe(r.created_at)

    await fresh()
    await exec('delete from landing_items')
    await runMigrations(migrationDb)
    expect((await items()).size).toBe(0)
  })
})

// ---- unit: helpers -------------------------------------------------------------------------------

describe('unit: slug, date and conflict helpers', () => {
  it('isLandingSlug: lower case letters and digits in groups joined by single hyphens, 3..80 long', () => {
    const ok = ['abc', 'a-b', 'a-b-c', '0-9', 'abc123', 'a1-b2-c3', 'all-lotteries', 'x'.repeat(LANDING_SLUG_MAX), 'a-' + 'b'.repeat(78)]
    for (const s of ok) expect(isLandingSlug(s), s).toBe(true)
    const bad = [
      '', 'a', 'ab', 'x'.repeat(LANDING_SLUG_MAX + 1), 'ABC', 'Abc', 'a_b', 'a b', ' abc', 'abc ', '-abc', 'abc-', 'a--b',
      '--a', 'a-', 'ไทย', 'abc\n', '\nabc', 'a/b', 'a.b', 'a%20b', 'a+b', 'a:b', 'a\u0000b', 'ａｂｃ',
    ]
    for (const s of bad) expect(isLandingSlug(s), JSON.stringify(s)).toBe(false)
    expect(LANDING_SLUG_MIN).toBe(3)
    expect(LANDING_SLUG_MAX).toBe(80)
  })

  it('newArticleSlug: "a-" and 8 lower case hex characters, different every time', () => {
    const slugs = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const s = newArticleSlug()
      expect(s).toMatch(AUTO_SLUG_RE)
      expect(isLandingSlug(s)).toBe(true)
      slugs.add(s)
    }
    expect(slugs.size).toBeGreaterThan(195)
  })

  it('parseIsoDateTime: strict ISO-8601 in, UTC ISO string out, independent of the server time zone', () => {
    const cases: [string, string][] = [
      ['2026-11-14T10:00:00Z', '2026-11-14T10:00:00.000Z'],
      ['2026-11-14T10:00:00.123Z', '2026-11-14T10:00:00.123Z'],
      ['2026-11-14T10:00:00.1Z', '2026-11-14T10:00:00.100Z'],
      ['2026-11-14T10:00:00.123456789Z', '2026-11-14T10:00:00.123Z'],
      ['2026-11-14T17:00:00+07:00', '2026-11-14T10:00:00.000Z'],
      ['2026-11-14T17:00:00+0700', '2026-11-14T10:00:00.000Z'],
      ['2026-11-14T03:30:00-05:30', '2026-11-14T09:00:00.000Z'],
      ['2026-11-14T10:00', '2026-11-14T10:00:00.000Z'], // no zone: UTC
      ['2026-11-14T10:00:30', '2026-11-14T10:00:30.000Z'],
      ['2026-11-14 10:00:00', '2026-11-14T10:00:00.000Z'],
      ['2026-11-14', '2026-11-14T00:00:00.000Z'],
      ['2024-02-29', '2024-02-29T00:00:00.000Z'], // leap day
      ['2026-12-31T23:59:59.999Z', '2026-12-31T23:59:59.999Z'],
      ['1999-01-01T00:00:00Z', '1999-01-01T00:00:00.000Z'],
    ]
    for (const [input, expected] of cases) expect(parseIsoDateTime(input), input).toBe(expected)
    const bad = [
      '', ' ', 'not a date', 'now', '1', '2026', '2026-11', '20261114', '14/11/2026', '11-14-2026', 'Nov 14 2026',
      'Sat, 14 Nov 2026 10:00:00 GMT', '2026-13-01', '2026-00-10', '2026-11-00', '2026-11-31', '2026-02-30', '2025-02-29',
      '2026-11-14T24:00:00Z', '2026-11-14T10:60:00Z', '2026-11-14T10:00:60Z', '2026-11-14T10:00:00+24:00',
      '2026-11-14T10:00:00+07:60', '2026-11-14T10:00:00 Z', ' 2026-11-14', '2026-11-14 ', '2026-11-14T', '0099-01-01',
      '+002026-11-14', '-002026-11-14', '2026-11-14T10:00:00ZZ', '2026-11-14T10', '9999-12-31T23:59:59-01:00',
    ]
    for (const input of bad) expect(parseIsoDateTime(input), JSON.stringify(input)).toBeNull()
  })

  it('isSlugConflict: only the unique index on landing_items.slug, at any depth of the cause chain', () => {
    const libsql = Object.assign(new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: landing_items.slug'), { code: 'SQLITE_CONSTRAINT' })
    expect(isSlugConflict(libsql)).toBe(true)
    // drizzle wraps the driver error
    expect(isSlugConflict(Object.assign(new Error('Failed query: insert into landing_items ...'), { cause: libsql }))).toBe(true)
    // D1
    expect(isSlugConflict(new Error('D1_ERROR: UNIQUE constraint failed: landing_items.slug: SQLITE_CONSTRAINT'))).toBe(true)
    expect(isSlugConflict(Object.assign(new Error('Failed query'), { cause: { cause: new Error('UNIQUE constraint failed: landing_items.slug') } }))).toBe(true)
    expect(isSlugConflict('UNIQUE constraint failed: landing_items.slug')).toBe(true)
    expect(isSlugConflict(new Error('UNIQUE constraint failed: index landing_items_slug_unique_idx'))).toBe(true)
    // anything else is not
    expect(isSlugConflict(new Error('UNIQUE constraint failed: landing_items.id'))).toBe(false)
    expect(isSlugConflict(new Error('UNIQUE constraint failed: members.link_token'))).toBe(false)
    expect(isSlugConflict(new Error('NOT NULL constraint failed: landing_items.slug'))).toBe(false)
    expect(isSlugConflict(new Error('database is locked'))).toBe(false)
    expect(isSlugConflict(null)).toBe(false)
    expect(isSlugConflict(undefined)).toBe(false)
    expect(isSlugConflict({})).toBe(false)
    expect(isSlugConflict(42)).toBe(false)
    // a cause loop does not hang
    const loop: { message: string; cause?: unknown } = { message: 'x' }
    loop.cause = loop
    expect(isSlugConflict(loop)).toBe(false)
  })
})

// ---- GET /landing: the article cards ---------------------------------------------------------------

describe('GET /landing article cards', () => {
  it('each card has id, title, body, slug, imageUrl and publishedAt, and never the long text', async () => {
    const created = await createArticle({
      slug: 'card-test',
      contentHtml: '<p>SECRET-LONG-TEXT</p>',
      publishedAt: '2026-05-06T07:08:09Z',
    })
    const res = await publicGet('/landing')
    const text = await res.text()
    expect(text).not.toContain('SECRET-LONG-TEXT')
    expect(text).not.toContain('contentHtml')
    const list = JSON.parse(text) as LandingResponse
    for (const a of list.articles) {
      expect(Object.keys(a).sort()).toEqual(['body', 'id', 'imageUrl', 'publishedAt', 'slug', 'title'])
      expect(isLandingSlug(a.slug as string)).toBe(true)
    }
    expect(list.articles.at(-1)).toEqual({
      id: created.id,
      title: 'บทความ',
      body: 'สรุป',
      slug: 'card-test',
      imageUrl: null,
      publishedAt: '2026-05-06T07:08:09.000Z',
    })
    // steps are unchanged
    for (const s of list.steps) expect(Object.keys(s).sort()).toEqual(['body', 'id', 'imageUrl', 'title'])
  })

  it('an inactive article is not listed and its address does not work', async () => {
    await patch('landing-article-1', { active: false })
    expect((await getList()).articles.map((a) => a.slug)).toEqual(['customize-card', 'notify-time'])
    expect((await getArticle('all-lotteries')).status).toBe(404)
  })

  it('a row whose slug is NULL (hand edited) is listed with slug null and has no page', async () => {
    await getDb(env).update(landingItems).set({ slug: null }).where(eq(landingItems.id, 'landing-article-2'))
    const card = (await getList()).articles.find((a) => a.id === 'landing-article-2')
    expect(card).toMatchObject({ slug: null })
    expect((await getArticle('customize-card')).status).toBe(404)
  })
})

// ---- GET /landing/articles/:slug -------------------------------------------------------------------

describe('GET /landing/articles/:slug', () => {
  it('serves an active article: exactly the contract fields, JSON, Cache-Control public max-age=60, no session needed', async () => {
    const res = await getArticle('all-lotteries')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    const seed = seedRows.find((r) => r.id === 'landing-article-1')
    const body = (await res.json()) as LandingArticleDetail
    expect(Object.keys(body).sort()).toEqual(['body', 'contentHtml', 'id', 'imageUrl', 'publishedAt', 'slug', 'title'])
    expect(body).toEqual({
      id: 'landing-article-1',
      slug: 'all-lotteries',
      title: seed?.title,
      body: seed?.body,
      contentHtml: '', // none yet: the page shows `body` as plain text
      imageUrl: null,
      publishedAt: seed?.createdAt,
    })
    // a bogus member / admin cookie changes nothing
    const withCookies = await publicGet('/landing/articles/all-lotteries', { Cookie: 'ng_session=nope.nope; ng_admin=nope.nope' })
    expect(withCookies.status).toBe(200)
    expect(await withCookies.json()).toEqual(body)
  })

  it('returns the formatted long text, the cover picture and the date of the article', async () => {
    const item = await createArticle({
      slug: 'full-article',
      contentHtml: '<h2>หัวข้อ</h2><p>ย่อหน้า <strong>หนา</strong> และ <a href="https://example.com/x?a=1&b=2">ลิงก์</a></p><ul><li>หนึ่ง</li></ul>',
      publishedAt: '2026-05-06T14:08:09+07:00',
    })
    const up = new FormData()
    up.append('file', new File([pngBytes], 'a.png', { type: 'image/png' }))
    const withImage = await app.request(`/admin/landing/items/${item.id}/image`, { method: 'POST', body: up, headers: { Cookie: admin } }, env)
    expect(withImage.status).toBe(200)
    const imageUrl = ((await withImage.json()) as AdminLandingItem).imageUrl as string
    expect(imageUrl).toMatch(/^http:\/\/localhost\/landing\/image\/[A-Za-z0-9]{16}\.png$/)

    const body = (await (await getArticle('full-article')).json()) as LandingArticleDetail
    expect(body).toEqual({
      id: item.id,
      slug: 'full-article',
      title: 'บทความ',
      body: 'สรุป',
      contentHtml:
        '<h2>หัวข้อ</h2><p>ย่อหน้า <strong>หนา</strong> และ <a href="https://example.com/x?a=1&amp;b=2" rel="noopener noreferrer nofollow" target="_blank">ลิงก์</a></p><ul><li>หนึ่ง</li></ul>',
      imageUrl,
      publishedAt: '2026-05-06T07:08:09.000Z',
    })
    // the cover is also on the card, and the picture really is served
    expect((await getList()).articles.find((a) => a.id === item.id)?.imageUrl).toBe(imageUrl)
    expect((await publicGet(new URL(imageUrl).pathname)).status).toBe(200)
  })

  it('an article without a date is still public (publishedAt null)', async () => {
    await createArticle({ slug: 'no-date', publishedAt: null })
    const body = (await (await getArticle('no-date')).json()) as LandingArticleDetail
    expect(body.publishedAt).toBeNull()
  })

  it('404 NOT_FOUND for an inactive article, and it comes back when switched on again', async () => {
    const item = await createArticle({ slug: 'now-you-see-me', active: false })
    const res = await getArticle('now-you-see-me')
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND' })
    await patch(item.id, { active: true })
    expect((await getArticle('now-you-see-me')).status).toBe(200)
    await patch(item.id, { active: false })
    expect((await getArticle('now-you-see-me')).status).toBe(404)
  })

  it('404 for a how-to step, whatever is asked: its id, a slug of another step, an unknown slug', async () => {
    // "landing-howto-1" is a perfectly valid slug and the id of a step, but no article has it
    for (const slug of ['landing-howto-1', 'landing-howto-2', 'landing-howto-3']) {
      const res = await getArticle(slug)
      expect(res.status, slug).toBe(404)
      expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND' })
    }
    // an article's ID is not its address either
    expect((await getArticle('landing-article-1')).status).toBe(404)
    // an article's slug found on a row that is a step (hand edit) is still not an article
    await getDb(env).update(landingItems).set({ slug: 'step-with-slug' }).where(eq(landingItems.id, 'landing-howto-1'))
    expect((await getArticle('step-with-slug')).status).toBe(404)
  })

  it('404 for an unknown slug and for anything that is not a valid slug (which never reaches the database)', async () => {
    const lookup = vi.spyOn(getDb(env).query.landingItems, 'findFirst')
    try {
      for (const slug of ['does-not-exist', 'zzz', 'all-lotteries-2', 'all', 'a'.repeat(80)]) {
        const res = await getArticle(slug)
        expect(res.status, slug).toBe(404)
        expect(await errorOf(res)).toMatchObject({ code: 'NOT_FOUND' })
      }
      expect(lookup).toHaveBeenCalledTimes(5)
      lookup.mockClear()
      const invalid = [
        'ALL-LOTTERIES', 'All-Lotteries', 'all_lotteries', 'all%20lotteries', '-all-lotteries', 'all-lotteries-', 'all--lotteries',
        'ab', 'a', 'a'.repeat(81), 'all.lotteries', 'all+lotteries', 'ไทย', '%E0%B9%84%E0%B8%97%E0%B8%A2', 'all-lotteries%0A',
        'all-lotteries%00', 'all-lotteries%20', '%2e%2e', '..', '.', 'all%2Flotteries', 'all%5Clotteries', 'all-lotteries.png',
        'abcdefgh12345678.png', 'all-lotteries;x', 'all-lotteries?x=1'.replace('?', '%3F'), '%', '%zz', '%E0%A4%A',
      ]
      for (const slug of invalid) {
        const res = await getArticle(slug)
        expect(res.status, slug).toBe(404)
        expect(await errorOf(res), slug).toMatchObject({ code: 'NOT_FOUND' })
      }
      expect(lookup).not.toHaveBeenCalled()
      // no slug at all, or more path than a slug
      for (const path of ['/landing/articles', '/landing/articles/', '/landing/articles//', '/landing/articles/all-lotteries/x', '/landing/articles/all-lotteries/']) {
        expect((await publicGet(path)).status, path).toBe(404)
      }
    } finally {
      lookup.mockRestore()
    }
  })

  it('matches the slug exactly (case sensitive) and always by slug, never by id or title', async () => {
    expect((await getArticle('all-lotteries')).status).toBe(200)
    expect((await getArticle('ALL-LOTTERIES')).status).toBe(404)
    const item = await createArticle({ slug: 'second-one' })
    expect((await getArticle(item.id)).status).toBe(404)
    expect(((await (await getArticle('second-one')).json()) as LandingArticleDetail).id).toBe(item.id)
  })

  it('follows edits at once: new text, moved slug, switched off, deleted', async () => {
    const item = await createArticle({ slug: 'live-edit', contentHtml: '<p>one</p>' })
    expect(((await (await getArticle('live-edit')).json()) as LandingArticleDetail).contentHtml).toBe('<p>one</p>')
    await patch(item.id, { contentHtml: '<p>two</p>', title: 'ใหม่' })
    expect(await (await getArticle('live-edit')).json()).toMatchObject({ contentHtml: '<p>two</p>', title: 'ใหม่' })
    await patch(item.id, { slug: 'moved-slug' })
    expect((await getArticle('live-edit')).status).toBe(404)
    expect((await getArticle('moved-slug')).status).toBe(200)
    await patch(item.id, { contentHtml: '' })
    expect(((await (await getArticle('moved-slug')).json()) as LandingArticleDetail).contentHtml).toBe('')
    expect((await call('DELETE', `/admin/landing/items/${item.id}`, admin)).status).toBe(204)
    expect((await getArticle('moved-slug')).status).toBe(404)
  })

  it('does not shadow, and is not shadowed by, /landing/image/:name', async () => {
    // an article called "image" and one called "articles": both pages work ...
    await createArticle({ slug: 'image' })
    await createArticle({ slug: 'articles' })
    expect((await getArticle('image')).status).toBe(200)
    expect((await getArticle('articles')).status).toBe(200)
    // ... and the image route still serves images, and only through its own pattern
    await r2.put('landing/abcdefgh12345678.png', pngBytes, { httpMetadata: { contentType: 'image/png' } })
    const img = await publicGet('/landing/image/abcdefgh12345678.png')
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect((await publicGet('/landing/image/image')).status).toBe(404)
    expect((await publicGet('/landing/image/all-lotteries')).status).toBe(404)
    // an image file name is not an article slug, and an article slug is not an image name
    expect((await publicGet('/landing/articles/abcdefgh12345678.png')).status).toBe(404)
    expect((await publicGet('/landing/image/articles/all-lotteries')).status).toBe(404)
    expect((await publicGet('/landing/articles/image/abcdefgh12345678.png')).status).toBe(404)
    // /landing itself is untouched
    expect((await publicGet('/landing')).status).toBe(200)
  })

  it('allows the web origin like /landing does, and no other origin; answers the preflight', async () => {
    for (const path of ['/landing/articles/all-lotteries', '/landing']) {
      const ok = await publicGet(path, { Origin: 'http://localhost:5173' })
      expect(ok.status, path).toBe(200)
      expect(ok.headers.get('access-control-allow-origin'), path).toBe('http://localhost:5173')
      const evil = await publicGet(path, { Origin: 'https://evil.example' })
      expect(evil.status, path).toBe(200)
      expect(evil.headers.get('access-control-allow-origin'), path).toBeNull()
    }
    const prod = { ...env, WEB_URL: 'https://pnphoto.co', COOKIE_SECURE: 'true' }
    const res = await app.request('/landing/articles/all-lotteries', { headers: { Origin: 'https://pnphoto.co' } }, prod)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://pnphoto.co')
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    const pre = await app.request(
      '/landing/articles/all-lotteries',
      { method: 'OPTIONS', headers: { Origin: 'https://pnphoto.co', 'Access-Control-Request-Method': 'GET' } },
      prod,
    )
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://pnphoto.co')
  })

  it('writes (POST) to the public path are not a thing', async () => {
    expect((await call('POST', '/landing/articles/all-lotteries', admin, {})).status).toBe(404)
    expect((await call('DELETE', '/landing/articles/all-lotteries', admin)).status).toBe(404)
  })
})

// ---- POST /admin/landing/items ---------------------------------------------------------------------

describe('create an article', () => {
  it('without a slug (omitted, null or "") makes one: a- and 8 hex characters, each different', async () => {
    const made = [
      await createArticle({}),
      await createArticle({ slug: null }),
      await createArticle({ slug: '' }),
      await createArticle({ slug: undefined }),
    ]
    const slugs = made.map((m) => m.slug as string)
    for (const s of slugs) expect(s).toMatch(AUTO_SLUG_RE)
    expect(new Set(slugs).size).toBe(4)
    // and each page works
    for (const s of slugs) expect((await getArticle(s)).status, s).toBe(200)
  })

  it('with a slug uses it as typed', async () => {
    const a = await createArticle({ slug: 'my-first-article' })
    expect(a).toMatchObject({ kind: 'article', slug: 'my-first-article', contentHtml: '', active: true })
    expect((await getDoc()).items.find((i) => i.id === a.id)?.slug).toBe('my-first-article')
    expect((await createArticle({ slug: 'a1' + 'b'.repeat(LANDING_SLUG_MAX - 2) })).slug).toHaveLength(LANDING_SLUG_MAX)
    expect((await createArticle({ slug: 'abc' })).slug).toBe('abc')
  })

  it('publishedAt: omitted = now, null = no date, a value is normalized to UTC', async () => {
    const before = Date.now()
    const def = await createArticle({})
    const after = Date.now()
    expect(def.publishedAt).toMatch(ISO_RE)
    expect(Date.parse(def.publishedAt as string)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(def.publishedAt as string)).toBeLessThanOrEqual(after)
    // the default is the moment of creation
    expect(def.publishedAt).toBe((await row(def.id)).createdAt)

    expect((await createArticle({ publishedAt: null })).publishedAt).toBeNull()
    const cases: [string, string][] = [
      ['2026-05-06T07:08:09Z', '2026-05-06T07:08:09.000Z'],
      ['2026-05-06T14:08:09+07:00', '2026-05-06T07:08:09.000Z'],
      ['2026-05-06T14:08:09.5+07:00', '2026-05-06T07:08:09.500Z'],
      ['2026-05-06', '2026-05-06T00:00:00.000Z'],
      ['2026-05-06T07:08', '2026-05-06T07:08:00.000Z'],
    ]
    for (const [sent, stored] of cases) {
      const a = await createArticle({ publishedAt: sent })
      expect(a.publishedAt, sent).toBe(stored)
      expect((await row(a.id)).publishedAt, sent).toBe(stored)
    }
  })

  it('stores contentHtml sanitized, never as sent', async () => {
    const dirty =
      '<p onclick="x()">Hello <b style="c">world</b></p><script>alert(1)</script>' +
      '<a href="javascript:alert(1)">bad</a> <a href="https://ok.example" target="_self" onclick="y()">good</a>' +
      '<img src=x onerror=alert(1)><iframe src="//evil.example"></iframe><!-- c --><style>*{}</style>'
    const clean =
      '<p>Hello <b>world</b></p>bad <a href="https://ok.example" rel="noopener noreferrer nofollow" target="_blank">good</a>'
    expect(sanitizeHtml(dirty)).toBe(clean)
    const a = await createArticle({ slug: 'dirty-one', contentHtml: dirty })
    expect(a.contentHtml).toBe(clean)
    expect((await row(a.id)).contentHtml).toBe(clean) // what is in the database
    expect((await getDoc()).items.find((i) => i.id === a.id)?.contentHtml).toBe(clean)
    expect(((await (await getArticle('dirty-one')).json()) as LandingArticleDetail).contentHtml).toBe(clean)
    expect(JSON.stringify(await getList())).not.toContain('alert(1)')
  })

  it('contentHtml: omitted and "" and whitespace only all mean "no long text"', async () => {
    expect((await createArticle({})).contentHtml).toBe('')
    expect((await createArticle({ contentHtml: '' })).contentHtml).toBe('')
    expect((await createArticle({ contentHtml: '  \n\t ' })).contentHtml).toBe('')
    expect((await createArticle({ contentHtml: '<script>alert(1)</script>' })).contentHtml).toBe('')
  })

  it('title and body stay plain text next to contentHtml', async () => {
    const a = await createArticle({ contentHtml: '<p>x</p>' }, '<b>raw</b> title')
    expect(a.title).toBe('<b>raw</b> title')
    const b = await post({ kind: 'article', title: 'x', body: '<script>alert(1)</script>' })
    expect(((await b.json()) as AdminLandingItem).body).toBe('<script>alert(1)</script>')
  })

  it('refuses a slug that is already taken: 409 SLUG_TAKEN, Thai message, nothing created', async () => {
    const before = (await getDoc()).items.length
    const res = await post({ kind: 'article', title: 'ซ้ำ', body: '', slug: 'all-lotteries' })
    expect(res.status).toBe(409)
    const err = await errorOf(res)
    expect(err.code).toBe('SLUG_TAKEN')
    expect(err.message).toMatch(/[฀-๿]/)
    expect((await getDoc()).items).toHaveLength(before)
    // taken by an article the admin made, and by an inactive one
    await createArticle({ slug: 'mine', active: false })
    const again = await post({ kind: 'article', title: 'ซ้ำ', body: '', slug: 'mine' })
    expect(again.status).toBe(409)
    expect(await errorOf(again)).toMatchObject({ code: 'SLUG_TAKEN' })
    // the first one is untouched
    expect((await getDoc()).items.filter((i) => i.slug === 'mine')).toHaveLength(1)
  })

  it('a slug differing only in case is a validation error, not a conflict', async () => {
    const res = await post({ kind: 'article', title: 'x', body: '', slug: 'All-Lotteries' })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION' })
  })

  it('two creates racing for the same slug: one wins, the other gets SLUG_TAKEN, the index holds', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => post({ kind: 'article', title: `race ${i}`, body: '', slug: 'race-slug' })),
    )
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    for (const r of results) if (r.status !== 200) {
      expect(r.status).toBe(409)
      expect(await errorOf(r)).toMatchObject({ code: 'SLUG_TAKEN' })
    }
    const rows = await getDb(env).select().from(landingItems).where(eq(landingItems.slug, 'race-slug'))
    expect(rows).toHaveLength(1)
    // the losers did not take a position or a place in the quota
    const articles = (await getDoc()).items.filter((i) => i.kind === 'article')
    expect(articles).toHaveLength(4)
    expect(new Set(articles.map((a) => a.sortOrder)).size).toBe(4)
  })

  it('a generated slug that clashes is replaced by another one; if every draw clashes the answer is SLUG_TAKEN', async () => {
    await createArticle({ slug: 'a-01020304' })
    const real = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    let forced = 2
    let draws = 0
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((arr: Uint8Array) => {
      if (arr instanceof Uint8Array && arr.length === 4 && forced > 0) {
        forced--
        draws++
        arr.set([1, 2, 3, 4])
        return arr
      }
      if (arr instanceof Uint8Array && arr.length === 4) draws++
      return real(arr)
    }) as typeof crypto.getRandomValues)
    try {
      const ok = await createArticle({})
      expect(ok.slug).toMatch(AUTO_SLUG_RE)
      expect(ok.slug).not.toBe('a-01020304')
      expect(draws).toBe(3) // two clashes, then a free one

      draws = 0
      forced = Number.POSITIVE_INFINITY
      const res = await post({ kind: 'article', title: 'x', body: '' })
      expect(res.status).toBe(409)
      expect(await errorOf(res)).toMatchObject({ code: 'SLUG_TAKEN' })
      expect(draws).toBeGreaterThanOrEqual(2)
      expect(draws).toBeLessThanOrEqual(10)
    } finally {
      spy.mockRestore()
    }
    expect((await getDoc()).items.filter((i) => i.kind === 'article')).toHaveLength(5)
  })

  it('validates the slug', async () => {
    const bad: unknown[] = [
      'ab', 'a', 'ABC', 'a_b', 'a b', ' abc', 'abc ', '-abc', 'abc-', 'a--b', 'ไทย', 'a/b', 'a.b', 'abc\n', 'a'.repeat(81),
      5, true, [], {}, ['abc'],
    ]
    for (const slug of bad) {
      const res = await post({ kind: 'article', title: 'x', body: '', slug })
      expect(res.status, JSON.stringify(slug)).toBe(400)
      expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/^slug: /) })
    }
    expect((await getDoc()).items).toHaveLength(6)
  })

  it('validates publishedAt', async () => {
    const bad: unknown[] = ['', 'not a date', 'yesterday', '1', '14/11/2026', '2026-02-30', '2026-13-01', '2026-11-14T25:00:00Z', 'Nov 14 2026', 1731578400000, true, [], {}]
    for (const publishedAt of bad) {
      const res = await post({ kind: 'article', title: 'x', body: '', publishedAt })
      expect(res.status, JSON.stringify(publishedAt)).toBe(400)
      expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/^publishedAt: /) })
    }
    expect((await getDoc()).items).toHaveLength(6)
  })

  it('validates contentHtml: it must be a string', async () => {
    for (const contentHtml of [null, 5, true, [], {}, ['<p>x</p>']]) {
      const res = await post({ kind: 'article', title: 'x', body: '', contentHtml })
      expect(res.status, JSON.stringify(contentHtml)).toBe(400)
      expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/^contentHtml: /) })
    }
  })

  it('keeps the 12 per kind limit, the position rule and the other validations', async () => {
    for (let i = 0; i < MAX_LANDING_ITEMS_PER_KIND - 3; i++) await createArticle({ contentHtml: `<p>${i}</p>` })
    const over = await post({ kind: 'article', title: 'เกิน', body: '', slug: 'over-the-limit', contentHtml: '<p>x</p>' })
    expect(over.status).toBe(409)
    expect(await errorOf(over)).toMatchObject({ code: 'QUOTA' })
    expect((await getDoc()).items.filter((i) => i.kind === 'article')).toHaveLength(MAX_LANDING_ITEMS_PER_KIND)
    expect((await getDoc()).items.find((i) => i.slug === 'over-the-limit')).toBeUndefined()
    // a bad body is still a 400 first
    expect((await post({ kind: 'article', title: '', body: '' })).status).toBe(400)
    expect((await post({ kind: 'article', title: 'x', body: 'ก'.repeat(601) })).status).toBe(400)
  })
})

// ---- contentHtml limits ----------------------------------------------------------------------------

describe('contentHtml limits', () => {
  const create = (contentHtml: string) => post({ kind: 'article', title: 'x', body: '', contentHtml })

  it('reads up to 60000 characters; 60001 is a 400 with a Thai message', async () => {
    expect(MAX_LANDING_CONTENT_INPUT).toBe(60_000)
    // 60000 characters that sanitize to nothing
    const ok = await create('<!--' + 'x'.repeat(MAX_LANDING_CONTENT_INPUT - 7) + '-->')
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as AdminLandingItem).contentHtml).toBe('')
    const over = await create('<!--' + 'x'.repeat(MAX_LANDING_CONTENT_INPUT - 6) + '-->')
    expect(over.status).toBe(400)
    const err = await errorOf(over)
    expect(err).toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/^contentHtml: .*[฀-๿]/) })
    expect(err.message).toContain('60000')
    // a plain 60001 characters of text as well
    expect((await create('a'.repeat(MAX_LANDING_CONTENT_INPUT + 1))).status).toBe(400)
  })

  it('stores up to 20000 characters AFTER sanitizing; 20001 is a 400', async () => {
    expect(MAX_LANDING_CONTENT_HTML).toBe(20_000)
    const exact = await create('a'.repeat(MAX_LANDING_CONTENT_HTML))
    expect(exact.status).toBe(200)
    expect(((await exact.json()) as AdminLandingItem).contentHtml).toHaveLength(MAX_LANDING_CONTENT_HTML)
    const over = await create('a'.repeat(MAX_LANDING_CONTENT_HTML + 1))
    expect(over.status).toBe(400)
    const err = await errorOf(over)
    expect(err).toMatchObject({ code: 'VALIDATION', message: expect.stringMatching(/^contentHtml: .*[฀-๿]/) })
    expect(err.message).toContain('20000')
  })

  it('counts the sanitized length: markup that is dropped is free, escaping that grows is not', async () => {
    // 50000 raw characters, 18 of them survive
    const shrinks = await create('<p>keep this</p>' + '<script>' + 'x'.repeat(49_000) + '</script>' + '<b>b</b>')
    expect(shrinks.status).toBe(200)
    expect(((await shrinks.json()) as AdminLandingItem).contentHtml).toBe('<p>keep this</p><b>b</b>')
    // 4000 quotes are 4000 raw characters but 24000 once escaped
    const grows = await create('"'.repeat(4000))
    expect(grows.status).toBe(400)
    expect((await create('"'.repeat(3333))).status).toBe(200) // 19998
    // markup that is added also counts: <a> gets rel and target
    const links = Array.from({ length: 250 }, () => '<a href="https://example.com/x">y</a>').join('')
    expect(links.length).toBeLessThan(MAX_LANDING_CONTENT_HTML)
    expect(sanitizeHtml(links).length).toBeGreaterThan(MAX_LANDING_CONTENT_HTML)
    expect((await create(links)).status).toBe(400)
  })

  it('the same limits apply on PATCH, and a refused value changes nothing', async () => {
    expect((await patch('landing-article-1', { contentHtml: 'a'.repeat(MAX_LANDING_CONTENT_HTML + 1) })).status).toBe(400)
    expect((await patch('landing-article-1', { contentHtml: 'a'.repeat(MAX_LANDING_CONTENT_INPUT + 1) })).status).toBe(400)
    expect((await row('landing-article-1')).contentHtml).toBe('')
    const ok = await patch('landing-article-1', { contentHtml: 'a'.repeat(MAX_LANDING_CONTENT_HTML) })
    expect(ok.status).toBe(200)
    expect(((await ok.json()) as AdminLandingItem).contentHtml).toHaveLength(MAX_LANDING_CONTENT_HTML)
  })

  it('refuses a request body above 512 KB before reading it as JSON data', async () => {
    const big = JSON.stringify({ kind: 'article', title: 'x', body: '', junk: 'z'.repeat(600 * 1024) })
    const res = await call('POST', '/admin/landing/items', admin, big)
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('512') })
    const resPatch = await call('PATCH', '/admin/landing/items/landing-article-1', admin, big)
    expect(resPatch.status).toBe(400)
    expect((await getDoc()).items).toHaveLength(6)
    // the longest legal contentHtml in Thai (3 bytes a character, 60 KB) is far below that cap
    const heavy = await create('ก'.repeat(MAX_LANDING_CONTENT_HTML))
    expect(heavy.status).toBe(200)
  })

  it('a hostile document comes out safe on every read path', async () => {
    const hostile = [
      '<script>alert(1)</script>',
      '<p onclick="alert(1)" style="x:y">text</p>',
      '<a href="jav&#x09;ascript:alert(1)">a</a>',
      '<a href="&#106;avascript:alert(1)">b</a>',
      '<img src=x onerror=alert(1)>',
      '<svg><script>alert(1)</script></svg>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<math><mi xlink:href="javascript:alert(1)">m</mi></math>',
      '<style>@import "javascript:alert(1)"</style>',
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<form action="javascript:alert(1)"><input name=a></form>',
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">c</a>',
      '<a href="vbscript:msgbox(1)">d</a>',
      '<!--[if IE]><script>alert(1)</script><![endif]-->',
      '<p>\u0000<scr\u0000ipt>alert(1)</script></p>',
      '<a href="https://ok.example">fine</a>',
    ].join('\n')
    const a = await createArticle({ slug: 'hostile', contentHtml: hostile })
    const expected = sanitizeHtml(hostile)
    expect(a.contentHtml).toBe(expected)
    const page = (await (await getArticle('hostile')).json()) as LandingArticleDetail
    const doc = (await getDoc()).items.find((i) => i.id === a.id)
    for (const html of [a.contentHtml, page.contentHtml, doc?.contentHtml as string, (await row(a.id)).contentHtml]) {
      expect(html).toBe(expected)
      expect(html).not.toMatch(/<(?!\/?(?:p|strong|b|em|i|u|h2|h3|ul|ol|li|blockquote|br|a)\b)/i)
      expect(html).not.toMatch(/\bon\w+\s*=|javascript:|vbscript:|data:text/i)
      expect(html).toContain('<a href="https://ok.example" rel="noopener noreferrer nofollow" target="_blank">fine</a>')
    }
  })
})

// ---- how-to steps ----------------------------------------------------------------------------------

describe('how-to steps have no article fields', () => {
  it('POST: sending slug, contentHtml or publishedAt for a howto is a 400, whatever the value', async () => {
    const fields: [string, unknown][] = [
      ['slug', 'step-slug'],
      ['slug', null],
      ['slug', ''],
      ['contentHtml', '<p>x</p>'],
      ['contentHtml', ''],
      ['publishedAt', '2026-01-01T00:00:00Z'],
      ['publishedAt', null],
    ]
    for (const [field, value] of fields) {
      const res = await post({ kind: 'howto', title: 'ขั้นตอน', body: '', [field]: value })
      expect(res.status, `${field}=${JSON.stringify(value)}`).toBe(400)
      const err = await errorOf(res)
      expect(err.code).toBe('VALIDATION')
      expect(err.message).toMatch(/[฀-๿]/)
    }
    const all = await post({ kind: 'howto', title: 'x', body: '', slug: 'a-b', contentHtml: '<p>x</p>', publishedAt: '2026-01-01' })
    expect(all.status).toBe(400)
    expect((await getDoc()).items).toHaveLength(6)
  })

  it('POST: a plain howto still works and stays slug null, contentHtml "", publishedAt null', async () => {
    const res = await post({ kind: 'howto', title: 'ขั้นตอนใหม่', body: 'รายละเอียด', active: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ kind: 'howto', slug: null, contentHtml: '', publishedAt: null, active: false })
    const stored = await row(((await (await call('GET', '/admin/landing', admin)).json()) as AdminLanding).items.find((i) => i.title === 'ขั้นตอนใหม่')?.id as string)
    expect(stored).toMatchObject({ slug: null, contentHtml: '', publishedAt: null })
  })

  it('PATCH: the same three fields on a howto are a 400 (also null / "") and nothing changes', async () => {
    const before = await row('landing-howto-1')
    const bodies: Record<string, unknown>[] = [
      { slug: 'step-slug' },
      { slug: null },
      { slug: '' },
      { contentHtml: '<p>x</p>' },
      { contentHtml: '' },
      { publishedAt: '2026-01-01T00:00:00Z' },
      { publishedAt: null },
      { title: 'changed too', slug: 'step-slug' },
    ]
    for (const body of bodies) {
      const res = await patch('landing-howto-1', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION' })
    }
    expect(await row('landing-howto-1')).toEqual(before)
    // title / body / active are fine for a howto
    expect((await patch('landing-howto-1', { title: 'ok', body: 'ok', active: false })).status).toBe(200)
  })

  it('PATCH of an unknown item with article fields is 404; an invalid value is a 400 before that', async () => {
    const missing = await patch('does-not-exist', { slug: 'some-slug' })
    expect(missing.status).toBe(404)
    expect(await errorOf(missing)).toMatchObject({ code: 'NOT_FOUND' })
    expect((await patch('does-not-exist', { slug: 'BAD SLUG' })).status).toBe(400)
  })
})

// ---- PATCH an article ------------------------------------------------------------------------------

describe('patch an article', () => {
  it('changes slug, contentHtml and publishedAt, one at a time or together, and answers with the item', async () => {
    const res = await patch('landing-article-2', {
      slug: 'new-address',
      contentHtml: '<p>long <b>text</b></p><script>x()</script>',
      publishedAt: '2026-06-07T08:09:10+07:00',
    })
    expect(res.status).toBe(200)
    const item = (await res.json()) as AdminLandingItem
    expect(item).toMatchObject({
      id: 'landing-article-2',
      kind: 'article',
      slug: 'new-address',
      contentHtml: '<p>long <b>text</b></p>',
      publishedAt: '2026-06-07T01:09:10.000Z',
      sortOrder: 1,
      active: true,
    })
    expect(await row('landing-article-2')).toMatchObject({ slug: 'new-address', contentHtml: '<p>long <b>text</b></p>' })

    const onlyHtml = (await (await patch('landing-article-2', { contentHtml: '<p>again</p>' })).json()) as AdminLandingItem
    expect(onlyHtml).toMatchObject({ slug: 'new-address', contentHtml: '<p>again</p>', publishedAt: '2026-06-07T01:09:10.000Z' })
    const onlyDate = (await (await patch('landing-article-2', { publishedAt: '2030-01-01' })).json()) as AdminLandingItem
    expect(onlyDate).toMatchObject({ contentHtml: '<p>again</p>', publishedAt: '2030-01-01T00:00:00.000Z' })
    const cleared = (await (await patch('landing-article-2', { publishedAt: null, contentHtml: '' })).json()) as AdminLandingItem
    expect(cleared).toMatchObject({ publishedAt: null, contentHtml: '', slug: 'new-address' })
  })

  it('contentHtml is sanitized on PATCH as well, and whitespace only clears it', async () => {
    const res = await patch('landing-article-1', { contentHtml: '<h2 class="x" onclick="y">T</h2><a href="javascript:z">l</a>' })
    expect(((await res.json()) as AdminLandingItem).contentHtml).toBe('<h2>T</h2>l')
    const cleared = await patch('landing-article-1', { contentHtml: '  \n ' })
    expect(((await cleared.json()) as AdminLandingItem).contentHtml).toBe('')
  })

  it('setting the slug it already has is fine', async () => {
    const res = await patch('landing-article-1', { slug: 'all-lotteries', title: 'same address' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ slug: 'all-lotteries', title: 'same address' })
  })

  it('a slug another article has is 409 SLUG_TAKEN, with nothing else applied', async () => {
    const res = await patch('landing-article-2', { slug: 'all-lotteries', title: 'must not apply', contentHtml: '<p>no</p>' })
    expect(res.status).toBe(409)
    const err = await errorOf(res)
    expect(err.code).toBe('SLUG_TAKEN')
    expect(err.message).toMatch(/[฀-๿]/)
    expect(await row('landing-article-2')).toMatchObject({ slug: 'customize-card', title: seedRows.find((r) => r.id === 'landing-article-2')?.title, contentHtml: '' })
    // an inactive article keeps its address too
    await patch('landing-article-3', { active: false })
    expect((await patch('landing-article-2', { slug: 'notify-time' })).status).toBe(409)
  })

  it('two PATCHes racing for the same free slug: one wins, the other is SLUG_TAKEN', async () => {
    const results = await Promise.all([
      patch('landing-article-1', { slug: 'contested' }),
      patch('landing-article-2', { slug: 'contested' }),
      patch('landing-article-3', { slug: 'contested' }),
    ])
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    for (const r of results) if (r.status !== 200) {
      expect(r.status).toBe(409)
      expect(await errorOf(r)).toMatchObject({ code: 'SLUG_TAKEN' })
    }
    expect(await getDb(env).select().from(landingItems).where(eq(landingItems.slug, 'contested'))).toHaveLength(1)
  })

  it('an article always keeps a slug: null and "" are 400s; invalid slugs and bad values are 400s', async () => {
    const bad: Record<string, unknown>[] = [
      { slug: null }, { slug: '' }, { slug: 'ab' }, { slug: 'AB-CD' }, { slug: 'a b' }, { slug: '-ab' }, { slug: 'ab-' },
      { slug: 'x'.repeat(81) }, { slug: 5 }, { slug: ['abc'] },
      { publishedAt: '' }, { publishedAt: 'nope' }, { publishedAt: '2026-02-30' }, { publishedAt: 5 }, { publishedAt: false },
      { contentHtml: null }, { contentHtml: 5 }, { contentHtml: ['<p>x</p>'] },
    ]
    for (const body of bad) {
      const res = await patch('landing-article-1', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect(await errorOf(res)).toMatchObject({ code: 'VALIDATION' })
    }
    expect(await row('landing-article-1')).toMatchObject({ slug: 'all-lotteries' })
  })

  it('an empty PATCH returns the item as it is, including the new fields', async () => {
    const res = await patch('landing-article-3', {})
    expect(res.status).toBe(200)
    const seed = seedRows.find((r) => r.id === 'landing-article-3')
    expect(await res.json()).toMatchObject({ slug: 'notify-time', contentHtml: '', publishedAt: seed?.publishedAt })
  })

  it('the order endpoint, the image endpoints and GET /admin/landing all return the new fields', async () => {
    await patch('landing-article-2', { contentHtml: '<p>kept</p>' })
    const ids = ['landing-article-3', 'landing-article-2', 'landing-article-1']
    const order = await call('PUT', '/admin/landing/items/order', admin, { kind: 'article', ids })
    const list = (await order.json()) as AdminLandingItem[]
    expect(list.map((i) => i.id)).toEqual(ids)
    for (const i of list) {
      expect(Object.keys(i).sort()).toEqual(['active', 'body', 'contentHtml', 'id', 'imageUrl', 'kind', 'publishedAt', 'slug', 'sortOrder', 'title'])
    }
    expect(list[1]).toMatchObject({ slug: 'customize-card', contentHtml: '<p>kept</p>' })
    // howto list: slug null, contentHtml "", publishedAt null
    const steps = (await (await call('PUT', '/admin/landing/items/order', admin, { kind: 'howto', ids: ['landing-howto-1', 'landing-howto-2', 'landing-howto-3'] })).json()) as AdminLandingItem[]
    for (const s of steps) expect(s).toMatchObject({ slug: null, contentHtml: '', publishedAt: null })

    const up = new FormData()
    up.append('file', new File([pngBytes], 'a.png', { type: 'image/png' }))
    const withCover = (await (await app.request('/admin/landing/items/landing-article-2/image', { method: 'POST', body: up, headers: { Cookie: admin } }, env)).json()) as AdminLandingItem
    expect(withCover).toMatchObject({ slug: 'customize-card', contentHtml: '<p>kept</p>' })
    expect(withCover.imageUrl).toMatch(/\/landing\/image\//)
    const removed = (await (await call('DELETE', '/admin/landing/items/landing-article-2/image', admin)).json()) as AdminLandingItem
    expect(removed).toMatchObject({ imageUrl: null, slug: 'customize-card', contentHtml: '<p>kept</p>' })
    const doc = await getDoc()
    expect(doc.items.find((i) => i.id === 'landing-article-2')).toMatchObject({ contentHtml: '<p>kept</p>', slug: 'customize-card' })
  })
})

// ---- auth and CSRF -----------------------------------------------------------------------------------

describe('the new fields change nothing about who may write', () => {
  const bodies = {
    post: { kind: 'article', title: 'x', body: '', slug: 'no-session', contentHtml: '<p>x</p>', publishedAt: '2026-01-01' },
    patch: { slug: 'no-session', contentHtml: '<p>x</p>', publishedAt: '2026-01-01' },
  }

  it('without an admin session: 401 and nothing is written', async () => {
    const created = await call('POST', '/admin/landing/items', undefined, bodies.post)
    expect(created.status).toBe(401)
    const patched = await call('PATCH', '/admin/landing/items/landing-article-1', undefined, bodies.patch)
    expect(patched.status).toBe(401)
    expect(await row('landing-article-1')).toMatchObject({ slug: 'all-lotteries', contentHtml: '' })
    expect((await getDoc()).items).toHaveLength(6)
  })

  it('from a foreign Origin: 403 and nothing is written', async () => {
    const evil = { Origin: 'https://evil.example' }
    expect((await call('POST', '/admin/landing/items', admin, bodies.post, evil)).status).toBe(403)
    expect((await call('PATCH', '/admin/landing/items/landing-article-1', admin, bodies.patch, evil)).status).toBe(403)
    expect(await row('landing-article-1')).toMatchObject({ slug: 'all-lotteries', contentHtml: '' })
    expect((await getDoc()).items).toHaveLength(6)
    const ok = await call('POST', '/admin/landing/items', admin, bodies.post, { Origin: 'http://localhost:5173' })
    expect(ok.status).toBe(200)
  })
})
