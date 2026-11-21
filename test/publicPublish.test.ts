// The public results pipeline end to end on a real libSQL database with a fake PUBLIC_RESULTS bucket:
// what a change bumps and marks, what a build writes (and in which order), the "really changed" rule, the
// guard against an older build (for the lottery files too: a slow older pass can neither bring back the
// file of a lottery that was hidden meanwhile nor delete the file of one that was shown again), the cron
// reconcile, the kill switch, a Worker without the bucket, the removal of files, the Bangkok midnight cases
// and what must never be public. The admin endpoints and the import are in publicAdmin.test.ts; the pure
// statistics are in publicSnapshot.test.ts.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, inArray } from 'drizzle-orm'
import type { Bindings, AdminLotteryResult } from '../src/types'
import { lotteries, lotteryResults, siteSettings } from '../src/db/schema'
import {
  putMonotonic,
  removeMonotonic,
  runPublishPass,
  runScheduledPublish,
  writeLotteryFiles,
  type LotteryFileJob,
  type PublishRun,
} from '../src/lib/publicPublish'
import { setPublicEnabled } from '../src/lib/publicChange'
import { loadPublicIds, loadPublicLotteries, lotteryPath } from '../src/lib/publicSnapshot'
import type { PublicDayFile, PublicLotteryFile, PublicTodayFile, PublicVersionFile } from '../src/lib/publicSnapshot'
import { scheduled } from '../src/index'
import { createHarness, ROBOT_KEY, type Harness } from './helpers/publicHarness'
import { FakeBucket } from './helpers/fakeR2'

const DB_FILE = 'test-public-publish.db'
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

const D = '2026-11-19'
const full = { top3: '123', top2: '45', bottom2: '67' }
/** Freezes only the clock (timers keep working), at a UTC instant. */
const at = (iso: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) })

const today = () => h.bucket.json<PublicTodayFile>('v1/today.json')
const lotteryFile = (id: string) => h.bucket.json<PublicLotteryFile>(`v1/lottery/${id}.json`)
const dayFile = (date: string) => h.bucket.json<PublicDayFile>(`v1/day/${date}.json`)
const versionFile = () => h.bucket.json<PublicVersionFile>('v1/version.json')

describe('a change of an official result', () => {
  it('counts the version, marks its day and lottery file, and publishes them in the background', async () => {
    at('2026-11-20T03:00:00Z') // 10:00 Bangkok on the 20th
    const res = await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    expect(res.status).toBe(201)
    // published already: the marks were processed by the pass that the route started
    expect(await h.marks()).toEqual([])
    const state = await h.state()
    expect(state.version).toBe(1)
    expect(state.published).toBe(1)
    expect(h.bucket.keys()).toEqual(['v1/day/2026-11-19.json', 'v1/lottery/hanoi-regular.json', 'v1/today.json', 'v1/version.json'])
    expect(versionFile()).toEqual({ v: 1, serverTime: '2026-11-20T03:00:00.000Z' })
    const day = dayFile(D)
    expect(day.results).toEqual([
      { lotteryId: 'hanoi-regular', date: D, time: '', ...full, state: 'final', updatedAt: '2026-11-20T03:00:00.000Z' },
    ])
    expect(lotteryFile('hanoi-regular').draws).toEqual([{ date: D, time: '', ...full, state: 'final' }])
  })

  it('every file of one build carries the same v, and version.json is written LAST', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    const written = h.bucket.puts()
    expect(written[written.length - 1]).toBe('v1/version.json')
    expect(new Set(written.slice(0, -1))).toEqual(new Set(['v1/day/2026-11-19.json', 'v1/lottery/hanoi-regular.json', 'v1/today.json']))
    const v = versionFile().v
    expect(today().v).toBe(v)
    expect(dayFile(D).v).toBe(v)
    expect(lotteryFile('hanoi-regular').v).toBe(v)
    // the version is also stored on each object, where the guard against an older build reads it
    for (const k of h.bucket.keys()) expect(h.bucket.objects.get(k)!.customMetadata.v).toBe(String(v))
  })

  it('stores the content type and the cache headers with each object', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    const meta = (k: string) => h.bucket.objects.get(k)!.httpMetadata
    for (const k of h.bucket.keys()) expect(meta(k).contentType).toBe('application/json; charset=utf-8')
    expect(meta('v1/version.json').cacheControl).toBe('public, max-age=5')
    expect(meta('v1/today.json').cacheControl).toBe('public, max-age=10')
    expect(meta('v1/day/2026-11-19.json').cacheControl).toBe('public, max-age=60')
    expect(meta('v1/lottery/hanoi-regular.json').cacheControl).toBe('public, max-age=60')
  })

  it('every real change counts once: the version grows by one per change', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full, top3: '999' })
    await h.put({ lotteryId: 'lao-vip', date: D, top2: '12' })
    expect((await h.state()).version).toBe(3)
    expect(versionFile().v).toBe(3)
    expect(today().v).toBe(3)
  })

  it('a robot sending identical numbers again changes nothing: no version, no marks, no write, updatedAt stays', async () => {
    const first = (await (await h.put({ lotteryId: 'hanoi-regular', date: D, ...full, source: 'robot-1' })).json()) as AdminLotteryResult
    const before = await h.state()
    const rowBefore = await h.officialRow('hanoi-regular', D)
    h.bucket.clearLog()
    await new Promise((r) => setTimeout(r, 5))
    const again = await h.put({ lotteryId: 'hanoi-regular', date: D, ...full, source: 'robot-2' })
    expect(again.status).toBe(200)
    expect((await again.json()) as AdminLotteryResult).toEqual(first) // the stored row, as it was
    expect(await h.state()).toEqual(before)
    expect(await h.marks()).toEqual([])
    expect(h.bucket.log).toEqual([]) // no build was started either
    expect(await h.officialRow('hanoi-regular', D)).toEqual(rowBefore)
    expect(await h.officialRow('hanoi-regular', D)).toMatchObject({ source: 'robot-1', updatedAt: first.updatedAt })
  })

  it('a different number is a change: version +1, updatedAt moves, the files follow', async () => {
    const first = (await (await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })).json()) as AdminLotteryResult
    await new Promise((r) => setTimeout(r, 5))
    const res = await h.put({ lotteryId: 'hanoi-regular', date: D, ...full, bottom2: '68' })
    expect(res.status).toBe(200)
    const second = (await res.json()) as AdminLotteryResult
    expect(second.id).toBe(first.id)
    expect(second.updatedAt > first.updatedAt).toBe(true)
    expect(dayFile(D).results[0]).toMatchObject({ bottom2: '68', updatedAt: second.updatedAt })
    expect((await h.state()).version).toBe(2)
  })

  it('clearing a number counts too (replace semantics)', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    await h.put({ lotteryId: 'hanoi-regular', date: D, top3: '123', top2: '45' }) // bottom2 left out = cleared
    expect(dayFile(D).results[0]).toMatchObject({ bottom2: null, state: 'partial' })
    expect((await h.state()).version).toBe(2)
  })

  it('a DELETE of an official result counts and removes it from the files', async () => {
    const created = (await (await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })).json()) as AdminLotteryResult
    const res = await h.adm('DELETE', `/results/${created.id}`)
    expect(res.status).toBe(204)
    expect((await h.state()).version).toBe(2)
    expect(dayFile(D).results).toEqual([])
    expect(lotteryFile('hanoi-regular').draws).toEqual([])
    // deleting something that is not there changes nothing
    const gone = await h.adm('DELETE', `/results/${created.id}`)
    expect(gone.status).toBe(404)
    expect((await h.state()).version).toBe(2)
  })

  it('a rejected write (validation, unknown lottery, wrong key) counts nothing', async () => {
    expect((await h.put({ lotteryId: 'hanoi-regular', date: D, top3: '12' })).status).toBe(400)
    expect((await h.put({ lotteryId: 'nope', date: D, top3: '123' })).status).toBe(404)
    expect((await h.put({ lotteryId: 'hanoi-regular', date: D, top3: '123' }, { key: 'wrong' })).status).toBe(401)
    expect((await h.state()).version).toBe(0)
    expect(h.bucket.log).toEqual([]) // no build; the bucket is as it was
  })

  it('a result of a lottery that is not public changes no file: no version, no mark, no build', async () => {
    await h.db.update(lotteries).set({ publicEnabled: false }).where(eq(lotteries.id, 'hanoi-hd'))
    await h.db.update(lotteries).set({ active: false }).where(eq(lotteries.id, 'hanoi-vip'))
    expect((await h.put({ lotteryId: 'hanoi-hd', date: D, ...full })).status).toBe(201)
    expect((await h.put({ lotteryId: 'hanoi-vip', date: D, ...full })).status).toBe(201)
    expect((await h.state()).version).toBe(0)
    expect(await h.marks()).toEqual([])
    expect(h.bucket.log).toEqual([])
    // but the rows are stored
    expect(await h.officialRow('hanoi-hd', D)).toBeDefined()
  })

  it('writes marks first and a failed build leaves them for the next one (the response is still fine)', async () => {
    h.bucket.failPutFor = (k) => k === 'v1/today.json'
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    expect(res.status).toBe(201)
    expect(log).toHaveBeenCalled()
    const keys = (await h.marks()).map((m) => m.key)
    expect(keys).toEqual(['results_dirty:d:2026-11-19', 'results_dirty:l:hanoi-regular'])
    expect(await h.state()).toMatchObject({ version: 1, published: 0 })
    // R2 is back: the next pass (the cron) finishes the work
    h.bucket.failPutFor = undefined
    const run = await runPublishPass(h.env)
    expect(run.status).toBe('published')
    expect(await h.marks()).toEqual([])
    expect(await h.state()).toMatchObject({ version: 1, published: 1 })
    expect(h.bucket.has('v1/today.json')).toBe(true)
  })
})

