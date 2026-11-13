// Web Push for Cloudflare Workers. WebCrypto only (no Node-only library), so the same code runs
// in Workers and in the Node tests.
//   - VAPID, RFC 8292: an ES256 JWT sent as `Authorization: vapid t=<jwt>, k=<public key>`.
//   - Message encryption, RFC 8291, using the aes128gcm content coding of RFC 8188.
import type { PushPayload } from '../types'
import { base64UrlToBytes, bytesToBase64Url } from './crypto'

const textEncoder = new TextEncoder()

/** TypeScript 5.9 distinguishes ArrayBuffer-backed views; WebCrypto wants those. */
const bs = (b: Uint8Array) => b as unknown as BufferSource

/** Both Web Push services and browsers accept this; the push service drops the message after it. */
export const PUSH_TTL_SECONDS = 600
/** RFC 8292 allows up to 24 h; the design keeps JWTs to 12 h. */
export const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60
/** A cached JWT is replaced once less than this is left. */
const JWT_MIN_REMAINING_SECONDS = 60 * 60
export const DEFAULT_VAPID_SUBJECT = 'https://pnphoto.co'
export const MAX_ENDPOINT_LENGTH = 2048
export const P256_POINT_BYTES = 65
export const AUTH_SECRET_BYTES = 16
/** RFC 8291 section 4: 4096 octets of body, minus the 86 octet header, the delimiter and the tag. */
export const MAX_PLAINTEXT_BYTES = 3993
const RECORD_SIZE = 4096
const DEFAULT_SEND_TIMEOUT_MS = 8000

// ---------------------------------------------------------------------------------------------
// Push service allow-list. The Worker POSTs to the endpoint a client registered, so the host must
// be a known push service; otherwise a member could make the Worker call arbitrary hosts.
// ---------------------------------------------------------------------------------------------

const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com'])
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.notify.windows.com', '.push.apple.com']
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/

/**
 * The parsed endpoint when it is an https URL (no credentials, no port) on a known push service,
 * otherwise null. Callers use the returned URL (`href`, `origin`) rather than the raw string, so
 * the host that was checked is the host that gets called.
 */
export function parsePushEndpoint(value: unknown): URL | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  const host = url.hostname
  if (!HOSTNAME_RE.test(host)) return null
  if (PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return url
  return null
}

export function isAllowedPushEndpoint(value: unknown): boolean {
  return parsePushEndpoint(value) !== null
}

/** Decodes a subscription `p256dh`: 65 bytes, uncompressed point form (leading 0x04). */
export function decodeP256dh(value: string): Uint8Array | null {
  const bytes = base64UrlToBytes(value)
  return bytes && bytes.length === P256_POINT_BYTES && bytes[0] === 0x04 ? bytes : null
}

/** Decodes a subscription `auth` secret: 16 bytes. */
export function decodeAuthSecret(value: string): Uint8Array | null {
  const bytes = base64UrlToBytes(value)
  return bytes && bytes.length === AUTH_SECRET_BYTES ? bytes : null
}

