// The pure part of the public results snapshots (src/lib/publicSnapshot.ts): draw state (final /
// partial), expected fields and weekdays, the statistics on fixtures that were worked out by hand (and
// cross-checked against a naive implementation on random data), the under-30 rule, and the builders of
// the three file kinds (the Bangkok window of today.json around midnight, the whitelist). No database.
import { describe, expect, it } from 'vitest'
import {
  HISTORY_SHOWN,
  assertWhitelisted,
  buildDayFile,
  buildLotteryFile,
  buildStats,
  buildTodayFile,
  buildVersionFile,
  cacheControlFor,
  dayPath,
  expectedFieldsFor,
  fieldStats,
  formatDays,
  formatExpectedFields,
  lotteryPath,
  parseDays,
  parseExpectedFields,
  resultState,
  statsWindow,
  type DrawRow,
  type PublicLotteryInfo,
  type PublicSchedule,
  type StatsDraw,
} from '../src/lib/publicSnapshot'
import { addDays } from '../src/lib/time'

// ---- fixtures worked out by hand -----------------------------------------------------------------
//
// Draw i (0 = newest) is dated 2026-11-20 minus i days, so draw 29 is 2026-10-22, draw 59 is
// 2026-09-22 and draw 89 is 2026-08-23.
//   top2    = `${i % 10}${(i * 3) % 10}`: period 10: 00 13 26 39 42 55 68 71 84 97, then again
//   bottom2 = ['07','18','29','30','41'][i % 5]: period 5
// Both periods divide 30, 60 and 90, so every count of a window is the count of one period times
// (window / period), and a number's first position is its position in the first period.

const day = (i: number) => addDays('2026-11-20', -i)
const TOP_PERIOD = ['00', '13', '26', '39', '42', '55', '68', '71', '84', '97']
const BOTTOM_PERIOD = ['07', '18', '29', '30', '41']

function fixture(n: number): StatsDraw[] {
  return Array.from({ length: n }, (_, i) => ({ date: day(i), top2: TOP_PERIOD[i % 10], bottom2: BOTTOM_PERIOD[i % 5] }))
}

