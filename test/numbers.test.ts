import { describe, expect, it } from 'vitest'
import {
  generateCardNumbers,
  generateForSettings,
  genDrill,
  genThree,
  genTwo,
  genWin,
  parseFixedDigit,
  pickRunning,
} from '../src/lib/numbers'

const RUNS = 200

function containsRunning(n: string, running: [string, string]) {
  return n.includes(running[0]) || n.includes(running[1])
}

/** Running digits to run the generator with: random, both fixed, edge digits (0 = leading zeros), one slot fixed. */
const FIXED_CASES: [number | undefined, number | undefined][] = [
  [undefined, undefined],
  [8, 1],
  [0, 9],
  [9, 0],
  [4, undefined],
  [undefined, 7],
]

/**
 * Asserts `counts` (how often each number was drawn) is uniform over exactly `pool`: nothing
 * outside the pool was drawn, and a chi-square test against the equal expectation stays within 9
 * standard deviations (chance of a false alarm below 1e-9) while a missing or heavily favoured
 * number fails it.
 */
function expectUniform(counts: Map<string, number>, pool: string[]) {
  const outside = [...counts.keys()].filter((k) => !pool.includes(k))
  expect(outside, 'drawn outside the allowed pool').toEqual([])
  let total = 0
  for (const k of pool) total += counts.get(k) ?? 0
  const expected = total / pool.length
  let chi = 0
  for (const k of pool) chi += ((counts.get(k) ?? 0) - expected) ** 2 / expected
  const df = pool.length - 1
  expect(chi, `chi-square over ${pool.length} numbers`).toBeLessThan(df + 9 * Math.sqrt(2 * df))
}

describe('pickRunning', () => {
  it('returns two distinct digits', () => {
    for (let i = 0; i < RUNS; i++) {
      const [a, b] = pickRunning()
      expect(a).not.toBe(b)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThanOrEqual(9)
    }
  })
  it('honours fixed digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(pickRunning([3, 7])).toEqual([3, 7])
      expect(pickRunning([4, undefined])[0]).toBe(4)
      expect(pickRunning([undefined, 9])[1]).toBe(9)
    }
  })
})

describe('generateCardNumbers (property style)', () => {
  it('2/3-digit numbers are unique, switches respected, rows exactly row x perRow, top/drill/win as documented', () => {
    for (let i = 0; i < RUNS; i++) {
      const twoRow = 1 + (i % 6)
      const twoPer = 1 + ((i * 7) % 6)
      const threeRow = 1 + ((i * 3) % 6)
      const threePer = 1 + ((i * 5) % 6)
      const n = generateCardNumbers({
        top: { row: 1 + (i % 2), perRow: 1 + ((i >> 1) % 2) },
        two: { row: twoRow, perRow: twoPer, isDouble: i % 3 === 0 },
        three: { row: threeRow, perRow: threePer, allowTriple: i % 4 === 0 },
        drill: { row: 1 + (i % 9) },
        win: { row: 1 + (i % 3), digitCount: 2 + (i % 6) },
      })
      const running = n.running
      expect(running[0]).toMatch(/^\d$/)
      expect(running[1]).toMatch(/^\d$/)
      expect(running[0]).not.toBe(running[1])

      const two = n.two.flat()
      const three = n.three.flat()
      // One inner array per row, each holding exactly perRow numbers (the pools are far bigger
      // than the 36 numbers a block can ask for, so there is no cap any more).
      expect(n.two.map((row) => row.length)).toEqual(Array(twoRow).fill(twoPer))
      expect(n.three.map((row) => row.length)).toEqual(Array(threeRow).fill(threePer))
      expect(two.length).toBe(twoRow * twoPer)
      expect(three.length).toBe(threeRow * threePer)

      for (const t of two) {
        expect(t).toMatch(/^\d{2}$/)
        if (i % 3 !== 0) expect(t[0]).not.toBe(t[1])
      }
      for (const t of three) {
        expect(t).toMatch(/^\d{3}$/)
        if (i % 4 !== 0) expect(t[0] === t[1] && t[1] === t[2]).toBe(false)
      }
      expect(new Set(two).size).toBe(two.length)
      expect(new Set(three).size).toBe(three.length)

      // top cycles the running digits
      n.top.forEach((d, idx) => expect(d).toBe(running[idx % 2]))

      // drill: shared prefix (running1 by default), unique
      expect(n.drill.length).toBe(Math.min(1 + (i % 9), 9))
      for (const d of n.drill) {
        expect(d).toMatch(/^\d{2}$/)
        expect(d[0]).toBe(running[0])
        expect(d[1]).not.toBe(d[0])
      }
      expect(new Set(n.drill).size).toBe(n.drill.length)

      // win: digitCount distinct digits including both running digits
      const digitCount = 2 + (i % 6)
      expect(n.win.length).toBe(1 + (i % 3))
      for (const w of n.win) {
        expect(w.length).toBe(digitCount)
        expect(new Set(w.split('')).size).toBe(digitCount)
        expect(w.includes(running[0])).toBe(true)
        expect(w.includes(running[1])).toBe(true)
      }
      expect(new Set(n.win).size).toBe(n.win.length)
    }
  })

  it('drill prefix can come from running2 / top / two', () => {
    for (let i = 0; i < RUNS; i++) {
      const r2 = generateCardNumbers({ drill: { row: 3, prefixFrom: 'running2' } })
      r2.drill.forEach((d) => expect(d[0]).toBe(r2.running[1]))
      const top = generateCardNumbers({ top: { row: 1, perRow: 2 }, drill: { row: 3, prefixFrom: 'top' } })
      top.drill.forEach((d) => expect(d[0]).toBe(top.top[0]))
      const two = generateCardNumbers({ two: { row: 1, perRow: 3 }, drill: { row: 3, prefixFrom: 'two' } })
      two.drill.forEach((d) => expect(d[0]).toBe(two.two[0][0][0]))
    }
  })

  it('win include "top" uses the top digits', () => {
    for (let i = 0; i < RUNS; i++) {
      const n = generateCardNumbers({
        top: { row: 1, perRow: 1 },
        win: { row: 2, digitCount: 5, include: 'top' },
      })
      for (const w of n.win) {
        expect(w.length).toBe(5)
        expect(new Set(w).size).toBe(5)
        expect(w.includes(n.top[0])).toBe(true)
      }
    }
  })
})

