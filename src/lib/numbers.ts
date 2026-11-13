// Number-generation rules for the lottery hint cards (SPEC.md "Card anatomy").
// Server-side port of the mockup's numbergen-web/src/lib/numbers.ts; the 2 ตัว / 3 ตัว / เลขเด่น
// rules below replace the mockup's "contains a running digit" rule. Running digits are r1, r2.
//  - running: two distinct single digits (either may be fixed)
//  - top: row*perRow tokens cycling running[0], running[1]
//  - two (2 ตัว): `row` rows of exactly `perRow` unique 2-digit numbers, no number twice in the block
//      1 row:    every number starts with r1 or r2
//      2+ rows:  row 1 starts with r1, row 2 starts with r2, rows 3+ are any 2-digit number (00-99)
//  - three (3 ตัว): same shape with 3-digit numbers and "contains" instead of "starts with"
//      1 row:    every number contains r1 or r2 (any position)
//      2+ rows:  row 1 contains r1, row 2 contains r2, rows 3+ are any 3-digit number (000-999)
//    isDouble (two) / allowTriple (three) decide whether 00..99 / 000..999 may appear, in every row
//  - drill: row*perRow 2-digit numbers sharing one prefix digit (from running1/running2/top/two),
//    unique, so at most 9 (the prefix followed by each other digit)
//  - win: rows of `digitCount` distinct digits that must include the running (or top) digits
//  - single (เลขเด่น): one 1/2/3-digit number unless fixedSingle locks it — 1 digit: a running
//    digit; 2 digits: r1 followed by r2; 3 digits: a number containing a running digit
// The only shape change: two/three are returned as one inner array per row (API.md CardNumbers).
// runningDouble (draw each running digit twice) is display only and is not read here.
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

// ---- 2 ตัว / 3 ตัว blocks ---------------------------------------------------------------------

/**
 * What a row rule looks at in each number, looked up by the number's integer value ("07" is 7,
 * "007" is 7). 2-digit numbers: the bit of the first digit, so a rule means "starts with". 3-digit
 * numbers: the bits of every digit it holds, so a rule means "contains" ("007" holds 0 and 7).
 * A rule is a mask of digits (bit d = digit d); a number passes when its profile shares a bit.
 */
const PROFILE: Record<2 | 3, Uint16Array> = { 2: new Uint16Array(100), 3: new Uint16Array(1000) }
for (let n = 0; n < 100; n++) PROFILE[2][n] = 1 << Math.floor(n / 10)
for (let n = 0; n < 1000; n++) {
  PROFILE[3][n] = (1 << Math.floor(n / 100)) | (1 << (Math.floor(n / 10) % 10)) | (1 << (n % 10))
}
/** A rule every number passes (rows 3 and beyond, top-ups). */
const ANY_DIGIT = 0x3ff

/** Digit masks (see PROFILE) for the rows of a block. */
interface BlockRules {
  /** The row of a block that has exactly one row. */
  only: number
  /** Row 1 of a block with two or more rows. */
  first: number
  /** Row 2 of a block with two or more rows. Rows 3 and beyond take any number. */
  second: number
}

/**
 * `k` distinct entries of `pool`, chosen uniformly at random and in random order (partial
 * Fisher-Yates, so exactly min(k, pool.length) random draws). Fewer than `k` only when the pool is
 * smaller. Reorders `pool`.
 */
function sampleDistinct(pool: number[], k: number): number[] {
  const n = Math.min(k, pool.length)
  for (let i = 0; i < n; i++) {
    const j = i + randInt(pool.length - i)
    const t = pool[i]
    pool[i] = pool[j]
    pool[j] = t
  }
  return pool.slice(0, n)
}