describe('expected fields and weekdays', () => {
  it('parses the stored text into canonical order, without duplicates or unknown names', () => {
    expect(parseExpectedFields('top3,top2,bottom2')).toEqual(['top3', 'top2', 'bottom2'])
    expect(parseExpectedFields('bottom2,top3')).toEqual(['top3', 'bottom2'])
    expect(parseExpectedFields('top2,top2, top2 ,nope')).toEqual(['top2'])
  })

  it('falls back to the default three fields when nothing usable is stored', () => {
    for (const bad of ['', ',', 'nope', 'TOP3', null, undefined]) {
      expect(parseExpectedFields(bad), String(bad)).toEqual(['top3', 'top2', 'bottom2'])
    }
  })

  it('formats in canonical order whatever order it was given', () => {
    expect(formatExpectedFields(['bottom2', 'top3'])).toBe('top3,bottom2')
    expect(formatExpectedFields(['top2'])).toBe('top2')
    expect(formatExpectedFields(['bottom2', 'top2', 'top3'])).toBe('top3,top2,bottom2')
  })

  it('days: sorted unique ISO weekdays, every day when nothing usable', () => {
    expect(parseDays('1234567')).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(parseDays('7351')).toEqual([1, 3, 5, 7])
    expect(parseDays('1122')).toEqual([1, 2])
    expect(parseDays('089x')).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(parseDays('')).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(parseDays(null)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(formatDays([5, 1, 3, 1])).toBe('135')
  })
})

describe('resultState', () => {
  const all = { top3: '123', top2: '45', bottom2: '67' }

  it('is final when every expected field is present (the default is all three)', () => {
    expect(resultState(all)).toBe('final')
    expect(resultState({ ...all, top3: null })).toBe('partial')
    expect(resultState({ ...all, top2: null })).toBe('partial')
    expect(resultState({ ...all, bottom2: null })).toBe('partial')
    expect(resultState({ top3: null, top2: null, bottom2: null })).toBe('partial')
  })

  it('looks only at the fields the schedule expects', () => {
    expect(resultState({ top3: null, top2: '45', bottom2: '67' }, ['top2', 'bottom2'])).toBe('final')
    expect(resultState({ top3: '123', top2: '45', bottom2: null }, ['top3', 'top2'])).toBe('final')
    expect(resultState({ top3: '123', top2: null, bottom2: null }, ['top3', 'top2'])).toBe('partial')
    expect(resultState({ top3: null, top2: null, bottom2: null }, ['top3'])).toBe('partial')
    expect(resultState({ top3: '000', top2: null, bottom2: null }, ['top3'])).toBe('final')
  })

  it('an empty string is not a number', () => {
    expect(resultState({ top3: '', top2: '45', bottom2: '67' })).toBe('partial')
  })

  it('expectedFieldsFor takes the schedule row of the same draw time, else the default', () => {
    const rows = [
      { drawTime: '', expectedFields: ['top2'] as const },
      { drawTime: '16:30', expectedFields: ['top3', 'bottom2'] as const },
    ]
    expect(expectedFieldsFor(rows, '')).toEqual(['top2'])
    expect(expectedFieldsFor(rows, '16:30')).toEqual(['top3', 'bottom2'])
    expect(expectedFieldsFor(rows, '09:00')).toEqual(['top3', 'top2', 'bottom2'])
    expect(expectedFieldsFor([], '')).toEqual(['top3', 'top2', 'bottom2'])
  })
})

describe('statistics, hand-checked on a periodic fixture', () => {
  const w30 = statsWindow(fixture(30), 30)

  it('names the window by its draws and its first and last date', () => {
    expect(w30).toMatchObject({ draws: 30, from: '2026-10-22', to: '2026-11-20' })
    expect(Object.keys(w30).sort()).toEqual(['bottom2', 'draws', 'from', 'to', 'top2'])
  })

  it('top2: draws in which each digit appears ("เลขวิ่งออกบ่อย"); 55 and 00 count their digit once per draw', () => {
    // numbers containing each digit in one period: 0:{00} 1:{13,71} 2:{26,42} 3:{13,39} 4:{42,84}
    // 5:{55} 6:{26,68} 7:{71,97} 8:{68,84} 9:{39,97}; three periods in 30 draws
    expect(w30.top2.of).toBe(30)
    expect(w30.top2.digitCounts).toEqual([3, 6, 6, 6, 6, 3, 6, 6, 6, 6])
  })

  it('top2: the most frequent numbers; equal counts go to the one seen more recently', () => {
    // every number is drawn 3 times; first positions 0..9 in period order
    expect(w30.top2.topNumbers).toEqual(TOP_PERIOD.map((n) => ({ n, count: 3 })))
  })

  it('top2: how long each digit has been absent, longest first, ties by digit', () => {
    // first position of a digit: 0:0 1:1 2:2 3:1 4:4 5:5 6:2 7:7 8:6 9:3
    expect(w30.top2.digitGaps).toEqual([
      { digit: 7, gap: 7, last: '2026-11-13' },
      { digit: 8, gap: 6, last: '2026-11-14' },
      { digit: 5, gap: 5, last: '2026-11-15' },
      { digit: 4, gap: 4, last: '2026-11-16' },
      { digit: 9, gap: 3, last: '2026-11-17' },
      { digit: 2, gap: 2, last: '2026-11-18' },
      { digit: 6, gap: 2, last: '2026-11-18' },
      { digit: 1, gap: 1, last: '2026-11-19' },
      { digit: 3, gap: 1, last: '2026-11-19' },
      { digit: 0, gap: 0, last: '2026-11-20' },
    ])
  })

  it('top2: how long each number has been absent (numbers seen in the window), longest first', () => {
    expect(w30.top2.numberGaps).toEqual([
      { n: '97', gap: 9, last: '2026-11-11' },
      { n: '84', gap: 8, last: '2026-11-12' },
      { n: '71', gap: 7, last: '2026-11-13' },
      { n: '68', gap: 6, last: '2026-11-14' },
      { n: '55', gap: 5, last: '2026-11-15' },
      { n: '42', gap: 4, last: '2026-11-16' },
      { n: '39', gap: 3, last: '2026-11-17' },
      { n: '26', gap: 2, last: '2026-11-18' },
      { n: '13', gap: 1, last: '2026-11-19' },
      { n: '00', gap: 0, last: '2026-11-20' },
    ])
  })

  it('top2: even / odd, low (00-49) / high (50-99) and doubles (เลขเบิ้ล)', () => {
    // per period: even 00 26 42 68 84 (5), odd 13 39 55 71 97 (5); low 00 13 26 39 42 (5), high 55 68 71 84 97 (5);
    // doubles 00 and 55 (2)
    expect(w30.top2).toMatchObject({ even: 15, odd: 15, low: 15, high: 15, doubles: 6 })
  })

  it('bottom2: counts, top numbers and a digit that never appears (gap = the draws of the window, no date)', () => {
    expect(w30.bottom2.of).toBe(30)
    expect(w30.bottom2.digitCounts).toEqual([12, 12, 6, 6, 6, 0, 0, 6, 6, 6])
    expect(w30.bottom2.topNumbers).toEqual(BOTTOM_PERIOD.map((n) => ({ n, count: 6 })))
    expect(w30.bottom2.digitGaps).toEqual([
      { digit: 5, gap: 30, last: null },
      { digit: 6, gap: 30, last: null },
      { digit: 4, gap: 4, last: '2026-11-16' },
      { digit: 3, gap: 3, last: '2026-11-17' },
      { digit: 2, gap: 2, last: '2026-11-18' },
      { digit: 9, gap: 2, last: '2026-11-18' },
      { digit: 1, gap: 1, last: '2026-11-19' },
      { digit: 8, gap: 1, last: '2026-11-19' },
      { digit: 0, gap: 0, last: '2026-11-20' },
      { digit: 7, gap: 0, last: '2026-11-20' },
    ])
    expect(w30.bottom2.numberGaps).toEqual([
      { n: '41', gap: 4, last: '2026-11-16' },
      { n: '30', gap: 3, last: '2026-11-17' },
      { n: '29', gap: 2, last: '2026-11-18' },
      { n: '18', gap: 1, last: '2026-11-19' },
      { n: '07', gap: 0, last: '2026-11-20' },
    ])
    // per period: even 18 30 (2), odd 07 29 41 (3); all five are below 50; no doubles
    expect(w30.bottom2).toMatchObject({ even: 12, odd: 18, low: 30, high: 0, doubles: 0 })
  })

  it('the 60 and 90 windows are the same periods repeated: every count doubles / triples, the gaps stay', () => {
    const d = fixture(90)
    const w60 = statsWindow(d, 60)
    const w90 = statsWindow(d, 90)
    expect(w60).toMatchObject({ draws: 60, from: '2026-09-22', to: '2026-11-20' })
    expect(w90).toMatchObject({ draws: 90, from: '2026-08-23', to: '2026-11-20' })
    expect(w60.top2.digitCounts).toEqual([6, 12, 12, 12, 12, 6, 12, 12, 12, 12])
    expect(w90.top2.digitCounts).toEqual([9, 18, 18, 18, 18, 9, 18, 18, 18, 18])
    expect(w60.top2.topNumbers).toEqual(TOP_PERIOD.map((n) => ({ n, count: 6 })))
    expect(w90.top2.topNumbers).toEqual(TOP_PERIOD.map((n) => ({ n, count: 9 })))
    expect(w60.top2).toMatchObject({ even: 30, odd: 30, low: 30, high: 30, doubles: 12 })
    expect(w90.top2).toMatchObject({ even: 45, odd: 45, low: 45, high: 45, doubles: 18 })
    expect(w60.top2.digitGaps).toEqual(w30.top2.digitGaps)
    expect(w90.bottom2.digitCounts).toEqual([36, 36, 18, 18, 18, 0, 0, 18, 18, 18])
    // a digit never seen has a gap of the whole window
    expect(w60.bottom2.digitGaps.slice(0, 2)).toEqual([
      { digit: 5, gap: 60, last: null },
      { digit: 6, gap: 60, last: null },
    ])
    expect(w90.bottom2.digitGaps.slice(0, 2)).toEqual([
      { digit: 5, gap: 90, last: null },
      { digit: 6, gap: 90, last: null },
    ])
  })

  it('statistics only read the window: older draws do not count', () => {
    // 30 periodic draws followed by older ones that would change every count
    const older: StatsDraw[] = Array.from({ length: 20 }, (_, i) => ({ date: day(30 + i), top2: '11', bottom2: '22' }))
    expect(statsWindow([...fixture(30), ...older], 30)).toEqual(w30)
  })
})

describe('statistics: ties, fields that are missing, odd data', () => {
  const entries = (values: string[]) => values.map((value, i) => ({ date: day(i), value }))

  it('equal counts: the number seen more recently comes first, even when it is the larger one', () => {
    // 90 at positions 0 and 3, 12 at 1 and 2: both twice, 90 first seen first
    expect(fieldStats(entries(['90', '12', '12', '90'])).topNumbers).toEqual([
      { n: '90', count: 2 },
      { n: '12', count: 2 },
    ])
    expect(fieldStats(entries(['12', '34', '12', '34', '56'])).topNumbers).toEqual([
      { n: '12', count: 2 },
      { n: '34', count: 2 },
      { n: '56', count: 1 },
    ])
  })

  it('the most frequent list has at most 10 numbers and the longest-absent list at most 10', () => {
    const many = entries(Array.from({ length: 40 }, (_, i) => String(i).padStart(2, '0')))
    const s = fieldStats(many)
    expect(s.topNumbers).toHaveLength(10)
    expect(s.numberGaps).toHaveLength(10)
    expect(s.numberGaps[0]).toEqual({ n: '39', gap: 39, last: day(39) })
    expect(s.digitGaps).toHaveLength(10)
  })

  it('draws without the field do not count (of < draws) and an empty field is all zeros', () => {
    const none = fieldStats([])
    expect(none).toEqual({
      of: 0,
      digitCounts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      topNumbers: [],
      digitGaps: Array.from({ length: 10 }, (_, digit) => ({ digit, gap: 0, last: null })),
      numberGaps: [],
      even: 0,
      odd: 0,
      low: 0,
      high: 0,
      doubles: 0,
    })
    const draws: StatsDraw[] = Array.from({ length: 30 }, (_, i) => ({ date: day(i), top2: '12', bottom2: i % 2 === 0 ? '34' : null }))
    const w = statsWindow(draws, 30)
    expect(w.top2.of).toBe(30)
    expect(w.bottom2.of).toBe(15)
    expect(w.bottom2.topNumbers).toEqual([{ n: '34', count: 15 }])
    // positions are counted among the draws that have the field, so 34 is "0 draws ago"
    expect(w.bottom2.numberGaps).toEqual([{ n: '34', gap: 0, last: day(0) }])
  })

  it('values that are not two digits are ignored (only a hand-edited database has them)', () => {
    const s = fieldStats(entries(['12', '1', 'abc', '123', '', '12']))
    expect(s.of).toBe(2)
    expect(s.topNumbers).toEqual([{ n: '12', count: 2 }])
  })

  it('matches a naive implementation on random data', () => {
    // a small deterministic generator, so a failure can be reproduced
    let seed = 12345
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let round = 0; round < 25; round++) {
      const n = 30 + rnd(70)
      const values = Array.from({ length: n }, () => `${rnd(10)}${rnd(10)}`)
      const fast = fieldStats(entries(values))

      // naive: loop over digits and numbers and look at every draw
      const digitCounts = Array.from({ length: 10 }, (_, d) => values.filter((v) => v.includes(String(d))).length)
      expect(fast.digitCounts, `round ${round}`).toEqual(digitCounts)
      for (let d = 0; d < 10; d++) {
        const first = values.findIndex((v) => v.includes(String(d)))
        const g = fast.digitGaps.find((x) => x.digit === d)!
        expect(g.gap).toBe(first === -1 ? n : first)
        expect(g.last).toBe(first === -1 ? null : day(first))
      }
      const counts = new Map<string, number>()
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
      for (const t of fast.topNumbers) expect(counts.get(t.n)).toBe(t.count)
      // the top list really is the top: nothing outside it beats its last entry
      const lastCount = fast.topNumbers[fast.topNumbers.length - 1].count
      for (const [num, c] of counts) {
        if (!fast.topNumbers.some((t) => t.n === num)) expect(c).toBeLessThanOrEqual(lastCount)
      }
      expect(fast.even).toBe(values.filter((v) => Number(v) % 2 === 0).length)
      expect(fast.odd).toBe(values.filter((v) => Number(v) % 2 === 1).length)
      expect(fast.low).toBe(values.filter((v) => Number(v) < 50).length)
      expect(fast.high).toBe(values.filter((v) => Number(v) >= 50).length)
      expect(fast.doubles).toBe(values.filter((v) => v[0] === v[1]).length)
      expect(fast.even + fast.odd).toBe(n)
      expect(fast.low + fast.high).toBe(n)
    }
  })
})

