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

// ---- Signed asset URLs: GET /assets/:id?exp=<unix seconds>&sig=<hex HMAC-SHA256("assetId:exp")>

export async function signAsset(
  secret: string,
  assetId: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): Promise<{ exp: number; sig: string }> {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds
  const sig = await hmacSha256Hex(secret, `${assetId}:${exp}`)
  return { exp, sig }
}

export async function signedAssetUrl(
  baseUrl: string,
  secret: string,
  assetId: string,
  ttlSeconds: number,
  nowMs = Date.now(),
): Promise<string> {
  const { exp, sig } = await signAsset(secret, assetId, ttlSeconds, nowMs)
  return `${baseUrl.replace(/\/$/, '')}/assets/${encodeURIComponent(assetId)}?exp=${exp}&sig=${sig}`
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
  sigRaw: string | undefined | null,
  maxTtlSeconds: number,
  nowMs = Date.now(),
): Promise<AssetSigCheck> {
  if (!expRaw || !sigRaw || !/^\d{1,12}$/.test(expRaw) || !/^[0-9a-fA-F]{64}$/.test(sigRaw)) {
    return 'invalid'
  }
  const exp = Number(expRaw)
  const valid = await verifyHmacHex(secret, `${assetId}:${exp}`, sigRaw)
  if (!valid) return 'invalid'
  const now = Math.floor(nowMs / 1000)
  if (exp < now) return 'expired'
  if (exp > now + maxTtlSeconds + 60) return 'invalid'
  return 'ok'
}
