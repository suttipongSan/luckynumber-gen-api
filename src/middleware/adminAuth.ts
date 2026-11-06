// Operator (back office) session guard: requires a valid `ng_admin` cookie.
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { readAdminSession } from '../lib/session'
import { errors } from '../lib/http'

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!(await readAdminSession(c))) throw errors.unauthenticated('กรุณาเข้าสู่ระบบผู้ดูแล')
  c.set('adminUser', c.env.ADMIN_USERNAME)
  await next()
})