describe('statistics need at least 30 final draws', () => {
  it('under 30 draws there are no statistics at all (null: the page shows the history alone)', () => {
    expect(buildStats([])).toBeNull()
    expect(buildStats(fixture(1))).toBeNull()
    expect(buildStats(fixture(29))).toBeNull()
  })

  it('from 30 draws: the 30 window; the 60 and 90 windows only when there are that many draws', () => {
    const windows = (n: number) => buildStats(fixture(n))?.map((w) => w.draws)
    expect(windows(30)).toEqual([30])
    expect(windows(59)).toEqual([30])
    expect(windows(60)).toEqual([30, 60])
    expect(windows(89)).toEqual([30, 60])
    expect(windows(90)).toEqual([30, 60, 90])
    expect(windows(400)).toEqual([30, 60, 90])
  })

  it('the 30 window of a longer history is the 30 newest draws', () => {
    expect(buildStats(fixture(120))![0]).toEqual(statsWindow(fixture(30), 30))
  })
})

// ---- the builders -----------------------------------------------------------------------------------

const info = (id: string, group: PublicLotteryInfo['group'], sortOrder: number, name = id): PublicLotteryInfo => ({
  id,
  name,
  shortName: name,
  group,
  accent: '#123456',
  sortOrder,
})

const row = (lotteryId: string, date: string, time: string, top3: string | null, top2: string | null, bottom2: string | null, updatedAt = `${date}T10:00:00.000Z`): DrawRow => ({
  lotteryId,
  date,
  time,
  top3,
  top2,
  bottom2,
  updatedAt,
})

