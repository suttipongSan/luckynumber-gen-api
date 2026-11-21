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

/**
 * A catalog lottery as the back office sees it (`GET /admin/lotteries`): the member shape plus the
 * default daily reminder. `notifyTime` is "HH:MM" in Asia/Bangkok; `notifyEnabled` is never true
 * while `notifyTime` is null.
 */
export interface AdminLottery extends Lottery {
  notifyTime: string | null
  notifyEnabled: boolean
}

/**
 * One line of `GET/PUT /notifications`: a lottery the member can see (active catalog lottery or
 * their own) with the reminder that applies to them. `saved` = the member has their own row
 * (their values win); otherwise the values are the admin default (catalog) or off (private).
 */
export interface NotificationItem {
  lotteryId: string
  name: string
  groupKey: Group
  /** True for the member's private lotteries. */
  own: boolean
  /** "HH:MM" in Asia/Bangkok. */
  notifyTime: string | null
  enabled: boolean
  saved: boolean
}

/** `GET /push/key`. */
export interface PushKeyResponse {
  publicKey: string
}

/** The JSON that is encrypted into every Web Push message; the service worker shows it. */
export interface PushPayload {
  title: string
  body: string
  lotteryIds: string[]
  /** Absolute web URL that opens the first lottery (`<web origin>/?lottery=<id>`). */
  url: string
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
  /**
   * Display only: the card draws each running digit twice ("8 - 1" becomes "88 - 11"). Stored with
   * the settings; the generator ignores it, so the running digits and every number are unchanged.
   * Default false / absent.
   */
  runningDouble?: boolean
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
  /** One inner array per row, each holding exactly `perRow` numbers (row rules: lib/numbers.ts). */
  two: string[][]
  /** One inner array per row, each holding exactly `perRow` numbers (row rules: lib/numbers.ts). */
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
 * integer 1..100000. `testsiteEnabled` is the on/off switch of the test stack (default true);
 * PUT accepts it as an optional boolean and leaves the stored value alone when it is omitted.
 */
export interface AdminSettings {
  contactLineId: string
  contactLineUrl: string
  contactTelegramId: string
  contactTelegramUrl: string
  renderLimitDefault: number
  testsiteEnabled: boolean
}

export interface AdminNews extends News {
  active: boolean
}

/**
 * A block of the public landing page: an 'article' is a full article (a card on the landing page
 * that links to the article's own page), a 'howto' is a numbered step. Titles and bodies are PLAIN
 * TEXT, never HTML; clients must render them as text. Only `contentHtml` of an article is HTML, and
 * the API stores and returns it sanitized (src/lib/sanitizeHtml.ts).
 */
export type LandingKind = 'article' | 'howto'
export const LANDING_KINDS = ['article', 'howto'] as const satisfies readonly LandingKind[]

/**
 * An article card in `GET /landing`: title = headline, body = the short summary, imageUrl = the
 * cover picture, slug = the address of its page (`GET /landing/articles/:slug`). The long text is
 * NOT in this list. `slug` / `publishedAt` are null only for a row that was edited by hand.
 */
export interface LandingArticle {
  id: string
  title: string
  body: string
  slug: string | null
  imageUrl: string | null
  /** ISO-8601 UTC timestamp, or null when the article has no date. */
  publishedAt: string | null
}

/** A numbered how-to step in `GET /landing`. */
export interface LandingStep {
  id: string
  title: string
  body: string
  imageUrl: string | null
}

/**
 * Public `GET /landing/articles/:slug` (no auth, `Cache-Control: public, max-age=60`): one ACTIVE
 * article with its long text. `contentHtml` is sanitized HTML (allowlist in sanitizeHtml.ts); when
 * it is empty the page shows `body` as plain text instead.
 */
export interface LandingArticleDetail {
  id: string
  slug: string
  title: string
  body: string
  contentHtml: string
  imageUrl: string | null
  publishedAt: string | null
}

/**
 * Public GET /landing (no auth, `Cache-Control: public, max-age=60`). Lists active items only,
 * ordered by sort_order. `logoUrl` / `promoUrl` / `imageUrl` are absolute URLs of
 * GET /landing/image/:name on this API, or null when no image is set.
 */
export interface LandingResponse {
  heroColor: string
  heroTitle: string
  heroSubtitle: string
  logoUrl: string | null
  promoUrl: string | null
  articlesTitle: string
  articlesSubtitle: string
  howtoTitle: string
  howtoSubtitle: string
  articles: LandingArticle[]
  steps: LandingStep[]
}

/** The editable single values of the landing page (back office GET/PUT /admin/landing). */
export interface AdminLandingSettings {
  heroColor: string
  heroTitle: string
  heroSubtitle: string
  articlesTitle: string
  articlesSubtitle: string
  howtoTitle: string
  howtoSubtitle: string
  logoUrl: string | null
  promoUrl: string | null
}

/**
 * One landing block as the back office sees it (active or not, with its sort position). For a
 * 'howto' step `slug` and `publishedAt` are null and `contentHtml` is ''.
 */
export interface AdminLandingItem {
  id: string
  kind: LandingKind
  title: string
  body: string
  imageUrl: string | null
  sortOrder: number
  active: boolean
  /** Address of the article page; null for a step. */
  slug: string | null
  /** Sanitized HTML of the long text of an article ('' = none). */
  contentHtml: string
  /** ISO-8601 UTC timestamp shown on the article, or null. */
  publishedAt: string | null
}

/** `GET /admin/landing`: `items` are ALL items ordered by kind, then sortOrder. */
export interface AdminLanding {
  settings: AdminLandingSettings
  items: AdminLandingItem[]
}

/**
 * The numbers of one draw of a lottery. `top3` is 3 ตัวบน (exactly 3 digits), `top2` 2 ตัวบน and
 * `bottom2` 2 ตัวล่าง (exactly 2 digits), each `null` while that number is not known; at least one
 * is set. The numbers are strings, so leading zeros survive ("05"). This is the OFFICIAL result of
 * a catalog lottery (what the back office and the results robot write, through the results API,
 * numbergen-results-api); members read it inside a {@link MemberLotteryResult}.
 */
export interface LotteryResult {
  lotteryId: string
  /** Thai calendar day of the draw, YYYY-MM-DD. */
  date: string
  /** "HH:MM" (Asia/Bangkok), or "" for a lottery that draws once a day. */
  time: string
  top3: string | null
  top2: string | null
  bottom2: string | null
}

/**
 * The official draw a member's own result hides (see {@link MemberLotteryResult.official}): its
 * draw time and numbers.
 */
export type OfficialResultNumbers = Pick<LotteryResult, 'time' | 'top3' | 'top2' | 'bottom2'>

/**
 * One result as a member sees it (`GET /results`, and the answers of `PUT` / `DELETE /results/mine`).
 * `mine` says whose numbers these are: `true` = the member typed them (a personal result), `false` =
 * the official result. A personal result hides every official result of the same lottery and date
 * from that member, so `official` tells what is behind it: the latest official draw (largest
 * `time`) of that lottery and date, or `null` when there is none. `official` is always `null` on an
 * official row.
 */
export interface MemberLotteryResult extends LotteryResult {
  mine: boolean
  official: OfficialResultNumbers | null
}

/**
 * Answer of `PUT /results/mine` and `DELETE /results/mine`: the rows `GET /results?date=` lists for
 * this one lottery and date after the change, i.e. what the card should show now (empty = no
 * result). After a delete these are the official rows the personal result was hiding, if any.
 */
export interface MemberLotteryResultsOfDay {
  date: string
  lotteryId: string
  results: MemberLotteryResult[]
}

/**
 * The numbers a member last drew for one card (`GET /draws`). `scope` is 'single' (the
 * single-card page) or the id of a set (the multiple page). `numbers` is exactly what
 * POST /render/numbers returned for that lottery.
 */
export interface MemberDraw {
  scope: string
  lotteryId: string
  numbers: CardNumbers
  updatedAt: string
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
  /**
   * 'true' only on the test Worker (numbergen-api-test). There, a `testsite_enabled` = "false"
   * setting makes every request answer 503 TESTSITE_OFF (src/middleware/testStack.ts). Unset on
   * the live Worker, where the middleware does nothing.
   */
  TEST_STACK?: string
  ASSETS: AssetBucket
  /**
   * Web Push (VAPID) keys, base64url: the 65 byte public point and the 32 byte private scalar
   * (`npm run vapid:generate`). Without both, GET /push/key answers 503 and the cron does nothing.
   */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  /** `mailto:` or `https:` contact for the VAPID `sub` claim. Default https://pnphoto.co. */
  VAPID_SUBJECT?: string
  /**
   * The secret shared with the results API (numbergen-results-api) that signs the 10 minute admin tokens of
   * GET /admin/results-token (src/lib/adminToken.ts), at least 32 characters. Unset or too short = that endpoint
   * answers 503 RESULTS_TOKEN_NOT_CONFIGURED. The test Worker needs its own copy (secrets are per Worker).
   */
  RESULTS_ADMIN_SECRET?: string
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
/** Landing page blocks per kind ('article' / 'howto'); the 13th is a 409 QUOTA. */
export const MAX_LANDING_ITEMS_PER_KIND = 12
/** Article slug length (characters), see LANDING_SLUG_RE in src/lib/landing.ts. */
export const LANDING_SLUG_MIN = 3
export const LANDING_SLUG_MAX = 80
/** Longest `contentHtml` the API reads from a request (characters, before sanitizing). */
export const MAX_LANDING_CONTENT_INPUT = 60_000
/** Longest `contentHtml` the API stores (characters, after sanitizing). */
export const MAX_LANDING_CONTENT_HTML = 20_000
/** Largest JSON body accepted by POST / PATCH /admin/landing/items (bytes). */
export const MAX_LANDING_ITEM_BODY_BYTES = 512 * 1024
/** Push devices (browsers) per member; registering another drops the oldest. */
export const MAX_PUSH_DEVICES = 10
/** Lines accepted by one PUT /notifications or PUT /admin/notifications. */
export const MAX_NOTIFICATION_ITEMS = 500
/** The `scope` of the numbers drawn on the single-card page (the multiple page uses the set id). */
export const DRAW_SCOPE_SINGLE = 'single'
/** Saved draws (member_draws) older than this many days are deleted by the daily cron. */
export const DRAW_RETENTION_DAYS = 14
/** `scope` values one GET /draws may name (a member has at most MAX_SETS sets plus 'single'). */
export const MAX_DRAW_SCOPES = 50
/** Largest JSON body accepted by PUT /results/mine (bytes; a real one is under 150). */
export const MAX_MY_RESULT_BODY_BYTES = 1024
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