describe('a Worker without the PUBLIC_RESULTS binding (the test Worker)', () => {
  let bare: Harness
  beforeAll(async () => {
    bare = await createHarness('test-public-bare.db', { bucket: false })
  })
  afterAll(() => {
    try {
      bare.close()
    } catch {
      // see above
    }
  })

  it('stores the result, counts the change and marks the files, publishes nothing and does not fail', async () => {
    const res = await bare.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    expect(res.status).toBe(201)
    expect((await bare.state()).version).toBe(2) // migration 0010 seeds 1, this change is the second
    expect((await bare.marks()).map((m) => m.key)).toEqual(['results_dirty:d:2026-11-19', 'results_dirty:l:hanoi-regular'])
    expect(bare.bucket.log).toEqual([])
    expect(await bare.officialRow('hanoi-regular', D)).toBeDefined()
  })

  it('a pass and the cron do nothing without the bucket (no error, not even a database read)', async () => {
    expect((await runPublishPass(bare.env)).status).toBe('no-bucket')
    expect(await runScheduledPublish(bare.env)).toBeNull()
    await expect(scheduled({ scheduledTime: Date.now() }, bare.env)).resolves.toBeUndefined()
  })

  it('the live Worker publishes what the bucket-less Worker wrote (same database): the cron reconciles it', async () => {
    // the live Worker = the same database with a bucket
    const live: Bindings = { ...bare.env, PUBLIC_RESULTS: new FakeBucket() }
    // nothing was ever published: the first run builds everything, a few files a minute
    for (let minute = 0; minute < 40; minute++) {
      const run = await runScheduledPublish(live, Date.parse('2026-11-20T03:00:00Z') + minute * 60_000)
      if (run?.status === 'idle') break
    }
    const files = (live.PUBLIC_RESULTS as FakeBucket).keys()
    expect(files).toContain('v1/day/2026-11-19.json')
    expect(files).toContain('v1/lottery/hanoi-regular.json')
    expect(files).toContain('v1/version.json')
    expect(await bare.marks()).toEqual([])
    expect((await bare.state()).published).toBe(2)
  })
})

describe('the kill switch public_results_enabled', () => {
  it('off: nothing is published, changes still count and mark; on again: it catches up', async () => {
    expect((await h.adm('PUT', '/admin/public/enabled', { enabled: false })).status).toBe(200)
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    await h.put({ lotteryId: 'lao-vip', date: D, top2: '12' })
    expect(h.bucket.log).toEqual([])
    expect(await h.state()).toMatchObject({ enabled: false, version: 2, published: 0 })
    expect((await runPublishPass(h.env)).status).toBe('disabled')
    expect((await runScheduledPublish(h.env))?.status).toBe('disabled')
    expect(h.bucket.log).toEqual([])
    expect((await h.marks()).length).toBe(3) // one date and two lotteries

    // on again: the switch itself starts a build (the cron would too)
    expect((await h.adm('PUT', '/admin/public/enabled', { enabled: true })).status).toBe(200)
    expect(await h.state()).toMatchObject({ enabled: true, published: 2 })
    expect(await h.marks()).toEqual([])
    expect(dayFile(D).results.map((r) => r.lotteryId)).toEqual(['hanoi-regular', 'lao-vip'])
  })

  it('only the exact text "false" switches it off', async () => {
    for (const v of ['true', 'False', '0', '', 'off']) {
      await h.db.delete(siteSettings)
      await h.db.insert(siteSettings).values({ key: 'public_results_enabled', value: v, updatedAt: 'x' })
      expect((await h.state()).enabled, v).toBe(true)
    }
    await h.db.delete(siteSettings)
    await h.db.insert(siteSettings).values({ key: 'public_results_enabled', value: 'false', updatedAt: 'x' })
    expect((await h.state()).enabled).toBe(false)
  })
})

