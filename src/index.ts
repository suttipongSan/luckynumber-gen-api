// NumberGen API — Hono on Cloudflare Workers.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv, Bindings } from './types'
import { API_VERSION } from './types'
import { ApiError, errorJson, errors } from './lib/http'
import { linkRoutes } from './routes/link'
import { meRoutes } from './routes/me'
import { bootstrapRoutes } from './routes/bootstrap'
import { contactsRoutes } from './routes/contacts'
import { lotteryRoutes } from './routes/lotteries'
import { newsRoutes } from './routes/news'
import { setRoutes } from './routes/sets'
import { settingsRoutes } from './routes/settings'
import { renderRoutes } from './routes/render'
import { assetRoutes } from './routes/assets'
import { notificationRoutes } from './routes/notifications'
import { pushRoutes } from './routes/push'
import { adminRoutes } from './routes/admin'
import { runScheduledReminders } from './lib/reminders'

const DEV_ORIGIN = 'http://localhost:5173'

/** WEB_URL may list several origins separated by commas; the first one is used in member links. */
export function webOrigins(webUrl: string | undefined): string[] {
  return (webUrl ?? '')
    .split(',')
    .map((u) => u.trim().replace(/\/+$/, ''))
    .filter(Boolean)
}

/**
 * Origins trusted by CORS and the CSRF guard. The Vite dev origin is added only outside
 * production: COOKIE_SECURE is 'true' in wrangler.toml [vars] (production) and 'false' in
 * .dev.vars (local http), so a page on a visitor's localhost:5173 cannot ride production
 * cookies. Local dev normally lists the dev origin in WEB_URL anyway.
 */
export function allowedOrigins(env: { WEB_URL?: string; COOKIE_SECURE?: string }): string[] {
  const listed = webOrigins(env.WEB_URL)
  return env.COOKIE_SECURE === 'true' ? listed : [DEV_ORIGIN, ...listed]
}

export const app = new Hono<AppEnv>()

app.use('*', async (c, next) => {
  const allowed = allowedOrigins(c.env)
  return cors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    // 2 h is the current Chrome cap for CORS preflight caching; Firefox allows up to 24 h.
    maxAge: 7200,
  })(c, next)
})

// CSRF guard: state-changing requests that carry an Origin must come from an allowed origin.
// (multipart uploads are "simple" requests and would otherwise skip the CORS preflight.)
app.use('*', async (c, next) => {
  const method = c.req.method
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = c.req.header('Origin')
    if (origin && !allowedOrigins(c.env).includes(origin)) {
      throw errors.forbidden('Origin not allowed')
    }
  }
  await next()
})

app.get('/health', (c) => c.json({ ok: true, version: API_VERSION }))

app.route('/', linkRoutes)
app.route('/', meRoutes)
app.route('/', bootstrapRoutes)
app.route('/', contactsRoutes)
app.route('/', lotteryRoutes)
app.route('/', newsRoutes)
app.route('/', setRoutes)
app.route('/', settingsRoutes)
app.route('/', renderRoutes)
app.route('/', assetRoutes)
app.route('/', notificationRoutes)
app.route('/', pushRoutes)
app.route('/admin', adminRoutes)

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'ไม่พบเส้นทางนี้' } }, 404))

app.onError((err, c) => {
  if (err instanceof ApiError) return errorJson(c, err)
  console.error(err)
  return c.json({ error: { code: 'INTERNAL', message: 'เกิดข้อผิดพลาดภายในระบบ' } }, 500)
})

/**
 * Cloudflare cron trigger (wrangler.toml [triggers], every minute): sends the daily reminders that
 * are due. Does nothing until the VAPID keys are configured. A thrown error is logged and
 * rethrown so the failed run shows up in the Workers dashboard.
 */
export async function scheduled(controller: { scheduledTime: number }, env: Bindings): Promise<void> {
  try {
    // scheduledTime is the minute the trigger was due; never run behind it, so a trigger that
    // fires a moment early still handles its own minute.
    await runScheduledReminders(env, Math.max(Date.now(), controller.scheduledTime))
  } catch (err) {
    console.error('scheduled reminders failed', err)
    throw err
  }
}

// Workers call default.fetch and default.scheduled. The Hono app already has fetch; adding
// scheduled to that same object keeps `import app from './index'` (app.request in the tests)
// working.
export default Object.assign(app, { scheduled })
