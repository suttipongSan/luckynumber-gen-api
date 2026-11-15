// HTTP tests for the public landing page: GET /landing, GET /landing/image/:name and the back
// office /admin/landing endpoints. Real libSQL file DB with the project's migrations (so the rows
// seeded by 0006 are the ones production gets) and a fake R2 bucket. The article pages (slug,
// formatted text, GET /landing/articles/:slug, migration 0007) are tested in articles.test.ts and
// the HTML sanitizer in sanitizeHtml.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, rmSync } from 'node:fs'
import { eq, like } from 'drizzle-orm'
import app from '../src/index'
import type {
  AdminLanding,
  AdminLandingItem,
  AssetBucket,
  Bindings,
  LandingResponse,
} from '../src/types'
import { MAX_ASSET_BYTES, MAX_LANDING_ITEMS_PER_KIND } from '../src/types'
import { hashPassword } from '../src/lib/crypto'
import { resetLimiter } from '../src/lib/loginLimiter'
import { getDb } from '../src/db/client'
import { openDb, runMigrations } from '../scripts/db'
import { landingItems, siteSettings } from '../src/db/schema'
import {
  LANDING_DEFAULTS,
  LANDING_SETTING_KEYS,
  hasImageSignature,
  isLandingImageName,
  landingImageUrl,
  overlayLandingSettings,
} from '../src/lib/landing'
import { SITE_SETTING_KEYS } from '../src/lib/siteSettings'

const DB_FILE = 'test-landing.db'
const DB_URL = `file:${DB_FILE}`

class FakeR2 implements AssetBucket {
  objects = new Map<string, { bytes: Uint8Array; contentType?: string }>()
  /** Keys whose delete() throws, to prove that removing an old file is best effort. */
  failDeleteFor = new Set<string>()
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
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      if (this.failDeleteFor.has(k)) throw new Error('R2 is down')
      this.objects.delete(k)
    }
  }
}

const r2 = new FakeR2()
let env: Bindings
let admin = ''
/** The rows migration 0006 seeded, captured once so every test can start from them again. */
let seedRows: (typeof landingItems.$inferSelect)[] = []