describe('the first publish (nothing was ever published)', () => {
  it('the first change builds everything, not just its own files, and does not repeat it on later passes', async () => {
    await h.reset({ neverPublished: true }) // no version.json in the bucket, no published version
    const now = Date.parse('2026-11-20T03:00:00Z')
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    // the request's pass handled its few files; every public lottery is marked
    const marked = (await h.marks()).map((m) => m.key)
    expect(marked.filter((k) => k.startsWith('results_dirty:l:')).length).toBeGreaterThan(70)
    expect(await h.state()).toMatchObject({ version: 1, published: 0 })
    expect(h.bucket.has('v1/version.json')).toBe(true)
    // later passes do NOT mark everything again (that would never end): the marks only shrink
    let left = (await h.marks()).length
    for (let i = 0; i < 40; i++) {
      const run = await runPublishPass(h.env, { nowMs: now })
      if (run.status === 'idle') break
      const now2 = (await h.marks()).length
      expect(now2).toBeLessThan(left)
      left = now2
    }
    expect(await h.state()).toMatchObject({ version: 1, published: 1 })
    expect(h.bucket.keys().filter((k) => k.startsWith('v1/lottery/'))).toHaveLength(82)
    expect(lotteryFile('hanoi-regular').draws).toHaveLength(1)
    expect(dayFile(D).results).toHaveLength(1)
  })

  it('once published, a change builds only its own files', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full }) // the bucket has a version.json already (see reset)
    expect(h.bucket.keys()).toEqual(['v1/day/2026-11-19.json', 'v1/lottery/hanoi-regular.json', 'v1/today.json', 'v1/version.json'])
    expect(await h.state()).toMatchObject({ version: 1, published: 1 })
  })
})

describe('the cron reconcile', () => {
  it('equal versions: it stops after the cheap read and touches nothing', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    h.bucket.clearLog()
    const run = await runScheduledPublish(h.env)
    expect(run?.status).toBe('idle')
    expect(h.bucket.log).toEqual([])
  })

  it('a version without marks (first publish, a hand edit) rebuilds everything: every public lottery and the recent days', async () => {
    // the data was written without going through the API: version 1 is what migration 0010 seeds
    await h.db.insert(siteSettings).values({ key: 'results_version', value: '1', updatedAt: 'x' })
    const rows = (date: string) => ({ id: `r-${date}`, lotteryId: 'hanoi-regular', drawDate: date, drawTime: '', memberId: '', top3: '123', top2: '45', bottom2: '67', source: null, createdAt: 'x', updatedAt: `${date}T01:00:00.000Z` })
    await h.db.insert(lotteryResults).values([rows('2026-11-19'), rows('2026-11-10'), rows('2026-01-01')])
    const now = Date.parse('2026-11-20T03:00:00Z')
    // each pass handles a few files; keep going the way the cron does, minute after minute
    const seen: string[] = []
    for (let i = 0; i < 40; i++) {
      const run = await runPublishPass(h.env, { nowMs: now, maxMarks: 8 })
      seen.push(run.status)
      if (run.status === 'idle') break
    }
    expect(seen[0]).toBe('published')
    expect(seen[seen.length - 1]).toBe('idle')
    const files = h.bucket.keys()
    // every public lottery (82 in the catalog) has a file, even without results
    expect(files.filter((k) => k.startsWith('v1/lottery/'))).toHaveLength(82)
    expect(files).toContain('v1/day/2026-11-19.json')
    expect(files).toContain('v1/day/2026-11-10.json')
    expect(files).not.toContain('v1/day/2026-01-01.json') // older than two weeks: only "rebuild all days" brings it
    expect(await h.state()).toMatchObject({ version: 1, published: 1 })
    expect(await h.marks()).toEqual([])
    expect(lotteryFile('hanoi-regular').draws).toHaveLength(3) // the history has all three
  })

  it('a pass handles a bounded number of files; the next pass continues (published only when none is left)', async () => {
    await h.db.insert(siteSettings).values({ key: 'results_version', value: '1', updatedAt: 'x' })
    const now = Date.parse('2026-11-20T03:00:00Z')
    const first = await runPublishPass(h.env, { nowMs: now, maxMarks: 8 })
    expect(first).toMatchObject({ status: 'published', more: true })
    // 8 lottery files + today.json + version.json
    expect(first.written).toHaveLength(10)
    expect(await h.state()).toMatchObject({ version: 1, published: 0 })
    expect((await h.marks()).length).toBeGreaterThan(0)
    const second = await runPublishPass(h.env, { nowMs: now, maxMarks: 8 })
    expect(second.status).toBe('published')
    expect(await h.state()).toMatchObject({ published: 0 })
  })

  it('one pass makes few calls: well inside the 50 a Worker may make per invocation', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full }) // warm: files exist
    h.bucket.clearLog()
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full, top3: '321' })
    // 3 data files + version.json: a head and a put each
    expect(h.bucket.log.length).toBeLessThanOrEqual(8)
    expect(h.bucket.log.filter((o) => o.op === 'get')).toEqual([]) // no body is ever downloaded
  })

  it('a full pass of the cron stays under 50 bucket calls', async () => {
    await h.db.insert(siteSettings).values({ key: 'results_version', value: '1', updatedAt: 'x' })
    await runPublishPass(h.env, { nowMs: 0, maxMarks: 8 })
    // 8 lotteries + today + version: 2 calls each, plus the one listing of the orphans
    expect(h.bucket.log.length).toBeLessThanOrEqual(30)
  })
})