/**
 * `rows` rows of `perRow` unique `len`-digit numbers (zero padded), one inner array per row.
 *
 * A one-row block follows `rules.only`. With two or more rows, row 1 follows `rules.first`, row 2
 * `rules.second` and rows 3 and beyond take any number. Every row is a uniform random sample,
 * without replacement, of the numbers its rule allows that no earlier row took, so no number
 * appears twice in the block. Numbers made of one repeated digit (00..99 / 000..999) are left out
 * of every row unless `allowRepeat`.
 *
 * Layout: every row holds exactly `perRow` numbers, because the web draws a row per inner array.
 * If a rule row's pool is smaller than `perRow` the row keeps its whole pool and the missing slots
 * are topped up with unused numbers of any kind (after every rule row has taken its own pool
 * first, so a top-up never takes a number a later rule row needs). The smallest rule pool is 9
 * numbers ("starts with r1" with doubles off; 10 with them on) and the API only accepts
 * perRow 1..6, so this only happens for direct callers with perRow above 9 / 10. A block asked
 * for more numbers than exist (above 90 / 100 two-digit, 990 / 1000 three-digit) ends up short;
 * empty trailing rows are dropped.
 */
function genBlock(
  len: 2 | 3,
  rows: number,
  perRow: number,
  allowRepeat: boolean,
  rules: BlockRules,
): string[][] {
  const profile = PROFILE[len]
  const size = profile.length
  const per = Number.isFinite(perRow) ? Math.max(1, Math.trunc(perRow)) : 1
  const rowCount = Number.isFinite(rows) ? Math.min(Math.max(0, Math.trunc(rows)), Math.ceil(size / per)) : 0
  // 00 11 .. 99 are the multiples of 11, 000 111 .. 999 the multiples of 111.
  const repeated = (size - 1) / 9
  const used = new Uint8Array(size)
  /** Every number passing `mask` that no row has taken (nor a repeated-digit one unless allowed). */
  const pool = (mask: number): number[] => {
    const out: number[] = []
    for (let n = 0; n < size; n++) {
      if (used[n] === 0 && (profile[n] & mask) !== 0 && (allowRepeat || n % repeated !== 0)) out.push(n)
    }
    return out
  }

  const masks = rowCount === 1 ? [rules.only] : [rules.first, rules.second]
  const picked: number[][] = []
  for (let r = 0; r < rowCount; r++) {
    const row = r < masks.length ? sampleDistinct(pool(masks[r]), per) : []
    for (const n of row) used[n] = 1
    picked.push(row)
  }

  // Rows 3+ (and any rule row whose pool ran out) are filled from what no row has taken.
  let missing = 0
  for (const row of picked) missing += per - row.length
  if (missing > 0) {
    const extra = sampleDistinct(pool(ANY_DIGIT), missing)
    let at = 0
    for (const row of picked) {
      const room = per - row.length
      if (room > 0) {
        row.push(...extra.slice(at, at + room))
        at += room
      }
    }
  }
  return picked.filter((row) => row.length > 0).map((row) => row.map((n) => String(n).padStart(len, '0')))
}

/**
 * The 2 ตัว block: `rows` x `perRow` unique 2-digit numbers (rows 1 / 2 start with r1 / r2, or
 * with either when there is a single row; later rows are any number). See genBlock.
 */
export function genTwo(
  rows: number,
  perRow: number,
  running: [Digit, Digit],
  opts?: { isDouble?: boolean },
): string[][] {
  const [r1, r2] = running
  return genBlock(2, rows, perRow, opts?.isDouble ?? false, {
    only: (1 << r1) | (1 << r2),
    first: 1 << r1,
    second: 1 << r2,
  })
}

/**
 * The 3 ตัว block: `rows` x `perRow` unique 3-digit numbers (rows 1 / 2 contain r1 / r2 in any
 * position, or one of them when there is a single row; later rows are any number). See genBlock.
 */
export function genThree(
  rows: number,
  perRow: number,
  running: [Digit, Digit],
  opts?: { allowTriple?: boolean },
): string[][] {
  const [r1, r2] = running
  return genBlock(3, rows, perRow, opts?.allowTriple ?? false, {
    only: (1 << r1) | (1 << r2),
    first: 1 << r1,
    second: 1 << r2,
  })
}

/**
 * `count` tokens: prefix digit followed by a random *other* digit, all unique. Only 9 such
 * numbers exist, so the result is capped at 9 (a 6x6 drill block gets 9, not 36).
 */
