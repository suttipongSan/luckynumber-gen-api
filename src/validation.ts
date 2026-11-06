// zod request schemas. CardSettings is stored as opaque JSON: unknown keys pass through, but the
// bounds from API.md are enforced (rows 0..6, perRow 1..6, fontSize 8..400, colours ≤ 40 chars,
// whole document ≤ 32 KB).
import { z } from 'zod'
import { GROUPS } from './types'

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
    winDigitCount: z.number().int().min(2).max(7).optional(),
    fixedRunning1: fixedDigit,
    fixedRunning2: fixedDigit,
    drillPrefixFrom: z.enum(['running1', 'running2', 'top', 'two']).optional(),
    winInclude: z.enum(['running', 'top', 'none']).optional(),
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
  })
  .superRefine((val, ctx) => {
    const bytes = new TextEncoder().encode(JSON.stringify(val)).length
    if (bytes > MAX_SETTINGS_BYTES) {
      ctx.addIssue({ code: 'custom', message: `CardSettings is ${bytes} bytes (max 32 KB)` })
    }
  })

export type CardSettingsInput = z.infer<typeof cardSettingsSchema>

export const passwordSchema = z.object({ password: z.string().min(8).max(200) })
export const loginPasswordSchema = z.object({ password: z.string().min(1).max(200) })

export const setNameSchema = z.object({ name: z.string().trim().min(1).max(40) })
export const patchSetSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  lotteryIds: z.array(z.string().min(1).max(64)).max(500).optional(),
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

export const patchMemberSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  expiresAt: isoDate.optional(),
  disabled: z.boolean().optional(),
})

export const lotterySchema = z.object({
  name: z.string().trim().min(1).max(80),
  shortName: z.string().trim().min(1).max(60),
  group: z.enum(GROUPS),
  accent: color,
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000),
  active: z.boolean(),
})
export const patchLotterySchema = lotterySchema.partial()

export const newsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  detailHtml: z.string().max(20_000),
  publishedAt: isoDate,
  active: z.boolean(),
})
export const patchNewsSchema = newsSchema.partial()