describe('a slow older build never overwrites a newer one', () => {
  it('putMonotonic skips a file that holds a newer version', async () => {
    const b = new FakeBucket()
    expect(await putMonotonic(b, 'v1/today.json', { v: 6 }, 6)).toBe('written')
    expect(await putMonotonic(b, 'v1/today.json', { v: 5 }, 5)).toBe('older')
    expect(b.json('v1/today.json')).toEqual({ v: 6 })
    // an equal version overwrites (the same state of the data), a newer one too
    expect(await putMonotonic(b, 'v1/today.json', { v: 6, builtAt: 'again' }, 6)).toBe('written')
    expect(await putMonotonic(b, 'v1/today.json', { v: 7 }, 7)).toBe('written')
    expect(b.json('v1/today.json')).toEqual({ v: 7 })
  })

  it('a newer build that lands between the check and the write wins (the conditional write fails and the check is repeated)', async () => {
    const b = new FakeBucket()
    await putMonotonic(b, 'v1/today.json', { v: 4 }, 4)
    // the older build (v 5) has read the file (v 4) and is about to write; meanwhile v 6 is written
    b.beforePut = async (key) => {
      b.beforePut = undefined
      await putMonotonic(b, key, { v: 6 }, 6)
    }
    expect(await putMonotonic(b, 'v1/today.json', { v: 5 }, 5)).toBe('older')
    expect(b.json('v1/today.json')).toEqual({ v: 6 })
  })

  it('two creators of the same new file: the newer one wins whichever writes first', async () => {
    const b = new FakeBucket()
    b.beforePut = async (key) => {
      b.beforePut = undefined
      await putMonotonic(b, key, { v: 9 }, 9)
    }
    expect(await putMonotonic(b, 'v1/day/2026-11-19.json', { v: 8 }, 8)).toBe('older')
    expect(b.json('v1/day/2026-11-19.json')).toEqual({ v: 9 })
  })

  it('a whole older pass, slowed down in the middle, leaves the newer files alone', async () => {
    // version 1 with one marked file: pass A will build it and today.json at version 1
    await h.db.insert(siteSettings).values([
      { key: 'results_version', value: '1', updatedAt: 'x' },
      { key: 'results_dirty:l:hanoi-regular', value: '1', updatedAt: 'x' },
    ])
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    h.bucket.beforePut = async (key) => {
      if (key === 'v1/today.json') {
        h.bucket.beforePut = undefined
        await gate // A has looked at today.json and is about to write it
      }
    }
    const slow = runPublishPass(h.env, { nowMs: Date.parse('2026-11-20T03:00:00Z') })
    await vi.waitFor(() => expect(h.bucket.log.some((o) => o.op === 'head' && o.key === 'v1/today.json')).toBe(true))
    // while A waits, a newer build (version 2) writes today.json and version.json
    const newer = (key: string, body: object) =>
      h.bucket.objects.set(key, { body: JSON.stringify(body), etag: `etag-newer-${key}`, httpMetadata: {}, customMetadata: { v: '2' } })
    newer('v1/today.json', { v: 2, builtAt: 'newer' })
    newer('v1/version.json', { v: 2, serverTime: 'newer' })
    release()
    const run = await slow
    // A's today.json and version.json were refused; its lottery file (nothing newer there) was written
    expect(run.skipped).toEqual(['v1/today.json', 'v1/version.json'])
    expect(run.written).toEqual(['v1/lottery/hanoi-regular.json'])
    expect(h.bucket.json('v1/today.json')).toEqual({ v: 2, builtAt: 'newer' })
    expect(h.bucket.json('v1/version.json')).toEqual({ v: 2, serverTime: 'newer' })
    // the log shows the conditional write of today.json failing, then A looking again
    const todayOps = h.bucket.log.filter((o) => o.key === 'v1/today.json').map((o) => `${o.op}${o.stored === false ? '-refused' : ''}`)
    expect(todayOps).toEqual(['head', 'put-refused', 'head'])
  })
})

// ---- the lottery files: a missing file means "this lottery is not public" --------------------------------
// putMonotonic keeps a slow older pass from overwriting a file that holds a newer version, but a file that
// is NOT there carries no version. A pass that began while a lottery was public could create the file again
// after the newer pass removed it (the history of a hidden lottery, public again), and a pass that began while
// it was hidden could delete the file that a newer pass had just written when it was shown again.

describe('removing a file is version-aware (removeMonotonic)', () => {
  it('removes a file of the same or an older version, leaves a newer one, and makes no call for an absent one', async () => {
    const b = new FakeBucket()
    const path = 'v1/lottery/a.json'
    await putMonotonic(b, path, { v: 4 }, 4)
    expect(await removeMonotonic(b, path, 3)).toBe('newer') // a newer build wrote it: not this pass's to remove
    expect(b.has(path)).toBe(true)
    expect(b.log.some((o) => o.op === 'delete')).toBe(false)
    expect(await removeMonotonic(b, path, 4)).toBe('removed') // the same version = the same state of the data
    expect(b.has(path)).toBe(false)
    expect(await removeMonotonic(b, path, 4)).toBe('absent')
    expect(b.log.filter((o) => o.op === 'delete')).toHaveLength(1)
  })

  it('removes a file that has no usable version (put there by hand)', async () => {
    const b = new FakeBucket()
    await b.put('v1/lottery/a.json', '{}')
    await b.put('v1/lottery/b.json', '{}', { customMetadata: { v: 'x' } })
    expect(await removeMonotonic(b, 'v1/lottery/a.json', 1)).toBe('removed')
    expect(await removeMonotonic(b, 'v1/lottery/b.json', 1)).toBe('removed')
    expect(b.keys()).toEqual([])
  })
})

describe('loadPublicIds: which lotteries are public right now', () => {
  it('answers with the public ones only: not a switched-off one, a hidden one, an unknown id or a member\'s own lottery', async () => {
    const member = await h.newMember('lister')
    const created = await h.call('POST', '/lotteries', { cookie: member.cookie, body: { name: 'หวยส่วนตัว', group: 'other' } })
    expect(created.status).toBe(200)
    const ownId = ((await created.json()) as { id: string }).id
    await h.db.update(lotteries).set({ active: false }).where(eq(lotteries.id, 'hanoi-vip'))
    await h.db.update(lotteries).set({ publicEnabled: false }).where(eq(lotteries.id, 'hanoi-hd'))
    const found = await loadPublicIds(h.db, ['hanoi-regular', 'lao-vip', 'hanoi-vip', 'hanoi-hd', 'nope', ownId])
    expect([...found].sort()).toEqual(['hanoi-regular', 'lao-vip'])
    expect(await loadPublicIds(h.db, [])).toEqual(new Set())
  })

  it('reads more ids than D1 may bind in one statement, in several queries', async () => {
    const all = (await loadPublicLotteries(h.db)).map((l) => l.id)
    expect(all.length).toBeGreaterThan(70)
    const many = [...Array.from({ length: 150 }, (_, i) => `ghost-${i}`), ...all]
    expect([...(await loadPublicIds(h.db, many))].sort()).toEqual([...all].sort())
  })
})

