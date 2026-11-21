// Shared set-up of the public results tests: a real libSQL file database with the project's migrations
// and the lottery catalog, the app called with `app.request` (the way the other test files do), an admin
// session, the results robot key, a fake PUBLIC_RESULTS bucket and a fake ExecutionContext. The context
// collects what the routes hand to ctx.waitUntil (the background build after a change) and `call` waits
// for it before answering, so a test reads the bucket right after the response; `background: 'keep'`
// leaves it pending for tests that interleave builds.
import { existsSync, rmSync } from 'node:fs'
import { expect } from 'vitest'
import { and, eq, like, notInArray, sql } from 'drizzle-orm'
import app from '../../src/index'
import type { AdminMember, AssetBucket, Bindings } from '../../src/types'
import { hashPassword } from '../../src/lib/crypto'
import { resetLimiter } from '../../src/lib/loginLimiter'
import { getDb, type DB } from '../../src/db/client'
import { openDb, runMigrations } from '../../scripts/db'
import { LOTTERY_CATALOG } from '../../src/db/catalog'
import { lotteries, lotteryResults, lotterySchedules, siteSettings } from '../../src/db/schema'
import { readPublishState, DIRTY_PREFIX } from '../../src/lib/publicChange'
import { FakeBucket } from './fakeR2'

export const ROBOT_KEY = 'test-public-key-0123456789abcdef0123456789abcdef'

const assetBucket: AssetBucket = {
  async put() {
    return {}
  },
  async get() {
    return null
  },
  async delete() {},
}

export interface CallOpts {
  cookie?: string
  /** value of the X-API-Key header */
  key?: string
  body?: unknown
  headers?: Record<string, string>
  env?: Bindings
  /** 'keep' = do not wait for the background build; it is returned in `harness.background` */
  background?: 'wait' | 'keep'
}

export interface Harness {
  env: Bindings
  bucket: FakeBucket
  db: DB
  admin: string
  /** Background work left pending by calls made with background: 'keep'. */
  background: Promise<unknown>[]
  call(method: string, path: string, o?: CallOpts): Promise<Response>
  /** PUT /results with the robot key (or the options given). */
  put(body: unknown, o?: CallOpts): Promise<Response>
  /** An admin call (the admin cookie). */
  adm(method: string, path: string, body?: unknown, o?: CallOpts): Promise<Response>
  newMember(name: string): Promise<{ id: string; cookie: string }>
  state(): ReturnType<typeof readPublishState>
  /** The dirty marks as { key, value } sorted by key. */
  marks(): Promise<{ key: string; value: string }[]>
  officialRow(lotteryId: string, date: string, time?: string): Promise<typeof lotteryResults.$inferSelect | undefined>
  /**
   * Wipes results, schedules and every site_settings row (marks, versions) and the bucket; the catalog
   * switches go back on. The bucket then holds a version.json of version 0, as after a first publish
   * (otherwise the first change would count as "nothing was ever published" and build everything);
   * `neverPublished: true` leaves it empty.
   */
  reset(o?: { neverPublished?: boolean }): Promise<void>
  close(): void
}

export function removeDbFiles(file: string) {
  for (const f of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    if (existsSync(f)) rmSync(f)
  }
}

function cookieFrom(res: Response, name: string): string {
  const raw = res.headers.get('set-cookie') ?? ''
  const m = raw.match(new RegExp(`${name}=([^;]*)`))
  if (!m) throw new Error(`no ${name} cookie in: ${raw}`)
  return `${name}=${m[1]}`
}

