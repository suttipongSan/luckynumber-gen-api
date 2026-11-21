// An in-memory stand-in for the PUBLIC_RESULTS R2 bucket (the Node tests have no Workers runtime). It
// implements what the publisher uses, with R2's conditional put (`onlyIf`: etagMatches, etagDoesNotMatch;
// a failed condition answers null and stores nothing), custom / http metadata, list and delete, logs
// every operation (so tests can check the ORDER of the writes and how many calls a build makes), and has
// hooks (before a put, a head, a delete) to interleave another writer deterministically.
import type { PublicBucket, PublicBucketHead, PublicBucketObject } from '../../src/types'

interface Stored {
  body: string
  etag: string
  httpMetadata: { contentType?: string; cacheControl?: string }
  customMetadata: Record<string, string>
}

export interface BucketOp {
  op: 'put' | 'get' | 'head' | 'delete' | 'list'
  key: string
  /** put only: false when the condition failed and nothing was stored */
  stored?: boolean
}

export class FakeBucket implements PublicBucket {
  readonly objects = new Map<string, Stored>()
  readonly log: BucketOp[] = []
  private seq = 0
  /** Runs before a put is evaluated (and before its condition is checked): lets a test slip a write in. */
  beforePut?: (key: string) => Promise<void> | void
  /** Runs before a head reads the object: what a head returns is what a hook left behind. */
  beforeHead?: (key: string) => Promise<void> | void
  /** Runs before a delete takes effect (a head that came earlier has already answered): lets a test slip a write in. */
  beforeDelete?: (key: string) => Promise<void> | void
  /** Makes puts of the matching keys throw (R2 being down). */
  failPutFor?: (key: string) => boolean

  async put(
    key: string,
    value: string,
    options: {
      httpMetadata?: { contentType?: string; cacheControl?: string }
      customMetadata?: Record<string, string>
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }
    } = {},
  ): Promise<{ key: string } | null> {
    await this.beforePut?.(key)
    if (this.failPutFor?.(key)) {
      this.log.push({ op: 'put', key, stored: false })
      throw new Error(`R2 put failed (test): ${key}`)
    }
    const existing = this.objects.get(key)
    const cond = options.onlyIf
    const ok =
      !cond ||
      ((cond.etagMatches === undefined || existing?.etag === cond.etagMatches) &&
        (cond.etagDoesNotMatch === undefined ||
          (cond.etagDoesNotMatch === '*' ? existing === undefined : existing?.etag !== cond.etagDoesNotMatch)))
    this.log.push({ op: 'put', key, stored: ok })
    if (!ok) return null
    this.objects.set(key, {
      body: value,
      etag: `etag-${++this.seq}`,
      httpMetadata: { ...options.httpMetadata },
      customMetadata: { ...options.customMetadata },
    })
    return { key }
  }

  async get(key: string): Promise<PublicBucketObject | null> {
    this.log.push({ op: 'get', key })
    const o = this.objects.get(key)
    if (!o) return null
    return {
      key,
      etag: o.etag,
      size: new TextEncoder().encode(o.body).length,
      body: new Response(o.body).body as ReadableStream,
      httpMetadata: o.httpMetadata,
      customMetadata: o.customMetadata,
    }
  }

  async head(key: string): Promise<PublicBucketHead | null> {
    await this.beforeHead?.(key)
    this.log.push({ op: 'head', key })
    const o = this.objects.get(key)
    return o ? { key, etag: o.etag, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata } : null
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      await this.beforeDelete?.(key)
      this.log.push({ op: 'delete', key })
      this.objects.delete(key)
    }
  }

  async list(opts: { prefix: string; cursor?: string; limit?: number }) {
    this.log.push({ op: 'list', key: opts.prefix })
    const all = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix)).sort()
    const start = opts.cursor ? Number(opts.cursor) : 0
    const limit = opts.limit ?? 1000
    const page = all.slice(start, start + limit)
    const truncated = start + limit < all.length
    return { objects: page.map((key) => ({ key })), truncated, cursor: truncated ? String(start + limit) : undefined }
  }

  // ---- helpers for the tests

  /** The parsed JSON of a stored file (throws when it is not there). */
  json<T = unknown>(key: string): T {
    const o = this.objects.get(key)
    if (!o) throw new Error(`not in the bucket: ${key}`)
    return JSON.parse(o.body) as T
  }

  has(key: string): boolean {
    return this.objects.has(key)
  }

  keys(): string[] {
    return [...this.objects.keys()].sort()
  }

  /** The paths successfully written, in order. */
  puts(): string[] {
    return this.log.filter((o) => o.op === 'put' && o.stored).map((o) => o.key)
  }

  /** Forgets the operation log (not the objects). */
  clearLog(): void {
    this.log.length = 0
  }

  /** Every stored file as one string: for "this text is nowhere in the public files" checks. */
  allText(): string {
    return [...this.objects.values()].map((o) => o.body).join('\n')
  }
}
