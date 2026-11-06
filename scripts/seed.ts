// npm run seed — applies migrations, then seeds:
//  - the lottery catalog (existing rows are left untouched so admin edits survive a re-seed)
//  - the demo member (link token demo0000000000000000000000000000, no password, +30 days)
// and prints the member link plus an ADMIN_PASSWORD_HASH for admin / admin1234.
import { eq } from 'drizzle-orm'
import { openDb, runMigrations, scriptDbUrl } from './db'
import { lotteries, memberSessions, members } from '../src/db/schema'
import { LOTTERY_CATALOG } from '../src/db/catalog'
import { hashPassword } from '../src/lib/crypto'
import { newId } from '../src/lib/ids'

export const DEMO_LINK_TOKEN = 'demo0000000000000000000000000000'
const DEMO_NAME = 'สมาชิกทดสอบ'
const WEB_URL = process.env.WEB_URL || 'http://localhost:5173'

const url = scriptDbUrl()
await runMigrations(url)
const { client, db } = openDb(url)

try {
  let inserted = 0
  for (const l of LOTTERY_CATALOG) {
    const res = await db
      .insert(lotteries)
      .values({
        id: l.id,
        name: l.name,
        shortName: l.shortName,
        groupKey: l.group,
        accent: l.accent,
        sortOrder: l.sortOrder,
        active: l.active,
      })
      .onConflictDoNothing()
      .returning({ id: lotteries.id })
    inserted += res.length
  }
  console.log(`Lotteries: ${LOTTERY_CATALOG.length} in catalog, ${inserted} inserted`)

  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const existing = await db.query.members.findFirst({
    where: eq(members.linkToken, DEMO_LINK_TOKEN),
  })
  if (existing) {
    await db
      .update(members)
      .set({ displayName: DEMO_NAME, passwordHash: null, expiresAt, disabled: false })
      .where(eq(members.id, existing.id))
    await db.delete(memberSessions).where(eq(memberSessions.memberId, existing.id))
    console.log('Demo member reset (password cleared, expiry +30 days)')
  } else {
    await db.insert(members).values({
      id: newId(),
      displayName: DEMO_NAME,
      linkToken: DEMO_LINK_TOKEN,
      passwordHash: null,
      expiresAt,
      disabled: false,
      lastLoginAt: null,
      createdAt: new Date().toISOString(),
      rendersTotal: 0,
    })
    console.log('Demo member created')
  }
  console.log(`Demo member link: ${WEB_URL.replace(/\/$/, '')}/m/${DEMO_LINK_TOKEN}`)
  console.log(`Demo member expiresAt: ${expiresAt}`)
  console.log('')
  console.log('Admin login: admin / admin1234 — paste into .dev.vars:')
  console.log(`ADMIN_PASSWORD_HASH=${await hashPassword('admin1234')}`)
} finally {
  client.close()
}
