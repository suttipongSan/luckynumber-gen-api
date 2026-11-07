// npm run seed:sql [-- --demo] — writes seed.sql for Cloudflare D1, then apply it with
//   npx wrangler d1 execute numbergen --remote --file seed.sql   (or --local)
// Lotteries use INSERT OR IGNORE, so admin edits survive a re-seed.
// --demo also adds the demo member (link token demo0000000000000000000000000000, no password,
// +30 days). Use it only for local development, never on production.
import { writeFileSync } from 'node:fs'
import { LOTTERY_CATALOG } from '../src/db/catalog'
import { newId } from '../src/lib/ids'

const DEMO_LINK_TOKEN = 'demo0000000000000000000000000000'
const DEMO_NAME = 'สมาชิกทดสอบ'

const q = (v: string) => `'${v.replace(/'/g, "''")}'`

const lines = LOTTERY_CATALOG.map(
  (l) =>
    `INSERT OR IGNORE INTO lotteries (id, name, short_name, group_key, accent, sort_order, active) ` +
    `VALUES (${q(l.id)}, ${q(l.name)}, ${q(l.shortName)}, ${q(l.group)}, ${q(l.accent)}, ${l.sortOrder}, ${l.active ? 1 : 0});`,
)

if (process.argv.includes('--demo')) {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  lines.push(
    `INSERT INTO members (id, display_name, link_token, password_hash, expires_at, disabled, last_login_at, created_at, renders_total) ` +
      `VALUES (${q(newId())}, ${q(DEMO_NAME)}, ${q(DEMO_LINK_TOKEN)}, NULL, ${q(expiresAt)}, 0, NULL, ${q(now.toISOString())}, 0) ` +
      `ON CONFLICT(link_token) DO UPDATE SET password_hash = NULL, expires_at = excluded.expires_at, disabled = 0;`,
  )
}

writeFileSync('seed.sql', lines.join('\n') + '\n', 'utf8')
console.log(`seed.sql written: ${LOTTERY_CATALOG.length} lotteries${process.argv.includes('--demo') ? ' + demo member' : ''}`)
