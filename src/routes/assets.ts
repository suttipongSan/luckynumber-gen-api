// Per-member asset library (backgrounds / logos / QR) stored in R2, served only via signed
// URLs. The signature embeds the member id and extension so the download path needs no D1
// lookup; the URL is bucketed to a 30-min boundary so the browser cache reuses the response.
import { Hono } from 'hono'
import { and, asc, eq, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { AppEnv, Asset, AssetKind } from '../types'
import { ASSET_URL_TTL_SECONDS, MAX_ASSETS_PER_KIND, MAX_ASSET_BYTES } from '../types'
import { getDb, type DB } from '../db/client'
import { assets, cardSettings } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { changedRows, errors } from '../lib/http'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'

const KIND_LABEL_TH: Record<AssetKind, string> = { background: 'พื้นหลัง', logo: 'โลโก้', qr: 'QR code' }
import { signedAssetUrl, verifyAssetSignature } from '../lib/crypto'
import { apiOrigin } from './render'

type BatchSqlite = BatchItem<'sqlite'>

export const assetRoutes = new Hono<AppEnv>()

/** Raster image types accepted for upload (SVG is refused: it could carry script). */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
}

type AssetRow = typeof assets.$inferSelect

export function toAsset(r: AssetRow): Asset {
  return {
    id: r.id,
    kind: r.kind,
    fileName: r.fileName,
    contentType: r.contentType,
    sizeBytes: r.sizeBytes,
    createdAt: r.createdAt,
  }
}

export function r2KeyFor(memberId: string, assetId: string, ext: string): string {
  return `members/${memberId}/assets/${assetId}.${ext}`
}

/**
 * The extension suffix of a stored r2 key. The signer embeds this in the signed URL so the
 * download handler can rebuild the key without a D1 read. Upload validates the content type
 * before building the key, so this is always one of {@link EXT_BY_TYPE}'s values.
 */
export function extFromR2Key(r2Key: string): string {
  const dot = r2Key.lastIndexOf('.')
  return dot < 0 ? '' : r2Key.slice(dot + 1)
}

async function ownedAsset(db: DB, memberId: string, id: string): Promise<AssetRow> {
  const row = await db.query.assets.findFirst({
    where: and(eq(assets.id, id), eq(assets.memberId, memberId)),
  })
  if (!row) throw errors.notFound('ไม่พบไฟล์')
  return row
}

// Signed file download — no cookie needed. Registered before the member-only routes.
assetRoutes.get('/assets/:id', async (c, next) => {
  const id = c.req.param('id')
  const exp = c.req.query('exp')
  const sig = c.req.query('sig')
  const memberId = c.req.query('m')
  const ext = c.req.query('e')
  // Fall through to the authenticated route when nothing identifying a signed request is
  // present (keeps the previous "unsigned → 403" shape for anyone hitting the raw path).
  if (exp === undefined && sig === undefined) return next()
  const check = await verifyAssetSignature(
    c.env.ASSET_SIGNING_SECRET,
    id,
    exp,
    memberId,
    ext,
    sig,
    ASSET_URL_TTL_SECONDS,
  )
  if (check === 'expired') throw errors.forbidden('ลิงก์รูปหมดอายุ')
  if (check !== 'ok') throw errors.forbidden('ลิงก์รูปไม่ถูกต้อง')
  // memberId and ext are HMAC-authenticated at this point, so rebuilding the R2 key from them
  // is safe (and avoids the D1 row read).
  const r2Key = r2KeyFor(memberId as string, id, ext as string)
  const obj = await c.env.ASSETS.get(r2Key)
  if (!obj) throw errors.notFound('ไม่พบไฟล์')
  const now = Math.floor(Date.now() / 1000)
  const maxAge = Math.max(0, Number(exp) - now)
  const contentType = obj.httpMetadata?.contentType || 'application/octet-stream'
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      // Asset bytes are immutable per id, and `exp` is bucketed so the same URL points at the
      // same bytes until it expires: the browser may reuse the cached response without
      // revalidating.
      'Cache-Control': `private, max-age=${maxAge}, immutable`,
      'X-Content-Type-Options': 'nosniff',
      // Defence in depth: the bytes are only ever used as an <img>, never as a document.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
      'Content-Length': String(obj.size),
    },
  })
})

