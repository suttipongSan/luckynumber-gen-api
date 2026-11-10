// Password hashing (PBKDF2-SHA256), constant-time comparison, HMAC signing, signed asset URLs.
// WebCrypto only, so the same code runs on Cloudflare Workers and in Node.

const enc = new TextEncoder()

export const PBKDF2_ITERATIONS = 100_000 // Workers caps PBKDF2 at 100k iterations.
const SALT_BYTES = 16
const HASH_BYTES = 32

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s
}

/** Constant-time comparison of two byte arrays (a length difference is not hidden). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

/** Constant-time string comparison (compares UTF-8 bytes). */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) {
    // Do the same amount of work so the result time does not depend on where strings differ.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number, bytes: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

/** Returns `pbkdf2$<iterations>$<saltB64>$<hashB64>`. */
export async function hashPassword(
  password: string,
  iterations = PBKDF2_ITERATIONS,
): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES)
  crypto.getRandomValues(salt)
  const hash = await pbkdf2(password, salt, iterations, HASH_BYTES)
  return `pbkdf2$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`
}

export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false
  const iterations = Number(parts[1])
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS) return false
  let salt: Uint8Array
  let expected: Uint8Array
  try {
    salt = base64ToBytes(parts[2])
    expected = base64ToBytes(parts[3])
  } catch {
    return false
  }
  if (expected.length === 0) return false
  const actual = await pbkdf2(password, salt, iterations, expected.length)
  return timingSafeEqual(actual, expected)
}

const hmacKeyCache = new Map<string, Promise<CryptoKey>>()

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = hmacKeyCache.get(secret)
  if (!k) {
    k = crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    )
    hmacKeyCache.set(secret, k)
  }
  return k
}

/** Hex HMAC-SHA256 of `message` keyed by `secret`. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(message))
  return bytesToHex(new Uint8Array(sig))
}

export async function verifyHmacHex(
  secret: string,
  message: string,
  sigHex: string,
): Promise<boolean> {
  const expected = await hmacSha256Hex(secret, message)
  return timingSafeEqualStr(expected, sigHex.toLowerCase())
}

// ---- Signed asset URLs
// URL shape: GET /assets/:id?exp=<unix seconds>&m=<memberId>&e=<ext>&sig=<hex HMAC-SHA256>
// Signed message: "assetId:memberId:ext:exp"
//
// `exp` is rounded UP to the next {@link ASSET_URL_BUCKET_SECONDS} boundary after
// now + {@link ASSET_URL_MIN_TTL_SECONDS}, so repeat signings of the same id inside one
// bucket yield the same URL. That lets the browser HTTP cache hit across page reloads and
// lets the download handler send `Cache-Control: private, max-age=<secondsUntilExp>, immutable`
// without ever outliving the signature. The member id + extension in the signed payload let
// the download handler compute the R2 key directly, so no D1 lookup is needed on hit.
//
// Tradeoff: a leaked URL — including one issued to a member who was then disabled or whose
// subscription expired — stays live until exp. Keep the bucket tight enough that this window
// is bounded by minutes, not hours (today: bucket 30 min + min 10 min = up to 40 min).

/** The signed URL is valid for at LEAST this many seconds beyond the signing time. */
export const ASSET_URL_MIN_TTL_SECONDS = 600
/** Exp is quantised to multiples of this (seconds); longer ⇒ better cache reuse, longer leak. */
export const ASSET_URL_BUCKET_SECONDS = 1800
/** Upper bound on exp - now that the verifier accepts; matches what the signer can ever emit. */
export const ASSET_URL_MAX_TTL_SECONDS = ASSET_URL_BUCKET_SECONDS + ASSET_URL_MIN_TTL_SECONDS

function assetMessage(assetId: string, memberId: string, ext: string, exp: number): string {
  return `${assetId}:${memberId}:${ext}:${exp}`
}

export async function signAsset(
  secret: string,
  assetId: string,
  memberId: string,
  ext: string,
  nowMs = Date.now(),
): Promise<{ exp: number; sig: string }> {
  const nowSec = Math.floor(nowMs / 1000)
  const earliest = nowSec + ASSET_URL_MIN_TTL_SECONDS
  const exp = Math.ceil(earliest / ASSET_URL_BUCKET_SECONDS) * ASSET_URL_BUCKET_SECONDS
  const sig = await hmacSha256Hex(secret, assetMessage(assetId, memberId, ext, exp))
  return { exp, sig }
}

export async function signedAssetUrl(
  baseUrl: string,
  secret: string,
  assetId: string,
  memberId: string,
  ext: string,
  nowMs = Date.now(),
): Promise<string> {
  const { exp, sig } = await signAsset(secret, assetId, memberId, ext, nowMs)
  return (
    `${baseUrl.replace(/\/$/, '')}/assets/${encodeURIComponent(assetId)}` +
    `?exp=${exp}&m=${encodeURIComponent(memberId)}&e=${encodeURIComponent(ext)}&sig=${sig}`
  )
}

export type AssetSigCheck = 'ok' | 'expired' | 'invalid'

/**
 * Validates an asset signature. `maxTtlSeconds` rejects exp values further in the future than
 * the API ever issues (plus 60 s clock slack).
 */
export async function verifyAssetSignature(
  secret: string,
  assetId: string,
  expRaw: string | undefined | null,
  memberIdRaw: string | undefined | null,
  extRaw: string | undefined | null,
  sigRaw: string | undefined | null,
  maxTtlSeconds: number,
  nowMs = Date.now(),
): Promise<AssetSigCheck> {
  if (!expRaw || !sigRaw || !memberIdRaw || !extRaw) return 'invalid'
  if (!/^\d{1,12}$/.test(expRaw) || !/^[0-9a-fA-F]{64}$/.test(sigRaw)) return 'invalid'
  // Tight whitelist for member id (same charset as newId / newToken) and extension (matches
  // the `EXT_BY_TYPE` values in routes/assets.ts). Anything else is rejected before the HMAC
  // compare so forged memberId / ext values never reach r2KeyFor.
  if (!/^[0-9A-Za-z]{1,32}$/.test(memberIdRaw)) return 'invalid'
  if (!/^[a-z0-9]{1,8}$/.test(extRaw)) return 'invalid'
  const exp = Number(expRaw)
  const valid = await verifyHmacHex(secret, assetMessage(assetId, memberIdRaw, extRaw, exp), sigRaw)
  if (!valid) return 'invalid'
  const now = Math.floor(nowMs / 1000)
  if (exp < now) return 'expired'
  if (exp > now + maxTtlSeconds + 60) return 'invalid'
  return 'ok'
}
