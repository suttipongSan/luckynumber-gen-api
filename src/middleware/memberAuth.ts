// Member session guard. Loads the member for every request and checks expiry + disabled on
// EVERY call (DESIGN.md). `allowInactive` is used by /me, /logout and /news, which must keep
// working for expired / disabled members.
import { createMiddleware } from 'hono/factory'
import type { AppEnv } from '../types'
import { readMemberSession } from '../lib/session'
import { errors } from '../lib/http'
import { isExpired } from '../lib/time'

export function requireMember(opts: { allowInactive?: boolean } = {}) {
  return createMiddleware<AppEnv>(async (c, next) => {
    // One D1 statement: session JOIN member (expiry / disabled are evaluated on every request;
    // no memory or KV cache — a disable or expiry takes effect on the next call).
    const member = await readMemberSession(c)
    if (!member) throw errors.unauthenticated()
    if (!opts.allowInactive) {
      if (member.disabled) throw errors.disabled()
      if (isExpired(member.expiresAt)) throw errors.expired()
    }
    c.set('member', member)
    await next()
  })
}
