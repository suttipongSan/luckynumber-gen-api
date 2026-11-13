// Web Push sender: RFC 8291 message encryption (the Appendix A example, byte for byte), VAPID
// (RFC 8292) JWTs, the push-service allow-list and the sender with a stubbed fetch.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { base64UrlToBytes, bytesToBase64Url } from '../src/lib/crypto'
import {
  MAX_PLAINTEXT_BYTES,
  PUSH_TTL_SECONDS,
  VAPID_JWT_LIFETIME_SECONDS,
  createPushSender,
  createVapidJwt,
  decodeAuthSecret,
  decodeP256dh,
  deriveContentKeys,
  encryptWebPush,
  generateVapidKeyPair,
  isValidP256PublicKey,
  loadVapidConfig,
  parsePushEndpoint,
  vapidAuthorization,
  type VapidConfig,
} from '../src/lib/webpush'
import type { PushPayload } from '../src/types'

const bs = (b: Uint8Array) => b as unknown as BufferSource
const b64 = (s: string) => base64UrlToBytes(s.replace(/\s+/g, ''))!
const dec = new TextDecoder()
const enc = new TextEncoder()

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- RFC 8291 section 5 and Appendix A -----------------------------------------------------------

const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  ecdhSecret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce: '4h_95klXJ5E_qnoN',
  // Appendix A: the 86 octet header and the AES-GCM output (ciphertext and tag).
  header:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  encrypted: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  // Section 5: the complete request body.
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

describe('RFC 8291 Appendix A', () => {
  it('derives the same IKM, content encryption key and nonce', async () => {
    const keys = await deriveContentKeys(
      b64(RFC.ecdhSecret),
      b64(RFC.authSecret),
      b64(RFC.uaPublic),
      b64(RFC.asPublic),
      b64(RFC.salt),
    )
    expect(bytesToBase64Url(keys.ikm)).toBe(RFC.ikm)
    expect(bytesToBase64Url(keys.cek)).toBe(RFC.cek)
    expect(bytesToBase64Url(keys.nonce)).toBe(RFC.nonce)
  })

  it('encrypts the example byte for byte with the injected salt and key pair', async () => {
    const plaintext = b64(RFC.plaintext)
    expect(dec.decode(plaintext)).toBe('When I grow up, I want to be a watermelon')
    const body = await encryptWebPush(plaintext, b64(RFC.uaPublic), b64(RFC.authSecret), {
      salt: b64(RFC.salt),
      serverKeys: { publicKey: b64(RFC.asPublic), privateKey: b64(RFC.asPrivate) },
    })
    // header (86 octets) + AES-GCM output (41 + delimiter + 16 tag = 58 octets)
    const expected = new Uint8Array([...b64(RFC.header), ...b64(RFC.encrypted)])
    expect(body.length).toBe(144)
    expect(Array.from(body)).toEqual(Array.from(expected))
    expect(bytesToBase64Url(body)).toBe(RFC.body)
    // header layout: salt, record size 4096 (big endian), key id length 65, key id
    expect(bytesToBase64Url(body.slice(0, 16))).toBe(RFC.salt)
    expect(Array.from(body.slice(16, 21))).toEqual([0, 0, 0x10, 0, 65])
    expect(bytesToBase64Url(body.slice(21, 86))).toBe(RFC.asPublic)
  })
})

// ---- encryption round trip, the receiving side written out from RFC 8291 -------------------------

async function newSubscriber() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const authSecret = crypto.getRandomValues(new Uint8Array(16))
  return {
    privateKey: pair.privateKey,
    publicRaw,
    authSecret,
    target: (endpoint: string) => ({
      endpoint,
      p256dh: bytesToBase64Url(publicRaw),
      auth: bytesToBase64Url(authSecret),
    }),
  }
}

/** What a browser does with a push body: derive the keys and decrypt the single record. */
async function decryptAsBrowser(
  body: Uint8Array,
  sub: Awaited<ReturnType<typeof newSubscriber>>,
): Promise<Uint8Array> {
  const salt = body.slice(0, 16)
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16, false)
  const idLen = body[20]
  const asPublic = body.slice(21, 21 + idLen)
  const record = body.slice(21 + idLen)
  expect(rs).toBeGreaterThan(record.length)
  const asKey = await crypto.subtle.importKey('raw', bs(asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, sub.privateKey, 256))
  const { cek, nonce } = await deriveContentKeys(ecdh, sub.authSecret, sub.publicRaw, asPublic, salt)
  const aes = await crypto.subtle.importKey('raw', bs(cek), 'AES-GCM', false, ['decrypt'])
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bs(nonce), tagLength: 128 }, aes, bs(record)),
  )
  // strip the zero padding after the delimiter; the delimiter of the last record is 0x02
  let end = padded.length
  while (end > 0 && padded[end - 1] === 0) end--
  expect(padded[end - 1]).toBe(0x02)
  return padded.slice(0, end - 1)
}

