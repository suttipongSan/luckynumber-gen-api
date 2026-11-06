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
}

export interface LotterySet {
  id: string
  name: string
  isDefault: boolean
  lotteryIds: string[]
}

export type AssetKind = 'background' | 'logo'

export interface Asset {
  id: string
  kind: AssetKind
  fileName: string
  contentType: string
  sizeBytes: number
  createdAt: string
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
  elements?: {
    lotteryName?: ElementStyle
    date?: ElementStyle
    running?: ElementStyle
    top?: ElementStyle
    two?: ElementStyle
    three?: ElementStyle
    drill?: ElementStyle
    win?: ElementStyle
    [key: string]: ElementStyle | undefined
  }
  backgroundAssetId?: string | null
  logo?: { assetId: string | null; x: number; y: number; width: number; opacity: number }
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
}

export interface News {
  id: string
  title: string
  detailHtml: string
  publishedAt: string
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
}

export interface Bindings {
  TURSO_DATABASE_URL: string
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
}

export interface Variables {
  member: MemberRow
  adminUser: string
}

export interface AppEnv {
  Bindings: Bindings
  Variables: Variables
}

export const RENDERS_PER_DAY = 600
export const MAX_ITEMS_PER_RENDER = 80
export const MAX_SETS = 30
export const MAX_ASSETS = 20
export const MAX_ASSET_BYTES = 5 * 1024 * 1024
export const ASSET_URL_TTL_SECONDS = 600
export const SESSION_TTL_SECONDS = 24 * 60 * 60
export const API_VERSION = '0.1.0'
