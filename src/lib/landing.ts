// The public landing page (what pnphoto.co shows to visitors without a member session) and the
// helpers behind its back office.
//
// - Single values (hero colour, headings, the names of the logo / promo image) are rows of
//   site_settings under the landing_* keys below. They are deliberately NOT part of
//   SITE_SETTING_KEYS (./siteSettings), so GET/PUT /admin/settings and the AdminSettings shape do not
//   change. Every key has a compiled-in default, so a database without any landing row (fresh, or
//   before an admin saved anything) still serves a complete page.
// - Blocks (articles and how-to steps) are rows of landing_items; migration 0006 seeds six. An
//   article is a full article since migration 0007: the card on the landing page (cover picture,
//   title, summary) links to the article's own page, GET /landing/articles/:slug, which carries the
//   formatted long text (`content_html`, always sanitized, see ./sanitizeHtml).
// - Images are R2 objects under `landing/<random id>.<ext>`. Unlike member assets (signed URLs) they
//   are PUBLIC: GET /landing/image/:name serves them to anyone, under a strict name pattern.
import { and, asc, eq, inArray } from 'drizzle-orm'
import type { DB } from '../db/client'
import { landingItems, siteSettings } from '../db/schema'
import type {
  AdminLandingItem,
  AdminLandingSettings,
  AssetBucket,
  LandingArticle,
  LandingArticleDetail,
  LandingKind,
  LandingResponse,
  LandingStep,
} from '../types'
import { LANDING_SLUG_MAX, LANDING_SLUG_MIN } from '../types'
import { newId } from './ids'

// ---- single values (site_settings)

export const LANDING_HERO_COLOR = 'landing_hero_color'
export const LANDING_HERO_TITLE = 'landing_hero_title'
export const LANDING_HERO_SUBTITLE = 'landing_hero_subtitle'
export const LANDING_ARTICLES_TITLE = 'landing_articles_title'
export const LANDING_ARTICLES_SUBTITLE = 'landing_articles_subtitle'
export const LANDING_HOWTO_TITLE = 'landing_howto_title'
export const LANDING_HOWTO_SUBTITLE = 'landing_howto_subtitle'
/** R2 file name of the logo (empty = none). Written only by the image endpoints. */
export const LANDING_LOGO_IMAGE = 'landing_logo_image'
/** R2 file name of the promo image (empty = none). Written only by the image endpoints. */
export const LANDING_PROMO_IMAGE = 'landing_promo_image'

/** Every landing key in site_settings (a separate list from SITE_SETTING_KEYS). */
export const LANDING_SETTING_KEYS = [
  LANDING_HERO_COLOR,
  LANDING_HERO_TITLE,
  LANDING_HERO_SUBTITLE,
  LANDING_ARTICLES_TITLE,
  LANDING_ARTICLES_SUBTITLE,
  LANDING_HOWTO_TITLE,
  LANDING_HOWTO_SUBTITLE,
  LANDING_LOGO_IMAGE,
  LANDING_PROMO_IMAGE,
] as const
export type LandingSettingKey = (typeof LANDING_SETTING_KEYS)[number]
export type LandingSettingsMap = Record<LandingSettingKey, string>

/** Body field of PUT /admin/landing -> its site_settings key. The images are not in here. */
export const LANDING_TEXT_KEYS = {
  heroColor: LANDING_HERO_COLOR,
  heroTitle: LANDING_HERO_TITLE,
  heroSubtitle: LANDING_HERO_SUBTITLE,
  articlesTitle: LANDING_ARTICLES_TITLE,
  articlesSubtitle: LANDING_ARTICLES_SUBTITLE,
  howtoTitle: LANDING_HOWTO_TITLE,
  howtoSubtitle: LANDING_HOWTO_SUBTITLE,
} as const satisfies Record<string, LandingSettingKey>
export type LandingTextField = keyof typeof LANDING_TEXT_KEYS