describe('encryptWebPush', () => {
  it('round-trips a Thai JSON payload to a subscriber with fresh salt and key each time', async () => {
    const sub = await newSubscriber()
    const message: PushPayload = {
      title: 'ถึงเวลาลง ฮานอยปกติ',
      body: 'แตะเพื่อเปิดหวยนี้',
      lotteryIds: ['hanoi-regular'],
      url: 'https://pnphoto.co/?lottery=hanoi-regular',
    }
    const plaintext = enc.encode(JSON.stringify(message))
    const one = await encryptWebPush(plaintext, sub.publicRaw, sub.authSecret)
    const two = await encryptWebPush(plaintext, sub.publicRaw, sub.authSecret)
    expect(JSON.parse(dec.decode(await decryptAsBrowser(one, sub)))).toEqual(message)
    expect(JSON.parse(dec.decode(await decryptAsBrowser(two, sub)))).toEqual(message)
    // new salt and a new ephemeral key for every message
    expect(bytesToBase64Url(one.slice(0, 16))).not.toBe(bytesToBase64Url(two.slice(0, 16)))
    expect(bytesToBase64Url(one.slice(21, 86))).not.toBe(bytesToBase64Url(two.slice(21, 86)))
    expect(one.length).toBe(86 + plaintext.length + 1 + 16)
  })

  it('accepts the 3993 octet maximum and refuses more', async () => {
    const sub = await newSubscriber()
    const max = await encryptWebPush(new Uint8Array(MAX_PLAINTEXT_BYTES).fill(65), sub.publicRaw, sub.authSecret)
    expect(max.length).toBe(4096)
    await expect(
      encryptWebPush(new Uint8Array(MAX_PLAINTEXT_BYTES + 1), sub.publicRaw, sub.authSecret),
    ).rejects.toThrow(RangeError)
  })

  it('refuses malformed keys', async () => {
    const sub = await newSubscriber()
    const data = enc.encode('x')
    await expect(encryptWebPush(data, sub.publicRaw.slice(0, 64), sub.authSecret)).rejects.toThrow(TypeError)
    await expect(encryptWebPush(data, sub.publicRaw, sub.authSecret.slice(0, 15))).rejects.toThrow(TypeError)
    const compressed = sub.publicRaw.slice(0, 65)
    compressed[0] = 0x02
    await expect(encryptWebPush(data, compressed, sub.authSecret)).rejects.toThrow(TypeError)
    await expect(encryptWebPush(data, sub.publicRaw, sub.authSecret, { salt: new Uint8Array(8) })).rejects.toThrow(
      TypeError,
    )
  })
})

// ---- VAPID ---------------------------------------------------------------------------------------

async function vapidConfig(subject?: string): Promise<{ vapid: VapidConfig; publicKey: string; privateKey: string }> {
  const { publicKey, privateKey } = await generateVapidKeyPair()
  const vapid = await loadVapidConfig({
    VAPID_PUBLIC_KEY: publicKey,
    VAPID_PRIVATE_KEY: privateKey,
    VAPID_SUBJECT: subject,
  })
  expect(vapid).not.toBeNull()
  return { vapid: vapid!, publicKey, privateKey }
}

async function verifyJwt(token: string, publicKey: string): Promise<boolean> {
  const [header, claims, signature] = token.split('.')
  const key = await crypto.subtle.importKey(
    'raw',
    bs(base64UrlToBytes(publicKey)!),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    bs(base64UrlToBytes(signature)!),
    bs(enc.encode(`${header}.${claims}`)),
  )
}

const parseSegment = (s: string) => JSON.parse(dec.decode(base64UrlToBytes(s)!))

