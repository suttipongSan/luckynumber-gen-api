// The admin token (src/lib/adminToken.ts): the format, the cross-check test vector and every way a token can be
// refused. THIS FILE IS IDENTICAL IN numbergen-api AND numbergen-results-api, next to an identical
// src/lib/adminToken.ts: the fixed vector below is what keeps the signer (numbergen-api) and the verifier
// (numbergen-results-api) byte-compatible. If you change the format, both repos fail until both are changed.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_TOKEN_MIN_SECRET_LENGTH,
  ADMIN_TOKEN_SKEW_SECONDS,
  ADMIN_TOKEN_TTL_SECONDS,
  bearerToken,
  signAdminToken,
  signAdminTokenPayload,
  usableSecret,
  verifyAdminToken,
} from '../src/lib/adminToken'

// ---- the cross-check test vector -----------------------------------------------------------------------------------
// A fixed secret and a fixed payload give exactly this token. The expected text was produced with node:crypto
// (createHmac), not with the code under test.
const VECTOR = {
  secret: 'results-admin-secret-test-vector-0123456789',
  payload: { sub: 'admin', iat: 1_700_000_000, exp: 1_700_000_600 },
  payloadJson: '{"sub":"admin","iat":1700000000,"exp":1700000600}',
  payloadPart: 'eyJzdWIiOiJhZG1pbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwNjAwfQ',
  signaturePart: 'Y3oLJtwltentT4-jV97FasGohuK-DWl2SxpC4hd3kZw',
  token:
    'eyJzdWIiOiJhZG1pbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwNjAwfQ.Y3oLJtwltentT4-jV97FasGohuK-DWl2SxpC4hd3kZw',
}
const NOW_MS = VECTOR.payload.iat * 1000
const SECRET = VECTOR.secret