const NO_SCHEDULES = new Map<string, PublicSchedule[]>()

describe('buildTodayFile', () => {
  const lotteries = [info('lao-a', 'lao', 20), info('hanoi-a', 'hanoi', 10), info('hanoi-b', 'hanoi', 5)]
  // loadPublicLotteries returns them ordered; the builder keeps the order it is given
  const ordered = [lotteries[2], lotteries[1], lotteries[0]]

  it('lists the lotteries as given, with only the groups that have one (in display order) and their Thai names', () => {
    const f = buildTodayFile({ v: 7, nowMs: Date.parse('2026-11-20T10:00:00Z'), lotteries: ordered, schedules: NO_SCHEDULES, results: [] })
    expect(f.v).toBe(7)
    expect(f.lotteries.map((l) => l.id)).toEqual(['hanoi-b', 'hanoi-a', 'lao-a'])
    expect(f.groups).toEqual([
      { key: 'hanoi', label: 'ฮานอย' },
      { key: 'lao', label: 'ลาว' },
    ])
    expect(f.lotteries.every((l) => l.results.length === 0 && l.schedules.length === 0)).toBe(true)
  })

  it('carries the Bangkok today and yesterday of the build and only their results, newest first', () => {
    const results = [
      row('hanoi-a', '2026-11-18', '', '111', '11', '11'), // before yesterday: not in the file
      row('hanoi-a', '2026-11-19', '', '222', '22', '22'),
      row('hanoi-a', '2026-11-20', '09:00', '333', '33', '33'),
      row('hanoi-a', '2026-11-20', '16:30', '444', '44', '44'),
      row('hanoi-a', '2026-11-21', '', '555', '55', '55'), // tomorrow: not in the file either
      row('unknown', '2026-11-20', '', '666', '66', '66'), // not a listed lottery: dropped
    ]
    const f = buildTodayFile({ v: 1, nowMs: Date.parse('2026-11-20T10:00:00Z'), lotteries: ordered, schedules: NO_SCHEDULES, results })
    expect(f.today).toBe('2026-11-20')
    expect(f.yesterday).toBe('2026-11-19')
    const a = f.lotteries.find((l) => l.id === 'hanoi-a')!
    expect(a.results.map((r) => `${r.date} ${r.time}`)).toEqual(['2026-11-20 16:30', '2026-11-20 09:00', '2026-11-19 '])
    expect(JSON.stringify(f)).not.toContain('666')
  })

  it('the window follows Bangkok midnight (UTC+7), not the UTC day', () => {
    const results = [row('hanoi-a', '2026-11-19', '', '222', '22', '22'), row('hanoi-a', '2026-11-20', '', '333', '33', '33')]
    const at = (iso: string) => buildTodayFile({ v: 1, nowMs: Date.parse(iso), lotteries: ordered, schedules: NO_SCHEDULES, results })
    // 23:59:59 Bangkok on the 20th
    const before = at('2026-11-20T16:59:59Z')
    expect([before.today, before.yesterday]).toEqual(['2026-11-20', '2026-11-19'])
    expect(before.lotteries[1].results.map((r) => r.date)).toEqual(['2026-11-20', '2026-11-19'])
    // 00:00:00 Bangkok on the 21st: the 19th has left the window
    const after = at('2026-11-20T17:00:00Z')
    expect([after.today, after.yesterday]).toEqual(['2026-11-21', '2026-11-20'])
    expect(after.lotteries[1].results.map((r) => r.date)).toEqual(['2026-11-20'])
  })

  it('every result has its state from the lottery\'s schedule of the same draw time', () => {
    const schedules = new Map<string, PublicSchedule[]>([
      ['hanoi-a', [{ drawTime: '', resultTime: '18:30', days: [1, 2, 3, 4, 5, 6, 7], expectedFields: ['top2', 'bottom2'], closedDate: null }]],
    ])
    const results = [
      row('hanoi-a', '2026-11-20', '', null, '12', '34'), // final for ['top2','bottom2']
      row('hanoi-a', '2026-11-20', '16:30', null, '12', '34'), // another time: default expected fields, partial
      row('hanoi-b', '2026-11-20', '', null, '12', '34'), // no schedule: default, partial
    ]
    const f = buildTodayFile({ v: 1, nowMs: Date.parse('2026-11-20T10:00:00Z'), lotteries: ordered, schedules, results })
    const states = (id: string) => f.lotteries.find((l) => l.id === id)!.results.map((r) => `${r.time || '-'}:${r.state}`)
    expect(states('hanoi-a')).toEqual(['16:30:partial', '-:final'])
    expect(states('hanoi-b')).toEqual(['-:partial'])
    expect(f.lotteries.find((l) => l.id === 'hanoi-a')!.schedules).toHaveLength(1)
  })

  it('copies only the whitelisted fields of a row', () => {
    const dirty = { ...row('hanoi-a', '2026-11-20', '', '123', '45', '67'), source: 'robot', id: 'row-id', memberId: 'm1' } as DrawRow
    const f = buildTodayFile({ v: 1, nowMs: Date.parse('2026-11-20T10:00:00Z'), lotteries: ordered, schedules: NO_SCHEDULES, results: [dirty] })
    expect(f.lotteries[1].results[0]).toEqual({ date: '2026-11-20', time: '', top3: '123', top2: '45', bottom2: '67', state: 'final', updatedAt: '2026-11-20T10:00:00.000Z' })
    expect(JSON.stringify(f)).not.toMatch(/robot|row-id|m1/)
    expect(() => assertWhitelisted(f)).not.toThrow()
  })
})

