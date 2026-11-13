// Web Push registration. GET /push/key is public (the browser needs the VAPID public key before
// it can subscribe); registering and removing a device needs a member session.
import { Hono } from 'hono'
import { and, desc, eq, notInArray, sql } from 'drizzle-orm'
import type { AppEnv, PushKeyResponse } from '../types'
import { MAX_PUSH_DEVICES } from '../types'
import { getDb } from '../db/client'
import { pushSubscriptions } from '../db/schema'
import { requireMember } from '../middleware/memberAuth'
import { errors, parseJson } from '../lib/http'
import { newId } from '../lib/ids'
import { nowIso } from '../lib/time'
import { bytesToBase64Url } from '../lib/crypto'
import {
  decodeAuthSecret,
  decodeP256dh,
  isValidP256PublicKey,
  loadVapidConfig,
  parsePushEndpoint,
} from '../lib/webpush'
import { pushSubscribeSchema, pushUnsubscribeSchema } from '../validation'

export const pushRoutes = new Hono<AppEnv>()
pushRoutes.use('/push/subscribe', requireMember())

pushRoutes.get('/push/key', async (c) => {
  const vapid = await loadVapidConfig(c.env)
  if (!vapid) throw errors.unavailable('PUSH_DISABLED', 'ยังไม่เปิดใช้การแจ้งเตือน')
  const body: PushKeyResponse = { publicKey: vapid.publicKey }
  return c.json(body)
})

pushRoutes.post('/push/subscribe', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const body = await parseJson(c, pushSubscribeSchema)

  // The schema already checked these; parse again for the normalised forms that get stored.
  const endpoint = parsePushEndpoint(body.endpoint)?.href
  const p256dh = decodeP256dh(body.keys.p256dh)
  const auth = decodeAuthSecret(body.keys.auth)
  if (!endpoint || !p256dh || !auth) throw errors.validation('ข้อมูลการสมัครรับแจ้งเตือนไม่ถูกต้อง')
  if (!(await isValidP256PublicKey(p256dh))) throw errors.validation('p256dh ไม่ใช่กุญแจ P-256 ที่ถูกต้อง')

  const now = nowIso()
  // One batch (= one transaction): register the device, then trim the member to the newest
  // MAX_PUSH_DEVICES. An endpoint that already belongs to another member moves to this one (the
  // same browser now belongs to whoever is logged in on it); re-registering refreshes the keys
  // and counts as the newest device.
  await db.batch([
    db
      .insert(pushSubscriptions)
      .values({
        id: newId(),
        memberId,
        endpoint,
        p256dh: bytesToBase64Url(p256dh),
        auth: bytesToBase64Url(auth),
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          memberId,
          p256dh: sql`excluded.p256dh`,
          auth: sql`excluded.auth`,
          createdAt: sql`excluded.created_at`,
        },
      }),
    db.delete(pushSubscriptions).where(
      and(
        eq(pushSubscriptions.memberId, memberId),
        notInArray(
          pushSubscriptions.id,
          db
            .select({ id: pushSubscriptions.id })
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.memberId, memberId))
            .orderBy(desc(pushSubscriptions.createdAt), desc(pushSubscriptions.id))
            .limit(MAX_PUSH_DEVICES),
        ),
      ),
    ),
  ])
  return c.json({ ok: true })
})

pushRoutes.delete('/push/subscribe', async (c) => {
  const db = getDb(c.env)
  const memberId = c.get('member').id
  const body = await parseJson(c, pushUnsubscribeSchema)
  // Only the member's own device; someone else's endpoint (or an unknown one) is a no-op, so the
  // answer never reveals whether an endpoint is registered. Stored endpoints are normalised the
  // same way as on subscribe.
  const endpoint = parsePushEndpoint(body.endpoint)?.href ?? body.endpoint
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.memberId, memberId), eq(pushSubscriptions.endpoint, endpoint)))
  return c.json({ ok: true })
})
