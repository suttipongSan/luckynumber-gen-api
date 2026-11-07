// Shared helpers for Node-side tests: open a libSQL file DB and apply drizzle/ migrations.
// The DB URL comes from the TURSO_DATABASE_URL environment variable, defaulting to the local
// file `file:local.db` (scripts never read .dev.vars, whose URL points at the dev DB bridge).
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import * as schema from '../src/db/schema'

export function scriptDbUrl(): string {
  return process.env.TURSO_DATABASE_URL || 'file:local.db'
}

export function openDb(url = scriptDbUrl(), authToken = process.env.TURSO_AUTH_TOKEN || undefined) {
  const client = createClient({ url, authToken })
  return { client, db: drizzle(client, { schema }) }
}

export async function runMigrations(url = scriptDbUrl(), folder = 'drizzle') {
  const { client, db } = openDb(url)
  try {
    await migrate(db, { migrationsFolder: folder })
  } finally {
    client.close()
  }
}
