// What may be public, and when a file must change or disappear: members' typed results, members' own
// lotteries, switched-off lotteries and lotteries with public_enabled = 0 are in NO file, every file
// has exactly the whitelisted keys, a lottery that stops being public takes its file and its results
// out of every file, Bangkok midnight, and the daily roll-over of today.json. Real libSQL database,
// fake bucket.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { lotteries, lotteryResults, siteSettings } from '../src/db/schema'
import { runPublishPass, runScheduledPublish } from '../src/lib/publicPublish'
import { addDays } from '../src/lib/time'
import { scheduled } from '../src/index'
import type {
  PublicDayFile,
  PublicLotteryFile,
  PublicTodayFile,
  PublicVersionFile,
} from '../src/lib/publicSnapshot'
import { createHarness, type Harness } from './helpers/publicHarness'

const DB_FILE = 'test-public-privacy.db'
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
    // see publicPublish.test.ts
  }
})

const at = (iso: string) => vi.useFakeTimers({ toFake: ['Date'], now: new Date(iso) })
const today = () => h.bucket.json<PublicTodayFile>('v1/today.json')
const lotteryFile = (id: string) => h.bucket.json<PublicLotteryFile>(`v1/lottery/${id}.json`)
const dayFile = (date: string) => h.bucket.json<PublicDayFile>(`v1/day/${date}.json`)

/** Runs publishing passes the way the cron does until nothing is left. */
async function settle(nowMs = Date.now()) {
  for (let i = 0; i < 80; i++) {
    if ((await runPublishPass(h.env, { nowMs })).status !== 'published') return
    if ((await h.state()).published >= (await h.state()).version && (await h.marks()).length === 0) return
  }
  throw new Error('publishing never settled')
}

const sorted = (o: object) => Object.keys(o).sort()

// ---- what must never be public ---------------------------------------------------------------------

