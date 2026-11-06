// Number-generation rules for the lottery hint cards (SPEC.md "Card anatomy").
// Server-side port of the mockup's numbergen-web/src/lib/numbers.ts — same behaviour:
//  - running: two distinct single digits (either may be fixed)
//  - top: row*perRow tokens cycling running[0], running[1]
//  - two / three: unique numbers that each contain at least one running digit
//    (doubles only with isDouble, triples only with allowTriple)
//  - drill: 2-digit numbers sharing one prefix digit (from running1/running2/top/two), unique, ≤ 9
//  - win: rows of `digitCount` distinct digits that must include the running (or top) digits
// The only shape change: two/three are returned as one inner array per row (API.md CardNumbers).
import type { CardNumbers, CardSettings, DrillPrefixFrom, WinInclude } from '../types'

export type Digit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9

const DIGITS: Digit[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]

/** Uniform random integer in [0, max). Uses WebCrypto so results are not predictable. */
export function randInt(max: number): number {
  if (max <= 1) return 0
  const buf = new Uint32Array(1)
  const limit = Math.floor(0x1_0000_0000 / max) * max
  let x: number
  do {
    crypto.getRandomValues(buf)
    x = buf[0]
  } while (x >= limit)
  return x % max
}

function pick<T>(arr: T[]): T {
  return arr[randInt(arr.length)]
}

function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function isDigit(v: unknown): v is Digit {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 9
}

/** Two distinct single digits. `fixed` may lock either or both slots (mockup behaviour). */
export function pickRunning(fixed?: [number | undefined, number | undefined]): [Digit, Digit] {
  const [f1, f2] = fixed ?? []
  // A fixed slot 2 is respected even when slot 1 is random (the mockup could overwrite it when
  // the random slot-1 digit happened to equal it).
  const d1: Digit = isDigit(f1) ? f1 : pick(DIGITS.filter((d) => !isDigit(f2) || d !== f2))
  let d2: Digit
  if (isDigit(f2)) {
    d2 = f2
  } else {
    d2 = pick(DIGITS.filter((d) => d !== d1))
  }
  // Running digits are always distinct (as in the mockup, even if both slots were fixed equal).
  if (d1 === d2) d2 = pick(DIGITS.filter((d) => d !== d1))
  return [d1, d2]
}

/** Unique 2-digit strings containing at least one running digit. */
export function genTwo(count: number, running: [Digit, Digit], opts?: { isDouble?: boolean }): string[] {
  const isDouble = opts?.isDouble ?? false
  const [r1, r2] = running
  const pool: string[] = []
  for (let a = 0; a <= 9; a++) {
    for (let b = 0; b <= 9; b++) {
      if (a !== r1 && a !== r2 && b !== r1 && b !== r2) continue
      if (!isDouble && a === b) continue
      pool.push(`${a}${b}`)
    }
  }
  return shuffle(pool).slice(0, Math.max(0, Math.min(count, pool.length)))
}

/** Unique 3-digit strings containing at least one running digit. */
export function genThree(count: number, running: [Digit, Digit], allowTriple = false): string[] {
  const [r1, r2] = running
  const pool: string[] = []
  for (let a = 0; a <= 9; a++) {
    for (let b = 0; b <= 9; b++) {
      for (let c = 0; c <= 9; c++) {
        const hasRun = a === r1 || a === r2 || b === r1 || b === r2 || c === r1 || c === r2
        if (!hasRun) continue
        if (!allowTriple && a === b && b === c) continue
        pool.push(`${a}${b}${c}`)
      }
    }
  }
  const need = Math.max(0, Math.min(count, pool.length))
  const result: string[] = []
  const used = new Set<number>()
  while (result.length < need) {
    const idx = randInt(pool.length)
    if (used.has(idx)) continue
    used.add(idx)
    result.push(pool[idx])
  }
  return result
}

/** Each row: prefix digit followed by a random *other* digit, unique across rows (max 9). */
export function genDrill(rows: number, prefixDigit: number): string[] {
  const out: string[] = []
  const tried = new Set<string>()
  const shuffled = shuffle(DIGITS.filter((d) => d !== prefixDigit))
  for (let i = 0; i < rows && out.length < 9; i++) {
    const key = `${prefixDigit}${shuffled[i % shuffled.length]}`
    if (tried.has(key)) continue
    tried.add(key)
    out.push(key)
  }
  return out
}

/**
 * Each row: `digitCount` (clamped 2..7) distinct digits that MUST contain every digit in
 * `mustInclude`. Returns unique rows up to the requested count.
 */
export function genWin(rows: number, digitCount = 6, mustInclude: number[] = []): string[] {
  const unique = Array.from(new Set(mustInclude.filter((d) => isDigit(d))))
  const target = Math.max(2, Math.min(7, digitCount))
  const fill = Math.max(0, target - unique.length)
  const seen = new Set<string>()
  const out: string[] = []
  let attempts = 0
  while (out.length < rows && attempts < rows * 80) {
    attempts++
    const others = DIGITS.filter((d) => !unique.includes(d))
    const extras = shuffle(others).slice(0, fill)
    const combined = shuffle([...unique, ...extras]).join('')
    if (seen.has(combined)) continue
    seen.add(combined)
    out.push(combined)
  }
  return out
}