describe('VAPID', () => {
  it('generates a 65 byte public key and a 32 byte private scalar', async () => {
    const { publicKey, privateKey } = await generateVapidKeyPair()
    expect(base64UrlToBytes(publicKey)!.length).toBe(65)
    expect(base64UrlToBytes(publicKey)![0]).toBe(0x04)
    expect(base64UrlToBytes(privateKey)!.length).toBe(32)
    expect(publicKey).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('signs an ES256 JWT that verifies with the public key, aud = push service origin, exp <= 12 h', async () => {
    const { vapid, publicKey } = await vapidConfig('mailto:ops@pnphoto.co')
    const nowMs = Date.UTC(2026, 10, 13, 2, 0, 0)
    const { token, exp } = await createVapidJwt({
      audience: 'https://fcm.googleapis.com',
      subject: vapid.subject,
      privateKey: vapid.privateKey,
      nowMs,
    })
    const [header, claims, signature] = token.split('.')
    expect(parseSegment(header)).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(parseSegment(claims)).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: nowMs / 1000 + VAPID_JWT_LIFETIME_SECONDS,
      sub: 'mailto:ops@pnphoto.co',
    })
    expect(exp).toBe(nowMs / 1000 + 12 * 3600)
    // ES256 signatures are the raw 64 byte r || s
    expect(base64UrlToBytes(signature)!.length).toBe(64)
    expect(await verifyJwt(token, publicKey)).toBe(true)

    // tampered claims and a different key do not verify
    const forged = `${header}.${bytesToBase64Url(enc.encode(JSON.stringify({ aud: 'https://evil.example', exp, sub: 'x' })))}.${signature}`
    expect(await verifyJwt(forged, publicKey)).toBe(false)
    expect(await verifyJwt(token, (await generateVapidKeyPair()).publicKey)).toBe(false)
  })

  it('never issues a JWT valid for longer than 12 hours', async () => {
    const { vapid } = await vapidConfig()
    const nowMs = Date.UTC(2026, 10, 13)
    const { exp } = await createVapidJwt({
      audience: 'https://fcm.googleapis.com',
      subject: vapid.subject,
      privateKey: vapid.privateKey,
      nowMs,
      lifetimeSeconds: 24 * 3600,
    })
    expect(exp - nowMs / 1000).toBe(12 * 3600)
  })

  it('formats the Authorization header per RFC 8292', async () => {
    const { vapid, publicKey } = await vapidConfig()
    expect(vapid.publicKey).toBe(publicKey)
    expect(vapidAuthorization('a.b.c', publicKey)).toBe(`vapid t=a.b.c, k=${publicKey}`)
  })

  it('loadVapidConfig: missing or unusable keys mean "not configured"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { publicKey, privateKey } = await generateVapidKeyPair()
    expect(await loadVapidConfig({})).toBeNull()
    expect(await loadVapidConfig({ VAPID_PUBLIC_KEY: publicKey })).toBeNull()
    expect(await loadVapidConfig({ VAPID_PRIVATE_KEY: privateKey })).toBeNull()
    expect(await loadVapidConfig({ VAPID_PUBLIC_KEY: '  ', VAPID_PRIVATE_KEY: privateKey })).toBeNull()
    // wrong sizes / alphabets
    expect(await loadVapidConfig({ VAPID_PUBLIC_KEY: 'AAAA', VAPID_PRIVATE_KEY: privateKey })).toBeNull()
    expect(await loadVapidConfig({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: 'not base64url!' })).toBeNull()
    expect(await loadVapidConfig({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: 'AAAA' })).toBeNull() // scalar 0
    // a private key that belongs to another public key (the import checks the pair)
    const other = await generateVapidKeyPair()
    expect(await loadVapidConfig({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: other.privateKey })).toBeNull()
    expect(err).toHaveBeenCalled()
  })

  it('loadVapidConfig: the private key may be a base64url scalar or a JWK with d; subject is normalised', async () => {
    const { publicKey, privateKey } = await generateVapidKeyPair()
    const asScalar = await loadVapidConfig({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey })
    const asJwk = await loadVapidConfig({
      VAPID_PUBLIC_KEY: publicKey,
      VAPID_PRIVATE_KEY: JSON.stringify({ kty: 'EC', crv: 'P-256', d: privateKey }),
    })
    expect(asScalar).not.toBeNull()
    expect(asJwk).not.toBeNull()
    expect(asScalar!.subject).toBe('https://pnphoto.co') // default
    for (const cfg of [asScalar!, asJwk!]) {
      const { token } = await createVapidJwt({ audience: 'https://x', subject: cfg.subject, privateKey: cfg.privateKey })
      expect(await verifyJwt(token, publicKey)).toBe(true)
    }
    const subject = async (v: string) =>
      (await loadVapidConfig({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: v }))!.subject
    expect(await subject('mailto:ops@pnphoto.co')).toBe('mailto:ops@pnphoto.co')
    expect(await subject('https://pnphoto.co/contact')).toBe('https://pnphoto.co/contact')
    expect(await subject('ops@pnphoto.co')).toBe('mailto:ops@pnphoto.co')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await subject('ftp://nope')).toBe('https://pnphoto.co')
  })
})