describe('what is never public', () => {
  const D = '2026-11-19'
  let member: { id: string; cookie: string }
  let privateId: string
  const PRIVATE_NAME = 'หวยลับของสมาชิก-qwerty'
  const SECRET_SOURCE = 'secret-source-xyz'

  // Public results only use the digits 1-4; everything that must stay hidden uses 5-9, so ANY number of
  // 5-9 in a published file is a leak, wherever it came from.
  const PUBLIC_NUMBER = /^[1-4]+$/
  const publicRow = (i: number) => ({
    top3: `${1 + (i % 4)}${1 + ((i * 3) % 4)}${1 + ((i * 7) % 4)}`,
    top2: `${1 + ((i * 3) % 4)}${1 + ((i * 7) % 4)}`,
    bottom2: `${1 + ((i * 5) % 4)}${1 + ((i * 11) % 4)}`,
  })

  beforeEach(async () => {
    member = await h.newMember('privacy-member')
    // a member's own lottery
    const created = await h.call('POST', '/lotteries', { cookie: member.cookie, body: { name: PRIVATE_NAME, group: 'other' } })
    expect(created.status).toBe(200)
    privateId = ((await created.json()) as { id: string }).id
    // switched-off and not-shown catalog lotteries
    await h.db.update(lotteries).set({ active: false }).where(eq(lotteries.id, 'hanoi-vip'))
    await h.db.update(lotteries).set({ publicEnabled: false }).where(eq(lotteries.id, 'hanoi-hd'))
    // official results: public lotteries (digits 1-4) with 35 draws for one of them (statistics), the hidden ones with 5-9
    await h.db.insert(lotteryResults).values(
      Array.from({ length: 35 }, (_, i) => ({
        id: `hist-${i}`,
        lotteryId: 'hanoi-regular',
        drawDate: addDays('2026-11-18', -i),
        drawTime: '',
        memberId: '',
        ...publicRow(i),
        source: SECRET_SOURCE,
        createdAt: 'x',
        updatedAt: '2026-11-19T10:00:00.000Z',
      })),
    )
    for (const [id, extra] of [
      ['lao-vip', { top3: '123', top2: '23', bottom2: '41' }],
      ['dow-jones', { top3: '444', top2: '44', bottom2: '11' }],
    ] as const) {
      expect((await h.put({ lotteryId: id, date: D, ...extra, source: SECRET_SOURCE })).status).toBe(201)
    }
    expect((await h.put({ lotteryId: 'hanoi-vip', date: D, top3: '987', top2: '98', bottom2: '87', source: SECRET_SOURCE })).status).toBe(201)
    expect((await h.put({ lotteryId: 'hanoi-hd', date: D, top3: '876', top2: '87', bottom2: '76', source: SECRET_SOURCE })).status).toBe(201)
    // an official row of the member's own lottery: the API never writes one, a hand edit could
    await h.db.insert(lotteryResults).values({ id: 'private-official', lotteryId: privateId, drawDate: D, drawTime: '', memberId: '', top3: '999', top2: '99', bottom2: '99', source: SECRET_SOURCE, createdAt: 'x', updatedAt: '2026-11-19T10:00:00.000Z' })
    // the member's own (personal) results, of a public lottery and of their own
    expect((await h.call('PUT', '/results/mine', { cookie: member.cookie, body: { lotteryId: 'hanoi-regular', date: D, top3: '567', top2: '56', bottom2: '78' } })).status).toBe(201)
    expect((await h.call('PUT', '/results/mine', { cookie: member.cookie, body: { lotteryId: privateId, date: D, top3: '789', top2: '78', bottom2: '89' } })).status).toBe(201)
    // and the official result of the lottery whose personal result exists
    expect((await h.put({ lotteryId: 'hanoi-regular', date: D, top3: '123', top2: '12', bottom2: '34', source: SECRET_SOURCE })).status).toBe(201)
    // build everything: every public lottery and every date
    expect((await h.adm('POST', '/admin/public/publish', { rebuild: true, allDays: true })).status).toBe(200)
    await settle(Date.parse('2026-11-20T03:00:00Z'))
  })

  /** Every object of every published file with the path of the file. */
  function* everyObject(): Generator<{ file: string; value: Record<string, unknown> }> {
    const walk = function* (file: string, v: unknown): Generator<{ file: string; value: Record<string, unknown> }> {
      if (Array.isArray(v)) for (const item of v) yield* walk(file, item)
      else if (v && typeof v === 'object') {
        yield { file, value: v as Record<string, unknown> }
        for (const item of Object.values(v)) yield* walk(file, item)
      }
    }
    for (const file of h.bucket.keys()) yield* walk(file, h.bucket.json(file))
  }

  it('publishes the public lotteries and nothing else: no file for a hidden, switched-off or member lottery', () => {
    const files = h.bucket.keys().filter((k) => k.startsWith('v1/lottery/'))
    expect(files).toHaveLength(80) // the catalog has 82; two are not public
    for (const hidden of ['hanoi-vip', 'hanoi-hd', privateId]) expect(files).not.toContain(`v1/lottery/${hidden}.json`)
    expect(files).toContain('v1/lottery/hanoi-regular.json')
    const ids = today().lotteries.map((l) => l.id)
    expect(ids).toHaveLength(80)
    for (const hidden of ['hanoi-vip', 'hanoi-hd', privateId]) expect(ids).not.toContain(hidden)
  })

  it('no id, name, source, member id or number of anything hidden is in any file', () => {
    const all = h.bucket.allText()
    expect(all).not.toContain(SECRET_SOURCE)
    expect(all).not.toContain(member.id)
    expect(all).not.toContain(privateId)
    expect(all).not.toContain(PRIVATE_NAME)
    expect(all).not.toContain('private-official')
    expect(all).not.toContain('hist-') // a row id
    // lottery ids appear only as public ones (exact values, not substrings: hanoi-hdx is public)
    const seen = new Set<string>()
    for (const { value } of everyObject()) {
      if (typeof value.lotteryId === 'string') seen.add(value.lotteryId)
      if (typeof value.id === 'string') seen.add(value.id)
    }
    expect(seen.has('hanoi-vip')).toBe(false)
    expect(seen.has('hanoi-hd')).toBe(false)
    // every number in every file is one of the public ones (digits 1-4 only)
    let numbers = 0
    for (const { file, value } of everyObject()) {
      for (const f of ['top3', 'top2', 'bottom2'] as const) {
        if (!(f in value) || typeof value[f] !== 'string') continue
        numbers++
        expect(value[f], `${file} ${f}`).toMatch(PUBLIC_NUMBER)
      }
    }
    expect(numbers).toBeGreaterThan(100) // the history and the day files really were inspected
  })

  it('the official result of a lottery is published, the member\'s own result of it is not', () => {
    expect(dayFile(D).results.find((r) => r.lotteryId === 'hanoi-regular')).toMatchObject({ top3: '123', top2: '12', bottom2: '34' })
    expect(lotteryFile('hanoi-regular').draws.find((d) => d.date === D)).toMatchObject({ top3: '123' })
    const onD = today().lotteries.find((l) => l.id === 'hanoi-regular')!.results.filter((r) => r.date === D)
    expect(onD.map((r) => r.top3)).toEqual(['123']) // today.json of the 20th covers the 19th: the official result, never the member's 567
  })

  it('the day file of that date holds public lotteries only', () => {
    expect(dayFile(D).results.map((r) => r.lotteryId)).toEqual(['dow-jones', 'hanoi-regular', 'lao-vip'])
  })

  it('every file has exactly the whitelisted keys', () => {
    expect(sorted(h.bucket.json<PublicVersionFile>('v1/version.json'))).toEqual(['serverTime', 'v'])
    const t = today()
    expect(sorted(t)).toEqual(['builtAt', 'groups', 'lotteries', 'today', 'v', 'yesterday'])
    expect(sorted(t.groups[0])).toEqual(['key', 'label'])
    for (const l of t.lotteries) {
      expect(sorted(l)).toEqual(['accent', 'group', 'id', 'name', 'results', 'schedules', 'shortName', 'sortOrder'])
      for (const r of l.results) expect(sorted(r)).toEqual(['bottom2', 'date', 'state', 'time', 'top2', 'top3', 'updatedAt'])
    }
    const day = dayFile(D)
    expect(sorted(day)).toEqual(['builtAt', 'date', 'results', 'v'])
    for (const r of day.results) expect(sorted(r)).toEqual(['bottom2', 'date', 'lotteryId', 'state', 'time', 'top2', 'top3', 'updatedAt'])
    for (const k of h.bucket.keys().filter((k) => k.startsWith('v1/lottery/'))) {
      const f = h.bucket.json<PublicLotteryFile>(k)
      expect(sorted(f), k).toEqual(['builtAt', 'draws', 'lottery', 'schedules', 'stats', 'v'])
      expect(sorted(f.lottery)).toEqual(['accent', 'group', 'id', 'name', 'shortName', 'sortOrder'])
      for (const d of f.draws) expect(sorted(d)).toEqual(['bottom2', 'date', 'state', 'time', 'top2', 'top3'])
    }
    // the lottery with 36 draws has statistics: check their keys too
    const stats = lotteryFile('hanoi-regular').stats!
    expect(stats.map((w) => w.draws)).toEqual([30])
    expect(sorted(stats[0])).toEqual(['bottom2', 'draws', 'from', 'to', 'top2'])
    for (const field of [stats[0].top2, stats[0].bottom2]) {
      expect(sorted(field)).toEqual(['digitCounts', 'digitGaps', 'doubles', 'even', 'high', 'low', 'numberGaps', 'odd', 'of', 'topNumbers'])
      expect(sorted(field.topNumbers[0])).toEqual(['count', 'n'])
      expect(sorted(field.digitGaps[0])).toEqual(['digit', 'gap', 'last'])
      expect(sorted(field.numberGaps[0])).toEqual(['gap', 'last', 'n'])
    }
  })

  it('statistics count official results only: the history of 36 draws, not the member\'s own', () => {
    const f = lotteryFile('hanoi-regular')
    expect(f.draws).toHaveLength(36)
    expect(f.stats![0].top2.of).toBe(30)
  })

  it('every public file stays within its own lottery: a lottery file lists only that lottery\'s results', () => {
    const f = lotteryFile('lao-vip')
    expect(f.draws).toEqual([{ date: D, time: '', top3: '123', top2: '23', bottom2: '41', state: 'final' }])
  })
})

