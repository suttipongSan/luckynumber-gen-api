// How many calls the public results work makes. A Worker invocation may make only so many D1 statements
// and R2 / fetch subrequests (50 each on the Workers Free plan, which this project runs on), and the cron
// runs every minute, so the numbers matter: an idle cron run must cost ONE read, a build after a change
// a few dozen calls at most, and a 2000 row import must not need more than a handful of statements. The
// libSQL client is wrapped to count the statements a request makes (a batch counts every statement in it,
// as D1 does).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { addDays } from '../src/lib/time'
import { runPublishPass, runScheduledPublish } from '../src/lib/publicPublish'
import { createHarness, type Harness } from './helpers/publicHarness'

const counter = vi.hoisted(() => ({ calls: 0, statements: 0 }))

vi.mock('@libsql/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@libsql/client')>()
  return {
    ...actual,
    createClient: (config: Parameters<typeof actual.createClient>[0]) => {
      const client = actual.createClient(config)
      return new Proxy(client, {
        get(target, prop) {
          if (prop === 'execute') {
            return (...args: Parameters<typeof target.execute>) => {
              counter.calls++
              counter.statements++
              return target.execute(...args)
            }
          }
          if (prop === 'batch') {
            return (stmts: unknown[], ...rest: unknown[]) => {
              counter.calls++
              counter.statements += stmts.length
              return (target.batch as (...a: unknown[]) => unknown)(stmts, ...rest)
            }
          }
          const value = Reflect.get(target, prop, target)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    },
  }
})

const DB_FILE = 'test-public-budget.db'
let h: Harness

beforeAll(async () => {
  h = await createHarness(DB_FILE)
})
beforeEach(async () => {
  await h.reset()
  vi.useRealTimers()
})
afterAll(() => {
  vi.useRealTimers()
  try {
    h.close()
  } catch {
    // the file may still be held open on Windows; harmless
  }
})

/** The D1 statements and the bucket calls `work` makes. */
async function measure(work: () => Promise<unknown>) {
  counter.calls = 0
  counter.statements = 0
  h.bucket.clearLog()
  await work()
  return { statements: counter.statements, bucket: h.bucket.log.length }
}

describe('calls per invocation (the Workers Free plan allows 50 of each)', () => {
  it('the cron with nothing to publish makes ONE read and no bucket call', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123' })
    const now = Date.now()
    await runScheduledPublish(h.env, now) // remembers the Bangkok day
    const m = await measure(() => runScheduledPublish(h.env, now))
    expect(m).toEqual({ statements: 1, bucket: 0 })
  })

  it('a Worker without the bucket makes no call at all', async () => {
    const m = await measure(() => runScheduledPublish({ ...h.env, PUBLIC_RESULTS: undefined }))
    expect(m).toEqual({ statements: 0, bucket: 0 })
  })

  it('a robot result: the whole request, background build included, stays far below the limits', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123', top2: '45', bottom2: '67' })
    const m = await measure(() => h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '321', top2: '45', bottom2: '67' }))
    expect(m.statements).toBeLessThanOrEqual(20)
    expect(m.bucket).toBeLessThanOrEqual(10) // a head and a put for three files and version.json
  })

  it('an identical result again costs only the lookup and the write attempt: no build', async () => {
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123' })
    const m = await measure(() => h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123' }))
    expect(m.bucket).toBe(0)
    expect(m.statements).toBeLessThanOrEqual(8)
  })

  it('a full cron pass of 8 marked files', async () => {
    await h.adm('POST', '/admin/public/publish', { rebuild: true }) // marks all 82 lotteries
    const m = await measure(() => runPublishPass(h.env, { maxMarks: 8 }))
    expect(m.statements).toBeLessThanOrEqual(25)
    expect(m.bucket).toBeLessThanOrEqual(25) // 9 files and version.json: a head and a put each
    expect(m.statements + m.bucket).toBeLessThanOrEqual(50)
  })

  it('the very first build also lists the bucket once, and still fits', async () => {
    await h.reset({ neverPublished: true })
    const m = await measure(() => h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', top3: '123' }))
    expect(m.statements + m.bucket).toBeLessThanOrEqual(50)
  })

  it('a 2000 row import: a handful of statements, and the request with its build stays under 50 of each', async () => {
    const lots = ['dow-jones', 'dow-jones-vip', 'dow-jones-star', 'nikkei-morning', 'nikkei-morning-vip', 'nikkei-afternoon', 'nikkei-afternoon-vip', 'china-morning', 'china-morning-vip', 'china-afternoon', 'hanoi-regular', 'hanoi-special', 'hanoi-vip', 'hanoi-hd', 'hanoi-hdx', 'lao-pattana', 'lao-vip', 'lao-star', 'lao-hd', 'lao-tv']
    const csv = lots.flatMap((id) => Array.from({ length: 100 }, (_, d) => `${id},${addDays('2026-11-01', -d)},,123,45,67`)).join('\n')
    const m = await measure(async () => {
      const res = await h.adm('POST', '/admin/results/import', { csv })
      expect(res.status).toBe(200)
      expect(((await res.json()) as { saved: number }).saved).toBe(2000)
    })
    expect(m.statements).toBeLessThanOrEqual(30)
    expect(m.bucket).toBeLessThanOrEqual(20)
    expect(m.statements).toBeLessThan(50)
    expect(m.bucket).toBeLessThan(50)
  })

  it('a dry run of 2000 rows reads, it does not write: two statements besides the login check', async () => {
    const csv = Array.from({ length: 2000 }, (_, d) => `hanoi-regular,${addDays('2026-11-01', -d)},,123,45,67`).join('\n')
    const m = await measure(async () => {
      const res = await h.adm('POST', '/admin/results/import', { csv, dryRun: true })
      expect(res.status).toBe(200)
    })
    expect(m.statements).toBeLessThanOrEqual(5)
    expect(m.bucket).toBe(0)
  })
})
