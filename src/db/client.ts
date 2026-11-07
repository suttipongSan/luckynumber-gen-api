// Drizzle client factory.
// - Production and `wrangler dev`: Cloudflare D1 through the `DB` binding (wrangler.toml).
// - Node (tests, scripts): libSQL with a `file:` URL from TURSO_DATABASE_URL.
// Both are async SQLite drivers with the same query-builder API, `batch` included, so routes
// only ever see the `DB` type below.
//
// D1 free-plan limits to respect in queries: at most 100 bound parameters per statement and
// 50 statements per request (each statement inside a batch counts). See src/lib/chunk.ts.
import { createClient } from '@libsql/client'
import { drizzle as drizzleD1, type AnyD1Database } from 'drizzle-orm/d1'
import { drizzle as drizzleLibsql, type LibSQLDatabase } from 'drizzle-orm/libsql'
import * as schema from './schema'

export type DB = LibSQLDatabase<typeof schema>

export interface DbEnv {
  DB?: AnyD1Database
  TURSO_DATABASE_URL?: string
  TURSO_AUTH_TOKEN?: string
}

const d1Cache = new WeakMap<object, DB>()
let libsqlCache: { key: string; db: DB } | null = null

export function getDb(env: DbEnv): DB {
  if (env.DB) {
    let db = d1Cache.get(env.DB)
    if (!db) {
      // Same runtime API as the libSQL driver for everything the routes use.
      db = drizzleD1(env.DB, { schema }) as unknown as DB
      d1Cache.set(env.DB, db)
    }
    return db
  }

  const url = env.TURSO_DATABASE_URL
  if (!url) throw new Error('No database: bind D1 as `DB` or set TURSO_DATABASE_URL')
  const authToken = env.TURSO_AUTH_TOKEN || undefined
  const key = `${url}|${authToken ?? ''}`
  if (libsqlCache && libsqlCache.key === key) return libsqlCache.db
  const db = drizzleLibsql(createClient({ url, authToken }), { schema })
  libsqlCache = { key, db }
  return db
}

export { schema }