export function genDrill(count: number, prefixDigit: number): string[] {
  const others = shuffle(DIGITS.filter((d) => d !== prefixDigit))
  return others.slice(0, Math.max(0, Math.min(count, others.length))).map((d) => `${prefixDigit}${d}`)
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
  drill?: { row: number; perRow?: number; prefixFrom?: DrillPrefixFrom }
  win?: { row: number; digitCount?: number; include?: WinInclude }
  fixed?: [number | undefined, number | undefined]
  single?: { digits?: number; fixed?: string | null; allowTriple?: boolean }
}

/** A fixed เลขเด่น counts only when it is all digits and exactly `digits` long. */
export function parseFixedSingle(v: unknown, digits: number): string | undefined {
  return typeof v === 'string' && v.length === digits && /^\d+$/.test(v) ? v : undefined
}

/**
 * One เลขเด่น of `digits` (1..3) digits (the caller handles a fixed value). 1 = one of the running
 * digits; 2 = r1 followed by r2 (always, so never a double and isDouble does not matter); 3 = one
 * number containing r1 or r2 in any position (the one-row 3 ตัว pool; triples only with allowTriple).
 */
export function genSingle(digits: number, running: [Digit, Digit], opts?: { allowTriple?: boolean }): string {
  if (digits === 1) return String(pick(running))
  if (digits === 3) return genThree(1, 1, running, { allowTriple: opts?.allowTriple })[0][0]
  return `${running[0]}${running[1]}`
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(v)))
}

export function generateCardNumbers(cfg: GenerateInput): CardNumbers {
  const running = pickRunning(cfg.fixed)

  const two = genTwo(cfg.two?.row ?? 0, cfg.two?.perRow ?? 1, running, { isDouble: cfg.two?.isDouble })
  const three = genThree(cfg.three?.row ?? 0, cfg.three?.perRow ?? 1, running, {
    allowTriple: cfg.three?.allowTriple,
  })

  const topCount = (cfg.top?.row ?? 0) * (cfg.top?.perRow ?? 0)
  const top: string[] = []
  for (let i = 0; i < topCount; i++) top.push(String(running[i % 2]))

  // Same shape rule as two/three: row rows of perRow tokens (returned flat; the card chunks
  // them by perRow). Capped at 9 by genDrill.
  const drillCount = (cfg.drill?.row ?? 0) * Math.max(1, cfg.drill?.perRow ?? 1)
  const prefixFrom = cfg.drill?.prefixFrom ?? 'running1'
  let prefixDigit: number = running[0]
  if (prefixFrom === 'running2') prefixDigit = running[1]
  if (prefixFrom === 'top' && top.length) prefixDigit = Number(top[0])
  if (prefixFrom === 'two' && two.length) prefixDigit = Number(two[0][0][0])
  const drill = drillCount > 0 ? genDrill(drillCount, prefixDigit) : []

  const winRows = cfg.win?.row ?? 0
  const include = cfg.win?.include ?? 'running'
  const mustInclude =
    include === 'none'
      ? []
      : include === 'top' && top.length
        ? top.map(Number)
        : [running[0], running[1]]
  const win = winRows > 0 ? genWin(winRows, cfg.win?.digitCount ?? 6, mustInclude) : []

  // Drawn last, with its own random calls, so every number above keeps exactly the distribution
  // it had before เลขเด่น existed.
  const singleDigits = clampInt(cfg.single?.digits, 1, 3, 2)
  const single =
    parseFixedSingle(cfg.single?.fixed, singleDigits) ??
    genSingle(singleDigits, running, { allowTriple: cfg.single?.allowTriple })

  return {
    running: [String(running[0]), String(running[1])],
    top,
    two,
    three,
    drill,
    win,
    single,
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
    drill: { row: rowOf('drill', 2), perRow: perOf('drill', 3), prefixFrom: s.drillPrefixFrom },
    win: { row: rowOf('win', 1), digitCount: clampInt(s.winDigitCount, 2, 7, 6), include: s.winInclude },
    fixed: [f1 ?? s1, f2 ?? s2],
    // s.runningDouble is display only (the card draws each running digit twice); it changes no number.
    single: { digits: s.singleDigits, fixed: s.fixedSingle, allowTriple: s.allowTriple === true },
  })
}
