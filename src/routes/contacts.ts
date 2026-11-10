// Public GET /contacts. No auth. Used by ContactLinks on the renew / no-session / lock
// screens; a channel with a blank id or URL is hidden (web drops that button). CORS falls through
// to the app-level config (same allow-list as other routes).
import { Hono } from 'hono'
import type { AppEnv, ContactChannel, ContactsResponse } from '../types'
import { getDb } from '../db/client'
import {
  CONTACT_LINE_ID,
  CONTACT_LINE_URL,
  CONTACT_TELEGRAM_ID,
  CONTACT_TELEGRAM_URL,
  getSiteSettings,
} from '../lib/siteSettings'

export const contactsRoutes = new Hono<AppEnv>()

function channel(id: string, url: string): ContactChannel | null {
  // An empty id OR an empty URL hides the channel (web shows no button): a button with an
  // empty href would just reopen the current page. PUT /admin/settings already enforces
  // https:// on any non-empty URL.
  const trimmedId = id.trim()
  const trimmedUrl = url.trim()
  if (!trimmedId || !trimmedUrl) return null
  return { id: trimmedId, url: trimmedUrl }
}

contactsRoutes.get('/contacts', async (c) => {
  const db = getDb(c.env)
  const map = await getSiteSettings(db)
  const payload: ContactsResponse = {
    line: channel(map[CONTACT_LINE_ID] ?? '', map[CONTACT_LINE_URL] ?? ''),
    telegram: channel(map[CONTACT_TELEGRAM_ID] ?? '', map[CONTACT_TELEGRAM_URL] ?? ''),
  }
  // Short edge cache: the admin page editing these values is low-traffic, 60 s is enough to
  // absorb the lock screen / renew page thrash without staleness that matters to a member.
  c.header('Cache-Control', 'public, max-age=60')
  return c.json(payload)
})