describe('buildDayFile', () => {
  const publicIds = new Set(['hanoi-a', 'lao-a'])

  it('holds the results of that date of the public lotteries, ordered by lottery then time, nothing else', () => {
    const results = [
      row('lao-a', '2026-11-19', '', '1', '1', '1'),
      row('lao-a', '2026-11-19', '', '333', '33', '33'),
      row('hanoi-a', '2026-11-19', '16:30', '222', '22', '22'),
      row('hanoi-a', '2026-11-19', '', '111', '11', '11'),
      row('hanoi-a', '2026-11-18', '', '999', '99', '99'), // another date
      row('hidden', '2026-11-19', '', '888', '88', '88'), // not a public lottery
    ]
    const f = buildDayFile({ v: 3, nowMs: Date.parse('2026-11-20T10:00:00Z'), date: '2026-11-19', publicIds, schedules: NO_SCHEDULES, results })
    expect(f).toMatchObject({ v: 3, date: '2026-11-19' })
    expect(f.results.map((r) => `${r.lotteryId} ${r.time || '-'} ${r.top3}`)).toEqual(['hanoi-a - 111', 'hanoi-a 16:30 222', 'lao-a - 1', 'lao-a - 333'])
    expect(JSON.stringify(f)).not.toMatch(/999|888/)
    expect(Object.keys(f.results[0]).sort()).toEqual(['bottom2', 'date', 'lotteryId', 'state', 'time', 'top2', 'top3', 'updatedAt'])
  })

  it('is valid and empty when the date has no results', () => {
    const f = buildDayFile({ v: 1, nowMs: 0, date: '2020-01-01', publicIds, schedules: NO_SCHEDULES, results: [] })
    expect(f.results).toEqual([])
  })
})

