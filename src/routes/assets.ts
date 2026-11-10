// Per-member asset library (backgrounds / logos) stored in R2, served only via signed URLs.
import { Hono } from 'hono'
import { and, asc, eq } from 'drizzle-orm'
import type { AppEnv, Asset, AssetKind, CardSettings } from '../types'
import { ASSET_URL_TTL_SECONDS, MAX_ASSETS_PER_KIND, MAX_ASSET_BYTES } from '../types'
import { getDb, type DB } from '../db/client'
import { assets, cardSettings } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { errors } from '../lib/http'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'

const KIND_LABEL_TH: Record<AssetKind, string> = { background: 'พื้นหลัง', logo: 'โลโก้', qr: 'QR code' }
import { signedAssetUrl, verifyAssetSignature } from '../lib/crypto'
import { apiOrigin } from './render'

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

/** Removes references to `assetId` from the member's saved card settings. */
export async function clearAssetRefs(db: DB, memberId: string, assetId: string): Promise<void> {
  const rows = await db.select().from(cardSettings).where(eq(cardSettings.memberId, memberId))
  for (const r of rows) {
    let s: CardSettings
    try {
      s = JSON.parse(r.settingsJson) as CardSettings
    } catch {
      continue
    }
    let changed = false
    if (s.backgroundAssetId === assetId) {
      s.backgroundAssetId = null
      changed = true
    }
    if (s.logo && s.logo.assetId === assetId) {
      s.logo = { ...s.logo, assetId: null }
      changed = true
    }
    if (s.qr && s.qr.assetId === assetId) {
      s.qr = { ...s.qr, assetId: null }
      changed = true
    }
    if (changed) {
      await db
        .update(cardSettings)
        .set({ settingsJson: JSON.stringify(s), updatedAt: nowIso() })
        .where(and(eq(cardSettings.memberId, memberId), eq(cardSettings.lotteryId, r.lotteryId)))
    }
  }
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
  if (exp === undefined && sig === undefined) return next()
  const check = await verifyAssetSignature(
    c.env.ASSET_SIGNING_SECRET,
    id,
    exp,
    sig,
    ASSET_URL_TTL_SECONDS,
  )
  if (check === 'expired') throw errors.forbidden('ลิงก์รูปหมดอายุ')
  if (check !== 'ok') throw errors.forbidden('ลิงก์รูปไม่ถูกต้อง')
  const row = await getDb(c.env).query.assets.findFirst({ where: eq(assets.id, id) })
  if (!row) throw errors.notFound('ไม่พบไฟล์')
  const obj = await c.env.ASSETS.get(row.r2Key)
  if (!obj) throw errors.notFound('ไม่พบไฟล์')
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': row.contentType,
      'Cache-Control': 'private, max-age=600',
      'X-Content-Type-Options': 'nosniff',
      // Defence in depth: the bytes are only ever used as an <img>, never as a document.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
      'Content-Length': String(obj.size),
    },
  })
})

assetRoutes.get('/assets', requireMember(), async (c) => {
  const rows = await getDb(c.env)
    .select()
    .from(assets)
    .where(eq(assets.memberId, c.get('member').id))
    .orderBy(asc(assets.createdAt))
  return c.json(rows.map(toAsset))
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

  const count = (
    await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.memberId, memberId), eq(assets.kind, kind)))
  ).length
  if (count >= MAX_ASSETS_PER_KIND) {
    throw errors.conflict('QUOTA', `${KIND_LABEL_TH[kind]} เก็บได้สูงสุด ${MAX_ASSETS_PER_KIND} ไฟล์ ลบไฟล์เดิมก่อนอัปโหลดใหม่`)
  }

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
  try {
    await db.insert(assets).values(row)
  } catch (e) {
    await c.env.ASSETS.delete(r2Key)
    throw e
  }
  return c.json(toAsset(row))
})

assetRoutes.delete('/assets/:id', requireMember(), async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const row = await ownedAsset(db, memberId, c.req.param('id'))
  await c.env.ASSETS.delete(row.r2Key)
  await db.delete(assets).where(eq(assets.id, row.id))
  await clearAssetRefs(db, memberId, row.id)
  return c.body(null, 204)
})

assetRoutes.get('/assets/:id/url', requireMember(), async (c) => {
  const db = getDb(c.env)
  const row = await ownedAsset(db, c.get('member').id, c.req.param('id'))
  const url = await signedAssetUrl(
    apiOrigin(c.req.url),
    c.env.ASSET_SIGNING_SECRET,
    row.id,
    ASSET_URL_TTL_SECONDS,
  )
  return c.json({ url })
})

// GET /assets/:id without a signature (fell through above).
assetRoutes.get('/assets/:id', () => {
  throw errors.forbidden('ต้องใช้ลิงก์ที่มีลายเซ็น')
})
