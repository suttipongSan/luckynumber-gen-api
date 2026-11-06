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
  const now = Date.UTC(2026, 10, 6, 12, 0, 0)

  it('builds a URL with exp and hex HMAC of "assetId:exp"', async () => {
    const url = new URL(await signedAssetUrl('https://api.example.com/', secret, 'abc123', 600, now))
    expect(url.pathname).toBe('/assets/abc123')
    const exp = url.searchParams.get('exp')!
    const sig = url.searchParams.get('sig')!
    expect(Number(exp)).toBe(Math.floor(now / 1000) + 600)
    expect(sig).toBe(await hmacSha256Hex(secret, `abc123:${exp}`))
    expect(await verifyAssetSignature(secret, 'abc123', exp, sig, 600, now)).toBe('ok')
  })

  it('rejects expired, tampered, wrong-id and too-far-future signatures', async () => {
    const { exp, sig } = await signAsset(secret, 'abc123', 600, now)
    const e = String(exp)
    expect(await verifyAssetSignature(secret, 'abc123', e, sig, 600, now + 601_000)).toBe('expired')
    expect(await verifyAssetSignature(secret, 'abc124', e, sig, 600, now)).toBe('invalid')
    expect(await verifyAssetSignature(secret, 'abc123', String(exp + 1), sig, 600, now)).toBe('invalid')
    expect(await verifyAssetSignature('other', 'abc123', e, sig, 600, now)).toBe('invalid')
    const flipped = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0')
    expect(await verifyAssetSignature(secret, 'abc123', e, flipped, 600, now)).toBe('invalid')
    expect(await verifyAssetSignature(secret, 'abc123', null, sig, 600, now)).toBe('invalid')
    expect(await verifyAssetSignature(secret, 'abc123', 'abc', sig, 600, now)).toBe('invalid')
    // A validly signed exp a day ahead is refused (API never issues > 10 min).
    const far = await signAsset(secret, 'abc123', 86_400, now)
    expect(await verifyAssetSignature(secret, 'abc123', String(far.exp), far.sig, 600, now)).toBe(
      'invalid',
    )
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