// ---- a lottery that stops being public -----------------------------------------------------------

describe('a lottery that stops (or starts) being public', () => {
  const D = '2026-11-19'
  const full = { top3: '123', top2: '45', bottom2: '67' }
  const now = '2026-11-20T03:00:00Z'

  beforeEach(async () => {
    at(now)
    await h.put({ lotteryId: 'hanoi-regular', date: D, ...full })
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-18', ...full })
    await h.put({ lotteryId: 'lao-vip', date: D, top2: '12' })
    expect(h.bucket.has('v1/lottery/hanoi-regular.json')).toBe(true)
    expect(dayFile(D).results.map((r) => r.lotteryId)).toEqual(['hanoi-regular', 'lao-vip'])
  })

  const patch = (id: string, body: object) => h.adm('PATCH', `/admin/lotteries/${id}`, body)
  const results = (date: string) => dayFile(date).results.map((r) => r.lotteryId)

  it('active = false: its file is removed, it leaves today.json and every day file, the others stay', async () => {
    const before = (await h.state()).version
    expect((await patch('hanoi-regular', { active: false })).status).toBe(200)
    expect((await h.state()).version).toBe(before + 1)
    expect(h.bucket.has('v1/lottery/hanoi-regular.json')).toBe(false)
    expect(today().lotteries.some((l) => l.id === 'hanoi-regular')).toBe(false)
    expect(results(D)).toEqual(['lao-vip'])
    expect(results('2026-11-18')).toEqual([])
    expect(h.bucket.has('v1/lottery/lao-vip.json')).toBe(true)
  })

  it('and back: active again, its file and its results come back', async () => {
    await patch('hanoi-regular', { active: false })
    expect((await patch('hanoi-regular', { active: true })).status).toBe(200)
    expect(h.bucket.has('v1/lottery/hanoi-regular.json')).toBe(true)
    expect(lotteryFile('hanoi-regular').draws).toHaveLength(2)
    expect(results(D)).toEqual(['hanoi-regular', 'lao-vip'])
    expect(results('2026-11-18')).toEqual(['hanoi-regular'])
    expect(today().lotteries.some((l) => l.id === 'hanoi-regular')).toBe(true)
  })

  it('public_enabled = 0 (the back office switch): the same, and back on again', async () => {
    expect((await h.adm('PATCH', '/admin/public/lotteries/hanoi-regular', { publicEnabled: false })).status).toBe(200)
    expect(h.bucket.has('v1/lottery/hanoi-regular.json')).toBe(false)
    expect(results(D)).toEqual(['lao-vip'])
    expect(today().lotteries.some((l) => l.id === 'hanoi-regular')).toBe(false)
    expect((await h.adm('PATCH', '/admin/public/lotteries/hanoi-regular', { publicEnabled: true })).status).toBe(200)
    expect(results(D)).toEqual(['hanoi-regular', 'lao-vip'])
    expect(h.bucket.has('v1/lottery/hanoi-regular.json')).toBe(true)
  })

  it('deleting the lottery removes its file and its results from the files', async () => {
    expect((await h.adm('DELETE', '/admin/lotteries/hanoi-regular')).status).toBe(204)
    expect(h.bucket.has('v1/lottery/hanoi-regular.json')).toBe(false)
    expect(results(D)).toEqual(['lao-vip'])
    expect(results('2026-11-18')).toEqual([])
    expect(today().lotteries.some((l) => l.id === 'hanoi-regular')).toBe(false)
  })

  it('a change of a lottery that is not public changes no file (and counts nothing)', async () => {
    await patch('hanoi-vip', { active: false })
    await h.adm('PATCH', '/admin/public/lotteries/hanoi-hd', { publicEnabled: false })
    const before = await h.state()
    h.bucket.clearLog()
    expect((await patch('hanoi-vip', { name: 'ฮานอย VIP ใหม่', sortOrder: 5 })).status).toBe(200)
    expect((await h.adm('PATCH', '/admin/public/lotteries/hanoi-vip', { publicEnabled: false })).status).toBe(200) // already inactive: no visible change
    expect(await h.state()).toEqual(before)
    expect(h.bucket.log).toEqual([])
  })

  it('a rename, a new accent colour or a new position counts and reaches today.json and the lottery file', async () => {
    const before = (await h.state()).version
    expect((await patch('hanoi-regular', { name: 'ฮานอยปกติ (ใหม่)', accent: '#112233', sortOrder: 5 })).status).toBe(200)
    expect((await h.state()).version).toBe(before + 1)
    const entry = today().lotteries.find((l) => l.id === 'hanoi-regular')!
    expect(entry).toMatchObject({ name: 'ฮานอยปกติ (ใหม่)', accent: '#112233', sortOrder: 5 })
    expect(lotteryFile('hanoi-regular').lottery).toMatchObject({ name: 'ฮานอยปกติ (ใหม่)', accent: '#112233', sortOrder: 5 })
    // sortOrder 5 puts it first of its group
    expect(today().lotteries.filter((l) => l.group === 'hanoi')[0].id).toBe('hanoi-regular')
    // the day files only name lotteries by id: nothing to rebuild there
    expect(dayFile(D).results.map((r) => r.lotteryId)).toEqual(['hanoi-regular', 'lao-vip'])
  })

  it('changes the public files do not show count nothing: the reminder default, the same values again', async () => {
    const before = await h.state()
    h.bucket.clearLog()
    expect((await patch('hanoi-regular', { notifyTime: '09:30', notifyEnabled: true })).status).toBe(200)
    expect((await patch('hanoi-regular', { name: 'ฮานอย ปกติ' })).status).toBe(200) // the name it already has
    expect(await h.state()).toEqual(before)
    expect(h.bucket.log).toEqual([])
  })

  it('a new catalog lottery appears in today.json with a (still empty) file of its own', async () => {
    const res = await h.adm('POST', '/admin/lotteries', { name: 'หวยใหม่', shortName: 'ใหม่', group: 'other', accent: '#445566', sortOrder: 99999, active: true })
    expect(res.status).toBe(200)
    const id = ((await res.json()) as { id: string }).id
    expect(today().lotteries.find((l) => l.id === id)).toMatchObject({ name: 'หวยใหม่', results: [], schedules: [] })
    expect(lotteryFile(id)).toMatchObject({ draws: [], stats: null })
    // an inactive new lottery is not public
    const off = await h.adm('POST', '/admin/lotteries', { name: 'หวยปิด', shortName: 'ปิด', group: 'other', accent: '#445566', sortOrder: 99998, active: false })
    const offId = ((await off.json()) as { id: string }).id
    expect(today().lotteries.some((l) => l.id === offId)).toBe(false)
    expect(h.bucket.has(`v1/lottery/${offId}.json`)).toBe(false)
  })

  it('files of lotteries that are not public are swept by "rebuild everything" even when no mark exists for them', async () => {
    // a stale file that nothing marks (the data was changed by hand while publishing was off)
    await h.bucket.put('v1/lottery/ghost-lottery.json', JSON.stringify({ v: 1 }), { customMetadata: { v: '1' } })
    await h.adm('POST', '/admin/public/publish', { rebuild: true })
    await settle(Date.parse(now))
    expect(h.bucket.has('v1/lottery/ghost-lottery.json')).toBe(false)
  })
})

