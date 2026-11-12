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
  it('every 2/3-digit number contains a running digit, all unique, rows shaped', () => {
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
      expect(n.two.every((row) => row.length <= twoPer)).toBe(true)
      expect(n.three.every((row) => row.length <= threePer)).toBe(true)
      // Pool of 2-digit numbers is 34 (36 with doubles); otherwise exactly row*perRow.
      expect(two.length).toBe(Math.min(twoRow * twoPer, i % 3 === 0 ? 36 : 34))
      expect(three.length).toBe(threeRow * threePer)

      for (const t of two) {
        expect(t).toMatch(/^\d{2}$/)
        expect(containsRunning(t, running)).toBe(true)
        if (i % 3 !== 0) expect(t[0]).not.toBe(t[1])
      }
      for (const t of three) {
        expect(t).toMatch(/^\d{3}$/)
        expect(containsRunning(t, running)).toBe(true)
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

describe('generator helpers', () => {
  it('genTwo / genThree respect count and uniqueness', () => {
    for (let i = 0; i < RUNS; i++) {
      const two = genTwo(40, [1, 2])
      expect(two.length).toBe(34)
      expect(new Set(two).size).toBe(34)
      const three = genThree(50, [5, 6], true)
      expect(new Set(three).size).toBe(50)
      three.forEach((t) => expect(/[56]/.test(t)).toBe(true))
    }
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
  it('defaults to one 2-digit number from the genTwo pool', () => {
    for (let i = 0; i < RUNS; i++) {
      const n = generateForSettings(null)
      expect(n.single).toMatch(/^\d{2}$/)
      expect(containsRunning(n.single, n.running)).toBe(true)
      expect(n.single[0]).not.toBe(n.single[1])
    }
  })
  it('singleDigits 1 is one of the running digits', () => {
    for (let i = 0; i < RUNS; i++) {
      const n = generateForSettings({ singleDigits: 1 })
      expect(n.running).toContain(n.single)
    }
  })
  it('singleDigits 3 is from the genThree pool; triples only with allowTriple', () => {
    for (let i = 0; i < RUNS; i++) {
      const n = generateForSettings({ singleDigits: 3, fixedRunning1: 1, fixedRunning2: 2 })
      expect(n.single).toMatch(/^\d{3}$/)
      expect(containsRunning(n.single, n.running)).toBe(true)
      expect(['111', '222']).not.toContain(n.single)
    }
    const seen = new Set<string>()
    for (let i = 0; i < 4000; i++) {
      seen.add(generateForSettings({ singleDigits: 3, allowTriple: true, fixedRunning1: 1, fixedRunning2: 2 }).single)
    }
    expect(seen.has('111') || seen.has('222')).toBe(true)
  })
  it('isDouble lets the 2-digit single be a double', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 2000; i++) {
      seen.add(generateForSettings({ isDouble: true, fixedRunning1: 1, fixedRunning2: 2 }).single)
    }
    expect(seen.has('11') || seen.has('22')).toBe(true)
  })
  it('fixedSingle locks it only when it is exactly singleDigits digits', () => {
    expect(generateForSettings({ fixedSingle: '07' }).single).toBe('07')
    expect(generateForSettings({ singleDigits: 1, fixedSingle: '5' }).single).toBe('5')
    expect(generateForSettings({ singleDigits: 3, fixedSingle: '999' }).single).toBe('999')
    for (let i = 0; i < 50; i++) {
      // wrong length / not digits → random from the pool
      const a = generateForSettings({ singleDigits: 3, fixedSingle: '12', fixedRunning1: 4, fixedRunning2: 5 })
      expect(a.single).toMatch(/^\d{3}$/)
      expect(containsRunning(a.single, a.running)).toBe(true)
      const b = generateForSettings({ fixedSingle: '1x', fixedRunning1: 4, fixedRunning2: 5 })
      expect(containsRunning(b.single, b.running)).toBe(true)
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