const TWO_DIGIT = Array.from({ length: 100 }, (_, n) => String(n).padStart(2, '0'))
const THREE_DIGIT = Array.from({ length: 1000 }, (_, n) => String(n).padStart(3, '0'))
const isRepeated = (s: string) => new Set(s).size === 1

/**
 * What is wrong with a 2 ตัว block, [] when nothing: the row layout (`rows` rows of exactly
 * `perRow`), rule A (one row: every number starts with r1 or r2; 2+ rows: row 1 starts with r1,
 * row 2 with r2, later rows free), rule C (no 00..99 without isDouble, in any row) and rule D (no
 * number twice in the block).
 */
function twoViolations(
  two: string[][],
  [r1, r2]: [string, string],
  rows: number,
  perRow: number,
  isDouble: boolean,
): string[] {
  const bad: string[] = []
  if (two.length !== rows) bad.push(`${two.length} rows, want ${rows}`)
  two.forEach((row, i) => {
    const at = `row ${i + 1}`
    if (row.length !== perRow) bad.push(`${at} holds ${row.length} numbers, want ${perRow}`)
    for (const t of row) {
      if (!/^\d{2}$/.test(t)) {
        bad.push(`${at}: ${t} is not 2 digits`)
        continue
      }
      if (!isDouble && t[0] === t[1]) bad.push(`${at}: ${t} is a double`)
      if (rows === 1) {
        if (t[0] !== r1 && t[0] !== r2) bad.push(`${at}: ${t} starts with neither ${r1} nor ${r2}`)
      } else if (i === 0 && t[0] !== r1) {
        bad.push(`${at}: ${t} does not start with ${r1}`)
      } else if (i === 1 && t[0] !== r2) {
        bad.push(`${at}: ${t} does not start with ${r2}`)
      }
    }
  })
  const all = two.flat()
  if (new Set(all).size !== all.length) bad.push(`a number repeats in ${all.join(' ')}`)
  return bad
}

/** The same for a 3 ตัว block: rule B ("contains" in any position), rule C (no triples without allowTriple), rule D. */
function threeViolations(
  three: string[][],
  [r1, r2]: [string, string],
  rows: number,
  perRow: number,
  allowTriple: boolean,
): string[] {
  const bad: string[] = []
  if (three.length !== rows) bad.push(`${three.length} rows, want ${rows}`)
  three.forEach((row, i) => {
    const at = `row ${i + 1}`
    if (row.length !== perRow) bad.push(`${at} holds ${row.length} numbers, want ${perRow}`)
    for (const t of row) {
      if (!/^\d{3}$/.test(t)) {
        bad.push(`${at}: ${t} is not 3 digits`)
        continue
      }
      if (!allowTriple && isRepeated(t)) bad.push(`${at}: ${t} is a triple`)
      if (rows === 1) {
        if (!t.includes(r1) && !t.includes(r2)) bad.push(`${at}: ${t} holds neither ${r1} nor ${r2}`)
      } else if (i === 0 && !t.includes(r1)) {
        bad.push(`${at}: ${t} does not hold ${r1}`)
      } else if (i === 1 && !t.includes(r2)) {
        bad.push(`${at}: ${t} does not hold ${r2}`)
      }
    }
  })
  const all = three.flat()
  if (new Set(all).size !== all.length) bad.push(`a number repeats in ${all.join(' ')}`)
  return bad
}