// ---- Bangkok midnight --------------------------------------------------------------------------------

describe('a rebuild is driven by the written row\'s draw date, never by "now"', () => {
  const full = { top3: '123', top2: '45', bottom2: '67' }

  it('23:59 in Bangkok: a result of yesterday is in today.json, in its day file and in the lottery file', async () => {
    at('2026-11-20T16:59:30Z') // 23:59:30 on the 20th in Bangkok
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', ...full })
    expect(today()).toMatchObject({ today: '2026-11-20', yesterday: '2026-11-19' })
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.results.map((r) => r.date)).toEqual(['2026-11-19'])
    expect(dayFile('2026-11-19').results).toHaveLength(1)
    expect(lotteryFile('hanoi-regular').draws).toHaveLength(1)
  })

  it('00:00 in Bangkok, a minute later: the same result is no longer in today.json, but its day and lottery files have it', async () => {
    at('2026-11-20T17:00:30Z') // 00:00:30 on the 21st in Bangkok
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', ...full })
    expect(today()).toMatchObject({ today: '2026-11-21', yesterday: '2026-11-20' })
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.results).toEqual([])
    expect(dayFile('2026-11-19').results).toHaveLength(1)
    expect(lotteryFile('hanoi-regular').draws).toHaveLength(1)
    // today.json is rewritten anyway (every build writes it), so its version moves with the change
    expect(today().v).toBe(1)
  })

  it('an old date (an import) touches its own day and lottery file; today.json is rewritten but shows nothing of it', async () => {
    at('2026-11-20T03:00:00Z')
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-20', ...full })
    const before = h.bucket.json<PublicDayFile>('v1/day/2026-11-20.json')
    await h.put({ lotteryId: 'hanoi-regular', date: '2025-03-04', ...full })
    expect(dayFile('2025-03-04').results).toHaveLength(1)
    expect(h.bucket.json<PublicDayFile>('v1/day/2026-11-20.json')).toEqual(before) // untouched: not rewritten
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.results.map((r) => r.date)).toEqual(['2026-11-20'])
    expect(lotteryFile('hanoi-regular').draws.map((d) => d.date)).toEqual(['2026-11-20', '2025-03-04'])
  })

  it('a result dated tomorrow (allowed) gets its own day file; today.json shows it from the Bangkok day it belongs to', async () => {
    at('2026-11-20T16:59:30Z') // 23:59:30 on the 20th in Bangkok
    expect((await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-21', ...full })).status).toBe(201)
    expect(dayFile('2026-11-21').results).toHaveLength(1)
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.results).toEqual([]) // not today yet
    // the cron's first run of the new Bangkok day rolls today.json over
    await runScheduledPublish(h.env, Date.parse('2026-11-20T16:59:40Z')) // sets the day it knows
    at('2026-11-20T17:00:10Z')
    const run = await runScheduledPublish(h.env, Date.now())
    expect(run?.status).toBe('published')
    expect(today()).toMatchObject({ today: '2026-11-21', yesterday: '2026-11-20' })
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.results.map((r) => r.date)).toEqual(['2026-11-21'])
  })
})

