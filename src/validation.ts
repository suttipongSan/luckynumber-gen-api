// zod request schemas. CardSettings is stored as opaque JSON: unknown keys pass through, but the
// bounds from API.md are enforced (rows 0..6, perRow 1..6, fontSize 8..400, colours ≤ 40 chars,
// whole document ≤ 32 KB).
import { z } from 'zod'
import { GROUPS, MAX_NOTIFICATION_ITEMS, MAX_ROUND, MIN_ROUND } from './types'
import { decodeAuthSecret, decodeP256dh, MAX_ENDPOINT_LENGTH, parsePushEndpoint } from './lib/webpush'

export const MAX_SETTINGS_BYTES = 32 * 1024

const color = z.string().max(40)
const num = z.number().finite()
const fontSize = num.min(8).max(400)

export const elementStyleSchema = z.looseObject({
  visible: z.boolean().optional(),
  row: z.number().int().min(0).max(6).optional(),
  perRow: z.number().int().min(1).max(6).optional(),
  fontSize: fontSize.optional(),
  color: color.optional(),
  color2: color.optional(),
  stroke: color.optional(),
  strokeColor: color.optional(),
  shadowColor: color.optional(),
  strokeWidth: num.min(0).max(100).optional(),
  x: num.optional(),
  y: num.optional(),
  frame: z.boolean().optional(),
  // Manual size of the drawn frame in viewBox units, same bounds as the editor sliders (web
  // cardFrames.ts). Unset = the automatic size.
  frameW: num.min(60).max(1160).optional(),
  frameH: num.min(20).max(400).optional(),
})

const rectSchema = z.looseObject({
  fill: color.optional(),
  stroke: color.optional(),
  color: color.optional(),
})

const textSchema = z.looseObject({
  text: z.string().max(500).optional(),
  fontSize: fontSize.optional(),
  color: color.optional(),
  stroke: color.optional(),
})

const fixedDigit = z.number().int().min(0).max(9).nullable().optional()

const assetIdRef = z.string().max(64).nullable()

export const cardSettingsSchema = z
  .looseObject({
    fontFamily: z.string().max(100).optional(),
    dateFormat: z.string().max(40).optional(),
    separator: z.string().max(10).optional(),
    isDouble: z.boolean().optional(),
    allowTriple: z.boolean().optional(),
    // Display only (the card draws each running digit twice); the generator never reads it.
    runningDouble: z.boolean().optional(),
    winDigitCount: z.number().int().min(2).max(7).optional(),
    fixedRunning1: fixedDigit,
    fixedRunning2: fixedDigit,
    drillPrefixFrom: z.enum(['running1', 'running2', 'top', 'two']).optional(),
    winInclude: z.enum(['running', 'top', 'none']).optional(),
    singleDigits: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    // '' is allowed so a cleared input can be saved as-is; the generator treats any value that
    // is not exactly singleDigits long as "random".
    fixedSingle: z.string().regex(/^\d{0,3}$/, 'fixedSingle must be up to 3 digits').nullable().optional(),
    elements: z.record(z.string().max(40), elementStyleSchema).optional(),
    rects: z.array(rectSchema).max(50).optional(),
    texts: z.array(textSchema).max(50).optional(),
    backgroundAssetId: assetIdRef.optional(),
    logo: z
      .looseObject({
        assetId: assetIdRef,
        x: num,
        y: num,
        width: num.min(0),
        opacity: num.min(0).max(1),
      })
      .optional(),
    qr: z
      .looseObject({
        assetId: assetIdRef,
        x: num,
        y: num,
        width: num.min(0),
        opacity: num.min(0).max(1),
      })
      .optional(),
  })
  .superRefine((val, ctx) => {
    const bytes = new TextEncoder().encode(JSON.stringify(val)).length
    if (bytes > MAX_SETTINGS_BYTES) {
      ctx.addIssue({ code: 'custom', message: `CardSettings is ${bytes} bytes (max 32 KB)` })
    }
  })

export type CardSettingsInput = z.infer<typeof cardSettingsSchema>

/** Whole body cap for `PUT /settings` (bulk). Per-item settings are each capped at 32 KB. */
export const MAX_BULK_SETTINGS_BYTES = 1024 * 1024

export const bulkSettingsSchema = z
  .object({
    items: z
      .array(
        z.object({
          lotteryId: z.string().min(1).max(64),
          settings: cardSettingsSchema,
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((val, ctx) => {
    const seen = new Set<string>()
    const dups: string[] = []
    for (const it of val.items) {
      if (seen.has(it.lotteryId)) {
        if (!dups.includes(it.lotteryId) && dups.length < 5) dups.push(it.lotteryId)
      } else {
        seen.add(it.lotteryId)
      }
    }
    if (dups.length) {
      ctx.addIssue({ code: 'custom', message: `lotteryId ซ้ำ: ${dups.join(', ')}` })
    }
  })

export const passwordSchema = z.object({ password: z.string().min(8).max(200) })
export const loginPasswordSchema = z.object({ password: z.string().min(1).max(200) })

export const setNameSchema = z.object({ name: z.string().trim().min(1).max(40) })

const roundValue = z.number().int().min(MIN_ROUND).max(MAX_ROUND)

export const patchSetSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    lotteryIds: z.array(z.string().min(1).max(64)).max(500).optional(),
    rounds: z.array(roundValue).max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.rounds !== undefined && val.lotteryIds === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['rounds'],
        message: 'rounds ต้องส่งคู่กับ lotteryIds',
      })
    }
    if (
      val.rounds !== undefined &&
      val.lotteryIds !== undefined &&
      val.rounds.length !== val.lotteryIds.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['rounds'],
        message: 'จำนวน rounds ต้องเท่ากับ lotteryIds',
      })
    }
  })