// ---- allow-list and key decoding ----------------------------------------------------------------

describe('parsePushEndpoint', () => {
  it('accepts https URLs on the known push services', () => {
    for (const ok of [
      'https://fcm.googleapis.com/fcm/send/dQw4w9WgXcQ:APA91bHun4MxP5egoKMwt2KZFBaFUH',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk',
      'https://autopush-prod.push.services.mozilla.com/wpush/v2/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB%2f',
      'https://web.push.apple.com/QGx_Ao9YJ',
    ]) {
      expect(parsePushEndpoint(ok)?.href, ok).toBe(new URL(ok).href)
    }
    expect(parsePushEndpoint('HTTPS://FCM.GOOGLEAPIS.COM/fcm/send/x')?.origin).toBe('https://fcm.googleapis.com')
  })

  it('rejects everything else', () => {
    for (const bad of [
      'http://fcm.googleapis.com/fcm/send/x', // not https
      'https://example.com/push',
      'https://fcm.googleapis.com.evil.example/fcm/send/x', // suffix trick
      'https://evilfcm.googleapis.com/x', // other googleapis host
      'https://googleapis.com/x',
      'https://notify.windows.com/x', // no subdomain
      'https://push.apple.com/x',
      'https://push.services.mozilla.com/x',
      'https://evil-push.apple.com.example/x',
      'https://xpush.apple.com/x', // not on a label boundary
      'https://fcm.googleapis.com@evil.example/x', // userinfo trick
      'https://evil.example\\@fcm.googleapis.com/x', // backslash trick
      'https://user:pw@fcm.googleapis.com/x', // credentials
      'https://fcm.googleapis.com:8443/x', // port
      'https://fcm.googleapis.com./x', // trailing dot
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://xn--fcm-googleapis-9ya.com/x',
      'javascript:alert(1)',
      'ftp://fcm.googleapis.com/x',
      '//fcm.googleapis.com/x',
      'fcm.googleapis.com/x',
      '',
      'not a url',
      `https://fcm.googleapis.com/${'a'.repeat(2100)}`, // longer than the 2048 cap
    ]) {
      expect(parsePushEndpoint(bad), bad).toBeNull()
    }
    expect(parsePushEndpoint(undefined)).toBeNull()
    expect(parsePushEndpoint(42)).toBeNull()
    expect(parsePushEndpoint(null)).toBeNull()
  })
})

describe('subscription keys', () => {
  it('decodes p256dh (65 bytes, 0x04) and auth (16 bytes) as base64url', async () => {
    const sub = await newSubscriber()
    const p = bytesToBase64Url(sub.publicRaw)
    expect(p.length).toBe(87)
    expect(decodeP256dh(p)).toEqual(sub.publicRaw)
    expect(decodeP256dh(`${p}=`)).toEqual(sub.publicRaw) // padding tolerated
    expect(decodeP256dh(p.slice(0, 86))).toBeNull()
    expect(decodeP256dh(p.replace(/[-_]/g, '+'))).toBeNull() // '+' is not base64url
    expect(decodeP256dh('')).toBeNull()
    expect(decodeP256dh(bytesToBase64Url(new Uint8Array(65).fill(5)))).toBeNull() // must start with 0x04
    const a = bytesToBase64Url(sub.authSecret)
    expect(a.length).toBe(22)
    expect(decodeAuthSecret(a)).toEqual(sub.authSecret)
    expect(decodeAuthSecret(bytesToBase64Url(new Uint8Array(17)))).toBeNull()
    expect(decodeAuthSecret('a')).toBeNull()
  })

  it('isValidP256PublicKey: a real point passes, a made-up point fails', async () => {
    const sub = await newSubscriber()
    expect(await isValidP256PublicKey(sub.publicRaw)).toBe(true)
    const fake = new Uint8Array(65).fill(7)
    fake[0] = 0x04
    expect(await isValidP256PublicKey(fake)).toBe(false)
  })
})

// ---- sender with a stubbed fetch ----------------------------------------------------------------

