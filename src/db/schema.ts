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
  /** Per-member daily render ceiling override. NULL = fall back to site_settings.render_limit_default (then RENDERS_PER_DAY). */
  renderLimit: integer('render_limit'),
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

export const lotteries = sqliteTable(
  'lotteries',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    shortName: text('short_name').notNull(),
    groupKey: text('group_key').notNull(),
    accent: text('accent').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /** NULL = global catalog (admin-managed). Otherwise private to that member. */
    ownerMemberId: text('owner_member_id'),
    /**
     * Admin default "เวลาลง" for a catalog lottery: "HH:MM" in Asia/Bangkok, NULL = no time set.
     * Members without their own member_notifications row follow it. Unused for private lotteries.
     */
    notifyTime: text('notify_time'),
    /** Admin default on/off, paired with notifyTime. A catalog lottery is never "on" without a time. */
    notifyEnabled: integer('notify_enabled', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('lotteries_owner_idx').on(t.ownerMemberId)],
)

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
    /** F4 รอบ: 1..20. Set via PATCH /sets/:id { rounds }. */
    round: integer('round').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.setId, t.lotteryId] }),
    // Serves the lottery-scoped cascade on lottery delete (member / admin) without a full scan.
    index('set_lotteries_lottery_idx').on(t.lotteryId),
  ],
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
  (t) => [
    primaryKey({ columns: [t.memberId, t.lotteryId] }),
    // Serves the lottery-scoped cascade on lottery delete (member / admin) without a full scan.
    index('card_settings_lottery_idx').on(t.lotteryId),
  ],
)

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['background', 'logo', 'qr'] }).notNull(),
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

/**
 * Admin-editable key/value site settings (contact info shown to members + the default daily
 * render limit). Empty rows mean "use the compiled-in default from src/lib/siteSettings.ts".
 * Keys are a fixed whitelist (see SITE_SETTING_KEYS); values are stored as TEXT (integers are
 * decimal-encoded).
 */
export const siteSettings = sqliteTable('site_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/**
 * A member's own daily-reminder line for one lottery they can see (active catalog lottery or one
 * of their private lotteries). When PUT /notifications is saved, every line becomes a row here;
 * a row wins over the admin default on `lotteries` (members who never saved have no rows and
 * follow the default). `notifyTime` is "HH:MM" in Asia/Bangkok. `lastSentDay` (Bangkok
 * YYYY-MM-DD) is informational only; de-duplication uses the cursor in site_settings.
 * Deleted explicitly with the member / the lottery (see admin.ts, lotteries.ts).
 */
export const memberNotifications = sqliteTable(
  'member_notifications',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    lotteryId: text('lottery_id')
      .notNull()
      .references(() => lotteries.id, { onDelete: 'cascade' }),
    notifyTime: text('notify_time'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    lastSentDay: text('last_sent_day'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.lotteryId] }),
    // Serves the scheduled job: enabled lines whose time is one of the minutes being processed.
    index('member_notifications_due_idx').on(t.enabled, t.notifyTime),
    // Serves the lottery-scoped cascade on lottery delete (member / admin) without a full scan.
    index('member_notifications_lottery_idx').on(t.lotteryId),
  ],
)

/**
 * Web Push subscriptions (one row per browser / device). `endpoint` is unique: registering an
 * endpoint that belongs to another member re-assigns it. The scheduled job deletes rows whose
 * push service answers 404 / 410. Deleted explicitly with the member (see admin.ts).
 */
export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    /** base64url, 65-byte uncompressed P-256 point. */
    p256dh: text('p256dh').notNull(),
    /** base64url, 16-byte authentication secret. */
    auth: text('auth').notNull(),
    /** Time of the latest (re-)registration; the device cap drops the smallest values first. */
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('push_subscriptions_member_idx').on(t.memberId)],
)
