// Drizzle schema (SQLite / libSQL). Tables follow DESIGN.md "Data model".
// Timestamps are ISO-8601 UTC strings (lexicographically comparable).
// Foreign keys are declared for documentation; deletes are cascaded explicitly in code because
// SQLite only enforces FKs when `PRAGMA foreign_keys=ON` is set on each connection.
import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  linkToken: text('link_token').notNull().unique(),
  passwordHash: text('password_hash'),
  expiresAt: text('expires_at').notNull(),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  lastLoginAt: text('last_login_at'),
  createdAt: text('created_at').notNull(),
  rendersTotal: integer('renders_total').notNull().default(0),
})

export const memberSessions = sqliteTable(
  'member_sessions',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    expiresAt: text('expires_at').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('member_sessions_member_idx').on(t.memberId)],
)

export const adminSessions = sqliteTable('admin_sessions', {
  id: text('id').primaryKey(),
  expiresAt: text('expires_at').notNull(),
})

export const lotteries = sqliteTable('lotteries', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  shortName: text('short_name').notNull(),
  groupKey: text('group_key').notNull(),
  accent: text('accent').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
})

export const sets = sqliteTable(
  'sets',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    index('sets_member_idx').on(t.memberId),
    // At most one Default set per member (guards concurrent first GET /sets).
    uniqueIndex('sets_one_default_idx').on(t.memberId).where(sql`is_default = 1`),
  ],
)

export const setLotteries = sqliteTable(
  'set_lotteries',
  {
    setId: text('set_id')
      .notNull()
      .references(() => sets.id, { onDelete: 'cascade' }),
    lotteryId: text('lottery_id')
      .notNull()
      .references(() => lotteries.id, { onDelete: 'cascade' }),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.setId, t.lotteryId] })],
)

export const cardSettings = sqliteTable(
  'card_settings',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    lotteryId: text('lottery_id')
      .notNull()
      .references(() => lotteries.id, { onDelete: 'cascade' }),
    settingsJson: text('settings_json').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.lotteryId] })],
)

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['background', 'logo'] }).notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    r2Key: text('r2_key').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('assets_member_idx').on(t.memberId)],
)

export const news = sqliteTable('news', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  detailHtml: text('detail_html').notNull(),
  publishedAt: text('published_at').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
})

export const newsReads = sqliteTable(
  'news_reads',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    newsId: text('news_id')
      .notNull()
      .references(() => news.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.newsId] })],
)

export const renderCounters = sqliteTable(
  'render_counters',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    day: text('day').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.day] })],
)

/**
 * Failed-login counters shared by every Worker isolate (DESIGN: 5 wrong tries → 429 for 15 min).
 * key = 'link:<linkToken>' for member links, 'admin:<client ip>' for the back office login.
 * Not in DESIGN.md's table list; added so the lock holds across isolates.
 */
export const loginAttempts = sqliteTable('login_attempts', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  lockedUntil: text('locked_until'),
})
