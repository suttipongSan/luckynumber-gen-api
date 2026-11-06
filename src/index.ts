// NumberGen API — Hono on Cloudflare Workers.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './types'
import { API_VERSION } from './types'
import { ApiError, errorJson, errors } from './lib/http'
import { linkRoutes } from './routes/link'
import { meRoutes } from './routes/me'
import { lotteryRoutes } from './routes/lotteries'
import { newsRoutes } from './routes/news'
import { setRoutes } from './routes/sets'
import { settingsRoutes } from './routes/settings'
import { renderRoutes } from './routes/render'
import { assetRoutes } from './routes/assets'
import { adminRoutes } from './routes/admin'

const DEV_ORIGIN = 'http://localhost:5173'

export function allowedOrigins(webUrl: string | undefined): string[] {
  const list = [DEV_ORIGIN]
  if (webUrl) list.push(webUrl.replace(/\/$/, ''))
  return list
}

export const app = new Hono<AppEnv>()

app.use('*', async (c, next) => {
  const allowed = allowedOrigins(c.env.WEB_URL)
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 600,
  })(c, next)
})

// CSRF guard: state-changing requests that carry an Origin must come from an allowed origin.
// (multipart uploads are "simple" requests and would otherwise skip the CORS preflight.)
app.use('*', async (c, next) => {
  const method = c.req.method
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = c.req.header('Origin')
    if (origin && !allowedOrigins(c.env.WEB_URL).includes(origin)) {
      throw errors.forbidden('Origin not allowed')
    }
  }
  await next()
})

app.get('/health', (c) => c.json({ ok: true, version: API_VERSION }))

app.route('/', linkRoutes)
app.route('/', meRoutes)
app.route('/', lotteryRoutes)
app.route('/', newsRoutes)
app.route('/', setRoutes)
app.route('/', settingsRoutes)
app.route('/', renderRoutes)
app.route('/', assetRoutes)
app.route('/admin', adminRoutes)

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'ไม่พบเส้นทางนี้' } }, 404))

app.onError((err, c) => {
  if (err instanceof ApiError) return errorJson(c, err)
  console.error(err)
  return c.json({ error: { code: 'INTERNAL', message: 'เกิดข้อผิดพลาดภายในระบบ' } }, 500)
})

export default app
