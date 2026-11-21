// NumberGen API — Hono on Cloudflare Workers.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv, Bindings } from './types'
import { API_VERSION } from './types'
import { ApiError, errorJson, errors } from './lib/http'
import { testStackGate } from './middleware/testStack'
import { linkRoutes } from './routes/link'
import { meRoutes } from './routes/me'
import { bootstrapRoutes } from './routes/bootstrap'
import { contactsRoutes } from './routes/contacts'
import { drawRoutes } from './routes/draws'
import { landingRoutes } from './routes/landing'
import { lotteryRoutes } from './routes/lotteries'
import { newsRoutes } from './routes/news'
import { resultRoutes } from './routes/results'
import { setRoutes } from './routes/sets'
import { settingsRoutes } from './routes/settings'
import { renderRoutes } from './routes/render'
import { assetRoutes } from './routes/assets'
import { notificationRoutes } from './routes/notifications'
import { pushRoutes } from './routes/push'
import { publicDataRoutes } from './routes/publicData'
import { adminRoutes } from './routes/admin'
import { runScheduledPrune } from './lib/draws'
import { runScheduledPublish } from './lib/publicPublish'
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

// Local development only (a 404 when COOKIE_SECURE is 'true'): the snapshot files of the public results
// site, read from the PUBLIC_RESULTS bucket. Registered first, so the CORS / CSRF / test-stack middleware
// below does not run for it (it sets its own `Access-Control-Allow-Origin: *`).
app.route('/public-data', publicDataRoutes)

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

// Test stack kill switch: only when TEST_STACK=true (test Worker) and the back office switch is off,
// every request gets 503 TESTSITE_OFF. Right after CORS so the error carries the CORS headers.
app.use('*', testStackGate)

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
app.route('/', landingRoutes)
app.route('/', lotteryRoutes)
app.route('/', newsRoutes)
app.route('/', resultRoutes)
app.route('/', setRoutes)
app.route('/', settingsRoutes)
app.route('/', renderRoutes)
app.route('/', drawRoutes)
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
 * are due (nothing until the VAPID keys are configured), in the 03:17 Bangkok minute deletes the
 * member_draws rows older than 14 days (src/lib/draws.ts) and reconciles the public results snapshots
 * (src/lib/publicPublish.ts: one cheap read when results_version equals results_published_version, a
 * bounded build otherwise; nothing at all without the PUBLIC_RESULTS binding). The jobs are
 * independent: one that throws is logged and does not stop the others, then the first error is
 * rethrown so the failed run shows up in the Workers dashboard.
 */
export async function scheduled(controller: { scheduledTime: number }, env: Bindings): Promise<void> {
  // scheduledTime is the minute the trigger was due; never run behind it, so a trigger that
  // fires a moment early still handles its own minute.
  const now = Math.max(Date.now(), controller.scheduledTime)
  const failures: unknown[] = []
  try {
    await runScheduledReminders(env, now)
  } catch (err) {
    console.error('scheduled reminders failed', err)
    failures.push(err)
  }
  try {
    await runScheduledPrune(env, controller.scheduledTime, now)
  } catch (err) {
    console.error('scheduled draw cleanup failed', err)
    failures.push(err)
  }
  try {
    await runScheduledPublish(env, now)
  } catch (err) {
    console.error('scheduled public snapshots failed', err)
    failures.push(err)
  }
  if (failures.length > 0) throw failures[0]
}

// Workers call default.fetch and default.scheduled. The Hono app already has fetch; adding
// scheduled to that same object keeps `import app from './index'` (app.request in the tests)
// working.
export default Object.assign(app, { scheduled })
