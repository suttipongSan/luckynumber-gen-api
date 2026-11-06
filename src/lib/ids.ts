// Random identifiers from WebCrypto (works in Workers and Node 20+).
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** Uniform base62 string of `length` chars (rejection sampling, no modulo bias). */
export function randomBase62(length: number): string {
  let out = ''
  // 62 * 4 = 248: bytes >= 248 are rejected so each accepted byte maps uniformly.
  while (out.length < length) {
    const bytes = new Uint8Array(Math.ceil((length - out.length) * 1.1) + 4)
    crypto.getRandomValues(bytes)
    for (const b of bytes) {
      if (b >= 248) continue
      out += ALPHABET[b % 62]
      if (out.length === length) break
    }
  }
  return out
}

/** 16-char id used for every table row (API.md: "IDs are 16-char base62"). */
export function newId(): string {
  return randomBase62(16)
}

/** 32-char opaque token (member link tokens, session ids). */
export function newToken(): string {
  return randomBase62(32)
}