function removeDb() {
  for (const f of [DB_FILE, `${DB_FILE}-journal`, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
    if (existsSync(f)) rmSync(f)
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

/** multipart/form-data POST with an optional `file` part (field name overridable). */
function upload(
  path: string,
  cookie: string | undefined,
  file: File | null,
  opts: { field?: string; headers?: Record<string, string>; method?: string } = {},
) {
  const form = new FormData()
  if (file) form.append(opts.field ?? 'file', file)
  const headers: Record<string, string> = { ...opts.headers }
  if (cookie) headers.Cookie = cookie
  return app.request(path, { method: opts.method ?? 'POST', body: form, headers }, env)
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

/** A member session cookie, created through the back office like the other test files do. */
async function memberCookie(): Promise<string> {
  const created = await call('POST', '/admin/members', admin, {
    displayName: 'landing-test',
    expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
  })
  const m = (await created.json()) as { linkToken: string }
  const sp = await call('POST', `/link/${m.linkToken}/set-password`, undefined, { password: 'password-123' })
  expect(sp.status).toBe(204)
  return cookieFrom(sp, 'ng_session')
}

async function getDoc(): Promise<AdminLanding> {
  const res = await call('GET', '/admin/landing', admin)
  expect(res.status).toBe(200)
  return (await res.json()) as AdminLanding
}

async function getPublic(): Promise<LandingResponse> {
  const res = await app.request('/landing', {}, env)
  expect(res.status).toBe(200)
  return (await res.json()) as LandingResponse
}

async function createItem(
  kind: 'article' | 'howto',
  title: string,
  extra: Record<string, unknown> = {},
): Promise<AdminLandingItem> {
  const res = await call('POST', '/admin/landing/items', admin, { kind, title, body: '', ...extra })
  expect(res.status).toBe(200)
  return (await res.json()) as AdminLandingItem
}

const bytes = (...n: number[]) => new Uint8Array(n)
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0))
// The API checks the first bytes of an upload against its declared type, so image fixtures must
// start with a real signature: png() / jpg() / webp() build one, `tail` stands in for the image data.
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const png = (...tail: number[]) => bytes(...PNG_SIGNATURE, ...tail)
const jpg = (...tail: number[]) => bytes(255, 216, 255, 224, ...tail)
const webp = (...tail: number[]) => bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...tail)
const pngFile = (data: Uint8Array<ArrayBuffer> = png(1)) =>
  new File([data], 'a.png', { type: 'image/png' })
const jpgFile = (data: Uint8Array<ArrayBuffer> = jpg(2)) =>
  new File([data], 'a.jpg', { type: 'image/jpeg' })
const webpFile = (data: Uint8Array<ArrayBuffer> = webp(3)) =>
  new File([data], 'a.webp', { type: 'image/webp' })
/** A png-labelled file of exactly `size` bytes that still starts with a real PNG signature. */
const pngOfSize = (size: number) => {
  const data = new Uint8Array(size)
  data.set(png())
  return pngFile(data)
}
/** A file that DECLARES `type` whatever its bytes are (a client can always do that). */
const labelled = (type: string, data: Uint8Array<ArrayBuffer> | string) =>
  new File([data], `a.${type.split('/')[1]}`, { type })
const NOT_AN_IMAGE = { error: { code: 'VALIDATION', message: 'ไฟล์ไม่ใช่รูปภาพ png, jpg หรือ webp ที่ถูกต้อง' } }

/** File name part of an absolute image URL. */
const nameOf = (url: string | null) => (url as string).split('/').pop() as string
/** Every R2 key the landing page owns. */
const landingKeys = () => [...r2.objects.keys()].filter((k) => k.startsWith('landing/')).sort()
const arr = (u: Uint8Array) => Array.from(u)

async function resetLanding() {
  const db = getDb(env)
  await db.delete(landingItems)
  // every landing_* row, including keys no code knows about (one test plants such a row)
  await db.delete(siteSettings).where(like(siteSettings.key, 'landing_%'))
  await db.insert(landingItems).values(seedRows)
  r2.objects.clear()
  r2.failDeleteFor.clear()
}

// ---- fixtures from the contract ------------------------------------------------------------------

// Migration 0007 gave each starter article its address; published_at starts as created_at (the
// moment the migration ran), so it is read from the seeded rows, see `beforeAll`.
const SEED_ARTICLES = [
  {
    id: 'landing-article-1',
    slug: 'all-lotteries',
    title: 'ครบทุกหวย ทุกรอบ',
    body: 'ฮานอย ลาว หุ้น และหวยอื่น ๆ พร้อมใช้ทันที เพิ่มหวยของตัวเองได้ จัดเป็นชุดตามรอบเวลาที่ลง',
  },
  {
    id: 'landing-article-2',
    slug: 'customize-card',
    title: 'ปรับแต่งได้ทั้งใบ',
    body: 'เปลี่ยนพื้นหลัง โลโก้ ฟอนต์ สี ขนาดกรอบ ใส่ QR และข้อความของคุณเอง บันทึกดีไซน์ไว้ใช้ได้ทุกวัน',
  },
  {
    id: 'landing-article-3',
    slug: 'notify-time',
    title: 'แจ้งเตือนเมื่อถึงเวลาลง',
    body: 'ตั้งเวลาลงของแต่ละหวย ระบบเตือนบนมือถือและคอมเมื่อถึงเวลา ไม่พลาดทุกรอบ',
  },
]
/** An ISO-8601 UTC timestamp as `Date#toISOString` prints it. */
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** What a freshly created article gets as its address when none is sent: `a-` + 8 hex characters. */
const AUTO_SLUG_RE = /^a-[0-9a-f]{8}$/
const SEED_STEPS = [
  {
    id: 'landing-howto-1',
    title: 'เปิดลิงก์ส่วนตัว',
    body: 'สมัครผ่าน Line หรือ Telegram ทีมงานจะส่งลิงก์ส่วนตัวให้ เปิดแล้วตั้งรหัสผ่านได้เลย',
  },
  {
    id: 'landing-howto-2',
    title: 'เลือกหวย แล้วกดสุ่ม',
    body: 'เลือกหวยที่ต้องการ กำหนดเลขวิ่งเองหรือให้ระบบสุ่ม แล้วปรับหน้าตาใบตามชอบ',
  },
  {
    id: 'landing-howto-3',
    title: 'ดาวน์โหลดหรือคัดลอก',
    body: 'ดาวน์โหลดเป็นรูป คัดลอก หรือแชร์ได้ทันที ทำทีละใบหรือทั้งชุดก็ได้',
  },
]

const DEFAULT_PUBLIC: LandingResponse = {
  heroColor: '#7c2d12',
  heroTitle: 'โปรแกรมทำใบใบ้หวย สวย ไว ในคลิกเดียว',
  heroSubtitle: 'สุ่มเลข จัดหน้าตา ดาวน์โหลดพร้อมโพสต์ ครบทุกหวยทุกรอบ',
  logoUrl: null,
  promoUrl: null,
  articlesTitle: 'ทำไมต้อง PNPHOTO',
  articlesSubtitle: '',
  howtoTitle: 'วิธีใช้งาน',
  howtoSubtitle: 'เริ่มใช้ได้ใน 3 ขั้นตอน',
  // publishedAt is filled in from the seeded rows once the migrations have run (see `beforeAll`).
  articles: SEED_ARTICLES.map((a) => ({ ...a, imageUrl: null, publishedAt: null as string | null })),
  steps: SEED_STEPS.map((s) => ({ ...s, imageUrl: null })),
}

// ---- setup ---------------------------------------------------------------------------------------

beforeAll(async () => {
  removeDb()
  await runMigrations(DB_URL)
  const { client, db } = openDb(DB_URL)
  seedRows = await db.select().from(landingItems)
  client.close()
  for (const a of DEFAULT_PUBLIC.articles) {
    a.publishedAt = seedRows.find((r) => r.id === a.id)?.createdAt ?? null
  }
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
  try {
    removeDb()
  } catch {
    // file may still be held open on Windows; harmless
  }
})

// ---- migration -----------------------------------------------------------------------------------

describe('migration 0006', () => {
  it('creates landing_items with its (kind, sort_order) index and seeds the six starter rows', async () => {
    const { client } = openDb(DB_URL)
    try {
      const idx = await client.execute(
        "select name, sql from sqlite_master where type = 'index' and tbl_name = 'landing_items'",
      )
      const names = idx.rows.map((r) => String(r.name))
      expect(names).toContain('landing_items_kind_sort_idx')
      const ddl = String(idx.rows.find((r) => r.name === 'landing_items_kind_sort_idx')?.sql)
      expect(ddl.replace(/[`"]/g, '')).toMatch(/\(kind,\s*sort_order\)/)
    } finally {
      client.close()
    }

    expect(seedRows).toHaveLength(6)
    const byId = new Map(seedRows.map((r) => [r.id, r]))
    for (const [kind, list] of [
      ['article', SEED_ARTICLES],
      ['howto', SEED_STEPS],
    ] as const) {
      list.forEach((s, i) => {
        expect(byId.get(s.id), s.id).toMatchObject({
          kind,
          title: s.title,
          body: s.body,
          imageKey: null,
          sortOrder: i,
          active: true,
        })
      })
    }
    for (const r of seedRows) {
      expect(r.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(Number.isFinite(Date.parse(r.createdAt))).toBe(true)
      expect(r.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    }
  })

  it('writes no landing_* rows into site_settings (the page falls back to the defaults)', async () => {
    const rows = await getDb(env).select().from(siteSettings).where(like(siteSettings.key, 'landing_%'))
    expect(rows).toEqual([])
  })
})

// ---- GET /landing (public) -----------------------------------------------------------------------

describe('GET /landing', () => {
  it('returns the defaults and the seeded items on a database with no landing settings rows', async () => {
    const res = await app.request('/landing', {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    expect(await res.json()).toEqual(DEFAULT_PUBLIC)
  })

  it('needs no session and is not blocked by a bogus member or admin cookie', async () => {
    const res = await app.request(
      '/landing',
      { headers: { Cookie: 'ng_session=nope.nope; ng_admin=nope.nope' } },
      env,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(DEFAULT_PUBLIC)
  })

  it('exposes exactly the contract fields (an article card has slug / imageUrl / publishedAt, a step has imageUrl only)', async () => {
    const body = await getPublic()
    expect(Object.keys(body).sort()).toEqual(
      [
        'heroColor',
        'heroTitle',
        'heroSubtitle',
        'logoUrl',
        'promoUrl',
        'articlesTitle',
        'articlesSubtitle',
        'howtoTitle',
        'howtoSubtitle',
        'articles',
        'steps',
      ].sort(),
    )
    for (const a of body.articles) {
      expect(Object.keys(a).sort()).toEqual(['body', 'id', 'imageUrl', 'publishedAt', 'slug', 'title'])
    }
    for (const s of body.steps) expect(Object.keys(s).sort()).toEqual(['body', 'id', 'imageUrl', 'title'])
  })

  it('never lists inactive items, and never leaks the image of an inactive step', async () => {
    const withImage = await upload('/admin/landing/items/landing-howto-2/image', admin, pngFile())
    expect(withImage.status).toBe(200)
    const secretName = nameOf(((await withImage.json()) as AdminLandingItem).imageUrl)

    for (const id of ['landing-article-2', 'landing-howto-2']) {
      const res = await call('PATCH', `/admin/landing/items/${id}`, admin, { active: false })
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ id, active: false })
    }
    const res = await app.request('/landing', {}, env)
    const text = await res.text()
    const body = JSON.parse(text) as LandingResponse
    expect(body.articles.map((a) => a.id)).toEqual(['landing-article-1', 'landing-article-3'])
    expect(body.steps.map((s) => s.id)).toEqual(['landing-howto-1', 'landing-howto-3'])
    expect(text).not.toContain('landing-article-2')
    expect(text).not.toContain('landing-howto-2')
    expect(text).not.toContain(secretName)
    // the back office still lists them
    const doc = await getDoc()
    expect(doc.items.find((i) => i.id === 'landing-article-2')).toMatchObject({ active: false })
    expect(doc.items).toHaveLength(6)

    // an item created inactive is hidden from the start
    const hidden = await createItem('howto', 'ซ่อนไว้', { active: false })
    expect(hidden.active).toBe(false)
    expect((await getPublic()).steps.map((s) => s.id)).not.toContain(hidden.id)

    // switching it back on shows it again
    await call('PATCH', `/admin/landing/items/${hidden.id}`, admin, { active: true })
    expect((await getPublic()).steps.map((s) => s.id)).toContain(hidden.id)
  })

  it('lists items by sort_order, not by id or insertion order', async () => {
    const db = getDb(env)
    await db.update(landingItems).set({ sortOrder: 5 }).where(eq(landingItems.id, 'landing-article-1'))
    await db.update(landingItems).set({ sortOrder: -1 }).where(eq(landingItems.id, 'landing-article-3'))
    await db.update(landingItems).set({ sortOrder: 2 }).where(eq(landingItems.id, 'landing-howto-1'))
    await db.update(landingItems).set({ sortOrder: 0 }).where(eq(landingItems.id, 'landing-howto-3'))
    await db.update(landingItems).set({ sortOrder: 1 }).where(eq(landingItems.id, 'landing-howto-2'))
    const body = await getPublic()
    expect(body.articles.map((a) => a.id)).toEqual([
      'landing-article-3',
      'landing-article-2',
      'landing-article-1',
    ])
    expect(body.steps.map((s) => s.id)).toEqual(['landing-howto-3', 'landing-howto-2', 'landing-howto-1'])
  })

  it('a stored value overrides the default; a stored empty heading stays empty', async () => {
    const db = getDb(env)
    const updatedAt = new Date().toISOString()
    await db.insert(siteSettings).values([
      { key: 'landing_hero_color', value: '#112233', updatedAt },
      { key: 'landing_hero_title', value: '', updatedAt },
      { key: 'landing_howto_title', value: 'ขั้นตอน', updatedAt },
      { key: 'landing_not_a_key', value: 'ignored', updatedAt },
    ])
    const body = await getPublic()
    expect(body).toMatchObject({
      heroColor: '#112233',
      heroTitle: '',
      heroSubtitle: DEFAULT_PUBLIC.heroSubtitle,
      howtoTitle: 'ขั้นตอน',
      howtoSubtitle: DEFAULT_PUBLIC.howtoSubtitle,
      articlesTitle: DEFAULT_PUBLIC.articlesTitle,
    })
    expect(JSON.stringify(body)).not.toContain('ignored')
  })

  it('ignores a stored hero colour that is not #RRGGBB (manual database edit)', async () => {
    await getDb(env)
      .insert(siteSettings)
      .values({
        key: 'landing_hero_color',
        value: 'red;background:url(//evil.example)',
        updatedAt: new Date().toISOString(),
      })
    expect((await getPublic()).heroColor).toBe('#7c2d12')
  })

  it('answers with empty lists when every item is deleted or inactive', async () => {
    await getDb(env).delete(landingItems)
    const body = await getPublic()
    expect(body.articles).toEqual([])
    expect(body.steps).toEqual([])
    expect(body.heroColor).toBe('#7c2d12')
  })

  it('does not change GET /contacts or the GET/PUT /admin/settings shape', async () => {
    const settings = await (await call('GET', '/admin/settings', admin)).json()
    expect(Object.keys(settings as object).sort()).toEqual([
      'contactLineId',
      'contactLineUrl',
      'contactTelegramId',
      'contactTelegramUrl',
      'renderLimitDefault',
      'testsiteEnabled',
    ])
    // saving landing values leaves the existing settings alone, and the reverse
    await call('PUT', '/admin/landing', admin, { heroTitle: 'หัวข้อใหม่' })
    const put = await call('PUT', '/admin/settings', admin, {
      contactLineId: '@a',
      contactLineUrl: 'https://line.me/R/ti/p/@a',
      contactTelegramId: '@b',
      contactTelegramUrl: 'https://t.me/b',
      renderLimitDefault: 700,
    })
    expect(put.status).toBe(200)
    expect(Object.keys((await put.json()) as object)).toHaveLength(6)
    expect((await getPublic()).heroTitle).toBe('หัวข้อใหม่')
    expect(await (await app.request('/contacts', {}, env)).json()).toEqual({
      line: { id: '@a', url: 'https://line.me/R/ti/p/@a' },
      telegram: { id: '@b', url: 'https://t.me/b' },
    })
  })
})

// ---- GET /landing/image/:name (public) -----------------------------------------------------------

describe('GET /landing/image/:name', () => {
  it('serves the stored bytes with the right type and an immutable cache header, without a session', async () => {
    const cases: [string, string][] = [
      ['abcdefgh12345678.png', 'image/png'],
      ['abcdefgh12345678.jpg', 'image/jpeg'],
      ['abcdefgh12345678.jpeg', 'image/jpeg'],
      ['abcdefgh12345678.webp', 'image/webp'],
      ['A-b_C-d_E-f_G-h_I-j_K-l_M-n.png', 'image/png'], // upper case, '-' and '_' are allowed
      [`${'z'.repeat(64)}.png`, 'image/png'], // the longest id
      ['abcdefgh.png', 'image/png'], // the shortest id
    ]
    for (const [name, type] of cases) {
      const data = bytes(1, 2, 3, name.length)
      await r2.put(`landing/${name}`, data, { httpMetadata: { contentType: 'application/x-wrong' } })
      const res = await app.request(`/landing/image/${name}`, {}, env)
      expect(res.status, name).toBe(200)
      expect(res.headers.get('content-type'), name).toBe(type)
      expect(res.headers.get('cache-control'), name).toBe('public, max-age=31536000, immutable')
      expect(res.headers.get('x-content-type-options'), name).toBe('nosniff')
      expect(res.headers.get('content-length'), name).toBe(String(data.byteLength))
      expect(arr(new Uint8Array(await res.arrayBuffer())), name).toEqual(arr(data))
    }
  })

  it('answers 404 (JSON error) for names outside ^[A-Za-z0-9_-]{8,64}\\.(png|jpg|jpeg|webp)$ without reading R2', async () => {
    const get = vi.spyOn(r2, 'get')
    try {
      const bad = [
        'short.png', // id part under 8 chars
        `${'a'.repeat(65)}.png`, // id part over 64 chars
        'abcdefgh12345678.gif',
        'abcdefgh12345678.svg',
        'abcdefgh12345678.avif',
        'abcdefgh12345678.PNG', // extensions are lower case
        'abcdefgh12345678', // no extension
        'abcdefgh12345678.png.png',
        'abcdefgh.12345678.png', // a dot inside the id part
        '.png',
        '..%2F..%2Fmembers%2Fm1%2Fassets%2Fabcdefgh12345678.png', // encoded ../
        '%2e%2e%2f%2e%2e%2fabcdefgh12345678.png',
        '..%5C..%5Cabcdefgh12345678.png', // encoded ..\
        '%252e%252e%252fabcdefgh12345678.png', // double encoded
        'abcdefgh12345678.png%00.png', // NUL byte
        'abcdefgh12345678.png%0A', // trailing newline must not slip past the $ anchor
        'abcdefgh%2F12345678.png',
        'abcdefgh 12345678.png',
        'ไทยไทยไทยไทยไทย.png',
      ]
      for (const name of bad) {
        const res = await app.request(`/landing/image/${name}`, {}, env)
        expect(res.status, name).toBe(404)
        expect(await res.json(), name).toMatchObject({ error: { code: 'NOT_FOUND' } })
      }
      // a literal ../ is normalised by the URL parser and lands on an unknown route
      expect((await app.request('/landing/image/../x.png', {}, env)).status).toBe(404)
      expect((await app.request('/landing/image/', {}, env)).status).toBe(404)
      expect((await app.request('/landing/image', {}, env)).status).toBe(404)
      expect(get).not.toHaveBeenCalled()
    } finally {
      get.mockRestore()
    }
  })

  it('answers 404 for a well formed name that is not stored', async () => {
    const res = await app.request('/landing/image/abcdefgh12345678.png', {}, env)
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
  })

  it('only ever reads keys under landing/, never member assets or other prefixes', async () => {
    const secret = bytes(9, 9, 9)
    await r2.put('members/m1/assets/abcdefgh12345678.png', secret)
    await r2.put('abcdefgh12345678.png', secret)
    await r2.put('secret/abcdefgh12345678.png', secret)
    const get = vi.spyOn(r2, 'get')
    try {
      for (const name of [
        'abcdefgh12345678.png',
        '..%2Fsecret%2Fabcdefgh12345678.png',
        '..%2Fmembers%2Fm1%2Fassets%2Fabcdefgh12345678.png',
      ]) {
        expect((await app.request(`/landing/image/${name}`, {}, env)).status, name).toBe(404)
      }
      // the only lookup that reached R2 used the fixed prefix
      expect(get.mock.calls.map((c) => c[0])).toEqual(['landing/abcdefgh12345678.png'])
    } finally {
      get.mockRestore()
    }
  })
})

// ---- admin: auth ---------------------------------------------------------------------------------

describe('admin landing auth', () => {
  const ENDPOINTS: [string, string, unknown?][] = [
    ['GET', '/admin/landing'],
    ['PUT', '/admin/landing', { heroTitle: 'x' }],
    ['POST', '/admin/landing/image/logo'],
    ['DELETE', '/admin/landing/image/logo'],
    ['POST', '/admin/landing/image/promo'],
    ['DELETE', '/admin/landing/image/promo'],
    ['POST', '/admin/landing/items', { kind: 'article', title: 'x', body: '' }],
    ['PATCH', '/admin/landing/items/landing-article-1', { title: 'x' }],
    ['DELETE', '/admin/landing/items/landing-article-1'],
    ['POST', '/admin/landing/items/landing-howto-1/image'],
    ['DELETE', '/admin/landing/items/landing-howto-1/image'],
    ['PUT', '/admin/landing/items/order', { kind: 'article', ids: SEED_ARTICLES.map((a) => a.id).reverse() }],
  ]

  async function hitAll(cookie: string | undefined) {
    for (const [method, path, body] of ENDPOINTS) {
      const res =
        method === 'POST' && path.includes('/image')
          ? await upload(path, cookie, pngFile())
          : await call(method, path, cookie, body)
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(await res.json(), `${method} ${path}`).toMatchObject({ error: { code: 'UNAUTHENTICATED' } })
    }
  }

  async function expectUntouched() {
    expect(landingKeys()).toEqual([])
    const doc = await getDoc()
    expect(doc.items.map((i) => i.id)).toEqual([...SEED_ARTICLES, ...SEED_STEPS].map((s) => s.id))
    expect(doc.items.every((i) => i.imageUrl === null && i.active)).toBe(true)
    expect(doc.settings).toMatchObject({ heroTitle: DEFAULT_PUBLIC.heroTitle, logoUrl: null, promoUrl: null })
  }

  it('every endpoint is 401 without a session and changes nothing', async () => {
    await hitAll(undefined)
    await expectUntouched()
  })

  it('a member session is not an admin session', async () => {
    const member = await memberCookie()
    await hitAll(member)
    await hitAll(member.replace('ng_session=', 'ng_admin='))
    await expectUntouched()
  })

  it('a tampered admin cookie is refused', async () => {
    await hitAll(admin.slice(0, -2) + 'aa')
    await expectUntouched()
  })
})

// ---- admin: GET / PUT /admin/landing --------------------------------------------------------------

describe('GET and PUT /admin/landing', () => {
  it('GET returns the defaults and ALL items ordered by kind, then sortOrder', async () => {
    const doc = await getDoc()
    expect(doc.settings).toEqual({
      heroColor: '#7c2d12',
      heroTitle: DEFAULT_PUBLIC.heroTitle,
      heroSubtitle: DEFAULT_PUBLIC.heroSubtitle,
      articlesTitle: 'ทำไมต้อง PNPHOTO',
      articlesSubtitle: '',
      howtoTitle: 'วิธีใช้งาน',
      howtoSubtitle: 'เริ่มใช้ได้ใน 3 ขั้นตอน',
      logoUrl: null,
      promoUrl: null,
    })
    expect(doc.items).toEqual([
      ...DEFAULT_PUBLIC.articles.map((a, i) => ({
        ...a,
        kind: 'article',
        imageUrl: null,
        sortOrder: i,
        active: true,
        contentHtml: '',
      })),
      ...SEED_STEPS.map((s, i) => ({
        ...s,
        kind: 'howto',
        imageUrl: null,
        sortOrder: i,
        active: true,
        slug: null,
        contentHtml: '',
        publishedAt: null,
      })),
    ])
    // inactive items and a shuffled sort order do not change that ordering rule
    await call('PATCH', '/admin/landing/items/landing-article-1', admin, { active: false })
    await getDb(env).update(landingItems).set({ sortOrder: 9 }).where(eq(landingItems.id, 'landing-article-1'))
    const after = await getDoc()
    expect(after.items.map((i) => i.id)).toEqual([
      'landing-article-2',
      'landing-article-3',
      'landing-article-1',
      'landing-howto-1',
      'landing-howto-2',
      'landing-howto-3',
    ])
  })

  it('PUT saves any subset, trims, answers with the whole document and shows on the public page', async () => {
    const res = await call('PUT', '/admin/landing', admin, {
      heroColor: '#AbCdEf',
      heroTitle: '  หัวข้อใหม่  ',
      howtoSubtitle: 'ง่ายมาก',
    })
    expect(res.status).toBe(200)
    const doc = (await res.json()) as AdminLanding
    expect(doc.settings).toMatchObject({
      heroColor: '#AbCdEf', // stored as typed
      heroTitle: 'หัวข้อใหม่',
      heroSubtitle: DEFAULT_PUBLIC.heroSubtitle, // untouched
      howtoSubtitle: 'ง่ายมาก',
    })
    expect(doc.items).toHaveLength(6)
    expect(await getDoc()).toEqual(doc)
    expect(await getPublic()).toMatchObject({
      heroColor: '#AbCdEf',
      heroTitle: 'หัวข้อใหม่',
      howtoSubtitle: 'ง่ายมาก',
    })

    // a second PUT only touches the fields it sends
    const second = (await (await call('PUT', '/admin/landing', admin, { articlesTitle: 'จุดเด่น' })).json()) as AdminLanding
    expect(second.settings).toMatchObject({ heroColor: '#AbCdEf', heroTitle: 'หัวข้อใหม่', articlesTitle: 'จุดเด่น' })
  })

  it('PUT accepts all seven fields at their maximum lengths and empty headings', async () => {
    const full = {
      heroColor: '#000000',
      heroTitle: 'ก'.repeat(120),
      heroSubtitle: 'ข'.repeat(200),
      articlesTitle: 'ค'.repeat(120),
      articlesSubtitle: 'ง'.repeat(200),
      howtoTitle: 'จ'.repeat(120),
      howtoSubtitle: 'ฉ'.repeat(200),
    }
    const res = await call('PUT', '/admin/landing', admin, full)
    expect(res.status).toBe(200)
    expect(((await res.json()) as AdminLanding).settings).toMatchObject(full)

    const empty = await call('PUT', '/admin/landing', admin, {
      heroTitle: '',
      heroSubtitle: '   ',
      articlesTitle: '',
      articlesSubtitle: '',
      howtoTitle: '',
      howtoSubtitle: '',
    })
    expect(empty.status).toBe(200)
    expect(await getPublic()).toMatchObject({
      heroTitle: '',
      heroSubtitle: '',
      articlesTitle: '',
      articlesSubtitle: '',
      howtoTitle: '',
      howtoSubtitle: '',
      heroColor: '#000000',
    })
  })

  it('PUT {} is accepted and changes nothing', async () => {
    const before = await getDoc()
    const res = await call('PUT', '/admin/landing', admin, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(before)
    const rows = await getDb(env).select().from(siteSettings).where(like(siteSettings.key, 'landing_%'))
    expect(rows).toEqual([])
  })

  it('PUT rejects a bad colour with 400 VALIDATION and saves nothing, not even the valid fields', async () => {
    const before = await getDoc()
    const colours = [
      'red',
      '#fff',
      '#ffff',
      '7c2d12',
      '#7c2d1',
      '#7c2d123',
      '#12345g',
      '#7c2d12 ',
      ' #7c2d12',
      '#7c2d12\n',
      '#7c2d12;background:url(//evil.example)',
      'rgb(0,0,0)',
      '',
    ]
    for (const heroColor of colours) {
      const res = await call('PUT', '/admin/landing', admin, { heroColor, heroTitle: 'ไม่ควรถูกบันทึก' })
      expect(res.status, JSON.stringify(heroColor)).toBe(400)
      expect(await res.json(), JSON.stringify(heroColor)).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    expect((await call('PUT', '/admin/landing', admin, { heroColor: 123456 })).status).toBe(400)
    expect((await call('PUT', '/admin/landing', admin, { heroColor: null })).status).toBe(400)
    expect(await getDoc()).toEqual(before)
  })

  it('PUT rejects over-long and non-string text values', async () => {
    const before = await getDoc()
    const cases: Record<string, unknown>[] = [
      { heroTitle: 'ก'.repeat(121) },
      { heroSubtitle: 'ก'.repeat(201) },
      { articlesTitle: 'ก'.repeat(121) },
      { articlesSubtitle: 'ก'.repeat(201) },
      { howtoTitle: 'ก'.repeat(121) },
      { howtoSubtitle: 'ก'.repeat(201) },
      { heroTitle: 5 },
      { heroTitle: null },
      { howtoTitle: ['x'] },
    ]
    for (const body of cases) {
      const res = await call('PUT', '/admin/landing', admin, body)
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    for (const raw of ['{not json', '[]', 'null', '"x"']) {
      expect((await call('PUT', '/admin/landing', admin, raw)).status, raw).toBe(400)
    }
    expect(await getDoc()).toEqual(before)
  })

  it('PUT cannot set the images or unknown keys', async () => {
    const res = await call('PUT', '/admin/landing', admin, {
      logoUrl: 'https://evil.example/x.png',
      promoUrl: 'https://evil.example/y.png',
      landing_logo_image: 'abcdefgh12345678.png',
      landing_promo_image: 'abcdefgh12345678.png',
      items: [],
      foo: 1,
    })
    expect(res.status).toBe(200)
    const doc = (await res.json()) as AdminLanding
    expect(doc.settings.logoUrl).toBeNull()
    expect(doc.settings.promoUrl).toBeNull()
    expect(doc.items).toHaveLength(6)
    const rows = await getDb(env).select().from(siteSettings).where(like(siteSettings.key, 'landing_%'))
    expect(rows).toEqual([])
  })
})

// ---- admin: items --------------------------------------------------------------------------------

describe('landing items', () => {
  it('POST appends to the end of its kind, active by default, and answers with the item', async () => {
    const a = await createItem('article', 'ข้อใหม่', { body: 'รายละเอียด' })
    expect(a).toEqual({
      id: expect.stringMatching(/^[0-9A-Za-z]{16}$/),
      kind: 'article',
      title: 'ข้อใหม่',
      body: 'รายละเอียด',
      imageUrl: null,
      sortOrder: 3,
      active: true,
      slug: expect.stringMatching(AUTO_SLUG_RE),
      contentHtml: '',
      publishedAt: expect.stringMatching(ISO_RE),
    })
    const b = await createItem('article', 'ข้อถัดไป')
    expect(b.sortOrder).toBe(4)
    expect(b.slug).not.toBe(a.slug)
    const h = await createItem('howto', 'ขั้นตอนใหม่', { active: true })
    expect(h).toMatchObject({
      kind: 'howto',
      sortOrder: 3,
      active: true,
      slug: null,
      contentHtml: '',
      publishedAt: null,
    })

    const doc = await getDoc()
    expect(doc.items.filter((i) => i.kind === 'article').map((i) => i.id)).toEqual([
      ...SEED_ARTICLES.map((s) => s.id),
      a.id,
      b.id,
    ])
    const pub = await getPublic()
    expect(pub.articles.map((x) => x.id)).toContain(a.id)
    expect(pub.steps.map((x) => x.id)).toContain(h.id)
  })

  it('POST into an empty kind starts at position 0', async () => {
    await getDb(env).delete(landingItems).where(eq(landingItems.kind, 'howto'))
    expect((await createItem('howto', 'อันแรก')).sortOrder).toBe(0)
    expect((await createItem('howto', 'อันที่สอง')).sortOrder).toBe(1)
  })

  it('POST validates kind, title (1..80), body (0..600) and active', async () => {
    const bad: Record<string, unknown>[] = [
      {},
      { title: 'x', body: '' }, // no kind
      { kind: 'news', title: 'x', body: '' },
      { kind: 'article', body: '' }, // no title
      { kind: 'article', title: '', body: '' },
      { kind: 'article', title: '   ', body: '' },
      { kind: 'article', title: 'ก'.repeat(81), body: '' },
      { kind: 'article', title: 5, body: '' },
      { kind: 'article', title: 'x', body: 'ก'.repeat(601) },
      { kind: 'article', title: 'x', body: 5 },
      { kind: 'article', title: 'x' }, // no body
      { kind: 'article', title: 'x', body: '', active: 'yes' },
    ]
    for (const body of bad) {
      const res = await call('POST', '/admin/landing/items', admin, body)
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    expect((await call('POST', '/admin/landing/items', admin, '{oops')).status).toBe(400)
    expect((await getDoc()).items).toHaveLength(6)

    // the message is Thai and names the field
    const message = async (body: unknown, path = '/admin/landing/items', method = 'POST') =>
      ((await (await call(method, path, admin, body)).json()) as { error: { message: string } }).error.message
    expect(await message({ kind: 'article', title: 'ก'.repeat(81), body: '' })).toBe(
      'title: หัวข้อยาวได้ไม่เกิน 80 ตัวอักษร',
    )
    expect(await message({ kind: 'article', title: ' ', body: '' })).toBe('title: ต้องระบุหัวข้อ')
    expect(await message({ kind: 'article', title: 'x', body: 'ก'.repeat(601) })).toBe(
      'body: รายละเอียดยาวได้ไม่เกิน 600 ตัวอักษร',
    )
    expect(await message({ kind: 'news', title: 'x', body: '' })).toBe(
      "kind: ต้องเป็น 'article' หรือ 'howto'",
    )
    expect(await message({ heroColor: 'red' }, '/admin/landing', 'PUT')).toBe(
      'heroColor: สีต้องอยู่ในรูปแบบ #RRGGBB เช่น #7c2d12',
    )
    expect(await message({ heroTitle: 'ก'.repeat(121) }, '/admin/landing', 'PUT')).toBe(
      'heroTitle: ยาวได้ไม่เกิน 120 ตัวอักษร',
    )
    expect(await message({ howtoSubtitle: 'ก'.repeat(201) }, '/admin/landing', 'PUT')).toBe(
      'howtoSubtitle: ยาวได้ไม่เกิน 200 ตัวอักษร',
    )

    // the boundaries themselves are fine
    const edge = await createItem('article', 'ก'.repeat(80), { body: 'ข'.repeat(600) })
    expect(edge.title).toHaveLength(80)
    expect(edge.body).toHaveLength(600)
    const empty = await createItem('howto', 'x', { body: '' })
    expect(empty.body).toBe('')
    const padded = await createItem('howto', '  เว้นวรรค  ', { body: '  เนื้อหา  ' })
    expect(padded).toMatchObject({ title: 'เว้นวรรค', body: 'เนื้อหา' })
  })

  it('keeps title and body as PLAIN TEXT: markup is stored and returned verbatim, never interpreted', async () => {
    const title = '<script>alert(1)</script>'
    const body = '<b>bold</b> & <img src=x onerror=alert(1)> "quoted"'
    const item = await createItem('article', title, { body })
    expect(item).toMatchObject({ title, body })
    const res = await app.request('/landing', {}, env)
    expect(res.headers.get('content-type')).toMatch(/^application\/json/)
    const pub = (await res.json()) as LandingResponse
    expect(pub.articles.find((a) => a.id === item.id)).toEqual({
      id: item.id,
      title,
      body,
      slug: item.slug,
      imageUrl: null,
      publishedAt: item.publishedAt,
    })
  })

  it('PATCH changes title / body / active only and answers with the item', async () => {
    const res = await call('PATCH', '/admin/landing/items/landing-article-2', admin, {
      title: 'ชื่อใหม่',
      body: 'เนื้อใหม่',
      active: false,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: 'landing-article-2',
      kind: 'article',
      title: 'ชื่อใหม่',
      body: 'เนื้อใหม่',
      imageUrl: null,
      sortOrder: 1,
      active: false,
      slug: 'customize-card',
      contentHtml: '',
      publishedAt: DEFAULT_PUBLIC.articles[1].publishedAt,
    })
    // a partial patch leaves the rest alone
    const only = await call('PATCH', '/admin/landing/items/landing-article-2', admin, { active: true })
    expect(await only.json()).toMatchObject({ title: 'ชื่อใหม่', body: 'เนื้อใหม่', active: true })
    const bodyOnly = await call('PATCH', '/admin/landing/items/landing-article-2', admin, { body: '' })
    expect(await bodyOnly.json()).toMatchObject({ title: 'ชื่อใหม่', body: '' })
  })

  it('PATCH ignores kind, position, id and image keys', async () => {
    const res = await call('PATCH', '/admin/landing/items/landing-howto-3', admin, {
      title: 'ยังเป็นขั้นตอน',
      kind: 'article',
      sortOrder: 0,
      id: 'hijacked',
      imageUrl: 'https://evil.example/x.png',
      imageKey: 'abcdefgh12345678.png',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      id: 'landing-howto-3',
      kind: 'howto',
      title: 'ยังเป็นขั้นตอน',
      body: SEED_STEPS[2].body,
      imageUrl: null,
      sortOrder: 2,
      active: true,
      slug: null,
      contentHtml: '',
      publishedAt: null,
    })
  })

  it('PATCH with an empty body returns the item unchanged', async () => {
    const res = await call('PATCH', '/admin/landing/items/landing-article-1', admin, {})
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'landing-article-1', title: SEED_ARTICLES[0].title, active: true })
    expect((await call('PATCH', '/admin/landing/items/nope', admin, {})).status).toBe(404)
  })

  it('PATCH validates and answers 404 for an unknown item', async () => {
    const bad: Record<string, unknown>[] = [
      { title: '' },
      { title: '  ' },
      { title: 'ก'.repeat(81) },
      { body: 'ก'.repeat(601) },
      { active: 'no' },
      { title: 5 },
    ]
    for (const body of bad) {
      const res = await call('PATCH', '/admin/landing/items/landing-article-1', admin, body)
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400)
    }
    expect((await call('PATCH', '/admin/landing/items/landing-article-1', admin, '{oops')).status).toBe(400)
    const missing = await call('PATCH', '/admin/landing/items/does-not-exist', admin, { title: 'x' })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    expect((await getDoc()).items.find((i) => i.id === 'landing-article-1')?.title).toBe(SEED_ARTICLES[0].title)
  })

  it('DELETE removes the item (204), then 404; the page and the back office drop it', async () => {
    const res = await call('DELETE', '/admin/landing/items/landing-article-2', admin)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect((await getDoc()).items.map((i) => i.id)).not.toContain('landing-article-2')
    expect((await getPublic()).articles.map((a) => a.id)).toEqual(['landing-article-1', 'landing-article-3'])
    const again = await call('DELETE', '/admin/landing/items/landing-article-2', admin)
    expect(again.status).toBe(404)
    expect(await again.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
    // a new item appended after the gap still sorts last
    expect((await createItem('article', 'หลังช่องว่าง')).sortOrder).toBe(3)
  })

  it('PUT /items/order sets sort_order by position and answers with that kind, in the new order', async () => {
    const ids = SEED_ARTICLES.map((a) => a.id)
    const next = [ids[2], ids[0], ids[1]]
    const res = await call('PUT', '/admin/landing/items/order', admin, { kind: 'article', ids: next })
    expect(res.status).toBe(200)
    const list = (await res.json()) as AdminLandingItem[]
    expect(list.map((i) => i.id)).toEqual(next)
    expect(list.map((i) => i.sortOrder)).toEqual([0, 1, 2])
    expect(list.every((i) => i.kind === 'article')).toBe(true)
    // the page and the back office follow, and the other kind did not move
    expect((await getPublic()).articles.map((a) => a.id)).toEqual(next)
    const doc = await getDoc()
    expect(doc.items.filter((i) => i.kind === 'article').map((i) => i.id)).toEqual(next)
    expect(doc.items.filter((i) => i.kind === 'howto').map((i) => i.id)).toEqual(SEED_STEPS.map((s) => s.id))

    // reordering how-to steps works the same, including inactive ones and after a gap
    await call('PATCH', '/admin/landing/items/landing-howto-2', admin, { active: false })
    await call('DELETE', '/admin/landing/items/landing-howto-1', admin)
    const extra = await createItem('howto', 'ต่อท้าย')
    const steps = [extra.id, 'landing-howto-3', 'landing-howto-2']
    const res2 = await call('PUT', '/admin/landing/items/order', admin, { kind: 'howto', ids: steps })
    expect(((await res2.json()) as AdminLandingItem[]).map((i) => [i.id, i.sortOrder])).toEqual([
      [extra.id, 0],
      ['landing-howto-3', 1],
      ['landing-howto-2', 2],
    ])
    expect((await getPublic()).steps.map((s) => s.id)).toEqual([extra.id, 'landing-howto-3'])
  })

  it('PUT /items/order accepts the unchanged order and an empty kind', async () => {
    const ids = SEED_ARTICLES.map((a) => a.id)
    const same = await call('PUT', '/admin/landing/items/order', admin, { kind: 'article', ids })
    expect(same.status).toBe(200)
    expect(((await same.json()) as AdminLandingItem[]).map((i) => i.id)).toEqual(ids)
    await getDb(env).delete(landingItems).where(eq(landingItems.kind, 'howto'))
    const none = await call('PUT', '/admin/landing/items/order', admin, { kind: 'howto', ids: [] })
    expect(none.status).toBe(200)
    expect(await none.json()).toEqual([])
  })

  it('PUT /items/order rejects anything but exactly the kind\'s ids and changes nothing', async () => {
    const before = await getDoc()
    const [a1, a2, a3] = SEED_ARTICLES.map((a) => a.id)
    const bad: unknown[] = [
      { kind: 'article', ids: [a1, a2] }, // one missing
      { kind: 'article', ids: [a1, a2, a3, 'extra-id'] }, // one unknown
      { kind: 'article', ids: [a1, a2, 'unknown-id'] }, // wrong member, right length
      { kind: 'article', ids: [a1, a1, a2] }, // duplicate
      { kind: 'article', ids: [a1, a2, a3, a3] },
      { kind: 'article', ids: [] }, // items exist
      { kind: 'article', ids: [a1, a2, 'landing-howto-1'] }, // an id of the other kind
      { kind: 'howto', ids: [a1, a2, a3] }, // right ids, wrong kind
      { kind: 'news', ids: [a1, a2, a3] },
      { ids: [a1, a2, a3] },
      { kind: 'article' },
      { kind: 'article', ids: 'landing-article-1' },
      { kind: 'article', ids: [1, 2, 3] },
      { kind: 'article', ids: [a1, a2, ''] },
      { kind: 'article', ids: Array.from({ length: MAX_LANDING_ITEMS_PER_KIND + 1 }, (_, i) => `id${i}`) },
    ]
    for (const body of bad) {
      const res = await call('PUT', '/admin/landing/items/order', admin, body)
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    expect((await call('PUT', '/admin/landing/items/order', admin, '{oops')).status).toBe(400)
    expect(await getDoc()).toEqual(before)
  })
})

// ---- admin: the 12 per kind limit -----------------------------------------------------------------

describe('landing item limit', () => {
  it('allows 12 items per kind, answers 409 QUOTA for the 13th and counts each kind separately', async () => {
    for (let i = 0; i < MAX_LANDING_ITEMS_PER_KIND - 3; i++) await createItem('howto', `ขั้นตอน ${i}`)
    expect((await getDoc()).items.filter((i) => i.kind === 'howto')).toHaveLength(MAX_LANDING_ITEMS_PER_KIND)

    const over = await call('POST', '/admin/landing/items', admin, { kind: 'howto', title: 'เกิน', body: '' })
    expect(over.status).toBe(409)
    expect(await over.json()).toMatchObject({ error: { code: 'QUOTA', message: expect.any(String) } })
    expect((await getDoc()).items.filter((i) => i.kind === 'howto')).toHaveLength(MAX_LANDING_ITEMS_PER_KIND)

    // the other kind has its own room; inactive items count towards the limit
    const art = await createItem('article', 'ยังเพิ่มได้')
    expect(art.kind).toBe('article')
    await call('PATCH', '/admin/landing/items/landing-howto-1', admin, { active: false })
    expect(
      (await call('POST', '/admin/landing/items', admin, { kind: 'howto', title: 'เกิน', body: '' })).status,
    ).toBe(409)

    // freeing a slot (delete) makes room again, and the new item goes to the end
    expect((await call('DELETE', '/admin/landing/items/landing-howto-1', admin)).status).toBe(204)
    const again = await createItem('howto', 'ได้แล้ว')
    expect(again.sortOrder).toBeGreaterThan(2)
    expect(
      (await call('POST', '/admin/landing/items', admin, { kind: 'howto', title: 'เกินอีก', body: '' })).status,
    ).toBe(409)
  })

  it('concurrent creates never exceed the limit and never share a position', async () => {
    for (let i = 0; i < MAX_LANDING_ITEMS_PER_KIND - 3 - 2; i++) await createItem('article', `เติม ${i}`)
    const res = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call('POST', '/admin/landing/items', admin, { kind: 'article', title: `race ${i}`, body: '' }),
      ),
    )
    expect(res.filter((r) => r.status === 200)).toHaveLength(2)
    for (const r of res) {
      if (r.status !== 200) expect(await r.json()).toMatchObject({ error: { code: 'QUOTA' } })
    }
    const rows = await getDb(env).select().from(landingItems).where(eq(landingItems.kind, 'article'))
    expect(rows).toHaveLength(MAX_LANDING_ITEMS_PER_KIND)
    expect(new Set(rows.map((r) => r.sortOrder)).size).toBe(MAX_LANDING_ITEMS_PER_KIND)
  })
})

// ---- admin: header images (logo / promo) -----------------------------------------------------------

describe('logo and promo images', () => {
  it('upload -> absolute public URL -> the bytes are served -> replace deletes the old object -> delete clears', async () => {
    const first = png(1, 2, 3, 4)
    const up = await upload('/admin/landing/image/logo', admin, pngFile(first))
    expect(up.status).toBe(200)
    const doc = (await up.json()) as AdminLanding
    const url = doc.settings.logoUrl as string
    expect(url).toMatch(/^http:\/\/localhost\/landing\/image\/[A-Za-z0-9]{16}\.png$/)
    expect(doc.settings.promoUrl).toBeNull()
    expect(doc.items).toHaveLength(6)
    const oldName = nameOf(url)
    expect(landingKeys()).toEqual([`landing/${oldName}`])
    expect(r2.objects.get(`landing/${oldName}`)?.contentType).toBe('image/png')

    // anyone can fetch it, with no session
    const img = await app.request(new URL(url).pathname, {}, env)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(arr(new Uint8Array(await img.arrayBuffer()))).toEqual(arr(first))
    expect((await getPublic()).logoUrl).toBe(url)
    expect((await getDoc()).settings.logoUrl).toBe(url)

    // replacing stores a new random name and deletes the old object
    const second = webp(9, 8, 7)
    const rep = await upload('/admin/landing/image/logo', admin, webpFile(second))
    expect(rep.status).toBe(200)
    const newUrl = ((await rep.json()) as AdminLanding).settings.logoUrl as string
    expect(newUrl).toMatch(/\/landing\/image\/[A-Za-z0-9]{16}\.webp$/)
    expect(newUrl).not.toBe(url)
    expect(landingKeys()).toEqual([`landing/${nameOf(newUrl)}`])
    expect((await app.request(new URL(url).pathname, {}, env)).status).toBe(404)
    const img2 = await app.request(new URL(newUrl).pathname, {}, env)
    expect(img2.headers.get('content-type')).toBe('image/webp')
    expect(arr(new Uint8Array(await img2.arrayBuffer()))).toEqual(arr(second))
    expect((await getPublic()).logoUrl).toBe(newUrl)

    // removing clears the setting and the object
    const del = await call('DELETE', '/admin/landing/image/logo', admin)
    expect(del.status).toBe(200)
    expect(((await del.json()) as AdminLanding).settings.logoUrl).toBeNull()
    expect(landingKeys()).toEqual([])
    expect((await app.request(new URL(newUrl).pathname, {}, env)).status).toBe(404)
    expect((await getPublic()).logoUrl).toBeNull()

    // removing again is harmless
    const delAgain = await call('DELETE', '/admin/landing/image/logo', admin)
    expect(delAgain.status).toBe(200)
    expect(((await delAgain.json()) as AdminLanding).settings.logoUrl).toBeNull()
  })

  it('logo and promo are independent slots and accept png, jpeg and webp', async () => {
    const logo = await upload('/admin/landing/image/logo', admin, jpgFile())
    expect(((await logo.json()) as AdminLanding).settings.logoUrl).toMatch(/\.jpg$/)
    const promo = await upload('/admin/landing/image/promo', admin, pngFile(png(5, 5)))
    const doc = (await promo.json()) as AdminLanding
    expect(doc.settings.logoUrl).toMatch(/\.jpg$/)
    expect(doc.settings.promoUrl).toMatch(/\.png$/)
    expect(landingKeys()).toHaveLength(2)
    // clearing one leaves the other
    await call('DELETE', '/admin/landing/image/promo', admin)
    const after = await getDoc()
    expect(after.settings.promoUrl).toBeNull()
    expect(after.settings.logoUrl).toMatch(/\.jpg$/)
    expect(landingKeys()).toEqual([`landing/${nameOf(after.settings.logoUrl)}`])
  })

  it('builds the URL from the origin of the request', async () => {
    const res = await upload('https://api.example.test/admin/landing/image/promo', admin, pngFile())
    expect(res.status).toBe(200)
    const url = ((await res.json()) as AdminLanding).settings.promoUrl as string
    expect(url).toMatch(/^https:\/\/api\.example\.test\/landing\/image\/[A-Za-z0-9]{16}\.png$/)
    const pub = await app.request('https://api.example.test/landing', {}, env)
    expect(((await pub.json()) as LandingResponse).promoUrl).toBe(url)
  })

  it('refuses non-images, empty and oversize files, a missing file and a non-multipart body, storing nothing', async () => {
    const bad: [string, File | null][] = [
      ['gif', new File([bytes(1)], 'a.gif', { type: 'image/gif' })],
      ['avif', new File([bytes(1)], 'a.avif', { type: 'image/avif' })],
      ['svg', new File(['<svg onload=alert(1)/>'], 'a.svg', { type: 'image/svg+xml' })],
      ['html', new File(['<html></html>'], 'a.png', { type: 'text/html' })],
      ['text', new File(['hi'], 'a.txt', { type: 'text/plain' })],
      ['no type', new File([bytes(1)], 'a.png', { type: '' })],
      ['empty', new File([], 'a.png', { type: 'image/png' })],
      ['oversize', pngOfSize(MAX_ASSET_BYTES + 1)],
      ['missing', null],
    ]
    for (const [label, file] of bad) {
      const res = await upload('/admin/landing/image/logo', admin, file)
      expect(res.status, label).toBe(400)
      expect(await res.json(), label).toMatchObject({ error: { code: 'VALIDATION' } })
    }
    // the file under another field name does not count
    const wrongField = await upload('/admin/landing/image/logo', admin, pngFile(), { field: 'image' })
    expect(wrongField.status).toBe(400)
    // JSON instead of multipart
    const json = await call('POST', '/admin/landing/image/logo', admin, { file: 'x' })
    expect(json.status).toBe(400)
    expect(landingKeys()).toEqual([])
    expect((await getDoc()).settings.logoUrl).toBeNull()
  })

  it('refuses bytes that are not an image of the declared type, storing nothing', async () => {
    // The content type is whatever the client says; the first bytes must back it up.
    const cases: [string, File][] = [
      ['text as png', labelled('image/png', 'just some text, not an image')],
      ['html as png', labelled('image/png', '<!doctype html><script>alert(document.cookie)</script>')],
      ['svg as png', labelled('image/png', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
      ['text as jpeg', labelled('image/jpeg', 'not a jpeg')],
      ['text as webp', labelled('image/webp', 'RIFF is only the start of a webp')],
      ['gif as png', labelled('image/png', 'GIF89a\x01\x00\x01\x00')],
      ['png as jpeg', labelled('image/jpeg', png(1, 2, 3))],
      ['jpeg as png', labelled('image/png', jpg(1, 2, 3))],
      ['webp as png', labelled('image/png', webp(1, 2, 3))],
      ['png as webp', labelled('image/webp', png(1, 2, 3, 4, 5))],
      ['png signature cut short', labelled('image/png', bytes(...PNG_SIGNATURE.slice(0, 7)))],
      ['png signature with a wrong last byte', labelled('image/png', bytes(...PNG_SIGNATURE.slice(0, 7), 11))],
      ['png signature shifted by one byte', labelled('image/png', bytes(0, ...PNG_SIGNATURE))],
      ['jpeg signature cut short', labelled('image/jpeg', bytes(255, 216))],
      ['webp: a RIFF file that is not WEBP (wav)', labelled('image/webp', bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE'), 1))],
      ['webp: header cut short', labelled('image/webp', bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEB')))],
      ['webp: WEBP right after RIFF, no size field', labelled('image/webp', bytes(...ascii('RIFFWEBP'), 0, 0, 0, 0))],
      ['a single zero byte', labelled('image/png', bytes(0))],
    ]
    for (const slot of ['logo', 'promo']) {
      for (const [label, file] of cases) {
        const res = await upload(`/admin/landing/image/${slot}`, admin, file)
        expect(res.status, `${slot}: ${label}`).toBe(400)
        expect(await res.json(), `${slot}: ${label}`).toEqual(NOT_AN_IMAGE)
      }
    }
    expect(landingKeys()).toEqual([])
    const doc = await getDoc()
    expect(doc.settings.logoUrl).toBeNull()
    expect(doc.settings.promoUrl).toBeNull()
    const pub = await getPublic()
    expect(pub.logoUrl).toBeNull()
    expect(pub.promoUrl).toBeNull()
  })

  it('accepts the shortest file that carries the signature of its type', async () => {
    const shortest: [string, File][] = [
      ['png', labelled('image/png', bytes(...PNG_SIGNATURE))],
      ['jpeg', labelled('image/jpeg', bytes(255, 216, 255))],
      ['webp', labelled('image/webp', webp())],
    ]
    for (const [label, file] of shortest) {
      const res = await upload('/admin/landing/image/logo', admin, file)
      expect(res.status, label).toBe(200)
    }
    // each upload replaced the last one, so a single object is left
    expect(landingKeys()).toHaveLength(1)
  })

  it('a refused replacement leaves the current image alone', async () => {
    const first = await upload('/admin/landing/image/logo', admin, pngFile(png(1)))
    const url = ((await first.json()) as AdminLanding).settings.logoUrl as string
    const bad = await upload('/admin/landing/image/logo', admin, labelled('image/png', '<html>not a png</html>'))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual(NOT_AN_IMAGE)
    expect((await getDoc()).settings.logoUrl).toBe(url)
    expect(landingKeys()).toEqual([`landing/${nameOf(url)}`])
    expect((await app.request(new URL(url).pathname, {}, env)).status).toBe(200)
  })

  it('accepts a file of exactly 5 MB', async () => {
    const res = await upload('/admin/landing/image/logo', admin, pngOfSize(MAX_ASSET_BYTES))
    expect(res.status).toBe(200)
    expect([...r2.objects.values()][0]?.bytes.byteLength).toBe(MAX_ASSET_BYTES)
  })

  it('answers 404 for an unknown slot and stores nothing', async () => {
    for (const slot of ['banner', 'LOGO', 'hero', '__proto__', 'constructor']) {
      const up = await upload(`/admin/landing/image/${slot}`, admin, pngFile())
      expect(up.status, slot).toBe(404)
      expect(await up.json(), slot).toMatchObject({ error: { code: 'NOT_FOUND' } })
      expect((await call('DELETE', `/admin/landing/image/${slot}`, admin)).status, slot).toBe(404)
    }
    expect(landingKeys()).toEqual([])
  })

  it('removing the old file is best effort: a failing R2 delete does not fail the replacement', async () => {
    const first = await upload('/admin/landing/image/logo', admin, pngFile(png(1)))
    const oldKey = `landing/${nameOf(((await first.json()) as AdminLanding).settings.logoUrl)}`
    r2.failDeleteFor.add(oldKey)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const rep = await upload('/admin/landing/image/logo', admin, pngFile(png(2)))
      expect(rep.status).toBe(200)
      const newUrl = ((await rep.json()) as AdminLanding).settings.logoUrl as string
      expect(newUrl).not.toContain(oldKey.slice('landing/'.length))
      expect((await getPublic()).logoUrl).toBe(newUrl)
      expect((await app.request(new URL(newUrl).pathname, {}, env)).status).toBe(200)
      expect(err).toHaveBeenCalled()
      // removing the image also succeeds while R2 keeps failing
      r2.failDeleteFor.add(`landing/${nameOf(newUrl)}`)
      const del = await call('DELETE', '/admin/landing/image/logo', admin)
      expect(del.status).toBe(200)
      expect(((await del.json()) as AdminLanding).settings.logoUrl).toBeNull()
    } finally {
      err.mockRestore()
    }
  })

  it('concurrent replacements leave exactly the referenced object in R2', async () => {
    const res = await Promise.all(
      [1, 2, 3, 4].map((n) => upload('/admin/landing/image/logo', admin, pngFile(png(n, n)))),
    )
    expect(res.every((r) => r.status === 200)).toBe(true)
    const url = (await getDoc()).settings.logoUrl as string
    expect(landingKeys()).toEqual([`landing/${nameOf(url)}`])
  })

  it('a database failure after the upload does not leave the new file behind', async () => {
    const { client } = openDb(DB_URL)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await client.execute(
        `create trigger landing_test_fail before insert on site_settings
         when new.key = 'landing_logo_image'
         begin select raise(abort, 'boom'); end`,
      )
      const res = await upload('/admin/landing/image/logo', admin, pngFile())
      expect(res.status).toBe(500)
      expect(landingKeys()).toEqual([])
    } finally {
      await client.execute('drop trigger if exists landing_test_fail')
      client.close()
      err.mockRestore()
    }
    expect((await getDoc()).settings.logoUrl).toBeNull()
  })
})

// ---- admin: item images ----------------------------------------------------------------------------

describe('item images', () => {
  it('a step image: upload -> shown on the public step -> replace deletes the old object -> delete clears', async () => {
    const data = jpg(4, 5, 6)
    const up = await upload('/admin/landing/items/landing-howto-1/image', admin, jpgFile(data))
    expect(up.status).toBe(200)
    const item = (await up.json()) as AdminLandingItem
    expect(item).toMatchObject({ id: 'landing-howto-1', kind: 'howto', sortOrder: 0, active: true })
    expect(item.imageUrl).toMatch(/^http:\/\/localhost\/landing\/image\/[A-Za-z0-9]{16}\.jpg$/)
    const firstName = nameOf(item.imageUrl)
    expect(landingKeys()).toEqual([`landing/${firstName}`])

    const step = (await getPublic()).steps.find((s) => s.id === 'landing-howto-1')
    expect(step).toEqual({ ...SEED_STEPS[0], imageUrl: item.imageUrl })
    const img = await app.request(new URL(item.imageUrl as string).pathname, {}, env)
    expect(img.status).toBe(200)
    expect(arr(new Uint8Array(await img.arrayBuffer()))).toEqual(arr(data))
    expect((await getDoc()).items.find((i) => i.id === 'landing-howto-1')?.imageUrl).toBe(item.imageUrl)

    const rep = await upload('/admin/landing/items/landing-howto-1/image', admin, pngFile(png(7)))
    const repItem = (await rep.json()) as AdminLandingItem
    expect(repItem.imageUrl).not.toBe(item.imageUrl)
    expect(landingKeys()).toEqual([`landing/${nameOf(repItem.imageUrl)}`])
    expect((await app.request(new URL(item.imageUrl as string).pathname, {}, env)).status).toBe(404)

    const del = await call('DELETE', '/admin/landing/items/landing-howto-1/image', admin)
    expect(del.status).toBe(200)
    expect(await del.json()).toMatchObject({ id: 'landing-howto-1', imageUrl: null })
    expect(landingKeys()).toEqual([])
    expect((await getPublic()).steps[0]).toEqual({ ...SEED_STEPS[0], imageUrl: null })
    // removing again is harmless
    expect((await call('DELETE', '/admin/landing/items/landing-howto-1/image', admin)).status).toBe(200)
  })

  it('an article keeps a cover picture: the back office, the public list and the article page all show it', async () => {
    const up = await upload('/admin/landing/items/landing-article-1/image', admin, pngFile())
    expect(up.status).toBe(200)
    const item = (await up.json()) as AdminLandingItem
    expect(item.kind).toBe('article')
    expect(item.imageUrl).toMatch(/^http:\/\/localhost\/landing\/image\/[A-Za-z0-9]{16}\.png$/)
    expect(item.slug).toBe('all-lotteries')
    const pub = await getPublic()
    expect(pub.articles[0]).toEqual({ ...DEFAULT_PUBLIC.articles[0], imageUrl: item.imageUrl })
    expect(pub.articles[1].imageUrl).toBeNull()
    const page = await app.request('/landing/articles/all-lotteries', {}, env)
    expect(((await page.json()) as { imageUrl: string }).imageUrl).toBe(item.imageUrl)
    // an inactive article hides its cover from the public list like an inactive step does
    await call('PATCH', '/admin/landing/items/landing-article-1', admin, { active: false })
    expect(JSON.stringify(await getPublic())).not.toContain(nameOf(item.imageUrl))
  })

  it('deleting an item deletes its own image only', async () => {
    const a = await upload('/admin/landing/items/landing-howto-1/image', admin, pngFile(png(1)))
    const b = await upload('/admin/landing/items/landing-howto-2/image', admin, pngFile(png(2)))
    const nameA = nameOf(((await a.json()) as AdminLandingItem).imageUrl)
    const nameB = nameOf(((await b.json()) as AdminLandingItem).imageUrl)
    expect(landingKeys()).toEqual([`landing/${nameA}`, `landing/${nameB}`].sort())
    expect((await call('DELETE', '/admin/landing/items/landing-howto-1', admin)).status).toBe(204)
    expect(landingKeys()).toEqual([`landing/${nameB}`])
    expect((await app.request(`/landing/image/${nameA}`, {}, env)).status).toBe(404)
    expect((await app.request(`/landing/image/${nameB}`, {}, env)).status).toBe(200)
  })

  it('answers 404 for an unknown item and stores nothing; validation errors store nothing', async () => {
    const up = await upload('/admin/landing/items/nope/image', admin, pngFile())
    expect(up.status).toBe(404)
    expect((await call('DELETE', '/admin/landing/items/nope/image', admin)).status).toBe(404)
    expect(landingKeys()).toEqual([])

    const gif = await upload('/admin/landing/items/landing-howto-1/image', admin, new File([bytes(1)], 'a.gif', { type: 'image/gif' }))
    expect(gif.status).toBe(400)
    expect((await upload('/admin/landing/items/landing-howto-1/image', admin, null)).status).toBe(400)
    expect(
      (await upload('/admin/landing/items/landing-howto-1/image', admin, new File([], 'a.png', { type: 'image/png' }))).status,
    ).toBe(400)
    expect(
      (await upload('/admin/landing/items/landing-howto-1/image', admin, pngOfSize(MAX_ASSET_BYTES + 1))).status,
    ).toBe(400)
    expect(landingKeys()).toEqual([])
  })

  it('refuses bytes that are not an image of the declared type and keeps the current image', async () => {
    const first = await upload('/admin/landing/items/landing-howto-1/image', admin, pngFile(png(1)))
    const url = ((await first.json()) as AdminLandingItem).imageUrl as string
    const cases: [string, File][] = [
      ['text as png', labelled('image/png', 'just some text, not an image')],
      ['html as jpeg', labelled('image/jpeg', '<script>alert(1)</script>')],
      ['png as webp', labelled('image/webp', png(1))],
      ['jpeg as png', labelled('image/png', jpg(1))],
    ]
    for (const [label, file] of cases) {
      const res = await upload('/admin/landing/items/landing-howto-1/image', admin, file)
      expect(res.status, label).toBe(400)
      expect(await res.json(), label).toEqual(NOT_AN_IMAGE)
    }
    // an article goes through the same check
    const art = await upload('/admin/landing/items/landing-article-1/image', admin, labelled('image/png', 'plain text'))
    expect(art.status).toBe(400)
    expect(await art.json()).toEqual(NOT_AN_IMAGE)

    expect(landingKeys()).toEqual([`landing/${nameOf(url)}`])
    const doc = await getDoc()
    expect(doc.items.find((i) => i.id === 'landing-howto-1')?.imageUrl).toBe(url)
    expect(doc.items.find((i) => i.id === 'landing-article-1')?.imageUrl).toBeNull()
    expect((await app.request(new URL(url).pathname, {}, env)).status).toBe(200)
  })

  it('failing R2 deletes never fail the item routes', async () => {
    const up = await upload('/admin/landing/items/landing-howto-3/image', admin, pngFile())
    const key = `landing/${nameOf(((await up.json()) as AdminLandingItem).imageUrl)}`
    r2.failDeleteFor.add(key)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await call('DELETE', '/admin/landing/items/landing-howto-3/image', admin)).status).toBe(200)
      expect((await getDoc()).items.find((i) => i.id === 'landing-howto-3')?.imageUrl).toBeNull()
      expect(err).toHaveBeenCalled()
      // an item whose image cannot be removed from R2 can still be deleted
      const again = await upload('/admin/landing/items/landing-howto-3/image', admin, pngFile(png(3)))
      r2.failDeleteFor.add(`landing/${nameOf(((await again.json()) as AdminLandingItem).imageUrl)}`)
      expect((await call('DELETE', '/admin/landing/items/landing-howto-3', admin)).status).toBe(204)
    } finally {
      err.mockRestore()
    }
  })

  it('concurrent replacements leave exactly the referenced object in R2', async () => {
    const res = await Promise.all(
      [1, 2, 3, 4].map((n) => upload('/admin/landing/items/landing-howto-2/image', admin, webpFile(webp(n)))),
    )
    expect(res.every((r) => r.status === 200)).toBe(true)
    const item = (await getDoc()).items.find((i) => i.id === 'landing-howto-2') as AdminLandingItem
    expect(landingKeys()).toEqual([`landing/${nameOf(item.imageUrl)}`])
  })

  it('an item deleted while its upload runs does not keep the new file', async () => {
    // Delete the row right after the existence check by wrapping the bucket: put() is the first
    // thing that happens after findItem, so the row is gone by the time the image is swapped in.
    const realPut = r2.put.bind(r2)
    const spy = vi.spyOn(r2, 'put').mockImplementation(async (key, value, options) => {
      const out = await realPut(key, value, options)
      await getDb(env).delete(landingItems).where(eq(landingItems.id, 'landing-howto-1'))
      return out
    })
    try {
      const res = await upload('/admin/landing/items/landing-howto-1/image', admin, pngFile())
      expect(res.status).toBe(404)
      expect(landingKeys()).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  it('a database failure after the upload does not leave the new file behind', async () => {
    const { client } = openDb(DB_URL)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await client.execute(
        `create trigger landing_item_test_fail before update on landing_items
         when new.image_key is not null
         begin select raise(abort, 'boom'); end`,
      )
      const res = await upload('/admin/landing/items/landing-howto-1/image', admin, pngFile())
      expect(res.status).toBe(500)
      expect(landingKeys()).toEqual([])
    } finally {
      await client.execute('drop trigger if exists landing_item_test_fail')
      client.close()
      err.mockRestore()
    }
    expect((await getDoc()).items.find((i) => i.id === 'landing-howto-1')?.imageUrl).toBeNull()
  })
})

// ---- CORS and CSRF -------------------------------------------------------------------------------

describe('CORS and CSRF', () => {
  it('GET /landing and the image route allow the web origin like /contacts, and no other origin', async () => {
    await r2.put('landing/abcdefgh12345678.png', bytes(1))
    for (const path of ['/landing', '/landing/image/abcdefgh12345678.png', '/contacts']) {
      const ok = await app.request(path, { headers: { Origin: 'http://localhost:5173' } }, env)
      expect(ok.status, path).toBe(200)
      expect(ok.headers.get('access-control-allow-origin'), path).toBe('http://localhost:5173')
      expect(ok.headers.get('access-control-allow-credentials'), path).toBe('true')
      const evil = await app.request(path, { headers: { Origin: 'https://evil.example' } }, env)
      expect(evil.status, path).toBe(200)
      expect(evil.headers.get('access-control-allow-origin'), path).toBeNull()
    }
    // the production web origin, as configured in wrangler.toml
    const prod = { ...env, WEB_URL: 'https://pnphoto.co', COOKIE_SECURE: 'true' }
    const res = await app.request('/landing', { headers: { Origin: 'https://pnphoto.co' } }, prod)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://pnphoto.co')
    expect(res.headers.get('cache-control')).toBe('public, max-age=60')
    const pre = await app.request(
      '/landing',
      { method: 'OPTIONS', headers: { Origin: 'https://pnphoto.co', 'Access-Control-Request-Method': 'GET' } },
      prod,
    )
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://pnphoto.co')
  })

  it('back office writes from a foreign Origin are refused, multipart uploads included', async () => {
    const evil = { Origin: 'https://evil.example' }
    const cases = [
      await call('PUT', '/admin/landing', admin, { heroTitle: 'hacked' }, evil),
      await call('POST', '/admin/landing/items', admin, { kind: 'article', title: 'hacked', body: '' }, evil),
      await call('PATCH', '/admin/landing/items/landing-article-1', admin, { title: 'hacked' }, evil),
      await call('DELETE', '/admin/landing/items/landing-article-1', admin, undefined, evil),
      await call('PUT', '/admin/landing/items/order', admin, { kind: 'article', ids: ['a'] }, evil),
      await upload('/admin/landing/image/logo', admin, pngFile(), { headers: evil }),
      await upload('/admin/landing/items/landing-howto-1/image', admin, pngFile(), { headers: evil }),
    ]
    for (const res of cases) expect(res.status).toBe(403)
    expect(landingKeys()).toEqual([])
    const doc = await getDoc()
    expect(doc.settings.heroTitle).toBe(DEFAULT_PUBLIC.heroTitle)
    expect(doc.items).toHaveLength(6)
    expect(doc.items.find((i) => i.id === 'landing-article-1')?.title).toBe(SEED_ARTICLES[0].title)
    // the same writes from the web origin are fine
    const ok = await call('PUT', '/admin/landing', admin, { heroTitle: 'ok' }, { Origin: 'http://localhost:5173' })
    expect(ok.status).toBe(200)
  })
})

// ---- unit: lib/landing ---------------------------------------------------------------------------

describe('unit: lib/landing', () => {
  it('isLandingImageName: 8..64 url-safe characters plus png / jpg / jpeg / webp', () => {
    const ok = [
      'abcdefgh.png',
      'ABCDEFGH.jpg',
      'abc_def-1.jpeg',
      `${'a'.repeat(64)}.webp`,
      'aB3dE5gH7jK9mN1p.png',
    ]
    for (const n of ok) expect(isLandingImageName(n), n).toBe(true)
    const bad = [
      '',
      'abcdefg.png', // 7
      `${'a'.repeat(65)}.png`,
      'abcdefgh.gif',
      'abcdefgh.PNG',
      'abcdefgh',
      'abcdefgh.png\n',
      '../abcdefgh.png',
      'a/bcdefgh.png',
      'abcdefgh.png/',
      'abc.defgh.png',
      'abcdefgh.png.png',
      'abcdefgh .png',
    ]
    for (const n of bad) expect(isLandingImageName(n), JSON.stringify(n)).toBe(false)
  })

  it('hasImageSignature: each type needs its own leading bytes, any other type never matches', () => {
    const sigs: Record<string, Uint8Array<ArrayBuffer>> = {
      'image/png': bytes(...PNG_SIGNATURE),
      'image/jpeg': bytes(255, 216, 255),
      'image/webp': webp(),
    }
    for (const [type, sig] of Object.entries(sigs)) {
      // the bare signature, and the same followed by more data
      expect(hasImageSignature(type, sig), type).toBe(true)
      expect(hasImageSignature(type, bytes(...sig, 1, 2, 3)), type).toBe(true)
      // one byte short, shifted by one byte, nothing at all
      expect(hasImageSignature(type, sig.slice(0, -1)), `${type} cut short`).toBe(false)
      expect(hasImageSignature(type, bytes(0, ...sig)), `${type} shifted`).toBe(false)
      expect(hasImageSignature(type, bytes()), `${type} empty`).toBe(false)
      // another type's signature does not do
      for (const [other, otherSig] of Object.entries(sigs)) {
        if (other !== type) expect(hasImageSignature(type, otherSig), `${type} given ${other}`).toBe(false)
      }
    }
    // webp needs both markers, "WEBP" at bytes 8..11 and not right behind "RIFF"
    expect(hasImageSignature('image/webp', bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')))).toBe(false)
    expect(hasImageSignature('image/webp', bytes(...ascii('RIFFWEBP'), 0, 0, 0, 0))).toBe(false)
    expect(hasImageSignature('image/webp', bytes(...ascii('XXXX'), 0, 0, 0, 0, ...ascii('WEBP')))).toBe(false)
    // a type outside png / jpeg / webp never matches, whatever the bytes are
    const types = ['image/gif', 'image/avif', 'image/svg+xml', 'text/html', 'IMAGE/PNG', '', '__proto__', 'constructor']
    for (const type of types) expect(hasImageSignature(type, sigs['image/png']), type).toBe(false)
    // a view into a bigger buffer is read from its own first byte
    const buf = new Uint8Array(20)
    buf.set(sigs['image/png'], 5)
    expect(hasImageSignature('image/png', buf.subarray(5))).toBe(true)
    expect(hasImageSignature('image/png', buf)).toBe(false)
  })

  it('landingImageUrl: <origin>/landing/image/<name>, null for none or invalid', () => {
    expect(landingImageUrl('https://api.pnphoto.co', 'aB3dE5gH7jK9mN1p.png')).toBe(
      'https://api.pnphoto.co/landing/image/aB3dE5gH7jK9mN1p.png',
    )
    expect(landingImageUrl('https://api.pnphoto.co', '')).toBeNull()
    expect(landingImageUrl('https://api.pnphoto.co', null)).toBeNull()
    expect(landingImageUrl('https://api.pnphoto.co', undefined)).toBeNull()
    expect(landingImageUrl('https://api.pnphoto.co', '../../etc/passwd')).toBeNull()
  })

  it('overlayLandingSettings: defaults for missing rows, empty strings kept, unknown keys and bad colours ignored', () => {
    expect(overlayLandingSettings([])).toEqual(LANDING_DEFAULTS)
    const out = overlayLandingSettings([
      { key: 'landing_hero_title', value: '' },
      { key: 'landing_hero_color', value: '#ABCDEF' },
      { key: 'landing_howto_title', value: 'x' },
      { key: 'contact_line_id', value: '@not-landing' },
    ])
    expect(out.landing_hero_title).toBe('')
    expect(out.landing_hero_color).toBe('#ABCDEF')
    expect(out.landing_howto_title).toBe('x')
    expect(out.landing_hero_subtitle).toBe(LANDING_DEFAULTS.landing_hero_subtitle)
    expect(Object.keys(out).sort()).toEqual([...LANDING_SETTING_KEYS].sort())
    expect(overlayLandingSettings([{ key: 'landing_hero_color', value: 'blue' }]).landing_hero_color).toBe('#7c2d12')
  })

  it('the landing keys are kept out of the site settings whitelist', () => {
    for (const k of LANDING_SETTING_KEYS) expect((SITE_SETTING_KEYS as readonly string[]).includes(k)).toBe(false)
  })
})