/** True when the 65 bytes are a point on the P-256 curve (WebCrypto validates it on import). */
export async function isValidP256PublicKey(raw: Uint8Array): Promise<boolean> {
  try {
    await crypto.subtle.importKey('raw', bs(raw), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------------------------
// Message encryption (RFC 8291 + RFC 8188, single aes128gcm record)
// ---------------------------------------------------------------------------------------------

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** HKDF-SHA-256 (extract with `salt`, expand with `info`) of `ikm`, `bytes` long. */
async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', bs(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(info) },
    key,
    bytes * 8,
  )
  return new Uint8Array(bits)
}

/** The P-256 private key `scalar` (32 bytes) with its public point as a WebCrypto JWK. */
function p256PrivateJwk(scalar: Uint8Array, publicRaw: Uint8Array): JsonWebKey {
  return {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToBase64Url(scalar),
    x: bytesToBase64Url(publicRaw.slice(1, 33)),
    y: bytesToBase64Url(publicRaw.slice(33, 65)),
    ext: true,
  }
}

/**
 * The RFC 8291 section 3.3 / 3.4 derivation: combines the ECDH secret with the authentication
 * secret (IKM), then derives the content encryption key and nonce of RFC 8188 from IKM and salt.
 * Exported so the tests can check every intermediate value of the RFC 8291 Appendix A example.
 */
export async function deriveContentKeys(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
  salt: Uint8Array,
): Promise<{ ikm: Uint8Array; cek: Uint8Array; nonce: Uint8Array }> {
  const keyInfo = concat(textEncoder.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32)
  const cek = await hkdf(ikm, salt, textEncoder.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(ikm, salt, textEncoder.encode('Content-Encoding: nonce\0'), 12)
  return { ikm, cek, nonce }
}

/** An application-server ECDH key pair in raw form: 65-byte point and 32-byte private scalar. */
export interface RawKeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export interface EncryptOptions {
  /** 16 random bytes. Injectable so the RFC 8291 Appendix A example can be reproduced. */
  salt?: Uint8Array
  /** Ephemeral application-server key pair. Injectable for the same reason; default: a fresh one. */
  serverKeys?: RawKeyPair
}

/**
 * Encrypts `plaintext` for a push subscription (`uaPublic` = its p256dh, `authSecret` = its auth)
 * and returns the complete request body: the 86 octet aes128gcm header (salt, record size, key id
 * = the application server public key) followed by the single encrypted record.
 */
export async function encryptWebPush(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  options: EncryptOptions = {},
): Promise<Uint8Array> {
  if (plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new RangeError(`push payload is ${plaintext.length} bytes (max ${MAX_PLAINTEXT_BYTES})`)
  }
  if (uaPublic.length !== P256_POINT_BYTES || uaPublic[0] !== 0x04) {
    throw new TypeError('p256dh must be a 65 byte uncompressed P-256 point')
  }
  if (authSecret.length !== AUTH_SECRET_BYTES) throw new TypeError('auth must be 16 bytes')
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16))
  if (salt.length !== 16) throw new TypeError('salt must be 16 bytes')

  let asPublic: Uint8Array
  let asPrivate: CryptoKey
  if (options.serverKeys) {
    asPublic = options.serverKeys.publicKey
    asPrivate = await crypto.subtle.importKey(
      'jwk',
      p256PrivateJwk(options.serverKeys.privateKey, asPublic),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    )
  } else {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ])
    asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
    asPrivate = pair.privateKey
  }

  const uaKey = await crypto.subtle.importKey(
    'raw',
    bs(uaPublic),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asPrivate, 256),
  )
  const { cek, nonce } = await deriveContentKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt)

  // One record: plaintext, then the 0x02 "last record" delimiter (RFC 8188 section 2).
  const record = concat(plaintext, Uint8Array.of(0x02))
  const aesKey = await crypto.subtle.importKey('raw', bs(cek), 'AES-GCM', false, ['encrypt'])
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(nonce), tagLength: 128 }, aesKey, bs(record)),
  )

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false)
  header[20] = asPublic.length
  header.set(asPublic, 21)
  return concat(header, encrypted)
}

// ---------------------------------------------------------------------------------------------
// VAPID (RFC 8292)
// ---------------------------------------------------------------------------------------------

export interface VapidEnv {
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  VAPID_SUBJECT?: string
}

export interface VapidConfig {
  /** base64url, 65 byte uncompressed point: the `k=` value and what browsers subscribe with. */
  publicKey: string
  privateKey: CryptoKey
  /** `mailto:` or `https:` contact URL for the `sub` claim. */
  subject: string
}

/** A fresh VAPID key pair in the formats the Worker secrets use. */
export async function generateVapidKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  return { publicKey: bytesToBase64Url(publicRaw), privateKey: jwk.d as string }
}

function normalizeSubject(raw: string | undefined): string {
  const s = (raw ?? '').trim()
  if (!s) return DEFAULT_VAPID_SUBJECT
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(s) || /^https:\/\/\S+$/i.test(s)) return s
  if (/^[^\s@:]+@[^\s@]+$/.test(s)) return `mailto:${s}`
  console.warn('VAPID_SUBJECT must be a mailto: or https: URL; using the default')
  return DEFAULT_VAPID_SUBJECT
}

/** The private scalar from a base64url string or from a JWK JSON document (its `d`). */
function parsePrivateScalar(raw: string): Uint8Array | null {
  let b64 = raw
  if (raw.startsWith('{')) {
    try {
      const d = (JSON.parse(raw) as { d?: unknown }).d
      if (typeof d !== 'string') return null
      b64 = d
    } catch {
      return null
    }
  }
  const bytes = base64UrlToBytes(b64)
  if (!bytes || bytes.length === 0 || bytes.length > 32) return null
  if (bytes.length === 32) return bytes
  const padded = new Uint8Array(32)
  padded.set(bytes, 32 - bytes.length)
  return padded
}

async function buildVapidConfig(
  publicRaw: string,
  privateRaw: string,
  subject: string | undefined,
): Promise<VapidConfig | null> {
  const publicBytes = decodeP256dh(publicRaw)
  const scalar = parsePrivateScalar(privateRaw)
  if (!publicBytes || !scalar || !(await isValidP256PublicKey(publicBytes))) {
    console.error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not a valid P-256 key pair; push is disabled')
    return null
  }
  try {
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      p256PrivateJwk(scalar, publicBytes),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )
    return { publicKey: bytesToBase64Url(publicBytes), privateKey, subject: normalizeSubject(subject) }
  } catch {
    console.error('VAPID private key does not match VAPID_PUBLIC_KEY; push is disabled')
    return null
  }
}