describe('a slow older pass and the lottery files', () => {
  const X = 'hanoi-regular'
  const xPath = lotteryPath(X)
  const now = Date.parse('2026-11-20T03:00:00Z')
  const quietWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {})
  /** The corrections this feature logs (nothing else is counted). */
  const corrections = (warn: ReturnType<typeof quietWarn>) =>
    warn.mock.calls.filter((c) => String(c[0]).startsWith('public snapshots:'))
  const run0 = (): PublishRun => ({ status: 'published', version: 5, written: [], skipped: [], deleted: [], more: false })
  const mark = (id: string) => `results_dirty:l:${id}`
  const noXAnywhere = () => {
    const text = h.bucket.allText()
    expect(text).not.toContain(`"id":"${X}"`)
    expect(text).not.toContain(`"lotteryId":"${X}"`)
  }

  // ---- a lottery that stops being public while an older pass is still writing its file

  /** Every way a published lottery stops being public: each is ONE counted change that marks its file and its dates. */
  const stops: [string, () => Promise<Response>][] = [
    ['hidden with the back office switch', () => h.adm('PATCH', `/admin/public/lotteries/${X}`, { publicEnabled: false })],
    ['switched off (active = false)', () => h.adm('PATCH', `/admin/lotteries/${X}`, { active: false })],
    ['deleted', () => h.adm('DELETE', `/admin/lotteries/${X}`)],
  ]

  describe.each(stops)('a lottery that is %s while an older pass writes its file', (_name, stop) => {
    it.each([true, false])(
      'cannot bring the file back (the file existed: %s): it is taken out again, the lottery is marked again and the next pass settles it',
      async (existed) => {
        const warn = quietWarn()
        at('2026-11-20T03:00:00Z')
        await h.put({ lotteryId: X, date: D, ...full }) // version 1, published: the file exists
        expect(h.bucket.has(xPath)).toBe(true)
        if (!existed) h.bucket.objects.delete(xPath) // the old pass then creates it instead of replacing it
        // Pass A is about to publish a second change of X (version 2) ...
        await h.db.update(siteSettings).set({ value: '2' }).where(eq(siteSettings.key, 'results_version'))
        await h.db.insert(siteSettings).values({ key: mark(X), value: '2', updatedAt: 'x' })
        let stopped = false
        h.bucket.beforePut = async (key) => {
          if (key !== xPath || stopped) return
          stopped = true
          // ... has built X's file from the data it read, and is about to write it. Meanwhile the admin stops X
          // (version 3) and a newer pass B publishes that completely: B removes the file and clears the marks.
          expect((await stop()).ok).toBe(true)
          expect(h.bucket.has(xPath)).toBe(false)
          expect(await h.state()).toMatchObject({ version: 3, published: 3 })
          expect(await h.marks()).toEqual([])
        }
        const run = await runPublishPass(h.env, { nowMs: now })
        expect(stopped).toBe(true)

        // the stopped lottery has no file, and nothing of it is public anywhere ...
        expect(h.bucket.has(xPath)).toBe(false)
        noXAnywhere()
        // ... although A did write the file after B had removed it: it took it out again before it finished
        expect(run.written).toContain(xPath)
        expect(run.deleted).toEqual([xPath])
        // A's today.json and version.json were refused (B's are newer); the lottery is marked again at a NEW version,
        // so the cron does not stay idle
        expect(run.skipped).toEqual(['v1/today.json', 'v1/version.json'])
        expect(run.more).toBe(true)
        expect(corrections(warn)).toHaveLength(1)
        expect(await h.state()).toMatchObject({ version: 4, published: 3 })
        expect(await h.marks()).toEqual([{ key: mark(X), value: '4' }])

        // the next pass finds nothing left to remove and publishes the new version
        const next = await runPublishPass(h.env, { nowMs: now })
        expect(next.status).toBe('published')
        expect(next.deleted).toEqual([])
        expect(await h.marks()).toEqual([])
        expect(await h.state()).toMatchObject({ version: 4, published: 4 })
        expect(h.bucket.has(xPath)).toBe(false)
        expect(today().lotteries.some((l) => l.id === X)).toBe(false)
        expect(today().v).toBe(4)
        noXAnywhere()
      },
    )
  })

  // ---- a lottery that is shown again while an older pass removes its file

  /** X is hidden (version 2, nothing published since): its file (version 1) is still there and A is about to remove it. */
  async function hiddenNotYetRemoved() {
    at('2026-11-20T03:00:00Z')
    await h.put({ lotteryId: X, date: D, ...full }) // version 1
    await h.adm('PUT', '/admin/public/enabled', { enabled: false }) // no pass can publish now
    await h.adm('PATCH', `/admin/public/lotteries/${X}`, { publicEnabled: false })
    await setPublicEnabled(h.db, true) // back on, quietly: no pass is started
    expect(h.bucket.has(xPath)).toBe(true)
    expect(await h.state()).toMatchObject({ version: 2, published: 1, enabled: true })
    expect((await h.marks()).map((m) => m.key)).toEqual([`results_dirty:d:${D}`, mark(X)])
  }
  const show = () => h.adm('PATCH', `/admin/public/lotteries/${X}`, { publicEnabled: true })

  describe('a lottery that is shown again while an older pass removes its file', () => {
    it('leaves the file that the newer pass wrote (the removal checks the stored version)', async () => {
      await hiddenNotYetRemoved()
      let shown = false
      h.bucket.beforeHead = async (key) => {
        if (key !== xPath || shown) return
        shown = true
        // B (version 3) publishes X again: the file exists before A looks at it
        expect((await show()).status).toBe(200)
        expect(await h.state()).toMatchObject({ version: 3, published: 3 })
      }
      const run = await runPublishPass(h.env, { nowMs: now, maxMarks: 8 })
      expect(shown).toBe(true)
      expect(run.deleted).toEqual([])
      expect(run.skipped).toContain(xPath)
      expect(h.bucket.log.filter((o) => o.op === 'delete')).toEqual([])
      expect(h.bucket.has(xPath)).toBe(true)
      expect(lotteryFile(X)).toMatchObject({ v: 3, draws: [{ date: D, ...full }] })
      expect(await h.marks()).toEqual([])
      expect(await h.state()).toMatchObject({ version: 3, published: 3 })
    })

    it('puts the file back when the newer pass wrote it between the check and the delete', async () => {
      const warn = quietWarn()
      await hiddenNotYetRemoved()
      let shown = false
      h.bucket.beforeDelete = async (key) => {
        if (key !== xPath || shown) return
        shown = true
        // A has looked at the file (version 1, not newer than A) and is about to delete it; B publishes X again first
        expect((await show()).status).toBe(200)
        expect(h.bucket.json<PublicLotteryFile>(xPath).v).toBe(3)
      }
      const run = await runPublishPass(h.env, { nowMs: now, maxMarks: 8 })
      expect(shown).toBe(true)
      // R2 cannot delete conditionally, so A did delete B's file; it noticed that X is public and marked it again
      expect(run.deleted).toEqual([xPath])
      expect(h.bucket.has(xPath)).toBe(false)
      expect(corrections(warn)).toHaveLength(1)
      expect(run.more).toBe(true)
      expect(await h.state()).toMatchObject({ version: 4, published: 3 })
      expect(await h.marks()).toEqual([{ key: mark(X), value: '4' }])

      const next = await runPublishPass(h.env, { nowMs: now })
      expect(next.status).toBe('published')
      expect(next.written).toContain(xPath)
      expect(lotteryFile(X)).toMatchObject({ v: 4, draws: [{ date: D, ...full }] })
      expect(await h.marks()).toEqual([])
      expect(await h.state()).toMatchObject({ version: 4, published: 4 })
      expect(today().lotteries.some((l) => l.id === X)).toBe(true)
    })
  })

  // ---- the two looks of writeLotteryFiles, one by one

  it('a job that no longer matches its lottery is put off BEFORE anything is written, and its mark is kept', async () => {
    const [Y, Z, W] = ['lao-vip', 'dow-jones', 'hanoi-hd']
    // X: built while public, hidden since. Y: a removal built while Y was hidden, public since.
    // Z: still public (written). W: still hidden (removed).
    await h.db.update(lotteries).set({ publicEnabled: false }).where(inArray(lotteries.id, [X, W]))
    await h.bucket.put(lotteryPath(Y), '{"v":1}', { customMetadata: { v: '1' } })
    await h.bucket.put(lotteryPath(W), '{"v":1}', { customMetadata: { v: '1' } })
    const job = (id: string, body?: unknown): LotteryFileJob => ({ id, path: lotteryPath(id), markKey: mark(id), body })
    const jobs = [job(X, { v: 5 }), job(Y), job(Z, { v: 5 }), job(W)]
    h.bucket.clearLog()
    const run = run0()
    const held = await writeLotteryFiles(h.db, h.bucket, jobs, 5, '2026-11-20T03:00:00.000Z', run)
    expect([...held].sort()).toEqual([mark(X), mark(Y)].sort())
    expect(run).toMatchObject({ written: [lotteryPath(Z)], skipped: [lotteryPath(X), lotteryPath(Y)], deleted: [lotteryPath(W)], more: true })
    expect(h.bucket.has(lotteryPath(X))).toBe(false) // not written
    expect(h.bucket.has(lotteryPath(Y))).toBe(true) // not removed
    expect(h.bucket.has(lotteryPath(Z))).toBe(true)
    expect(h.bucket.has(lotteryPath(W))).toBe(false)
    // the put-off jobs never reached the bucket
    expect(h.bucket.log.filter((o) => o.key === lotteryPath(X) || o.key === lotteryPath(Y))).toEqual([])
    // nothing was wrong afterwards, so nothing is counted
    expect((await h.state()).version).toBe(0)
  })

  it('a pass whose jobs all match costs two reads of D1 and no extra bucket call; without lottery files it costs nothing', async () => {
    const reads = vi.spyOn(h.db, 'select')
    const job: LotteryFileJob = { id: X, path: xPath, markKey: mark(X), body: { v: 5 } }
    h.bucket.clearLog()
    const run = run0()
    expect((await writeLotteryFiles(h.db, h.bucket, [job], 5, '2026-11-20T03:00:00.000Z', run)).size).toBe(0)
    expect(h.bucket.log.map((o) => o.op)).toEqual(['head', 'put'])
    expect(run).toMatchObject({ written: [xPath], skipped: [], deleted: [], more: false })
    expect(reads).toHaveBeenCalledTimes(2) // just before and just after
    reads.mockClear()
    expect((await writeLotteryFiles(h.db, h.bucket, [], 5, 'x', run0())).size).toBe(0)
    expect(reads).not.toHaveBeenCalled()
  })

  it('the second look also happens when the writing fails halfway, and the failure is still reported', async () => {
    const warn = quietWarn()
    const Y = 'lao-vip'
    const job = (id: string): LotteryFileJob => ({ id, path: lotteryPath(id), markKey: mark(id), body: { v: 5 } })
    h.bucket.beforePut = async (key) => {
      if (key !== xPath) return
      h.bucket.beforePut = undefined
      await h.db.update(lotteries).set({ publicEnabled: false }).where(eq(lotteries.id, X)) // hidden while A writes
    }
    h.bucket.failPutFor = (k) => k === lotteryPath(Y) // and the next file cannot be written
    await expect(writeLotteryFiles(h.db, h.bucket, [job(X), job(Y)], 5, '2026-11-20T03:00:00.000Z', run0())).rejects.toThrow('R2 put failed')
    expect(h.bucket.has(xPath)).toBe(false) // written, then corrected
    expect(corrections(warn)).toHaveLength(1)
    expect(await h.state()).toMatchObject({ version: 1 })
    expect(await h.marks()).toEqual([{ key: mark(X), value: '1' }])
  })

  it('the mark and the delete of a correction are each tried whatever happens to the other', async () => {
    quietWarn()
    await h.db.insert(siteSettings).values({ key: 'results_version', value: '5', updatedAt: 'x' }) // the pass below is version 5
    const job: LotteryFileJob = { id: X, path: xPath, markKey: mark(X), body: { v: 5 } }
    const hiddenWhileWriting = async (key: string) => {
      if (key !== xPath) return
      h.bucket.beforePut = undefined
      await h.db.update(lotteries).set({ publicEnabled: false }).where(eq(lotteries.id, X))
    }
    // D1 refuses the mark: the file of the hidden lottery goes all the same, and the failure is reported
    h.bucket.beforePut = hiddenWhileWriting
    vi.spyOn(h.db, 'batch').mockRejectedValueOnce(new Error('D1 refused (test)'))
    await expect(writeLotteryFiles(h.db, h.bucket, [job], 5, '2026-11-20T03:00:00.000Z', run0())).rejects.toThrow('D1 refused')
    expect(h.bucket.has(xPath)).toBe(false)
    expect((await h.state()).version).toBe(5) // nothing was counted
    // R2 refuses the delete: the mark is there, so the next pass removes the file
    await h.db.update(lotteries).set({ publicEnabled: true }).where(eq(lotteries.id, X))
    h.bucket.beforePut = hiddenWhileWriting
    h.bucket.beforeDelete = () => {
      throw new Error('R2 delete refused (test)')
    }
    await expect(writeLotteryFiles(h.db, h.bucket, [job], 5, '2026-11-20T03:00:00.000Z', run0())).rejects.toThrow('R2 delete refused')
    expect(h.bucket.has(xPath)).toBe(true)
    expect(await h.state()).toMatchObject({ version: 6 })
    expect(await h.marks()).toEqual([{ key: mark(X), value: '6' }])
    h.bucket.beforeDelete = undefined
    const next = await runPublishPass(h.env, { nowMs: now })
    expect(next.status).toBe('published')
    expect(h.bucket.has(xPath)).toBe(false)
    expect(await h.marks()).toEqual([])
  })

  it('a failure of the second look is reported, but never in place of the failure of the writing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const job = (id: string): LotteryFileJob => ({ id, path: lotteryPath(id), markKey: mark(id), body: { v: 5 } })
    // D1 answers the first read (just before) and fails the second (just after)
    const real = h.db.select.bind(h.db) as unknown as (...args: unknown[]) => unknown
    let reads = 0
    vi.spyOn(h.db, 'select').mockImplementation(((...args: unknown[]) => {
      if (++reads === 2) throw new Error('D1 is down (test)')
      return real(...args)
    }) as never)
    // the writing failed too: that is the failure to see, and the other one is logged
    h.bucket.failPutFor = (k) => k === lotteryPath('lao-vip')
    await expect(writeLotteryFiles(h.db, h.bucket, [job(X), job('lao-vip')], 5, 'x', run0())).rejects.toThrow('R2 put failed')
    expect(err).toHaveBeenCalledWith(expect.stringContaining('failed too'), expect.objectContaining({ message: 'D1 is down (test)' }))
    // the writing went well: the failure of the second look is the one that is reported
    h.bucket.failPutFor = undefined
    reads = 0
    await expect(writeLotteryFiles(h.db, h.bucket, [job(X)], 5, 'x', run0())).rejects.toThrow('D1 is down (test)')
  })

  it('without an overlap nothing is corrected: stopping, showing and deleting a lottery count the changes and nothing more', async () => {
    const warn = quietWarn()
    at('2026-11-20T03:00:00Z')
    await h.put({ lotteryId: X, date: D, ...full }) // 1
    expect((await h.adm('PATCH', `/admin/public/lotteries/${X}`, { publicEnabled: false })).status).toBe(200) // 2
    expect(h.bucket.has(xPath)).toBe(false)
    expect((await show()).status).toBe(200) // 3
    expect(h.bucket.has(xPath)).toBe(true)
    expect((await h.adm('PATCH', `/admin/lotteries/${X}`, { active: false })).status).toBe(200) // 4
    expect((await h.adm('PATCH', `/admin/lotteries/${X}`, { active: true })).status).toBe(200) // 5
    expect(h.bucket.has(xPath)).toBe(true)
    expect((await h.adm('DELETE', `/admin/lotteries/${X}`)).status).toBe(204) // 6
    expect(h.bucket.has(xPath)).toBe(false)
    expect(await h.state()).toMatchObject({ version: 6, published: 6 })
    expect(await h.marks()).toEqual([])
    expect(corrections(warn)).toEqual([])
  })

  // ---- random interleavings

  it('random interleavings of passes, visibility changes and result writes always end in the state D1 describes', async () => {
    const warn = quietWarn()
    const Y = 'lao-vip'
    const mulberry32 = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    for (let seed = 1; seed <= 20; seed++) {
      const rng = mulberry32(seed)
      const why = `seed ${seed}`
      await h.reset()
      at('2026-11-20T03:00:00Z')
      for (const id of [X, Y]) await h.put({ lotteryId: id, date: '2026-11-18', ...full })
      // every bucket call may take a few milliseconds, so the passes below really overlap
      const jitter = async () => {
        if (rng() < 0.6) await sleep(rng() * 3)
      }
      h.bucket.beforePut = jitter
      h.bucket.beforeHead = jitter
      h.bucket.beforeDelete = jitter
      const ops: Promise<unknown>[] = []
      const count = 4 + Math.floor(rng() * 7)
      for (let i = 0; i < count; i++) {
        await sleep(rng() * 4)
        const pick = rng()
        const id = rng() < 0.7 ? X : Y
        if (pick < 0.3) ops.push(h.adm('PATCH', `/admin/public/lotteries/${id}`, { publicEnabled: rng() < 0.5 }, { background: 'keep' }))
        else if (pick < 0.45) ops.push(h.adm('PATCH', `/admin/lotteries/${id}`, { active: rng() < 0.5 }, { background: 'keep' }))
        else if (pick < 0.75) {
          const date = `2026-11-${String(10 + Math.floor(rng() * 9)).padStart(2, '0')}`
          ops.push(h.put({ lotteryId: id, date, top3: String(100 + Math.floor(rng() * 800)), top2: '12', bottom2: '34' }, { key: ROBOT_KEY, background: 'keep' }))
        } else ops.push(runPublishPass(h.env, { maxMarks: 4 + Math.floor(rng() * 5) })) // a cron minute
      }
      await Promise.all(ops)
      await Promise.all(h.background)
      h.bucket.beforePut = undefined
      h.bucket.beforeHead = undefined
      h.bucket.beforeDelete = undefined
      // the cron carries on until nothing is left
      for (let i = 0; i < 40; i++) {
        const st = await h.state()
        if (st.published >= st.version && (await h.marks()).length === 0) break
        await runPublishPass(h.env)
      }
      expect(await h.marks(), why).toEqual([])
      const st = await h.state()
      expect(st.published, why).toBeGreaterThanOrEqual(st.version)

      // what D1 says is public, and what the bucket holds
      const publicNow = new Set((await loadPublicLotteries(h.db)).map((l) => l.id))
      expect(h.bucket.has(lotteryPath(X)), `${why}: the file of ${X}`).toBe(publicNow.has(X))
      expect(h.bucket.has(lotteryPath(Y)), `${why}: the file of ${Y}`).toBe(publicNow.has(Y))
      expect(today().lotteries.some((l) => l.id === X), `${why}: ${X} in today.json`).toBe(publicNow.has(X))
      const rows = (await h.db.select().from(lotteryResults)).filter((r) => r.memberId === '' && publicNow.has(r.lotteryId))
      for (const id of [X, Y]) {
        if (!publicNow.has(id)) continue
        const mine = rows.filter((r) => r.lotteryId === id)
        expect(lotteryFile(id).draws.length, `${why}: draws of ${id}`).toBe(mine.length)
      }
      const dates = new Set([...rows.map((r) => r.drawDate), ...h.bucket.keys().filter((k) => k.startsWith('v1/day/')).map((k) => k.slice('v1/day/'.length, -'.json'.length))])
      for (const date of dates) {
        const want = rows.filter((r) => r.drawDate === date).map((r) => `${r.lotteryId}:${r.top3}`).sort()
        const got = h.bucket.has(`v1/day/${date}.json`) ? dayFile(date).results.map((r) => `${r.lotteryId}:${r.top3}`).sort() : []
        expect(got, `${why}: day ${date}`).toEqual(want)
      }
      warn.mockClear()
    }
    // About one round in three makes a correction (the tests above replay each kind on purpose); whatever
    // the timing of this machine, every round must end in the state D1 describes.
  }, 180_000)
})

