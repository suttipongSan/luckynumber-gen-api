// npm run db:migrate — applies drizzle/ migrations to TURSO_DATABASE_URL (default file:local.db).
import { runMigrations, scriptDbUrl } from './db'

const url = scriptDbUrl()
await runMigrations(url)
console.log(`Migrations applied to ${url.replace(/\?.*$/, '')}`)
