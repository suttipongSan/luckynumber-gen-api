// Admin-editable key/value settings (contact info shown to members on the lock screen and
// the renew / no-session pages, plus the default daily render limit). Every key has a
// compiled-in default here so the public /contacts endpoint and the per-request render
// limit keep working even when no row exists in `site_settings` (fresh DB or after a
// migration but before an admin writes anything).
//
// Values are stored as TEXT; integer-valued settings are decimal-encoded. Callers that
// need the full map should use {@link getSiteSettings}, which batches the one read and
// overlays persisted values on top of DEFAULTS.
import { inArray } from 'drizzle-orm'
import type { DB } from '../db/client'
import { siteSettings } from '../db/schema'
import { RENDERS_PER_DAY } from '../types'

export const CONTACT_LINE_ID = 'contact_line_id'
export const CONTACT_LINE_URL = 'contact_line_url'
export const CONTACT_TELEGRAM_ID = 'contact_telegram_id'
export const CONTACT_TELEGRAM_URL = 'contact_telegram_url'
export const RENDER_LIMIT_DEFAULT = 'render_limit_default'

/** Whitelist of settings keys accepted by GET/PUT /admin/settings. */
export const SITE_SETTING_KEYS = [
  CONTACT_LINE_ID,
  CONTACT_LINE_URL,
  CONTACT_TELEGRAM_ID,
  CONTACT_TELEGRAM_URL,
  RENDER_LIMIT_DEFAULT,
] as const
export type SiteSettingKey = (typeof SITE_SETTING_KEYS)[number]

/**
 * Compiled-in defaults. Contacts match the values currently baked into the web app
 * (src/config.ts) so a fresh database behaves exactly like the current client fallback.
 * The render-limit default tracks RENDERS_PER_DAY (600).
 */
export const DEFAULTS: Readonly<Record<SiteSettingKey, string>> = {
  [CONTACT_LINE_ID]: '@numbergen',
  [CONTACT_LINE_URL]: 'https://line.me/R/ti/p/@numbergen',
  [CONTACT_TELEGRAM_ID]: '@numbergen_support',
  [CONTACT_TELEGRAM_URL]: 'https://t.me/numbergen_support',
  [RENDER_LIMIT_DEFAULT]: String(RENDERS_PER_DAY),
}

export type SiteSettingsMap = Record<SiteSettingKey, string>

/**
 * Loads every whitelisted setting (one D1 read), overlaid on {@link DEFAULTS}. Unknown
 * keys that somehow slipped into the table are ignored; missing keys stay on their default.
 */
export async function getSiteSettings(db: DB): Promise<SiteSettingsMap> {
  const rows = await db
    .select()
    .from(siteSettings)
    .where(inArray(siteSettings.key, SITE_SETTING_KEYS as unknown as string[]))
  const out: SiteSettingsMap = { ...DEFAULTS }
  for (const r of rows) {
    if ((SITE_SETTING_KEYS as readonly string[]).includes(r.key)) {
      out[r.key as SiteSettingKey] = r.value
    }
  }
  return out
}

/** Parses the configured default render limit, falling back to RENDERS_PER_DAY on garbage. */
export function parseDefaultRenderLimit(value: string | undefined | null): number {
  if (!value) return RENDERS_PER_DAY
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 1 && n <= 100_000 ? n : RENDERS_PER_DAY
}

/**
 * Effective per-member render limit: member's own override (when set) beats the
 * admin-configured default, which beats the compiled-in RENDERS_PER_DAY.
 */
export function effectiveRenderLimit(
  memberRenderLimit: number | null | undefined,
  defaultLimit: number,
): number {
  if (memberRenderLimit != null && memberRenderLimit >= 1 && memberRenderLimit <= 100_000) {
    return memberRenderLimit
  }
  return defaultLimit
}