describe('the token format: the cross-check vector (the same in both repos)', () => {
  it('signs the fixed payload with the fixed secret to exactly the expected token', async () => {
    expect(await signAdminTokenPayload(VECTOR.secret, VECTOR.payload)).toBe(VECTOR.token)
  })

  it('the vector is what an independent HMAC-SHA256 gives: payload = base64url of the JSON, signature = HMAC over that text', () => {
    const payloadPart = Buffer.from(VECTOR.payloadJson, 'utf8').toString('base64url')
    expect(payloadPart).toBe(VECTOR.payloadPart)
    const signature = createHmac('sha256', VECTOR.secret).update(payloadPart).digest('base64url')
    expect(signature).toBe(VECTOR.signaturePart)
    expect(`${payloadPart}.${signature}`).toBe(VECTOR.token)
  })

  it('signAdminToken at the instant of the vector gives the vector: iat now, exp 600 seconds later, no padding, no "+" or "/"', async () => {
    const signed = await signAdminToken(VECTOR.secret, NOW_MS)
    expect(signed.token).toBe(VECTOR.token)
    expect(signed.payload).toEqual(VECTOR.payload)
    expect(signed.expiresAt).toBe('2023-11-14T22:23:20.000Z')
    expect(signed.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })

  it('the keys of the payload are always written in the order sub, iat, exp, whatever the order of the object', async () => {
    const shuffled = { exp: VECTOR.payload.exp, sub: 'admin', iat: VECTOR.payload.iat }
    expect(await signAdminTokenPayload(VECTOR.secret, shuffled)).toBe(VECTOR.token)
  })

  it('verifies the vector while it is valid and refuses it from its exp on', async () => {
    const ok = await verifyAdminToken(VECTOR.secret, VECTOR.token, NOW_MS)
    expect(ok).toEqual({ ok: true, payload: VECTOR.payload })
    expect(await verifyAdminToken(VECTOR.secret, VECTOR.token, (VECTOR.payload.exp - 1) * 1000 + 999)).toMatchObject({ ok: true })
    expect(await verifyAdminToken(VECTOR.secret, VECTOR.token, VECTOR.payload.exp * 1000)).toEqual({ ok: false, reason: 'expired' })
  })

  it('the constants of the format', () => {
    expect(ADMIN_TOKEN_TTL_SECONDS).toBe(600)
    expect(ADMIN_TOKEN_SKEW_SECONDS).toBe(60)
    expect(ADMIN_TOKEN_MIN_SECRET_LENGTH).toBe(32)
  })
})

describe('usableSecret', () => {
  it('needs 32 characters after trimming; a newline that came with `secret put` is harmless', () => {
    expect(usableSecret(undefined)).toBeNull()
    expect(usableSecret(null)).toBeNull()
    expect(usableSecret('')).toBeNull()
    expect(usableSecret('x'.repeat(31))).toBeNull()
    expect(usableSecret(`${' '.repeat(10)}${'x'.repeat(31)}${' '.repeat(10)}`)).toBeNull()
    expect(usableSecret('x'.repeat(32))).toBe('x'.repeat(32))
    expect(usableSecret(`  ${'x'.repeat(32)}\r\n`)).toBe('x'.repeat(32))
  })
})

describe('signAdminToken', () => {
  it('lives 10 minutes from now and says when', async () => {
    const t0 = Date.parse('2026-11-20T03:00:00.750Z')
    const { token, expiresAt, payload } = await signAdminToken(SECRET, t0)
    expect(payload).toEqual({ sub: 'admin', iat: Math.floor(t0 / 1000), exp: Math.floor(t0 / 1000) + 600 })
    expect(expiresAt).toBe('2026-11-20T03:10:00.000Z')
    expect(await verifyAdminToken(SECRET, token, t0)).toMatchObject({ ok: true })
  })

  it('refuses to sign without a usable secret', async () => {
    for (const secret of [undefined, null, '', ' ', 'short', 'x'.repeat(31)]) {
      await expect(signAdminToken(secret)).rejects.toThrow(/RESULTS_ADMIN_SECRET/)
    }
  })

  it('a secret with surrounding whitespace signs and verifies like the trimmed one', async () => {
    const padded = `${SECRET}\n`
    const a = await signAdminToken(padded, NOW_MS)
    expect(a.token).toBe(VECTOR.token)
    expect(await verifyAdminToken(padded, VECTOR.token, NOW_MS)).toMatchObject({ ok: true })
    expect(await verifyAdminToken(SECRET, a.token, NOW_MS)).toMatchObject({ ok: true })
  })

  it('two tokens of the same second are the same token (nothing random in it)', async () => {
    expect((await signAdminToken(SECRET, NOW_MS)).token).toBe((await signAdminToken(SECRET, NOW_MS + 999)).token)
    expect((await signAdminToken(SECRET, NOW_MS)).token).not.toBe((await signAdminToken(SECRET, NOW_MS + 1000)).token)
  })
})

describe('verifyAdminToken: what is refused', () => {
  // the secret is a required parameter of reasonWith on purpose: a default value would swallow `undefined`
  const reasonWith = async (token: string | null | undefined, secret: string | null | undefined, now: number) => {
    const res = await verifyAdminToken(secret, token, now)
    return res.ok ? 'ok' : res.reason
  }
  /** Why `token` is refused (or 'ok') by the right secret at the instant of the vector, unless told otherwise. */
  const reason = (token: string | null | undefined, secret: string = SECRET, now = NOW_MS) => reasonWith(token, secret, now)

  it('a token signed with another secret (also one that differs in the last character only)', async () => {
    expect(await reason(VECTOR.token, 'another-secret-that-is-long-enough-1234567')).toBe('bad-signature')
    expect(await reason(VECTOR.token, `${SECRET.slice(0, -1)}x`)).toBe('bad-signature')
    expect(await reason(VECTOR.token, SECRET.toUpperCase())).toBe('bad-signature')
  })

  it('no usable secret on the verifying side: every token is refused, even a good one', async () => {
    for (const secret of [undefined, null, '', '   ', 'short', 'x'.repeat(31)]) {
      expect(await reasonWith(VECTOR.token, secret, NOW_MS)).toBe('no-secret')
    }
  })

  it('a changed payload or a changed signature', async () => {
    const [payload, signature] = VECTOR.token.split('.')
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1)
    expect(await reason(`${flip(payload, 5)}.${signature}`)).toBe('bad-signature')
    expect(await reason(`${payload}.${flip(signature, 5)}`)).toBe('bad-signature')
    expect(await reason(`${payload}.${flip(signature, 0)}`)).toBe('bad-signature')
    // a payload that says something else with the old signature
    const other = Buffer.from('{"sub":"admin","iat":1700000000,"exp":1900000000}').toString('base64url')
    expect(await reason(`${other}.${signature}`)).toBe('bad-signature')
  })

  it('only one spelling of the signature is valid: the same bytes written with other trailing bits are refused', async () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const last = VECTOR.signaturePart.slice(-1)
    const base = alphabet.indexOf(last) & ~3
    const spellings = [0, 1, 2, 3].map((k) => alphabet[base + k]).filter((c) => c !== last)
    expect(spellings).toHaveLength(3)
    for (const c of spellings) {
      expect(await reason(`${VECTOR.payloadPart}.${VECTOR.signaturePart.slice(0, -1)}${c}`)).toBe('bad-signature')
    }
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['an empty string', ''],
    ['no dot', VECTOR.payloadPart],
    ['an empty signature', `${VECTOR.payloadPart}.`],
    ['an empty payload', `.${VECTOR.signaturePart}`],
    ['two dots', `${VECTOR.token}.x`],
    ['a JWT-like three parts', `${VECTOR.payloadPart}.${VECTOR.payloadPart}.${VECTOR.signaturePart}`],
    ['characters outside base64url', 'eyJz+/==.Y3oL+/=='],
    ['spaces', `${VECTOR.payloadPart} .${VECTOR.signaturePart}`],
    ['a Bearer prefix', `Bearer ${VECTOR.token}`],
    ['plain text', 'hello world'],
    ['something very long', `${'A'.repeat(500)}.${'B'.repeat(500)}`],
  ])('malformed: %s', async (_name, token) => {
    expect(await reason(token as string | null | undefined)).toBe('malformed')
  })

  it('expired, with the exact boundary: valid until the second before exp, refused from exp on', async () => {
    const { payload } = await signAdminToken(SECRET, NOW_MS)
    const token = await signAdminTokenPayload(SECRET, payload)
    expect(await reason(token, SECRET, (payload.exp - 1) * 1000)).toBe('ok')
    expect(await reason(token, SECRET, payload.exp * 1000)).toBe('expired')
    expect(await reason(token, SECRET, (payload.exp + 3600) * 1000)).toBe('expired')
  })

  it('iat in the future: allowed up to 60 seconds of clock skew, refused beyond', async () => {
    const token = await signAdminTokenPayload(SECRET, { sub: 'admin', iat: 2_000_000_000, exp: 2_000_000_600 })
    expect(await reason(token, SECRET, (2_000_000_000 - 60) * 1000)).toBe('ok')
    expect(await reason(token, SECRET, (2_000_000_000 - 61) * 1000)).toBe('not-yet-valid')
    expect(await reason(token, SECRET, (2_000_000_000 - 3600) * 1000)).toBe('not-yet-valid')
  })

  it('another subject (signed correctly, but not an admin token)', async () => {
    for (const sub of ['user', 'Admin', 'admin ', '', 'root']) {
      const token = await signAdminTokenPayload(SECRET, { sub, iat: 1_700_000_000, exp: 1_700_000_600 })
      expect(await reason(token), JSON.stringify(sub)).toBe('wrong-subject')
    }
  })

  it('a payload of the wrong shape, even when it is signed correctly', async () => {
    const forge = async (json: string) => {
      const body = Buffer.from(json, 'utf8').toString('base64url')
      return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
    }
    for (const json of [
      'null',
      '[]',
      '"admin"',
      '42',
      'not json',
      '{}',
      '{"sub":"admin"}',
      '{"sub":"admin","iat":1700000000}',
      '{"sub":"admin","exp":1700000600}',
      '{"sub":"admin","iat":"1700000000","exp":1700000600}',
      '{"sub":"admin","iat":1700000000.5,"exp":1700000600}',
      '{"sub":"admin","iat":1700000000,"exp":null}',
      '{"sub":"admin","iat":1700000000,"exp":1e400}',
      '{"sub":"admin","iat":1700000600,"exp":1700000600}', // exp is not after iat
      '{"sub":"admin","iat":1700000600,"exp":1700000000}',
      '{"sub":1,"iat":1700000000,"exp":1700000600}',
    ]) {
      expect(await reason(await forge(json)), json).toBe('bad-payload')
    }
    // bytes that are not UTF-8
    const body = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')
    expect(await reason(`${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`)).toBe('bad-payload')
    // unknown extra keys are tolerated (a later version may add one)
    const extra = await forge('{"sub":"admin","iat":1700000000,"exp":1700000600,"jti":"x"}')
    expect(await reason(extra)).toBe('ok')
  })
})

describe('bearerToken', () => {
  it('takes the token of `Authorization: Bearer <token>` (the scheme is case-insensitive)', () => {
    expect(bearerToken(`Bearer ${VECTOR.token}`)).toBe(VECTOR.token)
    expect(bearerToken(`bearer ${VECTOR.token}`)).toBe(VECTOR.token)
    expect(bearerToken(`BEARER ${VECTOR.token}`)).toBe(VECTOR.token)
    expect(bearerToken(`  Bearer ${VECTOR.token}  `)).toBe(VECTOR.token)
  })

  it.each([
    ['nothing', undefined],
    ['null', null],
    ['empty', ''],
    ['the token alone', VECTOR.token],
    ['another scheme', `Basic ${VECTOR.token}`],
    ['no token', 'Bearer'],
    ['no token but a space', 'Bearer '],
    ['two spaces', `Bearer  ${VECTOR.token}`],
    ['two tokens', `Bearer ${VECTOR.token} ${VECTOR.token}`],
    ['characters a token never has', 'Bearer abc$def'],
  ])('no token in %s', (_name, header) => {
    expect(bearerToken(header as string | null | undefined)).toBeNull()
  })
})
