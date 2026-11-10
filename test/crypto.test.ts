import { describe, expect, it } from 'vitest'
import {
  hashPassword,
  hmacSha256Hex,
  signAsset,
  signedAssetUrl,
  timingSafeEqual,
  timingSafeEqualStr,
  verifyAssetSignature,
  verifyHmacHex,
  verifyPassword,
} from '../src/lib/crypto'
import { newId, newToken } from '../src/lib/ids'

describe('password hashing', () => {
  it('round-trips and rejects wrong passwords', async () => {
    const h = await hashPassword('correct horse')
    expect(h).toMatch(/^pbkdf2\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(await verifyPassword('correct horse', h)).toBe(true)
    expect(await verifyPassword('correct horsf', h)).toBe(false)
    expect(await verifyPassword('', h)).toBe(false)
  })
  it('uses a random salt', async () => {
    const a = await hashPassword('same', 1000)
    const b = await hashPassword('same', 1000)
    expect(a).not.toBe(b)
    expect(await verifyPassword('same', a)).toBe(true)
    expect(await verifyPassword('same', b)).toBe(true)
  })
  it('stores PBKDF2-SHA256, 100k iterations, 16-byte salt, 32-byte hash, matching an independent derivation', async () => {
    const h = await hashPassword('ตรวจสอบ-pass')
    const [scheme, iters, saltB64, hashB64] = h.split('$')
    expect(scheme).toBe('pbkdf2')
    expect(iters).toBe('100000')
    const salt = Uint8Array.from(atob(saltB64), (ch) => ch.charCodeAt(0))
    const hash = Uint8Array.from(atob(hashB64), (ch) => ch.charCodeAt(0))
    expect(salt.length).toBe(16)
    expect(hash.length).toBe(32)
    const { pbkdf2Sync } = await import('node:crypto')
    const expected = pbkdf2Sync('ตรวจสอบ-pass', salt, 100_000, 32, 'sha256')
    expect(Buffer.from(hash).equals(expected)).toBe(true)
  })
  it('rejects malformed hashes', async () => {
    expect(await verifyPassword('x', null)).toBe(false)
    expect(await verifyPassword('x', 'bcrypt$abc')).toBe(false)
    expect(await verifyPassword('x', 'pbkdf2$999999999$AAAA$AAAA')).toBe(false)
    expect(await verifyPassword('x', 'pbkdf2$1000$!!!$AAAA')).toBe(false)
  })
})

describe('constant-time compare', () => {
  it('compares bytes and strings', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false)
    expect(timingSafeEqualStr('admin', 'admin')).toBe(true)
    expect(timingSafeEqualStr('admin', 'admim')).toBe(false)
    expect(timingSafeEqualStr('ผู้ดูแล', 'ผู้ดูแล')).toBe(true)
  })
})

describe('HMAC', () => {
  it('matches the known RFC 4231 test vector 2', async () => {
    const sig = await hmacSha256Hex('Jefe', 'what do ya want for nothing?')
    expect(sig).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
    expect(await verifyHmacHex('Jefe', 'what do ya want for nothing?', sig)).toBe(true)
    expect(await verifyHmacHex('Jefe', 'what do ya want for nothing!', sig)).toBe(false)
  })
})

