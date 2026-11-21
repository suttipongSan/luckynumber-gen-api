// The short-lived token that lets the back office call the results API (numbergen-results-api) after it
// signed in to numbergen-api. THE TOKEN FORMAT IS WRITTEN HERE, ONCE, and this file is IDENTICAL in both
// repos: numbergen-api/src/lib/adminToken.ts (which signs, GET /admin/results-token) and
// numbergen-results-api/src/lib/adminToken.ts (which verifies, every admin route). Each repo has the same
// test/adminToken.test.ts with the same fixed test vector (secret + payload -> the exact token), so a
// change of the format breaks the tests of both repos until both copies are changed. It imports nothing.
//
// Format:   <payload>.<signature>
//   payload    base64url (RFC 4648 section 5, no padding) of the UTF-8 JSON text {"sub":"admin","iat":<s>,"exp":<s>},
//              the keys in exactly that order; iat and exp are integer Unix seconds and exp = iat + 600.
//   signature  base64url (no padding) of HMAC-SHA256 with the key = the UTF-8 bytes of the trimmed secret
//              RESULTS_ADMIN_SECRET and the message = the payload part exactly as it stands in the token
//              (the ASCII bytes of the base64url text, not of the JSON).
// It travels as `Authorization: Bearer <token>`. There is no cookie and no state on either side: both Workers
// hold the same secret, which must be at least 32 characters (anything shorter counts as "not configured":
// nothing is signed and every token is refused).
//
// A token is valid while iat - 60 s <= now < exp (60 s of clock skew between the two Workers is allowed for an
// iat that is slightly ahead), and only for sub = "admin". The signature is compared in constant time and
// before anything of the payload is read.

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export const ADMIN_TOKEN_SUBJECT = 'admin'
/** How long a token lives: exp = iat + this. */
export const ADMIN_TOKEN_TTL_SECONDS = 600
/** How far in the future an `iat` may be (the clocks of two Workers are not exactly the same). */
export const ADMIN_TOKEN_SKEW_SECONDS = 60
/** The secret RESULTS_ADMIN_SECRET must have at least this many characters (after trimming). */
export const ADMIN_TOKEN_MIN_SECRET_LENGTH = 32
/** A real token is about 100 characters; anything longer than this is refused without being decoded. */
const MAX_TOKEN_LENGTH = 400

export interface AdminTokenPayload {
  sub: string
  /** Unix seconds the token was issued at. */
  iat: number
  /** Unix seconds the token stops being valid at (exclusive). */
  exp: number
}

// ---- small helpers (kept here so that the file stands alone) -------------------------------------------------------

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Strict decoder: null for anything outside the base64url alphabet or with an impossible length. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL_RE.test(text) || text.length % 4 === 1) return null
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4))
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** Constant-time comparison of two byte arrays (a difference in length is not hidden, it is public here). */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

// ---- the secret --------------------------------------------------------------------------------------------------------

/**
 * The secret as it is used (trimmed, so a newline that came with `wrangler secret put` is harmless), or null
 * when it is missing or shorter than ADMIN_TOKEN_MIN_SECRET_LENGTH: then no token can be signed or accepted.
 */
export function usableSecret(secret: string | null | undefined): string | null {
  const trimmed = typeof secret === 'string' ? secret.trim() : ''
  return trimmed.length >= ADMIN_TOKEN_MIN_SECRET_LENGTH ? trimmed : null
}

// ---- signing -----------------------------------------------------------------------------------------------------------

/** Signs exactly this payload with `secret` (already a usable one). Tests use it to make expired or odd tokens. */
export async function signAdminTokenPayload(secret: string, payload: AdminTokenPayload): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify({ sub: payload.sub, iat: payload.iat, exp: payload.exp })))
  return `${body}.${toBase64Url(await hmacSha256(secret, body))}`
}

export interface SignedAdminToken {
  token: string
  /** ISO-8601 UTC instant the token stops being valid at (the payload's exp). */
  expiresAt: string
  payload: AdminTokenPayload
}

/** A fresh admin token valid for ADMIN_TOKEN_TTL_SECONDS from `nowMs`. Throws when the secret is not usable. */
export async function signAdminToken(secret: string | null | undefined, nowMs = Date.now()): Promise<SignedAdminToken> {
  const key = usableSecret(secret)
  if (key === null) {
    throw new Error(`RESULTS_ADMIN_SECRET is missing or shorter than ${ADMIN_TOKEN_MIN_SECRET_LENGTH} characters`)
  }
  const iat = Math.floor(nowMs / 1000)
  const payload: AdminTokenPayload = { sub: ADMIN_TOKEN_SUBJECT, iat, exp: iat + ADMIN_TOKEN_TTL_SECONDS }
  return {
    token: await signAdminTokenPayload(key, payload),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    payload,
  }
}

// ---- verifying ---------------------------------------------------------------------------------------------------------

/** Why a token was refused (for logs and tests; the HTTP answer is the same 401 for every reason). */
export type AdminTokenFailure =
  | 'no-secret'
  | 'malformed'
  | 'bad-signature'
  | 'bad-payload'
  | 'wrong-subject'
  | 'expired'
  | 'not-yet-valid'

export type AdminTokenCheck = { ok: true; payload: AdminTokenPayload } | { ok: false; reason: AdminTokenFailure }

const refused = (reason: AdminTokenFailure): AdminTokenCheck => ({ ok: false, reason })

/** Checks a token: the signature first (constant time), then the payload, the subject and the time window. */
export async function verifyAdminToken(
  secret: string | null | undefined,
  token: string | null | undefined,
  nowMs = Date.now(),
): Promise<AdminTokenCheck> {
  const key = usableSecret(secret)
  if (key === null) return refused('no-secret')
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return refused('malformed')
  const parts = token.split('.')
  if (parts.length !== 2 || !BASE64URL_RE.test(parts[0]) || !BASE64URL_RE.test(parts[1])) return refused('malformed')
  const [body, signature] = parts

  // The signature is compared as text (what the signer would have written), so there is only one valid spelling of it.
  const expected = toBase64Url(await hmacSha256(key, body))
  if (!constantTimeEqual(encoder.encode(expected), encoder.encode(signature))) return refused('bad-signature')

  // Signed by us, but still checked: a payload of the wrong shape is refused rather than trusted.
  let payload: unknown
  try {
    const bytes = fromBase64Url(body)
    payload = bytes === null ? null : JSON.parse(decoder.decode(bytes))
  } catch {
    return refused('bad-payload')
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return refused('bad-payload')
  const { sub, iat, exp } = payload as Record<string, unknown>
  if (typeof sub !== 'string' || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return refused('bad-payload')
  const issuedAt = iat as number
  const expiresAt = exp as number
  if (sub !== ADMIN_TOKEN_SUBJECT) return refused('wrong-subject')
  if (expiresAt <= issuedAt) return refused('bad-payload')
  const now = Math.floor(nowMs / 1000)
  if (expiresAt <= now) return refused('expired')
  if (issuedAt > now + ADMIN_TOKEN_SKEW_SECONDS) return refused('not-yet-valid')
  return { ok: true, payload: { sub, iat: issuedAt, exp: expiresAt } }
}

// ---- the header --------------------------------------------------------------------------------------------------------

/** The token of an `Authorization: Bearer <token>` header (the scheme is case-insensitive), or null. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(header.trim())
  return match ? match[1] : null
}
