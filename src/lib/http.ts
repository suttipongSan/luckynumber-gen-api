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
