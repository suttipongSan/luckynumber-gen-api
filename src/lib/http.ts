// Error helpers: every error response is { error: { code, message } }.
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'

export class ApiError extends Error {
  constructor(
    public status: ContentfulStatusCode,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export const errors = {
  unauthenticated: (m = 'กรุณาเข้าสู่ระบบ') => new ApiError(401, 'UNAUTHENTICATED', m),
  expired: (m = 'บัญชีหมดอายุการใช้งาน') => new ApiError(403, 'EXPIRED', m),
  disabled: (m = 'บัญชีถูกระงับการใช้งาน') => new ApiError(403, 'DISABLED', m),
  forbidden: (m = 'ไม่มีสิทธิ์เข้าถึง') => new ApiError(403, 'FORBIDDEN', m),
  notFound: (m = 'ไม่พบข้อมูล') => new ApiError(404, 'NOT_FOUND', m),
  validation: (m = 'ข้อมูลไม่ถูกต้อง') => new ApiError(400, 'VALIDATION', m),
  rateLimited: (m = 'เรียกใช้งานเกินกำหนด') => new ApiError(429, 'RATE_LIMITED', m),
  conflict: (code = 'CONFLICT', m = 'ข้อมูลขัดแย้ง') => new ApiError(409, code, m),
  unavailable: (code = 'UNAVAILABLE', m = 'ระบบยังไม่พร้อมใช้งาน') => new ApiError(503, code, m),
}

/**
 * Rows changed by a `db.run(...)` write. The two drivers report it differently (D1:
 * `meta.changes`, libSQL in tests: `rowsAffected`); routes use it to detect a conditional
 * INSERT ... SELECT ... WHERE that matched nothing (e.g. a quota lost to a concurrent request).
 */
export function changedRows(res: unknown): number {
  const r = res as { rowsAffected?: number; meta?: { changes?: number } } | null
  return Number(r?.rowsAffected ?? r?.meta?.changes ?? 0)
}

export function errorJson(c: Context, err: ApiError) {
  return c.json({ error: { code: err.code, message: err.message } }, err.status)
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ')
}

export function parseWith<T extends z.ZodType>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw)
  if (!result.success) throw errors.validation(formatZodIssues(result.error))
  return result.data
}

/** Parses the JSON body with a zod schema, throwing 400 VALIDATION on failure. */
export async function parseJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw errors.validation('ต้องส่งข้อมูลเป็น JSON')
  }
  return parseWith(schema, raw)
}

/**
 * Like {@link parseJson} but rejects a body larger than `maxBytes` with 400 VALIDATION.
 * Checks the declared `Content-Length` first, then the actual UTF-8 byte length of the read body.
 */
export async function parseJsonLimited<T extends z.ZodType>(
  c: Context,
  schema: T,
  maxBytes: number,
): Promise<z.infer<T>> {
  const declared = Number(c.req.header('Content-Length') ?? '0')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw errors.validation(`ขนาดข้อมูลเกิน ${Math.round(maxBytes / 1024)} KB`)
  }
  let text: string
  try {
    text = await c.req.text()
  } catch {
    throw errors.validation('ต้องส่งข้อมูลเป็น JSON')
  }
  const bytes = new TextEncoder().encode(text).length
  if (bytes > maxBytes) {
    throw errors.validation(`ขนาดข้อมูลเกิน ${Math.round(maxBytes / 1024)} KB`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw errors.validation('ต้องส่งข้อมูลเป็น JSON')
  }
  return parseWith(schema, raw)
}