let vapidCache: { key: string; config: Promise<VapidConfig | null> } | null = null

/**
 * Reads the VAPID configuration from the Worker environment. Returns null when either key is
 * missing or the pair is unusable; callers then treat push as not configured. The imported key
 * is cached per isolate.
 */
export function loadVapidConfig(env: VapidEnv): Promise<VapidConfig | null> {
  const publicRaw = env.VAPID_PUBLIC_KEY?.trim()
  const privateRaw = env.VAPID_PRIVATE_KEY?.trim()
  if (!publicRaw || !privateRaw) return Promise.resolve(null)
  const key = `${publicRaw}\n${privateRaw}\n${env.VAPID_SUBJECT ?? ''}`
  if (!vapidCache || vapidCache.key !== key) {
    vapidCache = { key, config: buildVapidConfig(publicRaw, privateRaw, env.VAPID_SUBJECT) }
  }
  return vapidCache.config
}

export interface VapidJwtInput {
  /** Origin of the push service the request goes to, e.g. `https://fcm.googleapis.com`. */
  audience: string
  subject: string
  privateKey: CryptoKey
  nowMs?: number
  lifetimeSeconds?: number
}

/** A signed ES256 JWT (header.claims.signature, base64url) and its `exp` in unix seconds. */
export async function createVapidJwt(input: VapidJwtInput): Promise<{ token: string; exp: number }> {
  const lifetime = Math.min(input.lifetimeSeconds ?? VAPID_JWT_LIFETIME_SECONDS, VAPID_JWT_LIFETIME_SECONDS)
  const exp = Math.floor((input.nowMs ?? Date.now()) / 1000) + lifetime
  const header = bytesToBase64Url(textEncoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = bytesToBase64Url(
    textEncoder.encode(JSON.stringify({ aud: input.audience, exp, sub: input.subject })),
  )
  const signingInput = `${header}.${claims}`
  // WebCrypto returns ECDSA signatures as r || s (IEEE P1363), which is the JWS ES256 format.
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      input.privateKey,
      textEncoder.encode(signingInput),
    ),
  )
  return { token: `${signingInput}.${bytesToBase64Url(signature)}`, exp }
}

export function vapidAuthorization(token: string, publicKey: string): string {
  return `vapid t=${token}, k=${publicKey}`
}

// ---------------------------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------------------------

/** What a stored subscription row provides. */
export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

/** `status` is the HTTP status of the push service: 201 = accepted, 404 / 410 = subscription gone. */
export interface PushSendResult {
  status: number
}

export type PushSender = (target: PushTarget, message: PushPayload) => Promise<PushSendResult>

export interface SenderOptions {
  /** Replaces the global fetch (tests). */
  fetch?: typeof fetch
  /** Clock in ms (tests). */
  now?: () => number
  timeoutMs?: number
}

/**
 * Builds the sender used by the scheduled job: encrypts `message` as JSON for the subscription
 * and POSTs it to the push service with VAPID authorization, TTL 600 and urgency high.
 * Throws when the endpoint is not an allowed push service or the keys are malformed (nothing is
 * sent then); resolves with the push service's status otherwise, whatever it is.
 */
export function createPushSender(vapid: VapidConfig, options: SenderOptions = {}): PushSender {
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS
  const tokens = new Map<string, { token: string; exp: number }>()

  async function tokenFor(origin: string): Promise<string> {
    const nowMs = now()
    const cached = tokens.get(origin)
    if (cached && cached.exp - nowMs / 1000 >= JWT_MIN_REMAINING_SECONDS) return cached.token
    const fresh = await createVapidJwt({
      audience: origin,
      subject: vapid.subject,
      privateKey: vapid.privateKey,
      nowMs,
    })
    tokens.set(origin, fresh)
    return fresh.token
  }

  return async (target, message) => {
    // Re-checked here as well as at subscribe time: the Worker must never POST anywhere else.
    const url = parsePushEndpoint(target.endpoint)
    if (!url) throw new Error('push endpoint is not on an allowed push service')
    const uaPublic = decodeP256dh(target.p256dh)
    const authSecret = decodeAuthSecret(target.auth)
    if (!uaPublic || !authSecret) throw new Error('push subscription keys are malformed')

    const body = await encryptWebPush(textEncoder.encode(JSON.stringify(message)), uaPublic, authSecret)
    const res = await doFetch(url.href, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(await tokenFor(url.origin), vapid.publicKey),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: 'high',
      },
      body: bs(body),
      // A redirect would send the encrypted payload to a host nobody checked.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    // Read the body so the connection is released (Workers allow 6 open connections at once).
    try {
      await res.arrayBuffer()
    } catch {
      // the status is all that matters
    }
    return { status: res.status }
  }
}