describe('createPushSender', () => {
  const message: PushPayload = {
    title: 'ถึงเวลาลง 2 หวย',
    body: 'ฮานอยปกติ, ลาวพัฒนา',
    lotteryIds: ['hanoi-regular', 'lao-develop'],
    url: 'https://pnphoto.co/?lottery=hanoi-regular',
  }

  function stubFetch(status = 201) {
    const calls: { url: string; init: RequestInit }[] = []
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init! })
      return new Response(null, { status })
    }) as typeof fetch
    return { calls, fetchStub }
  }

  it('POSTs the encrypted payload with VAPID, TTL 600, urgency high and aes128gcm', async () => {
    const { vapid, publicKey } = await vapidConfig('mailto:ops@pnphoto.co')
    const sub = await newSubscriber()
    const { calls, fetchStub } = stubFetch(201)
    const send = createPushSender(vapid, { fetch: fetchStub })
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def'
    expect(await send(sub.target(endpoint), message)).toEqual({ status: 201 })

    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe(endpoint)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    const headers = new Headers(init.headers)
    expect(headers.get('content-encoding')).toBe('aes128gcm')
    expect(headers.get('ttl')).toBe(String(PUSH_TTL_SECONDS))
    expect(headers.get('ttl')).toBe('600')
    expect(headers.get('urgency')).toBe('high')
    const auth = headers.get('authorization')!
    const m = auth.match(/^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/)
    expect(m).not.toBeNull()
    expect(m![2]).toBe(publicKey)
    expect(parseSegment(m![1].split('.')[1])).toMatchObject({
      aud: 'https://fcm.googleapis.com',
      sub: 'mailto:ops@pnphoto.co',
    })
    expect(await verifyJwt(m![1], publicKey)).toBe(true)

    // the body decrypts to the message with the subscriber's keys
    const plain = await decryptAsBrowser(init.body as Uint8Array, sub)
    expect(JSON.parse(dec.decode(plain))).toEqual(message)
  })

  it('reuses the JWT per push service and signs a new one when it is about to expire', async () => {
    const { vapid } = await vapidConfig()
    const sub = await newSubscriber()
    const { calls, fetchStub } = stubFetch()
    let now = Date.UTC(2026, 10, 13, 2, 0, 0)
    const send = createPushSender(vapid, { fetch: fetchStub, now: () => now })
    const tokenOf = (i: number) => /t=([\w.-]+),/.exec(new Headers(calls[i].init.headers).get('authorization')!)![1]

    await send(sub.target('https://fcm.googleapis.com/fcm/send/1'), message)
    await send(sub.target('https://fcm.googleapis.com/fcm/send/2'), message)
    await send(sub.target('https://updates.push.services.mozilla.com/wpush/v2/3'), message)
    expect(tokenOf(0)).toBe(tokenOf(1))
    expect(tokenOf(2)).not.toBe(tokenOf(0))
    expect(parseSegment(tokenOf(2).split('.')[1]).aud).toBe('https://updates.push.services.mozilla.com')

    now += 11.5 * 3600 * 1000 // less than an hour of validity left
    await send(sub.target('https://fcm.googleapis.com/fcm/send/4'), message)
    expect(tokenOf(3)).not.toBe(tokenOf(0))
  })

  it('reports the push service status without throwing (404 / 410 / 429 / 500 ...)', async () => {
    const { vapid } = await vapidConfig()
    const sub = await newSubscriber()
    for (const status of [201, 400, 403, 404, 410, 413, 429, 500, 503]) {
      const { fetchStub } = stubFetch(status)
      const send = createPushSender(vapid, { fetch: fetchStub })
      expect(await send(sub.target('https://fcm.googleapis.com/fcm/send/x'), message)).toEqual({ status })
    }
  })

  it('never calls out for an endpoint outside the allow-list or with malformed keys', async () => {
    const { vapid } = await vapidConfig()
    const sub = await newSubscriber()
    const { calls, fetchStub } = stubFetch()
    const send = createPushSender(vapid, { fetch: fetchStub })
    await expect(send(sub.target('https://evil.example/push'), message)).rejects.toThrow(/allowed push service/)
    await expect(send(sub.target('http://fcm.googleapis.com/fcm/send/x'), message)).rejects.toThrow()
    await expect(
      send({ ...sub.target('https://fcm.googleapis.com/fcm/send/x'), auth: 'short' }, message),
    ).rejects.toThrow(/malformed/)
    await expect(
      send({ ...sub.target('https://fcm.googleapis.com/fcm/send/x'), p256dh: '' }, message),
    ).rejects.toThrow(/malformed/)
    expect(calls).toHaveLength(0)
  })

  it('propagates a network failure to the caller', async () => {
    const { vapid } = await vapidConfig()
    const sub = await newSubscriber()
    const send = createPushSender(vapid, {
      fetch: (async () => {
        throw new TypeError('network down')
      }) as typeof fetch,
    })
    await expect(send(sub.target('https://fcm.googleapis.com/fcm/send/x'), message)).rejects.toThrow('network down')
  })
})