/**
 * Builds the GET /assets response from preloaded rows (used by GET /assets and by /bootstrap
 * so bootstrap does not need a second query). Signs every row with the same bucketed exp
 * logic as a direct GET /assets call. At most MAX_ASSETS_PER_KIND × 3 kinds = 6 HMACs with a
 * cached CryptoKey.
 */
export async function buildAssetsResponse(
  origin: string,
  secret: string,
  memberId: string,
  rows: AssetRow[],
): Promise<Asset[]> {
  const out: Asset[] = []
  for (const r of rows) {
    const ext = extFromR2Key(r.r2Key)
    const base = toAsset(r)
    if (!ext) {
      out.push(base)
      continue
    }
    const url = await signedAssetUrl(origin, secret, r.id, memberId, ext)
    out.push({ ...base, url })
  }
  return out
}

assetRoutes.get('/assets', requireMember(), async (c) => {
  const member = c.get('member')
  const rows = await getDb(c.env)
    .select()
    .from(assets)
    .where(eq(assets.memberId, member.id))
    .orderBy(asc(assets.createdAt))
  const out = await buildAssetsResponse(
    apiOrigin(c.req.url),
    c.env.ASSET_SIGNING_SECRET,
    member.id,
    rows,
  )
  return c.json(out)
})

assetRoutes.post('/assets', requireMember(), async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
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
  const kind = form['kind']
  if (kind !== 'background' && kind !== 'logo' && kind !== 'qr') {
    throw errors.validation("kind ต้องเป็น 'background', 'logo' หรือ 'qr'")
  }
  if (!(file instanceof File)) throw errors.validation('ไม่พบไฟล์ (file)')
  const contentType = (file.type || '').toLowerCase()
  const ext = EXT_BY_TYPE[contentType]
  if (!ext) throw errors.validation('รองรับเฉพาะไฟล์รูปภาพ (png, jpg, webp, gif, avif)')
  if (file.size === 0) throw errors.validation('ไฟล์ว่างเปล่า')
  if (file.size > MAX_ASSET_BYTES) throw errors.validation('ไฟล์ต้องมีขนาดไม่เกิน 5 MB')

  const quotaError = () =>
    errors.conflict('QUOTA', `${KIND_LABEL_TH[kind]} เก็บได้สูงสุด ${MAX_ASSETS_PER_KIND} ไฟล์ ลบไฟล์เดิมก่อนอัปโหลดใหม่`)
  // Cheap pre-check so the common over-quota case fails before uploading to R2. It is not
  // authoritative (concurrent uploads can all pass it); the conditional INSERT below is.
  // count(*) rather than selecting ids: one scalar instead of up to MAX_ASSETS_PER_KIND rows.
  const [countRow] = await db
    .select({ c: sql<number>`count(*)` })
    .from(assets)
    .where(and(eq(assets.memberId, memberId), eq(assets.kind, kind)))
  const count = Number(countRow?.c ?? 0)
  if (count >= MAX_ASSETS_PER_KIND) throw quotaError()

  const id = newId()
  const r2Key = r2KeyFor(memberId, id, ext)
  const bytes = new Uint8Array(await file.arrayBuffer())
  await c.env.ASSETS.put(r2Key, bytes, { httpMetadata: { contentType } })
  const row: AssetRow = {
    id,
    memberId,
    kind: kind as AssetKind,
    fileName: (file.name || `${id}.${ext}`).slice(0, 200),
    contentType,
    sizeBytes: bytes.byteLength,
    r2Key,
    createdAt: nowIso(),
  }
  // Conditional INSERT: the count and the insert are one statement, so SQLite's single writer
  // makes it atomic and concurrent uploads cannot push the member past the per-kind quota.
  let inserted: number
  try {
    inserted = changedRows(
      await db.run(sql`
        insert into assets (id, member_id, kind, file_name, content_type, size_bytes, r2_key, created_at)
        select ${row.id}, ${row.memberId}, ${row.kind}, ${row.fileName}, ${row.contentType},
               ${row.sizeBytes}, ${row.r2Key}, ${row.createdAt}
        where (select count(*) from assets where member_id = ${memberId} and kind = ${kind})
              < ${MAX_ASSETS_PER_KIND}
          and exists (select 1 from members where id = ${memberId})`),
    )
  } catch (e) {
    await c.env.ASSETS.delete(r2Key)
    throw e
  }
  if (inserted === 0) {
    // Lost the quota race to a concurrent upload, or an admin deleted the member while this
    // upload ran (their R2 prefix sweep may already be done): drop the object we just stored.
    await c.env.ASSETS.delete(r2Key)
    throw quotaError()
  }
  return c.json(toAsset(row))
})