describe('buildLotteryFile', () => {
  const lottery = info('hanoi-a', 'hanoi', 10, 'ฮานอย A')
  const schedules: PublicSchedule[] = [{ drawTime: '', resultTime: '18:30', days: [1, 2, 3], expectedFields: ['top3', 'top2', 'bottom2'], closedDate: '2026-11-21' }]
  const rowsOf = (n: number, mutate: (i: number) => Partial<DrawRow> = () => ({})): DrawRow[] =>
    Array.from({ length: n }, (_, i) => ({ ...row('hanoi-a', day(i), '', TOP_PERIOD[i % 10] + '0', TOP_PERIOD[i % 10], BOTTOM_PERIOD[i % 5]), ...mutate(i) }))

  it('has the lottery info, its schedule, the draws and the statistics', () => {
    const f = buildLotteryFile({ v: 9, nowMs: Date.parse('2026-11-20T10:00:00Z'), lottery, schedules, rows: rowsOf(30) })
    expect(Object.keys(f).sort()).toEqual(['builtAt', 'draws', 'lottery', 'schedules', 'stats', 'v'])
    expect(f.lottery).toEqual({ id: 'hanoi-a', name: 'ฮานอย A', shortName: 'ฮานอย A', group: 'hanoi', accent: '#123456', sortOrder: 10 })
    expect(f.schedules).toEqual(schedules)
    expect(f.draws).toHaveLength(30)
    expect(f.draws[0]).toEqual({ date: '2026-11-20', time: '', top3: '000', top2: '00', bottom2: '07', state: 'final' })
    expect(f.stats?.map((w) => w.draws)).toEqual([30])
    expect(f.stats![0]).toEqual(statsWindow(fixture(30), 30))
  })

  it('shows at most 90 draws but builds the 90 window from final draws only', () => {
    const f = buildLotteryFile({ v: 1, nowMs: 0, lottery, schedules: [], rows: rowsOf(120) })
    expect(f.draws).toHaveLength(HISTORY_SHOWN)
    expect(f.draws[89].date).toBe(day(89))
    expect(f.stats?.map((w) => w.draws)).toEqual([30, 60, 90])
  })

  it('under 30 final draws the statistics are null but the history is still there', () => {
    const f = buildLotteryFile({ v: 1, nowMs: 0, lottery, schedules: [], rows: rowsOf(29) })
    expect(f.stats).toBeNull()
    expect(f.draws).toHaveLength(29)
  })

  it('a partial draw is listed (state partial) but is no draw of the statistics', () => {
    // 31 draws, the newest has no bottom2: partial under the default expected fields
    const f = buildLotteryFile({ v: 1, nowMs: 0, lottery, schedules: [], rows: rowsOf(31, (i) => (i === 0 ? { bottom2: null } : {})) })
    expect(f.draws[0]).toMatchObject({ date: '2026-11-20', state: 'partial', bottom2: null })
    expect(f.draws[1].state).toBe('final')
    // 30 final draws remain: draws 1..30
    expect(f.stats?.map((w) => w.draws)).toEqual([30])
    expect(f.stats![0].to).toBe(day(1))
    expect(f.stats![0].from).toBe(day(30))
    // with only 30 draws, one of them partial, there are 29 final ones: no statistics
    const g = buildLotteryFile({ v: 1, nowMs: 0, lottery, schedules: [], rows: rowsOf(30, (i) => (i === 0 ? { bottom2: null } : {})) })
    expect(g.stats).toBeNull()
  })

  it('the expected fields of the schedule decide: top2 + bottom2 only makes a draw without top3 final', () => {
    const two: PublicSchedule[] = [{ drawTime: '', resultTime: '18:30', days: [1], expectedFields: ['top2', 'bottom2'], closedDate: null }]
    const f = buildLotteryFile({ v: 1, nowMs: 0, lottery, schedules: two, rows: rowsOf(30, () => ({ top3: null })) })
    expect(f.draws.every((d) => d.state === 'final' && d.top3 === null)).toBe(true)
    expect(f.stats).not.toBeNull()
    const none = buildLotteryFile({ v: 1, nowMs: 0, lottery, schedules: [], rows: rowsOf(30, () => ({ top3: null })) })
    expect(none.draws.every((d) => d.state === 'partial')).toBe(true)
    expect(none.stats).toBeNull()
  })

  it('sorts the rows it is given newest first (date, then time)', () => {
    const rows = [row('hanoi-a', '2026-11-19', '09:00', '111', '11', '11'), row('hanoi-a', '2026-11-19', '16:30', '222', '22', '22'), row('hanoi-a', '2026-11-20', '', '333', '33', '33')]
    const f = buildLotteryFile({ v: 1, nowMs: 0, lottery, schedules: [], rows })
    expect(f.draws.map((d) => `${d.date} ${d.time}`)).toEqual(['2026-11-20 ', '2026-11-19 16:30', '2026-11-19 09:00'])
  })
})

