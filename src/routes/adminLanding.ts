// Back office API for the public landing page (GET /landing, see ./landing). Mounted by ./admin
// at /admin/landing AFTER `requireAdmin`, so every route here needs the admin session; the
// app-level CSRF guard covers the writes like it does for the rest of /admin. Shared logic
// (keys, defaults, R2 names, row -> JSON) is in ../lib/landing.
import { Hono, type Context } from 'hono'
import { and, eq, inArray, sql } from 'drizzle-orm'
import type { AdminLanding, AppEnv, AssetBucket } from '../types'
import {
  MAX_ASSET_BYTES,
  MAX_LANDING_ITEMS_PER_KIND,
  MAX_LANDING_ITEM_BODY_BYTES,
} from '../types'
import { getDb, type DB } from '../db/client'
import { landingItems, siteSettings } from '../db/schema'
import { changedRows, errors, parseJson, parseJsonLimited } from '../lib/http'
import { newId } from '../lib/ids'
import {
  LANDING_IMAGE_SLOTS,
  LANDING_TEXT_KEYS,
  deleteLandingImage,
  hasImageSignature,
  isSlugConflict,
  landingR2Key,
  listLandingItems,
  loadLanding,
  newArticleSlug,
  newLandingImageName,
  toAdminLandingItem,
  toAdminLandingSettings,
  type LandingItemRow,
  type LandingSettingKey,
  type LandingTextField,
} from '../lib/landing'
import { nowIso } from '../lib/time'
import {
  HOWTO_ARTICLE_FIELDS_MESSAGE,
  adminLandingSchema,
  landingItemSchema,
  landingOrderSchema,
  patchLandingItemSchema,
} from '../validation'
import { EXT_BY_TYPE } from './assets'
import { apiOrigin } from './render'

export const adminLandingRoutes = new Hono<AppEnv>()

/** Content types the landing page accepts (the member asset table minus gif / avif). */
const LANDING_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp']

/** The whole AdminLanding document, which most settings routes answer with. */
async function landingPayload(c: Context<AppEnv>, db: DB): Promise<AdminLanding> {
  const origin = apiOrigin(c.req.url)
  const { settings, items } = await loadLanding(db, { activeOnly: false })
  return {
    settings: toAdminLandingSettings(origin, settings),
    items: items.map((r) => toAdminLandingItem(origin, r)),
  }
}

async function findItem(db: DB, id: string): Promise<LandingItemRow> {
  const row = await db.query.landingItems.findFirst({ where: eq(landingItems.id, id) })
  if (!row) throw errors.notFound('ไม่พบรายการ')
  return row
}

// ---- image uploads

interface ImageUpload {
  bytes: Uint8Array
  contentType: string
  ext: string
}

/**
 * Reads and validates the multipart `file` field: png / jpeg / webp, 1 byte to MAX_ASSET_BYTES,
 * whose first bytes are the signature of the type it declares. Nothing is stored here; every
 * refusal happens before R2 is touched.
 */