/** Path slot of POST/DELETE /admin/landing/image/:slot -> its site_settings key. */
export const LANDING_IMAGE_SLOTS = {
  logo: LANDING_LOGO_IMAGE,
  promo: LANDING_PROMO_IMAGE,
} as const satisfies Record<string, LandingSettingKey>
export type LandingImageSlot = keyof typeof LANDING_IMAGE_SLOTS

/** Hero colour: exactly #RRGGBB (it ends up in a CSS value on the page, so nothing looser). */
export const LANDING_COLOR_RE = /^#[0-9a-fA-F]{6}$/

// ---- article slugs

/**
 * An article slug: lower case letters and digits in groups separated by single hyphens. Linear to
 * match (the hyphen can only be read one way). The length limits are separate: LANDING_SLUG_MIN /
 * LANDING_SLUG_MAX, applied by {@link isLandingSlug}.
 */
export const LANDING_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isLandingSlug(value: string): boolean {
  return (
    value.length >= LANDING_SLUG_MIN && value.length <= LANDING_SLUG_MAX && LANDING_SLUG_RE.test(value)
  )
}

/** A fresh address for an article created without one: `a-` and 8 random lower case hex characters. */
export function newArticleSlug(): string {
  const bytes = new Uint8Array(4)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return `a-${hex}`
}

/**
 * True when `err` is the unique index on landing_items.slug rejecting a write (two articles with
 * the same slug, including two requests racing for it). Drivers differ in how they report it: D1
 * says `UNIQUE constraint failed: landing_items.slug: SQLITE_CONSTRAINT`, libSQL puts the same
 * text behind an error code, and drizzle wraps either one with the original as `cause`, so every
 * error in the chain is looked at.
 */
export function isSlugConflict(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; e !== null && e !== undefined && depth < 8; depth++) {
    const message = typeof e === 'string' ? e : (e as { message?: unknown }).message
    if (
      typeof message === 'string' &&
      message.includes('UNIQUE constraint failed') &&
      (message.includes('landing_items.slug') || message.includes('landing_items_slug_unique_idx'))
    ) {
      return true
    }
    e = typeof e === 'object' ? (e as { cause?: unknown }).cause : undefined
  }
  return false
}

/** Compiled-in defaults, used for every key that has no row. */
export const LANDING_DEFAULTS: Readonly<LandingSettingsMap> = {
  [LANDING_HERO_COLOR]: '#7c2d12',
  [LANDING_HERO_TITLE]: 'โปรแกรมทำใบใบ้หวย สวย ไว ในคลิกเดียว',
  [LANDING_HERO_SUBTITLE]: 'สุ่มเลข จัดหน้าตา ดาวน์โหลดพร้อมโพสต์ ครบทุกหวยทุกรอบ',
  [LANDING_ARTICLES_TITLE]: 'ทำไมต้อง PNPHOTO',
  [LANDING_ARTICLES_SUBTITLE]: '',
  [LANDING_HOWTO_TITLE]: 'วิธีใช้งาน',
  [LANDING_HOWTO_SUBTITLE]: 'เริ่มใช้ได้ใน 3 ขั้นตอน',
  [LANDING_LOGO_IMAGE]: '',
  [LANDING_PROMO_IMAGE]: '',
}

/**
 * Persisted rows laid over {@link LANDING_DEFAULTS}. Unknown keys are ignored. A stored empty
 * string is kept as empty (an admin may blank a heading), only a MISSING row falls back to the
 * default. A stored colour that is not #RRGGBB (only possible through a manual database edit) is
 * ignored so the page never receives anything but a plain hex colour.
 */
export function overlayLandingSettings(rows: { key: string; value: string }[]): LandingSettingsMap {
  const out: LandingSettingsMap = { ...LANDING_DEFAULTS }
  for (const r of rows) {
    if (!(LANDING_SETTING_KEYS as readonly string[]).includes(r.key)) continue
    if (r.key === LANDING_HERO_COLOR && !LANDING_COLOR_RE.test(r.value)) continue
    out[r.key as LandingSettingKey] = r.value
  }
  return out
}