describe('what is not a change of the public results', () => {
  const D = '2026-11-19'

  it('a member\'s own result (typed, replaced, deleted) counts nothing and publishes nothing', async () => {
    const member = await h.newMember('typist2')
    const body = { lotteryId: 'hanoi-regular', date: D, top3: '555', top2: '55', bottom2: '55' }
    expect((await h.call('PUT', '/results/mine', { cookie: member.cookie, body })).status).toBe(201)
    expect((await h.call('PUT', '/results/mine', { cookie: member.cookie, body: { ...body, top3: '666' } })).status).toBe(200)
    expect((await h.call('DELETE', `/results/mine?lotteryId=hanoi-regular&date=${D}`, { cookie: member.cookie })).status).toBe(200)
    expect(await h.state()).toMatchObject({ version: 0, published: 0 })
    expect(await h.marks()).toEqual([])
    expect(h.bucket.log).toEqual([])
  })

  it('the back office cannot delete a member\'s personal result (404) and trying counts nothing', async () => {
    const member = await h.newMember('typist3')
    await h.call('PUT', '/results/mine', { cookie: member.cookie, body: { lotteryId: 'hanoi-regular', date: D, top3: '555' } })
    const [personal] = (await h.db.select().from(lotteryResults)).filter((r) => r.memberId === member.id)
    expect((await h.adm('DELETE', `/results/${personal.id}`)).status).toBe(404)
    expect((await h.db.select().from(lotteryResults)).some((r) => r.id === personal.id)).toBe(true)
    expect((await h.state()).version).toBe(0)
  })

  it('a personal result next to the official one: only the official one is published, and it is not touched by the personal write', async () => {
    const member = await h.newMember('typist4')
    await h.put({ lotteryId: 'hanoi-regular', date: D, top3: '123', top2: '12', bottom2: '12' })
    const version = (await h.state()).version
    h.bucket.clearLog()
    await h.call('PUT', '/results/mine', { cookie: member.cookie, body: { lotteryId: 'hanoi-regular', date: D, top3: '999', top2: '99', bottom2: '99' } })
    expect((await h.state()).version).toBe(version)
    expect(h.bucket.log).toEqual([])
    expect(dayFile(D).results[0]).toMatchObject({ top3: '123' })
  })
})

