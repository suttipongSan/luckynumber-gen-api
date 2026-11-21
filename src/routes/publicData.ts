// GET /public-data/<path>: LOCAL DEVELOPMENT ONLY. Streams a snapshot file of the public results site out
// of the PUBLIC_RESULTS bucket so the new site can read the same files locally that production serves
// from the bucket's R2 custom domain. Paths are the file paths below the bucket root:
//   /public-data/v1/version.json   /public-data/v1/today.json
//   /public-data/v1/day/2026-11-20.json   /public-data/v1/lottery/hanoi-regular.json
// It exists only while COOKIE_SECURE is not 'true' (the .dev.vars of local development say 'false'; the
// live and the test Worker say 'true'), so it is a 404 in production. The bucket holds public data only,
// the answer carries `Access-Control-Allow-Origin: *`, the Cache-Control the object was stored with
// (so the browser behaves as it will in production) and an ETag (If-None-Match gets a 304).
//
// Registered BEFORE the app-wide CORS / CSRF / test-stack middleware (src/index.ts): the site's dev
// server is a different origin that is not in WEB_URL, and a public read needs none of them.
import { Hono } from 'hono'
import type { AppEnv } from '../types'
import { JSON_CONTENT_TYPE, PUBLIC_PATH_RE, cacheControlFor } from '../lib/publicSnapshot'

export const publicDataRoutes = new Hono<AppEnv>()

const PREFIX = '/public-data/'

// A preflight (a browser that adds request headers of its own): public and read-only, so anything goes.
publicDataRoutes.options('/*', async (c, next) => {
  if (c.env.COOKIE_SECURE === 'true') return next()
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': c.req.header('Access-Control-Request-Headers') ?? '*',
      'Access-Control-Max-Age': '86400',
    },
  })
})

publicDataRoutes.get('/*', async (c, next) => {
  // Production (and the test Worker): not served here; fall through to the normal 404.
  if (c.env.COOKIE_SECURE === 'true') return next()
  const key = c.req.path.startsWith(PREFIX) ? c.req.path.slice(PREFIX.length) : ''
  const bucket = c.env.PUBLIC_RESULTS
  const obj = bucket && PUBLIC_PATH_RE.test(key) ? await bucket.get(key) : null
  if (!obj) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'ไม่พบไฟล์' } }, 404, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
  }
  const etag = `"${obj.etag}"`
  const headers: Record<string, string> = {
    'Content-Type': obj.httpMetadata?.contentType ?? JSON_CONTENT_TYPE,
    'Cache-Control': obj.httpMetadata?.cacheControl ?? cacheControlFor(key),
    ETag: etag,
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  }
  if (c.req.header('If-None-Match') === etag) return new Response(null, { status: 304, headers })
  return new Response(obj.body, { status: 200, headers: { ...headers, 'Content-Length': String(obj.size) } })
})