describe('2 ตัว / 3 ตัว row rules', () => {
  it('the checkers above really flag every kind of violation (so the property tests are not vacuous)', () => {
    const run: [string, string] = ['8', '1']
    expect(twoViolations([['81', '18']], run, 1, 2, false)).toEqual([])
    expect(twoViolations([['81', '28']], run, 1, 2, false)).toHaveLength(1) // 28 starts with neither
    expect(twoViolations([['80'], ['10']], run, 2, 1, false)).toEqual([])
    expect(twoViolations([['10'], ['80']], run, 2, 1, false)).toHaveLength(2) // rows swapped
    expect(twoViolations([['80'], ['10'], ['11']], run, 3, 1, false)).toHaveLength(1) // 11 is a double
    expect(twoViolations([['80'], ['10'], ['11']], run, 3, 1, true)).toEqual([]) // ...unless isDouble
    expect(twoViolations([['80'], ['10'], ['80']], run, 3, 1, false).length).toBeGreaterThan(0) // repeats
    expect(twoViolations([['80', '81'], ['10']], run, 2, 2, false)).toHaveLength(1) // row 2 is short
    expect(threeViolations([['081', '218']], run, 1, 2, false)).toEqual([])
    expect(threeViolations([['081', '229']], run, 1, 2, false)).toHaveLength(1)
    expect(threeViolations([['081'], ['212']], run, 2, 1, false)).toEqual([])
    expect(threeViolations([['212'], ['081']], run, 2, 1, false)).toHaveLength(1) // 212 has no 8 in row 1
    expect(threeViolations([['081'], ['212'], ['111']], run, 3, 1, false)).toHaveLength(1) // 111 is a triple
    expect(threeViolations([['081'], ['212'], ['111']], run, 3, 1, true)).toEqual([])
    expect(threeViolations([['081'], ['081']], run, 2, 1, false).length).toBeGreaterThan(0)
  })

  it('rules A-D and exact row counts: rows 1-4, several perRow, switches on/off, random and fixed running digits', () => {
    const bad: string[] = []
    for (const fixed of FIXED_CASES) {
      for (const rows of [1, 2, 3, 4]) {
        for (const perRow of [1, 2, 3, 4, 6]) {
          for (const isDouble of [false, true]) {
            for (const allowTriple of [false, true]) {
              for (let i = 0; i < 6; i++) {
                const n = generateCardNumbers({
                  fixed,
                  two: { row: rows, perRow, isDouble },
                  three: { row: rows, perRow, allowTriple },
                })
                const at = `[running ${n.running.join('')}, ${rows} x ${perRow}, isDouble ${isDouble}, allowTriple ${allowTriple}]`
                for (const v of twoViolations(n.two, n.running, rows, perRow, isDouble)) bad.push(`${at} two: ${v}`)
                for (const v of threeViolations(n.three, n.running, rows, perRow, allowTriple)) bad.push(`${at} three: ${v}`)
              }
            }
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([])
  })

  it('every row is full across the whole validated range (row 0-6, perRow 1-6): no shifting, no row left short', () => {
    // validation.ts: row 0..6, perRow 1..6. The smallest pool of a rule row is 9 numbers
    // ("starts with r1" with isDouble off), so perRow 6 never runs a rule row dry.
    const bad: string[] = []
    for (let rows = 0; rows <= 6; rows++) {
      for (let perRow = 1; perRow <= 6; perRow++) {
        for (const on of [false, true]) {
          for (let i = 0; i < 6; i++) {
            const n = generateForSettings({
              isDouble: on,
              allowTriple: on,
              elements: { two: { row: rows, perRow }, three: { row: rows, perRow } },
            })
            const at = `[running ${n.running.join('')}, ${rows} x ${perRow}, switches ${on}]`
            for (const v of twoViolations(n.two, n.running, rows, perRow, on)) bad.push(`${at} two: ${v}`)
            for (const v of threeViolations(n.three, n.running, rows, perRow, on)) bad.push(`${at} three: ${v}`)
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([])
    // Stored settings are loose JSON: anything above the maximum is clamped to 6 x 6, never dropped.
    const big = generateForSettings({ elements: { two: { row: 9, perRow: 9 }, three: { row: 9, perRow: 9 } } })
    expect(big.two.map((r) => r.length)).toEqual(Array(6).fill(6))
    expect(big.three.map((r) => r.length)).toEqual(Array(6).fill(6))
  })

  it('each rule row is a uniform sample of exactly what its rule allows', () => {
    // 2 ตัว, two rows of one number: row 1 over 80-89 minus 88, row 2 over 10-19 minus 11.
    const row1 = new Map<string, number>()
    const row2 = new Map<string, number>()
    for (let i = 0; i < 9000; i++) {
      const [[a], [b]] = genTwo(2, 1, [8, 1])
      row1.set(a, (row1.get(a) ?? 0) + 1)
      row2.set(b, (row2.get(b) ?? 0) + 1)
    }
    expectUniform(row1, TWO_DIGIT.filter((s) => s[0] === '8' && !isRepeated(s)))
    expectUniform(row2, TWO_DIGIT.filter((s) => s[0] === '1' && !isRepeated(s)))

    // ...with doubles the pools are 10 numbers.
    const dbl = new Map<string, number>()
    for (let i = 0; i < 10_000; i++) {
      const [[a]] = genTwo(2, 1, [8, 1], { isDouble: true })
      dbl.set(a, (dbl.get(a) ?? 0) + 1)
    }
    expectUniform(dbl, TWO_DIGIT.filter((s) => s[0] === '8'))

    // 2 ตัว, one row of three: every allowed number is equally likely to be in the row.
    const one = new Map<string, number>()
    for (let i = 0; i < 6000; i++) for (const t of genTwo(1, 3, [8, 1])[0]) one.set(t, (one.get(t) ?? 0) + 1)
    expectUniform(one, TWO_DIGIT.filter((s) => (s[0] === '8' || s[0] === '1') && !isRepeated(s)))

    // 3 ตัว, one row (the old rule): over every number holding 8 or 1, minus 888 and 111.
    const three1 = new Map<string, number>()
    for (let i = 0; i < 20_000; i++) {
      const [[t]] = genThree(1, 1, [8, 1])
      three1.set(t, (three1.get(t) ?? 0) + 1)
    }
    expectUniform(
      three1,
      THREE_DIGIT.filter((s) => (s.includes('8') || s.includes('1')) && !isRepeated(s)),
    )

    // 3 ตัว, two rows: row 1 over every number holding 8, minus 888.
    const three2 = new Map<string, number>()
    for (let i = 0; i < 14_000; i++) {
      const [[t]] = genThree(2, 1, [8, 1])
      three2.set(t, (three2.get(t) ?? 0) + 1)
    }
    expectUniform(
      three2,
      THREE_DIGIT.filter((s) => s.includes('8') && !isRepeated(s)),
    )
  })

  it('rows 3 and beyond are fully random: no running digit needed, switches still apply', () => {
    const lead = Array<number>(10).fill(0)
    let neither = 0
    const runs = 3000
    for (let i = 0; i < runs; i++) {
      const two = genTwo(3, 1, [8, 1])
      lead[Number(two[2][0][0])]++
      if (!/[81]/.test(genThree(3, 1, [8, 1])[2][0])) neither++
    }
    // Every first digit shows up in row 3 (270-310 times each); a rule that kept the running
    // digits only would give 0 for the other eight.
    for (let d = 0; d < 10; d++) expect(lead[d], `first digit ${d} in row 3`).toBeGreaterThan(150)
    // About half of all 3-digit numbers (0.8^3 = 51%) hold neither 8 nor 1.
    expect(neither).toBeGreaterThan(runs * 0.4)

    // switches off: no 00..99 / 000..999 in rows 3+; switches on: they do appear there
    let offRepeats = 0
    let rowDoubles = 0
    let rowTriples = 0
    for (let i = 0; i < 300; i++) {
      const off = generateCardNumbers({ fixed: [8, 1], two: { row: 4, perRow: 6 }, three: { row: 4, perRow: 6 } })
      for (const row of [...off.two.slice(2), ...off.three.slice(2)]) offRepeats += row.filter(isRepeated).length
      const on = generateCardNumbers({
        fixed: [8, 1],
        two: { row: 4, perRow: 6, isDouble: true },
        three: { row: 4, perRow: 6, allowTriple: true },
      })
      for (const row of on.two.slice(2)) rowDoubles += row.filter(isRepeated).length
      for (const row of on.three.slice(2)) rowTriples += row.filter(isRepeated).length
    }
    expect(offRepeats).toBe(0)
    expect(rowDoubles).toBeGreaterThan(0)
    expect(rowTriples).toBeGreaterThan(0)
  })

  it('perRow above a rule row\'s pool: the row keeps its whole pool, then is topped up so it stays full', () => {
    // Not reachable through the API (perRow <= 6, smallest pool 9), but a direct caller can ask.
    for (let i = 0; i < RUNS; i++) {
      const two = genTwo(3, 12, [8, 1])
      expect(two.map((r) => r.length)).toEqual([12, 12, 12])
      expect(new Set(two.flat()).size).toBe(36)
      expect(two.flat().some(isRepeated)).toBe(false)
      for (const d of '012345679') expect(two[0], `8${d} in row 1`).toContain(`8${d}`)
      for (const d of '023456789') expect(two[1], `1${d} in row 2`).toContain(`1${d}`)

      // doubles on: 10 numbers per rule row, so perRow 11 needs one top-up each
      const dbl = genTwo(2, 11, [8, 1], { isDouble: true })
      expect(dbl.map((r) => r.length)).toEqual([11, 11])
      expect(new Set(dbl.flat()).size).toBe(22)
      for (let d = 0; d < 10; d++) {
        expect(dbl[0]).toContain(`8${d}`)
        expect(dbl[1]).toContain(`1${d}`)
      }

      // one row: all 18 numbers starting with 8 or 1 first, then 7 numbers that start with neither
      const one = genTwo(1, 25, [8, 1])
      expect(one[0]).toHaveLength(25)
      expect(new Set(one[0]).size).toBe(25)
      expect(one[0].filter((t) => t[0] === '8' || t[0] === '1')).toHaveLength(18)
      expect(one[0].some(isRepeated)).toBe(false)
    }

    // 3 ตัว: row 1 takes all 270 numbers holding 8, row 2 all 216 holding 1 but no 8 (111 excluded)
    const three = genThree(2, 300, [8, 1])
    expect(three.map((r) => r.length)).toEqual([300, 300])
    expect(new Set(three.flat()).size).toBe(600)
    const row1 = new Set(three[0])
    const row2 = new Set(three[1])
    expect(THREE_DIGIT.filter((s) => s.includes('8') && !isRepeated(s) && !row1.has(s))).toEqual([])
    expect(THREE_DIGIT.filter((s) => s.includes('1') && !s.includes('8') && !isRepeated(s) && !row2.has(s))).toEqual([])
    expect(three.flat().some(isRepeated)).toBe(false)
  })

  it('a block asked for more numbers than exist ends short, never repeated or padded', () => {
    const two = genTwo(6, 20, [8, 1]) // 120 asked, only 90 non-double 2-digit numbers exist
    expect(two.map((r) => r.length)).toEqual([20, 20, 20, 20, 10])
    expect(new Set(two.flat()).size).toBe(90)
    const three = genThree(1, 2000, [8, 1]) // 990 non-triple 3-digit numbers
    expect(three).toHaveLength(1)
    expect(three[0]).toHaveLength(990)
    expect(new Set(three[0]).size).toBe(990)
    // silly sizes neither hang nor throw
    expect(genTwo(Infinity, 3, [8, 1])).toEqual([])
    expect(genTwo(2, Infinity, [8, 1])).toHaveLength(2)
    expect(genTwo(1e9, 1, [8, 1])).toHaveLength(90)
    expect(genTwo(-3, 2, [8, 1])).toEqual([])
    expect(genTwo(1.9, 2.9, [8, 1]).map((r) => r.length)).toEqual([2])
  })
})

describe('top / drill / win keep their documented rules beside the 2 ตัว / 3 ตัว rules', () => {
  const PREFIXES = ['running1', 'running2', 'top', 'two'] as const
  const INCLUDES = ['running', 'top', 'none'] as const

  it('top cycles the running digits; drill shares one prefix; win rows hold distinct digits incl. the required ones', () => {
    for (let i = 0; i < RUNS * 2; i++) {
      const prefixFrom = PREFIXES[i % 4]
      const include = INCLUDES[i % 3]
      const topRow = 1 + (i % 3)
      const topPer = 1 + ((i >> 2) % 3)
      const twoRow = i % 5
      const threeRow = (i >> 1) % 5
      const drillRow = 1 + (i % 4)
      const drillPer = 1 + ((i >> 1) % 5)
      const winRow = 1 + (i % 3)
      const digitCount = 2 + (i % 6)
      const n = generateForSettings({
        isDouble: i % 2 === 0,
        allowTriple: i % 3 === 0,
        drillPrefixFrom: prefixFrom,
        winInclude: include,
        winDigitCount: digitCount,
        elements: {
          top: { row: topRow, perRow: topPer },
          two: { row: twoRow, perRow: 1 + (i % 6) },
          three: { row: threeRow, perRow: 1 + ((i >> 3) % 6) },
          drill: { row: drillRow, perRow: drillPer },
          win: { row: winRow },
        },
      })
      const [r1, r2] = n.running

      // top: row * perRow tokens cycling r1, r2, r1, ...
      expect(n.top).toHaveLength(topRow * topPer)
      n.top.forEach((d, k) => expect(d).toBe(n.running[k % 2]))

      // drill: row * perRow (at most the 9 possible) unique 2-digit numbers sharing the prefix
      const prefix =
        prefixFrom === 'running1'
          ? r1
          : prefixFrom === 'running2'
            ? r2
            : prefixFrom === 'top'
              ? n.top[0]
              : twoRow > 0
                ? n.two[0][0][0]
                : r1
      expect(n.drill).toHaveLength(Math.min(drillRow * drillPer, 9))
      expect(new Set(n.drill).size).toBe(n.drill.length)
      for (const d of n.drill) {
        expect(d).toMatch(/^\d{2}$/)
        expect(d[0]).toBe(prefix)
        expect(d[1]).not.toBe(d[0])
      }

      // win: winRow unique rows of digitCount distinct digits that include the required digits
      const required = include === 'running' ? [r1, r2] : include === 'top' ? [...new Set(n.top)] : []
      expect(n.win).toHaveLength(winRow)
      expect(new Set(n.win).size).toBe(n.win.length)
      for (const w of n.win) {
        expect(w).toHaveLength(digitCount)
        expect(new Set(w).size).toBe(digitCount)
        for (const d of required) expect(w).toContain(d)
      }
    }
  })

  it('the fixed running digits, top and win are untouched by the 2 ตัว row rules', () => {
    for (let i = 0; i < RUNS; i++) {
      const n = generateForSettings({
        fixedRunning1: 8,
        fixedRunning2: 1,
        elements: {
          top: { row: 2, perRow: 2 },
          two: { row: 3, perRow: 3 },
          three: { row: 3, perRow: 3 },
          drill: { row: 2, perRow: 6 }, // 12 asked, the 9 possible numbers come back
        },
      })
      expect(n.running).toEqual(['8', '1'])
      expect(n.top).toEqual(['8', '1', '8', '1'])
      expect(n.drill).toHaveLength(9)
      expect(n.drill.every((d) => d[0] === '8')).toBe(true)
      expect(n.win[0]).toHaveLength(6)
    }
  })
})

describe('runningDouble is display only', () => {
  it('is ignored by the generator: running digits stay single digits and every rule still holds', () => {
    for (let i = 0; i < RUNS; i++) {
      const on = generateForSettings({
        runningDouble: true,
        fixedRunning1: 8,
        fixedRunning2: 1,
        elements: { two: { row: 3, perRow: 3 }, three: { row: 3, perRow: 3 } },
      })
      expect(on.running).toEqual(['8', '1'])
      expect(on.single).toBe('81')
      expect(twoViolations(on.two, on.running, 3, 3, false)).toEqual([])
      expect(threeViolations(on.three, on.running, 3, 3, false)).toEqual([])
      const random = generateForSettings({ runningDouble: true })
      expect(random.running[0]).toMatch(/^\d$/)
      expect(random.running[1]).toMatch(/^\d$/)
      expect(random.single).toBe(random.running[0] + random.running[1])
    }
  })
})

describe('generator helpers', () => {
  it('genTwo / genThree give one inner array per row with exactly perRow unique numbers', () => {
    for (let i = 0; i < RUNS; i++) {
      const two = genTwo(3, 4, [1, 2])
      expect(two.map((r) => r.length)).toEqual([4, 4, 4])
      expect(new Set(two.flat()).size).toBe(12)
      const three = genThree(5, 6, [5, 6], { allowTriple: true })
      expect(three.map((r) => r.length)).toEqual([6, 6, 6, 6, 6])
      expect(new Set(three.flat()).size).toBe(30)
      three[0].forEach((t) => expect(t).toContain('5'))
      three[1].forEach((t) => expect(t).toContain('6'))
    }
    expect(genTwo(0, 3, [1, 2])).toEqual([])
    expect(genThree(0, 3, [1, 2])).toEqual([])
  })
  it('genDrill caps at 9 and genWin clamps digit count to 2..7', () => {
    expect(genDrill(20, 4).length).toBe(9)
    expect(genWin(3, 12, [1, 2]).every((w) => w.length === 7)).toBe(true)
    expect(genWin(3, 1, [1, 2]).every((w) => w.length === 2)).toBe(true)
  })
})

describe('generateForSettings', () => {
  it('uses mockup defaults when settings are missing', () => {
    const n = generateForSettings(null)
    expect(n.top.length).toBe(1)
    expect(n.two.length).toBe(2)
    expect(n.two[0].length).toBe(3)
    expect(n.three.length).toBe(2)
    // drill default: 2 rows x 3 per row (the card chunks the flat list by perRow)
    expect(n.drill.length).toBe(6)
    expect(n.win.length).toBe(1)
    expect(n.win[0].length).toBe(6)
  })
  it('request fixed digits override saved fixedRunning', () => {
    for (let i = 0; i < 50; i++) {
      const n = generateForSettings({ fixedRunning1: 1, fixedRunning2: 2 }, ['8', null])
      expect(n.running).toEqual(['8', '2'])
      const m = generateForSettings({ fixedRunning1: 1, fixedRunning2: 2 })
      expect(m.running).toEqual(['1', '2'])
    }
  })
  it('parseFixedDigit accepts only a single digit (blank / junk = random)', () => {
    expect(parseFixedDigit('0')).toBe(0)
    expect(parseFixedDigit('9')).toBe(9)
    expect(parseFixedDigit(7)).toBe(7)
    for (const v of [' ', '', '  ', '1.', '10', '-1', 'a', null, undefined, 10, 1.5, -1]) {
      expect(parseFixedDigit(v as string | number | null | undefined), String(v)).toBeUndefined()
    }
  })
  it('win include "none" still gives distinct digits of the right count', () => {
    for (let i = 0; i < RUNS; i++) {
      const n = generateCardNumbers({ win: { row: 3, digitCount: 4, include: 'none' } })
      expect(n.win).toHaveLength(3)
      for (const w of n.win) expect(new Set(w).size).toBe(4)
      expect(new Set(n.win).size).toBe(3)
    }
  })
  it('reads rows/perRow from elements', () => {
    const n = generateForSettings({
      winDigitCount: 4,
      elements: { two: { row: 3, perRow: 2 }, three: { row: 1, perRow: 4 }, win: { row: 2 } },
    })
    expect(n.two.map((r) => r.length)).toEqual([2, 2, 2])
    expect(n.three.map((r) => r.length)).toEqual([4])
    expect(n.win.length).toBe(2)
    expect(n.win.every((w) => w.length === 4)).toBe(true)
  })
  it('drill honours row x perRow, capped at the 9 possible numbers', () => {
    for (let i = 0; i < RUNS; i++) {
      const a = generateForSettings({ elements: { drill: { row: 2, perRow: 2 } } })
      expect(a.drill).toHaveLength(4)
      expect(new Set(a.drill).size).toBe(4)
      const b = generateForSettings({ elements: { drill: { row: 1, perRow: 5 } } })
      expect(b.drill).toHaveLength(5)
      const c = generateForSettings({ elements: { drill: { row: 6, perRow: 6 } } })
      expect(c.drill).toHaveLength(9)
      expect(new Set(c.drill).size).toBe(9)
      c.drill.forEach((d) => expect(d[0]).toBe(c.running[0]))
      expect(generateForSettings({ elements: { drill: { row: 0, perRow: 3 } } }).drill).toEqual([])
    }
  })
  it('generateCardNumbers drill count is row * perRow', () => {
    expect(generateCardNumbers({ drill: { row: 2, perRow: 3 } }).drill).toHaveLength(6)
    expect(generateCardNumbers({ drill: { row: 3 } }).drill).toHaveLength(3)
    expect(genDrill(0, 4)).toEqual([])
  })
})

describe('เลขเด่น (single)', () => {
  it('defaults to 2 digits: r1 followed by r2 (not a random pool number any more)', () => {
    for (let i = 0; i < RUNS; i++) {
      const n = generateForSettings(null)
      expect(n.single).toBe(n.running[0] + n.running[1])
    }
  })
  it('2 digits is r1 then r2 for random and fixed running digits, whatever isDouble says', () => {
    expect(generateForSettings({ fixedRunning1: 8, fixedRunning2: 1 }).single).toBe('81')
    expect(generateForSettings({ fixedRunning1: 1, fixedRunning2: 8 }).single).toBe('18')
    expect(generateForSettings({ fixedRunning1: 0, fixedRunning2: 9, isDouble: true }).single).toBe('09')
    // a render request's fixed digits win over the saved ones, slot by slot
    expect(generateForSettings({ fixedRunning1: 1, fixedRunning2: 2 }, ['8', null]).single).toBe('82')
    for (const fixed of FIXED_CASES) {
      for (let i = 0; i < 40; i++) {
        const n = generateCardNumbers({ fixed })
        expect(n.single).toBe(n.running[0] + n.running[1])
        expect(n.single[0]).not.toBe(n.single[1])
        if (fixed[0] !== undefined) expect(n.single[0]).toBe(String(fixed[0]))
        if (fixed[1] !== undefined) expect(n.single[1]).toBe(String(fixed[1]))
      }
    }
    for (const isDouble of [false, true]) {
      for (let i = 0; i < 50; i++) {
        const n = generateForSettings({ isDouble })
        expect(n.single).toBe(n.running[0] + n.running[1])
      }
    }
  })
  it('singleDigits 1 is one of the running digits, both of them get picked', () => {
    for (let i = 0; i < RUNS; i++) {
      const n = generateForSettings({ singleDigits: 1 })
      expect(n.running).toContain(n.single)
    }
    const seen = new Set<string>()
    for (let i = 0; i < RUNS; i++) {
      seen.add(generateForSettings({ singleDigits: 1, fixedRunning1: 3, fixedRunning2: 6 }).single)
    }
    expect([...seen].sort()).toEqual(['3', '6'])
  })
  it('singleDigits 3 holds a running digit in any position; triples only with allowTriple', () => {
    for (let i = 0; i < RUNS; i++) {
      const n = generateForSettings({ singleDigits: 3, fixedRunning1: 1, fixedRunning2: 2 })
      expect(n.single).toMatch(/^\d{3}$/)
      expect(containsRunning(n.single, n.running)).toBe(true)
      expect(['111', '222']).not.toContain(n.single)
    }
    const seen = new Set<string>()
    for (let i = 0; i < 4000; i++) {
      seen.add(generateCardNumbers({ fixed: [1, 2], single: { digits: 3, allowTriple: true } }).single)
    }
    expect(seen.has('111') || seen.has('222')).toBe(true)
  })
  it('singleDigits 3 is still uniform over every 3-digit number holding r1 or r2 (unchanged)', () => {
    const pool: string[] = []
    for (let n = 0; n < 1000; n++) {
      const s = String(n).padStart(3, '0')
      if ((s.includes('1') || s.includes('2')) && !/^(\d)\1\1$/.test(s)) pool.push(s)
    }
    expect(pool).toHaveLength(486)
    const counts = new Map<string, number>()
    for (let i = 0; i < 30_000; i++) {
      const s = generateCardNumbers({ fixed: [1, 2], single: { digits: 3 } }).single
      counts.set(s, (counts.get(s) ?? 0) + 1)
    }
    expectUniform(counts, pool)
  })
  it('a valid fixedSingle still wins (also over the r1 r2 rule, isDouble and the running digits)', () => {
    expect(generateForSettings({ fixedSingle: '07' }).single).toBe('07')
    expect(generateForSettings({ fixedSingle: '11', fixedRunning1: 8, fixedRunning2: 1 }).single).toBe('11')
    expect(generateForSettings({ fixedSingle: '45', fixedRunning1: 8, fixedRunning2: 1 }).single).toBe('45')
    expect(generateForSettings({ singleDigits: 1, fixedSingle: '5' }).single).toBe('5')
    expect(generateForSettings({ singleDigits: 1, fixedSingle: '5', fixedRunning1: 8, fixedRunning2: 1 }).single).toBe('5')
    expect(generateForSettings({ singleDigits: 3, fixedSingle: '999' }).single).toBe('999')
    expect(generateForSettings({ singleDigits: 3, fixedSingle: '246', fixedRunning1: 8, fixedRunning2: 1 }).single).toBe('246')
  })
  it('a fixedSingle that is not exactly singleDigits digits falls back to the rule for that digit count', () => {
    for (let i = 0; i < 50; i++) {
      // 3 digits asked, 2 given → a 3-digit number containing a running digit
      const a = generateForSettings({ singleDigits: 3, fixedSingle: '12', fixedRunning1: 4, fixedRunning2: 5 })
      expect(a.single).toMatch(/^\d{3}$/)
      expect(containsRunning(a.single, a.running)).toBe(true)
      // 2 digits asked → r1 r2, however the bad value looks
      for (const bad of ['1x', '123', '1', '', ' ', null]) {
        const b = generateForSettings({ fixedSingle: bad, fixedRunning1: 4, fixedRunning2: 5 })
        expect(b.single, String(bad)).toBe('45')
      }
      const c = generateForSettings({ fixedSingle: null, singleDigits: 1 })
      expect(c.running).toContain(c.single)
    }
  })
  it('out-of-range singleDigits is clamped (stored JSON is loose)', () => {
    expect(generateForSettings({ singleDigits: 9 as never }).single).toMatch(/^\d{3}$/)
    expect(generateForSettings({ singleDigits: 0 as never }).single).toMatch(/^\d$/)
  })
  it('generateCardNumbers always returns single', () => {
    expect(generateCardNumbers({}).single).toMatch(/^\d{2}$/)
  })
})
