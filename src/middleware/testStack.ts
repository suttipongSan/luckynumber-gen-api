// Test stack kill switch. The TEST Worker (numbergen-api-test: this same code deployed with
// `wrangler --env test`) shares the D1 database with the live Worker, and the live back office
// flips the `testsite_enabled` row of site_settings. When that Worker has TEST_STACK=true AND the
// row says "false", EVERY request gets 503 TESTSITE_OFF. On the live Worker TEST_STACK is unset:
// this middleware does nothing and never reads the database.
//
// Registered right after CORS (src/index.ts) so the 503 carries the CORS headers and the browser
// can read it. OPTIONS preflights are answered by CORS before they reach this middleware.
import { eq } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import type { AppEnv, Bindings } from '../types'
import { getDb } from '../db/client'
import { siteSettings } from '../db/schema'
import { errors } from '../lib/http'
import { parseTestsiteEnabled, TESTSITE_ENABLED } from '../lib/siteSettings'

/** How long the switch is remembered in module memory (per Worker isolate). */
export const TEST_STACK_CACHE_MS = 15_000

let cached: { enabled: boolean; readAt: number } | null = null

/** Forgets the remembered switch so the next request reads the database again (for tests). */
export function resetTestStackCache(): void {
  cached = null
}

/**
 * The current switch. A value is reused for less than TEST_STACK_CACHE_MS. If the read fails the
 * test stack counts as ON for this request and nothing is remembered, so the next request tries
 * the database again.
 */
async function testsiteEnabled(env: Bindings): Promise<boolean> {
  const now = Date.now()
  if (cached) {
    const age = now - cached.readAt
    // age < 0 means the clock went backwards: do not trust the entry.
    if (age >= 0 && age < TEST_STACK_CACHE_MS) return cached.enabled
  }
  try {
    const row = await getDb(env).query.siteSettings.findFirst({
      where: eq(siteSettings.key, TESTSITE_ENABLED),
    })
    const enabled = parseTestsiteEnabled(row?.value)
    cached = { enabled, readAt: now }
    return enabled
  } catch (err) {
    console.error('test stack switch: read failed, treating the test site as ON', err)
    return true
  }
}

export const testStackGate = createMiddleware<AppEnv>(async (c, next) => {
  // Only the test Worker sets TEST_STACK to exactly 'true'; everywhere else this is a no-op.
  if (c.env.TEST_STACK !== 'true') return next()
  if (!(await testsiteEnabled(c.env))) {
    throw errors.unavailable('TESTSITE_OFF', 'เว็บทดสอบปิดอยู่')
  }
  await next()
})