describe('the marks a pass works on', () => {
  const now = Date.parse('2026-11-20T03:00:00Z')

  it('lotteries first, then dates newest first, at most maxMarks in all; the rest stays marked', async () => {
    await h.db.insert(siteSettings).values([
      { key: 'results_version', value: '1', updatedAt: 'x' },
      ...['hanoi-regular', 'lao-vip', 'dow-jones'].map((id) => ({ key: `results_dirty:l:${id}`, value: '1', updatedAt: 'x' })),
      ...['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'].map((d) => ({ key: `results_dirty:d:${d}`, value: '1', updatedAt: 'x' })),
    ])
    const run = await runPublishPass(h.env, { nowMs: now, maxMarks: 4 })
    expect(run.status).toBe('published')
    expect(run.more).toBe(true)
    // the three lotteries and the newest date, then today.json, then version.json last
    expect(run.written).toEqual([
      'v1/lottery/dow-jones.json',
      'v1/lottery/hanoi-regular.json',
      'v1/lottery/lao-vip.json',
      'v1/day/2026-11-14.json',
      'v1/today.json',
      'v1/version.json',
    ])
    expect((await h.marks()).map((m) => m.key)).toEqual([
      'results_dirty:d:2026-11-10',
      'results_dirty:d:2026-11-11',
      'results_dirty:d:2026-11-12',
      'results_dirty:d:2026-11-13',
    ])
    expect((await h.state()).published).toBe(0) // marks of version 1 are left: not published yet
    const second = await runPublishPass(h.env, { nowMs: now, maxMarks: 4 })
    expect(second.written.filter((p) => p.startsWith('v1/day/'))).toEqual(['v1/day/2026-11-13.json', 'v1/day/2026-11-12.json', 'v1/day/2026-11-11.json', 'v1/day/2026-11-10.json'])
    expect(await h.marks()).toEqual([])
    expect((await h.state()).published).toBe(1)
  })

  it('a mark that was marked again during the build survives it (same key, newer value)', async () => {
    await h.db.insert(siteSettings).values([
      { key: 'results_version', value: '1', updatedAt: 'x' },
      { key: 'results_dirty:l:hanoi-regular', value: '1', updatedAt: 'x' },
    ])
    // a change arrives while the build is writing its files: it counts version 2 and marks the same file again
    h.bucket.beforePut = async (key) => {
      if (key !== 'v1/today.json') return
      h.bucket.beforePut = undefined
      await h.db.update(siteSettings).set({ value: '2' }).where(eq(siteSettings.key, 'results_version'))
      await h.db.update(siteSettings).set({ value: '2' }).where(eq(siteSettings.key, 'results_dirty:l:hanoi-regular'))
    }
    await runPublishPass(h.env, { nowMs: now, maxMarks: 4 })
    // the build started at version 1: its mark (value 1) was re-marked (value 2), so the mark stays; version 1 itself is
    // published (no mark of version 1 is left), version 2 is not
    expect(await h.marks()).toEqual([{ key: 'results_dirty:l:hanoi-regular', value: '2' }])
    expect(await h.state()).toMatchObject({ version: 2, published: 1 })
    const next = await runPublishPass(h.env, { nowMs: now, maxMarks: 4 })
    expect(next.status).toBe('published')
    expect(await h.marks()).toEqual([])
    expect(await h.state()).toMatchObject({ version: 2, published: 2 })
    expect(lotteryFile('hanoi-regular').v).toBe(2)
  })

  it('a hand-edited mark that names no possible file is dropped without writing anything for it', async () => {
    await h.db.insert(siteSettings).values([
      { key: 'results_version', value: '1', updatedAt: 'x' },
      { key: 'results_dirty:d:garbage', value: '1', updatedAt: 'x' },
      { key: 'results_dirty:d:2026-13-45', value: '1', updatedAt: 'x' },
      { key: 'results_dirty:l:bad id!', value: '1', updatedAt: 'x' },
      { key: 'results_dirty:l:../../x', value: '1', updatedAt: 'x' },
    ])
    const run = await runPublishPass(h.env, { nowMs: now, maxMarks: 8 })
    expect(run.status).toBe('published')
    expect(run.written).toEqual(['v1/today.json', 'v1/version.json'])
    expect(h.bucket.keys()).toEqual(['v1/today.json', 'v1/version.json'])
    expect(await h.marks()).toEqual([])
    expect(await h.state()).toMatchObject({ published: 1 })
  })

  it('only today.json and version.json are written for a version that carries no file mark', async () => {
    await h.db.insert(siteSettings).values([
      { key: 'results_version', value: '3', updatedAt: 'x' },
      { key: 'results_dirty:t', value: '3', updatedAt: 'x' },
    ])
    const run = await runPublishPass(h.env, { nowMs: now })
    expect(run.written).toEqual(['v1/today.json', 'v1/version.json'])
    expect(await h.marks()).toEqual([])
    expect(await h.state()).toMatchObject({ version: 3, published: 3 })
  })
})