describe('signed asset URLs', () => {
  const secret = 'test-asset-secret'
  const memberId = 'memberABC1234567'
  const ext = 'png'
  const now = Date.UTC(2026, 10, 6, 12, 0, 0)
  const MIN_TTL = 600
  const BUCKET = 1800
  // The verifier ceiling must match what the signer can emit: bucket + min-ttl (plus a 60 s
  // slack inside verifyAssetSignature).
  const MAX_TTL = BUCKET + MIN_TTL

  function bucketedExp(ms: number): number {
    const nowSec = Math.floor(ms / 1000)
    return Math.ceil((nowSec + MIN_TTL) / BUCKET) * BUCKET
  }

  it('builds a URL with exp, memberId, ext and hex HMAC of "assetId:memberId:ext:exp"', async () => {
    const url = new URL(
      await signedAssetUrl('https://api.example.com/', secret, 'abc123', memberId, ext, now),
    )
    expect(url.pathname).toBe('/assets/abc123')
    const exp = url.searchParams.get('exp')!
    const m = url.searchParams.get('m')!
    const e = url.searchParams.get('e')!
    const sig = url.searchParams.get('sig')!
    expect(Number(exp)).toBe(bucketedExp(now))
    expect(m).toBe(memberId)
    expect(e).toBe(ext)
    expect(sig).toBe(await hmacSha256Hex(secret, `abc123:${memberId}:${ext}:${exp}`))
    expect(await verifyAssetSignature(secret, 'abc123', exp, m, e, sig, MAX_TTL, now)).toBe('ok')
  })

  it('exp is stable inside a bucket and advances at the bucket boundary', async () => {
    // Two signings inside the same 30-min bucket produce identical exp + sig (same URL).
    const t1 = Date.UTC(2026, 10, 6, 12, 0, 0) // earliest = 12:10:00Z → bucket = 12:30:00Z
    const t2 = Date.UTC(2026, 10, 6, 12, 5, 0) // 5 min later — still points at 12:30:00Z.
    const t3 = Date.UTC(2026, 10, 6, 12, 25, 0) // earliest = 12:35:00Z → bucket = 13:00:00Z.
    const a = await signAsset(secret, 'abc', memberId, ext, t1)
    const b = await signAsset(secret, 'abc', memberId, ext, t2)
    const c = await signAsset(secret, 'abc', memberId, ext, t3)
    expect(a.exp).toBe(b.exp)
    expect(a.sig).toBe(b.sig)
    expect(c.exp).toBeGreaterThan(a.exp)
    expect(c.sig).not.toBe(a.sig)
    // The URL always gives the browser at least MIN_TTL seconds of validity.
    const nowSec = Math.floor(t1 / 1000)
    expect(a.exp - nowSec).toBeGreaterThanOrEqual(MIN_TTL)
    expect(a.exp - nowSec).toBeLessThanOrEqual(MAX_TTL)
  })

  it('rejects expired, tampered, wrong-id and too-far-future signatures', async () => {
    const { exp, sig } = await signAsset(secret, 'abc123', memberId, ext, now)
    const e = String(exp)
    // expired: verify at a time past exp
    expect(
      await verifyAssetSignature(secret, 'abc123', e, memberId, ext, sig, MAX_TTL, exp * 1000 + 1000),
    ).toBe('expired')
    // wrong asset id
    expect(await verifyAssetSignature(secret, 'abc124', e, memberId, ext, sig, MAX_TTL, now)).toBe(
      'invalid',
    )
    // exp tampered
    expect(
      await verifyAssetSignature(secret, 'abc123', String(exp + 1), memberId, ext, sig, MAX_TTL, now),
    ).toBe('invalid')
    // wrong secret
    expect(await verifyAssetSignature('other', 'abc123', e, memberId, ext, sig, MAX_TTL, now)).toBe(
      'invalid',
    )
    // sig tampered
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0')
    expect(await verifyAssetSignature(secret, 'abc123', e, memberId, ext, flipped, MAX_TTL, now)).toBe(
      'invalid',
    )
    // missing exp / sig / member / ext
    expect(await verifyAssetSignature(secret, 'abc123', null, memberId, ext, sig, MAX_TTL, now)).toBe(
      'invalid',
    )
    expect(await verifyAssetSignature(secret, 'abc123', 'abc', memberId, ext, sig, MAX_TTL, now)).toBe(
      'invalid',
    )
    expect(await verifyAssetSignature(secret, 'abc123', e, null, ext, sig, MAX_TTL, now)).toBe(
      'invalid',
    )
    expect(await verifyAssetSignature(secret, 'abc123', e, memberId, null, sig, MAX_TTL, now)).toBe(
      'invalid',
    )
    // other member (signature won't match)
    expect(
      await verifyAssetSignature(secret, 'abc123', e, 'otherMember00000', ext, sig, MAX_TTL, now),
    ).toBe('invalid')
    // other ext (signature won't match)
    expect(await verifyAssetSignature(secret, 'abc123', e, memberId, 'jpg', sig, MAX_TTL, now)).toBe(
      'invalid',
    )
    // memberId outside the whitelist
    expect(await verifyAssetSignature(secret, 'abc123', e, 'bad!id', ext, sig, MAX_TTL, now)).toBe(
      'invalid',
    )
    // ext outside the whitelist
    expect(await verifyAssetSignature(secret, 'abc123', e, memberId, 'SVG', sig, MAX_TTL, now)).toBe(
      'invalid',
    )
    // A validly signed exp a day ahead is refused (API never issues further than MAX_TTL).
    const farExp = Math.floor(now / 1000) + 86_400
    const farSig = await hmacSha256Hex(secret, `abc123:${memberId}:${ext}:${farExp}`)
    expect(
      await verifyAssetSignature(secret, 'abc123', String(farExp), memberId, ext, farSig, MAX_TTL, now),
    ).toBe('invalid')
  })
})

describe('ids', () => {
  it('generates base62 ids of the right length', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const id = newId()
      expect(id).toMatch(/^[0-9A-Za-z]{16}$/)
      seen.add(id)
    }
    expect(seen.size).toBe(500)
    expect(newToken()).toMatch(/^[0-9A-Za-z]{32}$/)
  })
})