async function readImageUpload(c: Context<AppEnv>): Promise<ImageUpload> {
  // Refuse obviously oversized uploads before buffering the multipart body (5 MB file + form overhead).
  const declared = Number(c.req.header('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES + 64 * 1024) {
    throw errors.validation('ไฟล์ต้องมีขนาดไม่เกิน 5 MB')
  }
  let form: Record<string, unknown>
  try {
    form = await c.req.parseBody()
  } catch {
    throw errors.validation('ต้องส่งแบบ multipart/form-data')
  }
  const file = form['file']
  if (!(file instanceof File)) throw errors.validation('ไม่พบไฟล์ (file)')
  const contentType = (file.type || '').toLowerCase()
  const ext = LANDING_IMAGE_TYPES.includes(contentType) ? EXT_BY_TYPE[contentType] : undefined
  if (!ext) throw errors.validation('รองรับเฉพาะไฟล์รูปภาพ (png, jpg, webp)')
  if (file.size === 0) throw errors.validation('ไฟล์ว่างเปล่า')
  if (file.size > MAX_ASSET_BYTES) throw errors.validation('ไฟล์ต้องมีขนาดไม่เกิน 5 MB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  // The declared type is client-controlled and the file ends up behind a public URL: only keep
  // bytes that really are that kind of image.
  if (!hasImageSignature(contentType, bytes)) {
    throw errors.validation('ไฟล์ไม่ใช่รูปภาพ png, jpg หรือ webp ที่ถูกต้อง')
  }
  return { bytes, contentType, ext }
}

/** Stores the upload under a fresh random name (public, immutable) and returns that name. */
async function storeImage(bucket: AssetBucket, image: ImageUpload): Promise<string> {
  const name = newLandingImageName(image.ext)
  await bucket.put(landingR2Key(name), image.bytes, {
    httpMetadata: { contentType: image.contentType },
  })
  return name
}

/**
 * Points a site_settings image key at `name` ('' = none) and returns the name it held before.
 * The read and the write are ONE batch (one transaction), so even when two requests race, the
 * returned name is exactly the value this call replaced and each replaced file gets deleted by
 * the request that replaced it. No object is orphaned.
 */
async function swapSettingImage(db: DB, key: LandingSettingKey, name: string): Promise<string> {
  const updatedAt = nowIso()
  const [before] = await db.batch([
    db.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, key)),
    db
      .insert(siteSettings)
      .values({ key, value: name, updatedAt })
      .onConflictDoUpdate({ target: [siteSettings.key], set: { value: name, updatedAt } }),
  ])
  return before[0]?.value ?? ''
}

/**
 * Same idea for an item: sets its image (null = none) and returns the updated row together with
 * the file name it replaced. Null when the item no longer exists.
 */
async function swapItemImage(
  db: DB,
  id: string,
  imageKey: string | null,
): Promise<{ row: LandingItemRow; previous: string | null } | null> {
  const [before, after] = await db.batch([
    db.select({ imageKey: landingItems.imageKey }).from(landingItems).where(eq(landingItems.id, id)),
    db
      .update(landingItems)
      .set({ imageKey, updatedAt: nowIso() })
      .where(eq(landingItems.id, id))
      .returning(),
  ])
  const row = after[0]
  return row ? { row, previous: before[0]?.imageKey ?? null } : null
}

function imageSlotKey(slot: string): LandingSettingKey {
  if (slot !== 'logo' && slot !== 'promo') throw errors.notFound('ไม่พบตำแหน่งรูปภาพ')
  return LANDING_IMAGE_SLOTS[slot]
}

// ---- single values and the two header images

adminLandingRoutes.get('/', async (c) => c.json(await landingPayload(c, getDb(c.env))))

adminLandingRoutes.put('/', async (c) => {
  const db = getDb(c.env)
  const body = await parseJson(c, adminLandingSchema)
  const updatedAt = nowIso()
  const rows = (Object.keys(LANDING_TEXT_KEYS) as LandingTextField[]).flatMap((field) => {
    const value = body[field]
    return value === undefined ? [] : [{ key: LANDING_TEXT_KEYS[field], value, updatedAt }]
  })
  // One multi-row upsert (at most 7 rows x 3 params, far under D1's 100-parameter cap): all of
  // the sent fields are saved or none.
  if (rows.length) {
    await db
      .insert(siteSettings)
      .values(rows)
      .onConflictDoUpdate({
        target: [siteSettings.key],
        set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
      })
  }
  return c.json(await landingPayload(c, db))
})

adminLandingRoutes.post('/image/:slot', async (c) => {
  const db = getDb(c.env)
  const key = imageSlotKey(c.req.param('slot'))
  const image = await readImageUpload(c)
  const name = await storeImage(c.env.ASSETS, image)
  let previous: string
  try {
    previous = await swapSettingImage(db, key, name)
  } catch (err) {
    // The database does not point at the new file: do not leave it behind.
    await deleteLandingImage(c.env.ASSETS, name)
    throw err
  }
  await deleteLandingImage(c.env.ASSETS, previous)
  return c.json(await landingPayload(c, db))
})

adminLandingRoutes.delete('/image/:slot', async (c) => {
  const db = getDb(c.env)
  const previous = await swapSettingImage(db, imageSlotKey(c.req.param('slot')), '')
  await deleteLandingImage(c.env.ASSETS, previous)
  return c.json(await landingPayload(c, db))
})

