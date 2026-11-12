import type { AnyD1Database } from 'drizzle-orm/d1'
// Shared API types. Mirrors API.md "Shared types" (and the web app's src/api/types.ts).

export type Group = 'hanoi' | 'lao' | 'stock' | 'thai' | 'other'
export const GROUPS = ['hanoi', 'lao', 'stock', 'thai', 'other'] as const satisfies readonly Group[]

export interface Lottery {
  id: string
  name: string
  shortName: string
  group: Group
  accent: string
  sortOrder: number
  active: boolean
  /** True when owned by the requesting member (F5). Admin responses always omit it / false. */
  custom: boolean
}

/** The member as seen by the member (`GET /me`). */
export interface Member {
  id: string
  displayName: string
  expiresAt: string
  expired: boolean
  disabled: boolean
  rendersToday: number
  rendersLimit: number
}

export interface AdminMember extends Member {
  linkToken: string
  link: string
  hasPassword: boolean
  lastLoginAt: string | null
  createdAt: string
  rendersTotal: number
  /** Per-member daily render override (null = use the admin-configured default). */
  renderLimit: number | null
}

export interface LotterySet {
  id: string
  name: string
  isDefault: boolean
  lotteryIds: string[]
  /** F4: parallel to lotteryIds (same length, same order), each 1..20. */
  rounds: number[]
}

export type AssetKind = 'background' | 'logo' | 'qr'

export interface Asset {
  id: string
  kind: AssetKind
  fileName: string
  contentType: string
  sizeBytes: number
  createdAt: string
  /**
   * Short-lived signed download URL. Present on `GET /assets` (so the web app can render
   * thumbnails without a `GET /assets/:id/url` round trip per asset); absent elsewhere.
   */
  url?: string
}

/**
 * CardSettings = the mockup's CardSettings (components/card/defaultCardSettings.ts) plus
 * backgroundAssetId / logo. The API treats it as opaque JSON validated by a passthrough zod
 * schema (see validation.ts); only the fields the generator reads are typed here.
 */
export interface ElementStyle {
  visible?: boolean
  row?: number
  perRow?: number
  fontSize?: number
  color?: string
  stroke?: string
  strokeWidth?: number
  x?: number
  y?: number
  /** Whether the element's box/pill outline is drawn (date/running/single). undefined = true. */
  frame?: boolean
  /**
   * Manual width / height of that frame (viewBox units; width 60..1160, height 20..400).
   * undefined = the automatic size.
   */
  frameW?: number
  frameH?: number
  [key: string]: unknown
}

export type DrillPrefixFrom = 'running1' | 'running2' | 'top' | 'two'
export type WinInclude = 'running' | 'top' | 'none'

export interface CardSettings {
  isDouble?: boolean
  allowTriple?: boolean
  winDigitCount?: number
  fixedRunning1?: number | null
  fixedRunning2?: number | null
  /** Where the drill (เลขเจาะ) prefix digit comes from. Default 'running1'. */
  drillPrefixFrom?: DrillPrefixFrom
  /** Which digits every win (เลขวิน) row must contain. Default 'running'. */
  winInclude?: WinInclude
  /** Digit count of the single highlighted number (เลขเด่น). Default 2. */
  singleDigits?: 1 | 2 | 3
  /** Locks เลขเด่น when it is exactly `singleDigits` digits; anything else = random. */
  fixedSingle?: string | null
  elements?: {
    lotteryName?: ElementStyle
    date?: ElementStyle
    running?: ElementStyle
    top?: ElementStyle
    two?: ElementStyle
    three?: ElementStyle
    drill?: ElementStyle
    win?: ElementStyle
    single?: ElementStyle
    [key: string]: ElementStyle | undefined
  }
  backgroundAssetId?: string | null
  logo?: { assetId: string | null; x: number; y: number; width: number; opacity: number }
  qr?: { assetId: string | null; x: number; y: number; width: number; opacity: number }
  [key: string]: unknown
}

export interface CardNumbers {
  running: [string, string]
  top: string[]
  /** One inner array per row. */
  two: string[][]
  /** One inner array per row. */
  three: string[][]
  drill: string[]
  win: string[]
  /** เลขเด่น: one 1..3 digit number (always present, even when the element is hidden). */
  single: string
}