assetRoutes.delete('/assets/:id', requireMember(), async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const assetId = c.req.param('id')
  const updatedAt = nowIso()

  // Ownership + r2Key in one PK read; also serves as the 404 shortcut.
  const row = await ownedAsset(db, memberId, assetId)

  // R2 delete first: if it throws, the D1 row is untouched so the member can retry. Doing
  // the D1 batch first would risk a successful D1 commit followed by an R2 failure, which
  // orphans the R2 object for up to the signed-URL TTL (the download handler no longer
  // reads D1) and leaves no table row from which the admin member-delete can find the key.
  await c.env.ASSETS.delete(row.r2Key)

  // One D1 batch (4 statements) clears every reference set-based in SQL and removes the
  // assets row atomically once the R2 object is gone.
  //
  // The WHERE predicate uses a CASE so a row with malformed JSON is skipped rather than
  // raising from `json_extract` (SQLite does not guarantee AND short-circuits left-to-right).
  // `json_set(..., json('null'))` writes JSON null, matching what the old JS code wrote.
  const clearRef = (path: string): BatchSqlite =>
    db
      .update(cardSettings)
      .set({
        settingsJson: sql`json_set(${cardSettings.settingsJson}, ${path}, json('null'))`,
        updatedAt,
      })
      .where(
        and(
          eq(cardSettings.memberId, memberId),
          sql`(CASE WHEN json_valid(${cardSettings.settingsJson}) THEN json_extract(${cardSettings.settingsJson}, ${path}) END) = ${assetId}`,
        ),
      ) as unknown as BatchSqlite

  const deleteStmt = db
    .delete(assets)
    .where(and(eq(assets.id, assetId), eq(assets.memberId, memberId))) as unknown as BatchSqlite

  await db.batch([
    deleteStmt,
    clearRef('$.backgroundAssetId'),
    clearRef('$.logo.assetId'),
    clearRef('$.qr.assetId'),
  ] as [BatchSqlite, BatchSqlite, BatchSqlite, BatchSqlite])

  return c.body(null, 204)
})

assetRoutes.get('/assets/:id/url', requireMember(), async (c) => {
  const db = getDb(c.env)
  const member = c.get('member')
  const row = await ownedAsset(db, member.id, c.req.param('id'))
  const ext = extFromR2Key(row.r2Key)
  const url = await signedAssetUrl(
    apiOrigin(c.req.url),
    c.env.ASSET_SIGNING_SECRET,
    row.id,
    member.id,
    ext,
  )
  return c.json({ url })
})

// GET /assets/:id without a signature (fell through above).
assetRoutes.get('/assets/:id', () => {
  throw errors.forbidden('ต้องใช้ลิงก์ที่มีลายเซ็น')
})