// ---- items (articles / how-to steps)

/** 409 for an article slug that another article already uses. */
const slugTaken = () =>
  errors.conflict('SLUG_TAKEN', 'ลิงก์ (slug) นี้ถูกใช้กับบทความอื่นแล้ว กรุณาใช้ลิงก์อื่น')

/** A generated slug is retried this many times in all before giving up (a clash is a 1 in 4 billion event). */
const MAX_SLUG_ATTEMPTS = 5

adminLandingRoutes.post('/items', async (c) => {
  const db = getDb(c.env)
  const body = await parseJsonLimited(c, landingItemSchema, MAX_LANDING_ITEM_BODY_BYTES)
  const id = newId()
  const now = nowIso()
  // The article fields exist for articles only (the schema refused them for a step). A slug the
  // admin typed is used as it is; none ('' / null / omitted) means "make one up". publishedAt:
  // omitted = now, null = no date.
  const isArticle = body.kind === 'article'
  const chosenSlug = isArticle && body.slug ? body.slug : null
  const contentHtml = isArticle ? (body.contentHtml ?? '') : ''
  const publishedAt = isArticle ? (body.publishedAt === undefined ? now : body.publishedAt) : null
  // The per-kind limit, the next position (appended at the end of its kind) and the insert are ONE
  // statement, atomic under SQLite's single writer: concurrent creates can neither get past 12
  // nor end up with the same sort_order. The unique index on slug is what keeps two articles
  // from ending up with the same address, also when two requests race for it: the loser's
  // INSERT fails and is mapped to 409 SLUG_TAKEN below (no check-then-insert gap to lose).
  let inserted = 0
  for (let attempt = 1; ; attempt++) {
    const slug = isArticle ? (chosenSlug ?? newArticleSlug()) : null
    try {
      inserted = changedRows(
        await db.run(sql`
          insert into landing_items (id, kind, title, body, image_key, sort_order, active, created_at, updated_at, slug, content_html, published_at)
          select ${id}, ${body.kind}, ${body.title}, ${body.body}, null,
                 (select coalesce(max(sort_order), -1) + 1 from landing_items where kind = ${body.kind}),
                 ${body.active === false ? 0 : 1}, ${now}, ${now}, ${slug}, ${contentHtml}, ${publishedAt}
          where (select count(*) from landing_items where kind = ${body.kind})
                < ${MAX_LANDING_ITEMS_PER_KIND}`),
      )
      break
    } catch (err) {
      if (!isSlugConflict(err)) throw err
      // The admin's own slug is taken: tell them. A generated one clashed: draw another.
      if (chosenSlug !== null || attempt >= MAX_SLUG_ATTEMPTS) throw slugTaken()
    }
  }
  if (inserted === 0) {
    throw errors.conflict(
      'QUOTA',
      `เพิ่มได้สูงสุด ${MAX_LANDING_ITEMS_PER_KIND} รายการต่อหมวด ลบรายการเดิมก่อนเพิ่มใหม่`,
    )
  }
  return c.json(toAdminLandingItem(apiOrigin(c.req.url), await findItem(db, id)))
})

// The new order of one kind. A fixed path (there is no PUT /items/:id for it to be mistaken for).
// The ids must be exactly the kind's current items; an item added or deleted by someone else
// between this check and the UPDATE just keeps its own position, it cannot corrupt the others.
adminLandingRoutes.put('/items/order', async (c) => {
  const db = getDb(c.env)
  const { kind, ids } = await parseJson(c, landingOrderSchema)
  const known = new Set((await listLandingItems(db, kind)).map((r) => r.id))
  if (new Set(ids).size !== ids.length) throw errors.validation('ลำดับมีรายการซ้ำ')
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
    throw errors.validation('ลำดับต้องมีครบทุกรายการของหมวดนี้ กรุณาโหลดข้อมูลใหม่แล้วลองอีกครั้ง')
  }
  if (ids.length) {
    // One UPDATE with a CASE: 3 params per id (when, then, IN) plus the kind and the timestamp,
    // so at most 38 of D1's 100 parameters.
    await db
      .update(landingItems)
      .set({
        sortOrder: sql`case ${landingItems.id} ${sql.join(
          ids.map((id, position) => sql`when ${id} then ${position}`),
          sql` `,
        )} end`,
        updatedAt: nowIso(),
      })
      .where(and(eq(landingItems.kind, kind), inArray(landingItems.id, ids)))
  }
  const origin = apiOrigin(c.req.url)
  return c.json((await listLandingItems(db, kind)).map((r) => toAdminLandingItem(origin, r)))
})