// ---- images (R2)

/** Every landing image lives under this key prefix of the ASSETS bucket. */
export const LANDING_R2_PREFIX = 'landing/'

/**
 * The only file names GET /landing/image/:name will look up: a random id of 8..64 URL-safe
 * characters plus a png / jpg / jpeg / webp extension. No dot, slash or percent can appear in the
 * id part, so a name can never leave the `landing/` prefix.
 */
export const LANDING_IMAGE_NAME_RE = /^[A-Za-z0-9_-]{8,64}\.(png|jpg|jpeg|webp)$/

export function isLandingImageName(name: string): boolean {
  return LANDING_IMAGE_NAME_RE.test(name)
}

/** R2 key of a landing image file name. Callers must have checked {@link isLandingImageName}. */
export function landingR2Key(name: string): string {
  return `${LANDING_R2_PREFIX}${name}`
}

/** Content type served for each extension of {@link LANDING_IMAGE_NAME_RE}. */
export const LANDING_CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

/** A fresh random file name for an upload of the given extension (`png` / `jpg` / `webp`). */
export function newLandingImageName(ext: string): string {
  return `${newId()}.${ext}`
}

/** True when `bytes` hold `expected` starting at `offset` (and are long enough to). */
function hasBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return bytes.length >= offset + expected.length && expected.every((b, i) => bytes[offset + i] === b)
}

/**
 * True when `bytes` start with the file signature of `contentType` (png, jpeg or webp; any other
 * type never matches). The content type of an upload is whatever the client declared, so the
 * upload routes check the bytes as well: arbitrary data (HTML, text, a script) labelled image/png
 * must not end up behind a public image URL.
 */
export function hasImageSignature(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case 'image/png': // 89 50 4E 47 0D 0A 1A 0A
      return hasBytesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/jpeg': // FF D8 FF
      return hasBytesAt(bytes, 0, [0xff, 0xd8, 0xff])
    case 'image/webp': // "RIFF", a 4 byte size, then "WEBP"
      return (
        hasBytesAt(bytes, 0, [0x52, 0x49, 0x46, 0x46]) &&
        hasBytesAt(bytes, 8, [0x57, 0x45, 0x42, 0x50])
      )
    default:
      return false
  }
}

/**
 * Absolute public URL of a stored image: `<origin of the API request>/landing/image/<name>`.
 * Null when there is no image, or when the stored name is not a valid landing image name.
 */
export function landingImageUrl(origin: string, name: string | null | undefined): string | null {
  return name && isLandingImageName(name) ? `${origin}/landing/image/${name}` : null
}

/**
 * Removes a stored image, best effort: the database already points elsewhere, so a failure is
 * logged rather than turned into an error. Names that are not landing image names are ignored,
 * which keeps this from ever touching an object outside `landing/`.
 */
export async function deleteLandingImage(
  bucket: AssetBucket,
  name: string | null | undefined,
): Promise<void> {
  if (!name || !isLandingImageName(name)) return
  try {
    await bucket.delete(landingR2Key(name))
  } catch (err) {
    console.error('landing: R2 delete failed', name, err)
  }
}

// ---- loading

export type LandingItemRow = typeof landingItems.$inferSelect

/** Order of every item list: by kind, then position (created_at and id only break ties). */
const itemOrder = () => [
  asc(landingItems.kind),
  asc(landingItems.sortOrder),
  asc(landingItems.createdAt),
  asc(landingItems.id),
]

/**
 * Settings (laid over the defaults) and items in ONE D1 round trip. `activeOnly` is what the
 * public page uses; the back office wants every item.
 */