export async function createHarness(dbFile: string, opts: { bucket?: boolean; extraEnv?: Partial<Bindings> } = {}): Promise<Harness> {
  const url = `file:${dbFile}`
  removeDbFiles(dbFile)
  await runMigrations(url)
  const { client, db } = openDb(url)
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
  const bucket = new FakeBucket()
  const env: Bindings = {
    TURSO_DATABASE_URL: url,
    TURSO_AUTH_TOKEN: '',
    SESSION_SECRET: 'test-session-secret',
    ASSET_SIGNING_SECRET: 'test-asset-secret',
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD_HASH: await hashPassword('admin1234', 1000),
    WEB_URL: 'http://localhost:5173',
    COOKIE_SECURE: 'false',
    ASSETS: assetBucket,
    RESULTS_API_KEY: ROBOT_KEY,
    ...(opts.bucket === false ? {} : { PUBLIC_RESULTS: bucket }),
    ...opts.extraEnv,
  }
  const handle = getDb(env)
  const background: Promise<unknown>[] = []

  const harness: Harness = {
    env,
    bucket,
    db: handle,
    admin: '',
    background,
    async call(method, path, o = {}) {
      const headers = new Headers(o.headers)
      if (o.cookie) headers.set('Cookie', o.cookie)
      if (o.key !== undefined) headers.set('X-API-Key', o.key)
      let payload: string | undefined
      if (o.body !== undefined) {
        payload = typeof o.body === 'string' ? o.body : JSON.stringify(o.body)
        headers.set('Content-Type', 'application/json')
      }
      const pending: Promise<unknown>[] = []
      const ctx = {
        waitUntil: (p: Promise<unknown>) => {
          pending.push(p)
        },
        passThroughOnException() {},
      }
      const res = await app.request(path, { method, headers, body: payload }, o.env ?? env, ctx as never)
      if (o.background === 'keep') background.push(...pending)
      else await Promise.all(pending)
      return res
    },
    put(body, o = { key: ROBOT_KEY }) {
      return harness.call('PUT', '/results', { ...o, body })
    },
    adm(method, path, body, o = {}) {
      return harness.call(method, path, { ...o, cookie: harness.admin, body })
    },
    async newMember(name) {
      const res = await harness.call('POST', '/admin/members', {
        cookie: harness.admin,
        body: { displayName: name, expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
      })
      const m = (await res.json()) as AdminMember
      const sp = await harness.call('POST', `/link/${m.linkToken}/set-password`, { body: { password: 'password-123' } })
      expect(sp.status).toBe(204)
      return { id: m.id, cookie: cookieFrom(sp, 'ng_session') }
    },
    state: () => readPublishState(handle),
    async marks() {
      const rows = await handle
        .select({ key: siteSettings.key, value: siteSettings.value })
        .from(siteSettings)
        .where(like(siteSettings.key, `${DIRTY_PREFIX}%`))
      return rows.sort((a, b) => (a.key < b.key ? -1 : 1))
    },
    async officialRow(lotteryId, date, time = '') {
      const [row] = await handle
        .select()
        .from(lotteryResults)
        .where(
          and(
            eq(lotteryResults.lotteryId, lotteryId),
            eq(lotteryResults.drawDate, date),
            eq(lotteryResults.drawTime, time),
            eq(lotteryResults.memberId, ''),
          ),
        )
      return row
    },
    async reset(o = {}) {
      await resetLimiter(handle)
      await handle.delete(lotteryResults)
      await handle.delete(lotterySchedules)
      await handle.delete(siteSettings)
      // the catalog as it was: lotteries a test made or deleted, renamed or switched off are put right
      await handle.delete(lotteries).where(notInArray(lotteries.id, LOTTERY_CATALOG.map((l) => l.id)))
      await handle
        .insert(lotteries)
        .values(
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
        .onConflictDoUpdate({
          target: lotteries.id,
          set: {
            name: sql`excluded.name`,
            shortName: sql`excluded.short_name`,
            groupKey: sql`excluded.group_key`,
            accent: sql`excluded.accent`,
            sortOrder: sql`excluded.sort_order`,
            active: sql`excluded.active`,
            publicEnabled: true,
            notifyTime: null,
            notifyEnabled: false,
            ownerMemberId: null,
          },
        })
      bucket.objects.clear()
      bucket.beforePut = undefined
      bucket.beforeHead = undefined
      bucket.beforeDelete = undefined
      bucket.failPutFor = undefined
      if (!o.neverPublished) {
        await bucket.put('v1/version.json', JSON.stringify({ v: 0, serverTime: '2026-01-01T00:00:00.000Z' }), {
          customMetadata: { v: '0' },
        })
      }
      bucket.clearLog()
      background.length = 0
    },
    close() {
      removeDbFiles(dbFile)
    },
  }
  const login = await harness.call('POST', '/admin/login', { body: { username: 'admin', password: 'admin1234' } })
  expect(login.status).toBe(204)
  harness.admin = cookieFrom(login, 'ng_admin')
  return harness
}