export interface News {
  id: string
  title: string
  detailHtml: string
  publishedAt: string
}

/** Public GET /contacts response. A channel is `null` when its id or URL is blank. */
export interface ContactChannel {
  id: string
  url: string
}
export interface ContactsResponse {
  line: ContactChannel | null
  telegram: ContactChannel | null
}

/**
 * Admin GET/PUT /admin/settings. Empty strings for contact id/url mean "hide this channel"
 * (GET /contacts returns null for a channel whose id or URL is empty). `renderLimitDefault` is an
 * integer 1..100000.
 */
export interface AdminSettings {
  contactLineId: string
  contactLineUrl: string
  contactTelegramId: string
  contactTelegramUrl: string
  renderLimitDefault: number
}

export interface AdminNews extends News {
  active: boolean
}

export interface ApiErrorBody {
  error: { code: string; message: string }
}

/** Minimal subset of the R2Bucket binding the API uses (so tests can pass a fake). */
export interface AssetBucket {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream | string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>
  get(key: string): Promise<{
    body: ReadableStream
    size: number
    httpMetadata?: { contentType?: string }
  } | null>
  delete(keys: string | string[]): Promise<void>
  /** Optional so the Node tests' fake bucket can omit it; the R2 binding always has it. */
  list?(opts: { prefix: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string }[]
    truncated: boolean
    cursor?: string
  }>
}

export interface Bindings {
  /** Cloudflare D1 (production and `wrangler dev`). */
  DB?: AnyD1Database
  /** libSQL URL, used only when DB is absent (Node tests and scripts). */
  TURSO_DATABASE_URL?: string
  TURSO_AUTH_TOKEN?: string
  SESSION_SECRET: string
  ASSET_SIGNING_SECRET: string
  ADMIN_USERNAME: string
  ADMIN_PASSWORD_HASH: string
  WEB_URL: string
  COOKIE_SECURE?: string
  ASSETS: AssetBucket
}

export interface MemberRow {
  id: string
  displayName: string
  linkToken: string
  passwordHash: string | null
  expiresAt: string
  disabled: boolean
  lastLoginAt: string | null
  createdAt: string
  rendersTotal: number
  renderLimit: number | null
}

/**
 * The subset of member columns the auth middleware loads for every request and that handlers
 * may read via `c.get('member')`. Must NOT include passwordHash / linkToken / lastLoginAt /
 * createdAt / rendersTotal: handlers only need the id (plus expiry/disabled for toMember).
 * `renderLimit` is included so render.ts / me.ts / bootstrap.ts can compute the effective
 * daily cap without a second query (the auth JOIN already reads the members row).
 */
export interface SessionMember {
  id: string
  displayName: string
  expiresAt: string
  disabled: boolean
  renderLimit: number | null
}

export interface Variables {
  member: SessionMember
  adminUser: string
}

export interface AppEnv {
  Bindings: Bindings
  Variables: Variables
}

export const RENDERS_PER_DAY = 600
export const MAX_ITEMS_PER_RENDER = 80
export const MAX_SETS = 40
/** Max files per asset kind (background / logo / qr) per member. */
export const MAX_ASSETS_PER_KIND = 2
export const MAX_CUSTOM_LOTTERIES = 30
export const MIN_ROUND = 1
export const MAX_ROUND = 20
export const MAX_ASSET_BYTES = 5 * 1024 * 1024
/**
 * Verifier ceiling: the download handler refuses exp values further in the future than this
 * (plus 60 s slack). Signed URLs are bucketed to the next
 * `ASSET_URL_BUCKET_SECONDS` boundary after `now + ASSET_URL_MIN_TTL_SECONDS`, so this cap
 * is bucket + min-ttl (see src/lib/crypto.ts). Today: 1800 s bucket + 600 s min = 2400 s max.
 */
export const ASSET_URL_TTL_SECONDS = 2400
export const SESSION_TTL_SECONDS = 24 * 60 * 60
export const API_VERSION = '0.1.0'