describe('the daily roll-over of today.json (cron)', () => {
  const full = { top3: '123', top2: '45', bottom2: '67' }

  it('the first run only remembers the day; a new Bangkok day bumps the version once and rebuilds today.json', async () => {
    await h.reset() // no rollover day known yet
    at('2026-11-20T03:00:00Z')
    await h.put({ lotteryId: 'hanoi-regular', date: '2026-11-19', ...full })
    expect(await h.state()).toMatchObject({ version: 1, published: 1, rolloverDay: null })
    // first cron run: remembers the day, nothing else
    expect((await runScheduledPublish(h.env, Date.parse('2026-11-20T03:01:00Z')))?.status).toBe('idle')
    expect(await h.state()).toMatchObject({ version: 1, rolloverDay: '2026-11-20' })
    // same day: idle, no write at all
    h.bucket.clearLog()
    expect((await runScheduledPublish(h.env, Date.parse('2026-11-20T10:00:00Z')))?.status).toBe('idle')
    expect(h.bucket.log).toEqual([])
    // 00:00 Bangkok: rolled over
    at('2026-11-20T17:00:05Z')
    const run = await runScheduledPublish(h.env, Date.parse('2026-11-20T17:00:05Z'))
    expect(run?.status).toBe('published')
    expect(run?.written).toEqual(['v1/today.json', 'v1/version.json'])
    expect(await h.state()).toMatchObject({ version: 2, published: 2, rolloverDay: '2026-11-21' })
    expect(today()).toMatchObject({ v: 2, today: '2026-11-21', yesterday: '2026-11-20' })
    // the 19th has left the window of today.json
    expect(today().lotteries.find((l) => l.id === 'hanoi-regular')!.results).toEqual([])
    expect(h.bucket.json<PublicVersionFile>('v1/version.json').v).toBe(2)
    // and not again the same day
    h.bucket.clearLog()
    expect((await runScheduledPublish(h.env, Date.parse('2026-11-20T18:00:00Z')))?.status).toBe('idle')
    expect(h.bucket.log).toEqual([])
  })

  it('switched off or without the bucket the cron neither bumps nor writes', async () => {
    await h.reset()
    await h.adm('PUT', '/admin/public/enabled', { enabled: false })
    await runScheduledPublish(h.env, Date.parse('2026-11-20T03:00:00Z'))
    const run = await runScheduledPublish(h.env, Date.parse('2026-11-25T03:00:00Z'))
    expect(run?.status).toBe('disabled')
    expect((await h.state()).version).toBe(0)
    expect(h.bucket.log).toEqual([])
  })

  it('scheduled() runs the publish job next to the others and a failing one does not stop them', async () => {
    await h.reset()
    await h.db.insert(siteSettings).values({ key: 'results_version', value: '1', updatedAt: 'x' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    h.bucket.failPutFor = (k) => k === 'v1/version.json'
    await expect(scheduled({ scheduledTime: Date.parse('2026-11-20T03:05:00Z') }, h.env)).rejects.toThrow('R2 put failed')
    expect(err).toHaveBeenCalled()
    // the failure is reported, but the files before version.json were written and version.json is still the old one
    expect(h.bucket.keys().some((k) => k.startsWith('v1/lottery/'))).toBe(true)
    expect(h.bucket.json<PublicVersionFile>('v1/version.json').v).toBe(0)
    h.bucket.failPutFor = undefined
    await expect(scheduled({ scheduledTime: Date.parse('2026-11-20T03:06:00Z') }, h.env)).resolves.toBeUndefined()
    expect(h.bucket.json<PublicVersionFile>('v1/version.json').v).toBe(1)
  })
})