export async function loadLanding(
  db: DB,
  opts: { activeOnly: boolean },
): Promise<{ settings: LandingSettingsMap; items: LandingItemRow[] }> {
  const [settingRows, items] = await db.batch([
    db
      .select()
      .from(siteSettings)
      .where(inArray(siteSettings.key, [...LANDING_SETTING_KEYS])),
    db
      .select()
      .from(landingItems)
      .where(opts.activeOnly ? eq(landingItems.active, true) : undefined)
      .orderBy(...itemOrder()),
  ])
  return { settings: overlayLandingSettings(settingRows), items }
}

/** Every item of one kind (active or not), in display order. */
export function listLandingItems(db: DB, kind: LandingKind): Promise<LandingItemRow[]> {
  return db
    .select()
    .from(landingItems)
    .where(eq(landingItems.kind, kind))
    .orderBy(...itemOrder())
}

/** The ACTIVE article with this slug, or undefined (inactive, a step, or no such slug). */
export function findActiveArticleBySlug(db: DB, slug: string): Promise<LandingItemRow | undefined> {
  return db.query.landingItems.findFirst({
    where: and(
      eq(landingItems.kind, 'article'),
      eq(landingItems.slug, slug),
      eq(landingItems.active, true),
    ),
  })
}

// ---- API shapes

export function toAdminLandingSettings(
  origin: string,
  map: LandingSettingsMap,
): AdminLandingSettings {
  return {
    heroColor: map[LANDING_HERO_COLOR],
    heroTitle: map[LANDING_HERO_TITLE],
    heroSubtitle: map[LANDING_HERO_SUBTITLE],
    articlesTitle: map[LANDING_ARTICLES_TITLE],
    articlesSubtitle: map[LANDING_ARTICLES_SUBTITLE],
    howtoTitle: map[LANDING_HOWTO_TITLE],
    howtoSubtitle: map[LANDING_HOWTO_SUBTITLE],
    logoUrl: landingImageUrl(origin, map[LANDING_LOGO_IMAGE]),
    promoUrl: landingImageUrl(origin, map[LANDING_PROMO_IMAGE]),
  }
}

export function toAdminLandingItem(origin: string, r: LandingItemRow): AdminLandingItem {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    imageUrl: landingImageUrl(origin, r.imageKey),
    sortOrder: r.sortOrder,
    active: r.active,
    slug: r.slug,
    contentHtml: r.contentHtml,
    publishedAt: r.publishedAt,
  }
}

/**
 * The public GET /landing body. Inactive items are skipped HERE as well (not only by the query),
 * so no caller can leak one by passing the full list. Articles and steps carry their picture
 * (cover / step image); the long text of an article is NOT in this list (GET /landing/articles/:slug).
 */
export function toLandingResponse(
  origin: string,
  map: LandingSettingsMap,
  items: LandingItemRow[],
): LandingResponse {
  const articles: LandingArticle[] = []
  const steps: LandingStep[] = []
  for (const r of items) {
    if (!r.active) continue
    if (r.kind === 'article') {
      articles.push({
        id: r.id,
        title: r.title,
        body: r.body,
        slug: r.slug,
        imageUrl: landingImageUrl(origin, r.imageKey),
        publishedAt: r.publishedAt,
      })
    } else {
      steps.push({
        id: r.id,
        title: r.title,
        body: r.body,
        imageUrl: landingImageUrl(origin, r.imageKey),
      })
    }
  }
  return { ...toAdminLandingSettings(origin, map), articles, steps }
}

/**
 * The public GET /landing/articles/:slug body. `contentHtml` is served as stored: every write path
 * sanitizes it (see ../validation), so it is the sanitized HTML of the article.
 */
export function toLandingArticleDetail(
  origin: string,
  r: LandingItemRow & { slug: string },
): LandingArticleDetail {
  return {
    id: r.id,
    slug: r.slug,
    title: r.title,
    body: r.body,
    contentHtml: r.contentHtml,
    imageUrl: landingImageUrl(origin, r.imageKey),
    publishedAt: r.publishedAt,
  }
}
