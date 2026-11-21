// Guard of PUT /results: the results robot (a script that posts the draw results) or a signed-in
// admin. The robot sends the shared secret RESULTS_API_KEY in the `X-API-Key` header; the admin
// uses the normal `ng_admin` cookie (the back office form). Everything else is 401.
import type { Context } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { readAdminSession } from '../lib/session'
import { timingSafeEqualStr } from '../lib/crypto'
import { errors } from '../lib/http'

export const RESULTS_KEY_HEADER = 'X-API-Key'

/**
 * True when the request carries the configured key. An unset, empty or blank secret never matches
 * (otherwise an empty header would be "equal" to an empty secret and open the endpoint); the
 * comparison itself is constant-time.
 */
export function hasValidResultsKey(c: Context<AppEnv>): boolean {
  const secret = c.env.RESULTS_API_KEY?.trim()
  const given = c.req.header(RESULTS_KEY_HEADER)
  if (!secret || !given) return false
  return timingSafeEqualStr(given, secret)
}

export const requireResultsWriter = createMiddleware<AppEnv>(async (c, next) => {
  // The key needs no database, so it is checked first; the admin cookie costs one read.
  if (!hasValidResultsKey(c) && !(await readAdminSession(c))) {
    throw errors.unauthenticated('ต้องใช้คีย์ API (X-API-Key) หรือเข้าสู่ระบบผู้ดูแล')
  }
  await next()
})
