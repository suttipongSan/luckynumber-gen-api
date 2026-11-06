// Drizzle client factory. In Workers `@libsql/client` resolves to its web build (libsql:// or
// http(s):// URLs only); in Node (tests, scripts) it resolves to the native build which also
// supports `file:` URLs.
import { createClient, type Client } from '@libsql/client'
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql'
import * as schema from './schema'

export type DB = LibSQLDatabase<typeof schema>

let cache: { key: string; db: DB; client: Client } | null = null

export function getDb(env: { TURSO_DATABASE_URL: string; TURSO_AUTH_TOKEN?: string }): DB {
  const url = env.TURSO_DATABASE_URL
  const authToken = env.TURSO_AUTH_TOKEN || undefined
  const key = `${url}|${authToken ?? ''}`
  if (cache && cache.key === key) return cache.db
  if (!url) throw new Error('TURSO_DATABASE_URL is not set')
  if (
    url.startsWith('file:') &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent === 'Cloudflare-Workers'
  ) {
    throw new Error(
      'file: database URLs do not work inside workerd. Run `npm run dev:db` and set ' +
        'TURSO_DATABASE_URL=http://127.0.0.1:8080 in .dev.vars.',
    )
  }
  const client = createClient({ url, authToken })
  const db = drizzle(client, { schema })
  cache = { key, db, client }
  return db
}

export { schema }
