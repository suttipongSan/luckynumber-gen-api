// Member session guard. Loads the member for every request and checks expiry + disabled on
// EVERY call (DESIGN.md). `allowInactive` is used by /me, /logout and /news, which must keep
// working for expired / disabled members.
import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import type { AppEnv } from '../types'
import { getDb } from '../db/client'
import { members } from '../db/schema'
import { readMemberSession } from '../lib/session'
import { errors } from '../lib/http'
import { isExpired } from '../lib/time'

export function requireMember(opts: { allowInactive?: boolean } = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const memberId = await readMemberSession(c)
    if (!memberId) throw errors.unauthenticated()
    const member = await getDb(c.env).query.members.findFirst({ where: eq(members.id, memberId) })
    if (!member) throw errors.unauthenticated()
    if (!opts.allowInactive) {
      if (member.disabled) throw errors.disabled()
      if (isExpired(member.expiresAt)) throw errors.expired()
    }
    c.set('member', member)
    await next()
  })
}