const fixedSlot = z.union([z.string().max(2), z.null()])

export const renderSchema = z.object({
  items: z
    .array(
      z.object({
        lotteryId: z.string().min(1).max(64),
        fixed: z.tuple([fixedSlot, fixedSlot]).optional(),
        settings: cardSettingsSchema.optional(),
      }),
    )
    .min(1)
    .max(80),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
})

const isoDate = z
  .string()
  .min(1)
  .refine((s) => Number.isFinite(Date.parse(s)), 'must be an ISO-8601 date')

export const adminLoginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
})

export const createMemberSchema = z.object({
  displayName: z.string().trim().min(1).max(60),
  expiresAt: isoDate,
})

/**
 * Admin override of a member's daily render limit. `null` clears the override (falls back
 * to the admin-configured default). Finite integer 1..100000 otherwise.
 */
const memberRenderLimit = z
  .union([z.number().int().min(1).max(100_000), z.null()])

export const patchMemberSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  expiresAt: isoDate.optional(),
  disabled: z.boolean().optional(),
  renderLimit: memberRenderLimit.optional(),
})

// Admin GET/PUT /admin/settings.
// - Contact ids: up to 60 chars, trimmed. Empty string = "hide this channel" on the public
//   /contacts endpoint (web then drops the button).
// - Contact URLs: either empty OR https://… (max 500 chars). Empty keeps the channel hidden.
// - renderLimitDefault: integer 1..100000.
const contactId = z.string().trim().max(60)
const contactUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === '' || v.startsWith('https://'), 'url ต้องเริ่มด้วย https://')

export const adminSettingsSchema = z.object({
  contactLineId: contactId,
  contactLineUrl: contactUrl,
  contactTelegramId: contactId,
  contactTelegramUrl: contactUrl,
  renderLimitDefault: z.number().int().min(1).max(100_000),
})

// Daily reminder time of a lottery: "HH:MM" (00:00..23:59, zero padded), Asia/Bangkok.
export const NOTIFY_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/
const notifyTime = z.string().regex(NOTIFY_TIME_RE, 'เวลาต้องอยู่ในรูปแบบ HH:MM (00:00-23:59)')

export const lotterySchema = z.object({
  name: z.string().trim().min(1).max(80),
  shortName: z.string().trim().min(1).max(60),
  group: z.enum(GROUPS),
  accent: color,
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
  active: z.boolean(),
  // Admin default reminder. Optional on create and on patch; null clears the time.
  notifyTime: notifyTime.nullable().optional(),
  notifyEnabled: z.boolean().optional(),
})
export const patchLotterySchema = lotterySchema.partial()

/**
 * F5 member-created lottery. `name` 1..40, `shortName?` 1..20 (defaults to name without spaces,
 * capped at 20), `group` is one of the catalog groups.
 */
export const memberLotterySchema = z.object({
  name: z.string().trim().min(1).max(40),
  shortName: z.string().trim().min(1).max(20).optional(),
  group: z.enum(GROUPS),
})
export const patchMemberLotterySchema = memberLotterySchema.partial()

export const newsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  detailHtml: z.string().max(20_000),
  publishedAt: isoDate,
  active: z.boolean(),
})
export const patchNewsSchema = newsSchema.partial()

// PUT /notifications (member) and PUT /admin/notifications (admin catalog defaults): the same
// body. A line that is on needs a time. The ids must be unique; whether the lotteries exist and
// may be used is checked against the database by the routes.
const notificationLine = z
  .object({
    lotteryId: z.string().min(1).max(64),
    notifyTime: notifyTime.nullable(),
    enabled: z.boolean(),
  })
  .superRefine((val, ctx) => {
    if (val.enabled && val.notifyTime === null) {
      ctx.addIssue({ code: 'custom', path: ['notifyTime'], message: 'ต้องระบุเวลาเมื่อเปิดแจ้งเตือน' })
    }
  })

export const notificationsSchema = z
  .object({ items: z.array(notificationLine).max(MAX_NOTIFICATION_ITEMS) })
  .superRefine((val, ctx) => {
    const seen = new Set<string>()
    const dups: string[] = []
    for (const it of val.items) {
      if (seen.has(it.lotteryId)) {
        if (!dups.includes(it.lotteryId) && dups.length < 5) dups.push(it.lotteryId)
      } else {
        seen.add(it.lotteryId)
      }
    }
    if (dups.length) {
      ctx.addIssue({ code: 'custom', message: `lotteryId ซ้ำ: ${dups.join(', ')}` })
    }
  })

// POST /push/subscribe: the PushSubscription JSON of the browser. The endpoint must be an https
// URL on a known push service (the Worker POSTs to it later), and the keys must decode to the
// right sizes. (Whether the p256dh is a real curve point is checked asynchronously by the route.)
export const pushSubscribeSchema = z.object({
  endpoint: z
    .string()
    .max(MAX_ENDPOINT_LENGTH)
    .refine((v) => parsePushEndpoint(v) !== null, 'ต้องเป็น URL https ของบริการ Push ที่รองรับ'),
  keys: z.object({
    p256dh: z
      .string()
      .max(200)
      .refine((v) => decodeP256dh(v) !== null, 'p256dh ต้องเป็น base64url ของจุด P-256 ขนาด 65 ไบต์'),
    auth: z
      .string()
      .max(100)
      .refine((v) => decodeAuthSecret(v) !== null, 'auth ต้องเป็น base64url ขนาด 16 ไบต์'),
  }),
})

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().min(1).max(MAX_ENDPOINT_LENGTH) })