describe('the whitelist and the paths', () => {
  it('accepts the keys of the files and refuses any other key at any depth', () => {
    expect(() => assertWhitelisted(buildVersionFile(3, 0))).not.toThrow()
    expect(() => assertWhitelisted({ v: 1, lotteries: [{ id: 'x', results: [{ date: 'd', top3: null }] }] })).not.toThrow()
    for (const bad of ['source', 'memberId', 'member_id', 'active', 'publicEnabled', 'ownerMemberId', 'createdAt', 'notifyTime', 'linkToken', 'password']) {
      expect(() => assertWhitelisted({ v: 1, lotteries: [{ id: 'x', results: [{ [bad]: 'leak' }] }] }), bad).toThrow(bad)
      expect(() => assertWhitelisted({ [bad]: 1 }), bad).toThrow(bad)
    }
  })

  it('builds the paths of the files', () => {
    expect(dayPath('2026-11-20')).toBe('v1/day/2026-11-20.json')
    expect(lotteryPath('hanoi-regular')).toBe('v1/lottery/hanoi-regular.json')
  })

  it('version.json is {v, serverTime}', () => {
    expect(buildVersionFile(12, Date.parse('2026-11-20T10:00:00Z'))).toEqual({ v: 12, serverTime: '2026-11-20T10:00:00.000Z' })
  })

  it('version.json and today.json are cached briefly (the client chases a version within seconds)', () => {
    expect(cacheControlFor('v1/version.json')).toBe('public, max-age=5')
    expect(cacheControlFor('v1/today.json')).toBe('public, max-age=10')
    expect(cacheControlFor(dayPath('2026-11-20'))).toBe('public, max-age=60')
    expect(cacheControlFor(lotteryPath('x'))).toBe('public, max-age=60')
  })
})