adminLandingRoutes.patch('/items/:id', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  const body = await parseJsonLimited(c, patchLandingItemSchema, MAX_LANDING_ITEM_BODY_BYTES)
  const patch: Partial<typeof landingItems.$inferInsert> = {}
  if (body.title !== undefined) patch.title = body.title
  if (body.body !== undefined) patch.body = body.body
  if (body.active !== undefined) patch.active = body.active
  if (body.slug !== undefined) patch.slug = body.slug
  if (body.contentHtml !== undefined) patch.contentHtml = body.contentHtml
  if (body.publishedAt !== undefined) patch.publishedAt = body.publishedAt
  // slug / contentHtml / publishedAt belong to articles: sending any of them (whatever the value)
  // for a how-to step is a 400. The kind of a row never changes, so this check cannot go stale.
  if (body.slug !== undefined || body.contentHtml !== undefined || body.publishedAt !== undefined) {
    if ((await findItem(db, id)).kind !== 'article') throw errors.validation(HOWTO_ARTICLE_FIELDS_MESSAGE)
  }
  const origin = apiOrigin(c.req.url)
  if (Object.keys(patch).length === 0) {
    return c.json(toAdminLandingItem(origin, await findItem(db, id)))
  }
  let updated: LandingItemRow[]
  try {
    updated = await db
      .update(landingItems)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(landingItems.id, id))
      .returning()
  } catch (err) {
    // The unique index on slug refused the new address (another article has it).
    if (isSlugConflict(err)) throw slugTaken()
    throw err
  }
  if (updated.length === 0) throw errors.notFound('ไม่พบรายการ')
  return c.json(toAdminLandingItem(origin, updated[0]))
})

adminLandingRoutes.delete('/items/:id', async (c) => {
  const db = getDb(c.env)
  const [row] = await db
    .delete(landingItems)
    .where(eq(landingItems.id, c.req.param('id')))
    .returning({ imageKey: landingItems.imageKey })
  if (!row) throw errors.notFound('ไม่พบรายการ')
  // D1 first, R2 after (best effort): see deleteLandingImage.
  await deleteLandingImage(c.env.ASSETS, row.imageKey)
  return c.body(null, 204)
})

adminLandingRoutes.post('/items/:id/image', async (c) => {
  const db = getDb(c.env)
  const id = c.req.param('id')
  await findItem(db, id) // 404 before the body is read or anything is stored
  const image = await readImageUpload(c)
  const name = await storeImage(c.env.ASSETS, image)
  let swapped: Awaited<ReturnType<typeof swapItemImage>>
  try {
    swapped = await swapItemImage(db, id, name)
  } catch (err) {
    await deleteLandingImage(c.env.ASSETS, name)
    throw err
  }
  if (!swapped) {
    // The item was deleted while the upload ran: drop the file we just stored.
    await deleteLandingImage(c.env.ASSETS, name)
    throw errors.notFound('ไม่พบรายการ')
  }
  await deleteLandingImage(c.env.ASSETS, swapped.previous)
  return c.json(toAdminLandingItem(apiOrigin(c.req.url), swapped.row))
})

adminLandingRoutes.delete('/items/:id/image', async (c) => {
  const db = getDb(c.env)
  const swapped = await swapItemImage(db, c.req.param('id'), null)
  if (!swapped) throw errors.notFound('ไม่พบรายการ')
  await deleteLandingImage(c.env.ASSETS, swapped.previous)
  return c.json(toAdminLandingItem(apiOrigin(c.req.url), swapped.row))
})