export interface GenerateInput {
  top?: { row: number; perRow: number }
  two?: { row: number; perRow: number; isDouble?: boolean }
  three?: { row: number; perRow: number; allowTriple?: boolean }
  drill?: { row: number; prefixFrom?: DrillPrefixFrom }
  win?: { row: number; digitCount?: number; include?: WinInclude }
  fixed?: [number | undefined, number | undefined]
}

function chunk(arr: string[], size: number): string[][] {
  const per = Math.max(1, size)
  const out: string[][] = []
  for (let i = 0; i < arr.length; i += per) out.push(arr.slice(i, i + per))
  return out
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(v)))
}

export function generateCardNumbers(cfg: GenerateInput): CardNumbers {
  const running = pickRunning(cfg.fixed)

  const twoPer = Math.max(1, cfg.two?.perRow ?? 1)
  const twoCount = (cfg.two?.row ?? 0) * twoPer
  const twoFlat = twoCount > 0 ? genTwo(twoCount, running, { isDouble: cfg.two?.isDouble }) : []

  const threePer = Math.max(1, cfg.three?.perRow ?? 1)
  const threeCount = (cfg.three?.row ?? 0) * threePer
  const threeFlat = threeCount > 0 ? genThree(threeCount, running, cfg.three?.allowTriple) : []

  const topCount = (cfg.top?.row ?? 0) * (cfg.top?.perRow ?? 0)
  const top: string[] = []
  for (let i = 0; i < topCount; i++) top.push(String(running[i % 2]))

  const drillRows = cfg.drill?.row ?? 0
  const prefixFrom = cfg.drill?.prefixFrom ?? 'running1'
  let prefixDigit: number = running[0]
  if (prefixFrom === 'running2') prefixDigit = running[1]
  if (prefixFrom === 'top' && top.length) prefixDigit = Number(top[0])
  if (prefixFrom === 'two' && twoFlat.length) prefixDigit = Number(twoFlat[0][0])
  const drill = drillRows > 0 ? genDrill(drillRows, prefixDigit) : []

  const winRows = cfg.win?.row ?? 0
  const include = cfg.win?.include ?? 'running'
  const mustInclude =
    include === 'none'
      ? []
      : include === 'top' && top.length
        ? top.map(Number)
        : [running[0], running[1]]
  const win = winRows > 0 ? genWin(winRows, cfg.win?.digitCount ?? 6, mustInclude) : []

  return {
    running: [String(running[0]), String(running[1])],
    top,
    two: chunk(twoFlat, twoPer),
    three: chunk(threeFlat, threePer),
    drill,
    win,
  }
}

/** Parses a fixed running digit from the request (`"0".."9"`, else random). */
export function parseFixedDigit(v: string | number | null | undefined): number | undefined {
  if (v === null || v === undefined) return undefined
  if (typeof v === 'string') {
    // Only a single digit counts; ' ' / '' / '1.' are "random" (Number(' ') would be 0).
    return /^\d$/.test(v) ? Number(v) : undefined
  }
  return isDigit(v) ? v : undefined
}

/**
 * Maps a (possibly partial) CardSettings to generator input, with the mockup defaults
 * (DEFAULT_CARD_SETTINGS) for anything missing. `fixed` from the request overrides
 * fixedRunning1/2 per slot when that slot is given.
 */
export function generateForSettings(
  settings: CardSettings | null | undefined,
  fixed?: [string | null, string | null],
): CardNumbers {
  const s = settings ?? {}
  const el = s.elements ?? {}
  const rowOf = (key: string, def: number) => clampInt(el[key]?.row, 0, 6, def)
  const perOf = (key: string, def: number) => clampInt(el[key]?.perRow, 1, 6, def)

  const f1 = fixed ? parseFixedDigit(fixed[0]) : undefined
  const f2 = fixed ? parseFixedDigit(fixed[1]) : undefined
  const s1 = parseFixedDigit(s.fixedRunning1 ?? undefined)
  const s2 = parseFixedDigit(s.fixedRunning2 ?? undefined)

  return generateCardNumbers({
    top: { row: rowOf('top', 1), perRow: perOf('top', 1) },
    two: { row: rowOf('two', 2), perRow: perOf('two', 3), isDouble: s.isDouble === true },
    three: { row: rowOf('three', 2), perRow: perOf('three', 3), allowTriple: s.allowTriple === true },
    drill: { row: rowOf('drill', 2), prefixFrom: s.drillPrefixFrom },
    win: { row: rowOf('win', 1), digitCount: clampInt(s.winDigitCount, 2, 7, 6), include: s.winInclude },
    fixed: [f1 ?? s1, f2 ?? s2],
  })
}
