// Public landing page: GET /landing (content), GET /landing/articles/:slug (one article with its
// long text) and GET /landing/image/:name (the images). No auth and no cookies; no member-auth
// middleware is registered on these paths. CORS falls through to the app-level allow-list (same as
// /contacts). The content is edited in the back office, see ./adminLanding and ../lib/landing.
import { Hono } from 'hono'
import type { AppEnv, LandingArticleDetail, LandingResponse } from '../types'
import { getDb } from '../db/client'
import { errors } from '../lib/http'
import {
  LANDING_CONTENT_TYPE_BY_EXT,
  findActiveArticleBySlug,
  isLandingImageName,
  isLandingSlug,
  landingR2Key,
  loadLanding,
  toLandingArticleDetail,
  toLandingResponse,
} from '../lib/landing'
import { apiOrigin } from './render'

export const landingRoutes = new Hono<AppEnv>()

landingRoutes.get('/landing', async (c) => {
  const db = getDb(c.env)
  // Works on a database with no landing rows at all: missing settings fall back to the defaults
  // and inactive items are never selected.
  const { settings, items } = await loadLanding(db, { activeOnly: true })
  const payload: LandingResponse = toLandingResponse(apiOrigin(c.req.url), settings, items)
  // Same short edge cache as /contacts: an admin edit shows up within a minute.
  c.header('Cache-Control', 'public, max-age=60')
  return c.json(payload)
})

// One article with its long text. Only an ACTIVE article is public: an inactive one, a how-to step
// that happens to have an id like the slug, an unknown slug and a slug that is not a valid slug at
// all are all the same 404 (and an invalid one never reaches the database). The path has its own
// `/articles/` segment, so it can neither shadow nor be shadowed by `/landing/image/:name`.
landingRoutes.get('/landing/articles/:slug', async (c) => {
  const slug = c.req.param('slug')
  if (!isLandingSlug(slug)) throw errors.notFound('ไม่พบบทความ')
  const row = await findActiveArticleBySlug(getDb(c.env), slug)
  if (!row || row.slug === null) throw errors.notFound('ไม่พบบทความ')
  const payload: LandingArticleDetail = toLandingArticleDetail(apiOrigin(c.req.url), {
    ...row,
    slug: row.slug,
  })
  c.header('Cache-Control', 'public, max-age=60')
  return c.json(payload)
})

// The image bytes. Public on purpose (the page shows them to anyone). Safe against path
// traversal twice over: the name must match a strict pattern with no dot, slash or percent in the
// id part, and the R2 key is always the fixed `landing/` prefix plus that name.
landingRoutes.get('/landing/image/:name', async (c) => {
  const name = c.req.param('name')
  if (!isLandingImageName(name)) throw errors.notFound('ไม่พบรูปภาพ')
  const obj = await c.env.ASSETS.get(landingR2Key(name))
  if (!obj) throw errors.notFound('ไม่พบรูปภาพ')
  // The type comes from the (validated) extension, never from client-supplied metadata.
  const ext = name.slice(name.lastIndexOf('.') + 1)
  return new Response(obj.body, {
    status: 200,
    headers: {
      'Content-Type': LANDING_CONTENT_TYPE_BY_EXT[ext] ?? 'application/octet-stream',
      // Every upload gets a fresh random name, so the bytes behind a name never change.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      // Defence in depth: the bytes are only ever used as an <img>, never as a document.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': 'inline',
      'Content-Length': String(obj.size),
    },
  })
})
