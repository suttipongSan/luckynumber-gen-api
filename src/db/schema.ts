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
    /**
     * The "แสดงบนเว็บผลหวย" switch: whether the free public results site shows this catalog lottery.
     * Only a catalog lottery (owner_member_id IS NULL) that is `active` AND `publicEnabled` is ever
     * published (src/lib/publicSnapshot.ts); a member's own lottery never is, whatever this says.
     */
    publicEnabled: integer('public_enabled', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [index('lotteries_owner_idx').on(t.ownerMemberId)],
)

/**
 * When a catalog lottery draws and which numbers it publishes, for the public results site. One row
 * per draw time of the lottery: `drawTime` is "HH:MM" (Asia/Bangkok) or '' for a lottery that draws
 * once a day, and matches lottery_results.draw_time, so a result finds its schedule row. A lottery
 * without a row for a draw time uses the defaults (every day, the three default expected fields).
 * `resultTime` is "HH:MM" Bangkok: when the result is expected ("ออกผลประมาณ ..."). `days` is the
 * weekdays it draws, one digit each, 1 = Monday .. 7 = Sunday (default every day). `expectedFields`
 * is the comma separated subset of top3 / top2 / bottom2 the draw publishes, in that order: a draw
 * whose result has all of them is "final", otherwise "partial". `closedDate` (YYYY-MM-DD) is the
 * "no draw on this date" switch of the back office. Deleted explicitly with the lottery.
 */
export const lotterySchedules = sqliteTable(
  'lottery_schedules',
  {
    lotteryId: text('lottery_id')
      .notNull()
      .references(() => lotteries.id, { onDelete: 'cascade' }),
    drawTime: text('draw_time').notNull(),
    resultTime: text('result_time').notNull(),
    days: text('days').notNull().default('1234567'),
    expectedFields: text('expected_fields').notNull().default('top3,top2,bottom2'),
    closedDate: text('closed_date'),
  },
  (t) => [primaryKey({ columns: [t.lotteryId, t.drawTime] })],
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

/**
 * Content blocks of the public landing page, edited in the back office. `kind` 'article' is a
 * full article (card on the landing page + its own public page), 'howto' is a numbered step.
 * `title` / `body` are PLAIN TEXT, never HTML. `imageKey` is the R2 file name under `landing/`
 * (null = no image): the cover picture of an article, the picture of a step. Ordered by
 * `sortOrder` within a kind; the single-value texts and the two header images live in
 * site_settings (see src/lib/landing.ts). Not linked to any other table.
 *
 * For kind 'article': title = headline, body = short summary shown on the card, imageKey = cover
 * picture, `contentHtml` = the long text. A 'howto' row keeps slug NULL, contentHtml '' and
 * publishedAt NULL.
 */
export const landingItems = sqliteTable(
  'landing_items',
  {
    id: text('id').primaryKey(),
    kind: text('kind', { enum: ['article', 'howto'] }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    imageKey: text('image_key'),
    sortOrder: integer('sort_order').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    /** Address of the article page (/articles/<slug>). Unique among the non-NULL values. */
    slug: text('slug'),
    /**
     * The long text as HTML. ALWAYS the output of sanitizeHtml (src/lib/sanitizeHtml.ts): the API
     * sanitizes on every write. '' = none, the article page then shows `body` as plain text.
     */
    contentHtml: text('content_html').notNull().default(''),
    /** ISO-8601 UTC timestamp shown on the article (NULL = no date). */
    publishedAt: text('published_at'),
  },
  (t) => [
    index('landing_items_kind_sort_idx').on(t.kind, t.sortOrder),
    // Two articles can never share an address; rows without a slug (steps) are not constrained.
    uniqueIndex('landing_items_slug_unique_idx').on(t.slug).where(sql`slug IS NOT NULL`),
  ],
)

/**
 * The result of one draw, in two kinds told apart by `memberId`:
 *   - OFFICIAL (memberId ''): entered by the back office or the results robot (PUT /results), for
 *     a catalog lottery (owner_member_id IS NULL), read by every member (GET /results).
 *   - PERSONAL (memberId = a member): typed by that member (PUT /results/mine) for any lottery they
 *     can see, an active catalog lottery or one of their own. Only that member ever reads it, and
 *     for them it hides the official result of the same lottery and date; the back office never
 *     lists or deletes it.
 * One row per (lottery, Thai date, draw time, kind); `drawTime` is "HH:MM" (Asia/Bangkok) or ''
 * for a lottery that draws once a day. `top3` (3 ตัวบน, exactly 3 digits), `top2` (2 ตัวบน) and
 * `bottom2` (2 ตัวล่าง, exactly 2 digits) are NULL while unknown; the API never stores a row
 * without at least one of them. No row = no result yet.
 *
 * `memberId` is '' for an official row and not NULL, because a unique index treats NULLs as
 * distinct (two official rows for one draw would be allowed). There is no foreign key on it ('' is
 * no member); a member's personal rows are deleted explicitly with the member (see admin.ts) and
 * a lottery's rows, of both kinds, with the lottery (see admin.ts, lotteries.ts).
 */
export const lotteryResults = sqliteTable(
  'lottery_results',
  {
    id: text('id').primaryKey(),
    lotteryId: text('lottery_id')
      .notNull()
      .references(() => lotteries.id, { onDelete: 'cascade' }),
    /** Thai calendar day, YYYY-MM-DD. */
    drawDate: text('draw_date').notNull(),
    /** "HH:MM" or '' (one draw a day). Part of the unique key, so it can never be NULL. */
    drawTime: text('draw_time').notNull(),
    /** '' = the official result; otherwise the member who typed it (a personal result). Part of the unique key. */
    memberId: text('member_id').notNull().default(''),
    top3: text('top3'),
    top2: text('top2'),
    bottom2: text('bottom2'),
    /** Free text saying where the numbers came from (robot name, "manual" ...). Back office only; NULL on a personal row. */
    source: text('source'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    // The upsert target of PUT /results and PUT /results/mine: one result per draw and kind.
    uniqueIndex('lottery_results_draw_unique_idx').on(t.lotteryId, t.drawDate, t.drawTime, t.memberId),
    // Serves GET /results?date= (the official rows and the member's own: member_id IN ('', me)),
    // GET /admin/results?date= (member_id = '') and the delete of a member's personal rows.
    index('lottery_results_member_date_idx').on(t.memberId, t.drawDate),
    // Serves "the official rows of one lottery, newest first" (the public results snapshot, the
    // import's lookup of existing rows, the dates a lottery has results on) without reading or
    // sorting the members' personal rows: WHERE lottery_id = ? AND member_id = '' ORDER BY draw_date
    // DESC, draw_time DESC. Added by migration 0010.
    index('lottery_results_official_idx').on(t.lotteryId, t.memberId, t.drawDate, t.drawTime),
  ],
)

/**
 * The numbers a member last drew for one card, so the pages can show them again after a reload
 * (they used to live only in the browser). Written by POST /render/numbers when the request names
 * a `scope`, read by GET /draws. `scope` is 'single' (the single-card page) or the id of a set (a
 * section of the multiple page; no foreign key is possible for that, so deleting a set deletes its
 * rows explicitly, see sets.ts). `cardDate` is the card date (YYYY-MM-DD) of the request;
 * `numbers` is the JSON of CardNumbers exactly as the request returned it. A new สุ่ม overwrites
 * the row; rows whose `updatedAt` is older than 14 days are deleted by the cron (src/lib/draws.ts).
 *
 * Unlike the other tables this one is write-heavy (a page of the multiple page saves up to ~140
 * rows) and D1 counts every index entry as a row written, so it keeps only the indexes the hot
 * paths need: the primary key (the overwrite) and one for the read. There is deliberately NO
 * foreign key on lottery_id (it would need an index of its own, or every lottery delete would scan
 * this table) and no index for the cleanup (the cron scans the table once a day). The rows of a
 * member / a lottery are deleted explicitly instead (see admin.ts, lotteries.ts).
 */
export const memberDraws = sqliteTable(
  'member_draws',
  {
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    lotteryId: text('lottery_id').notNull(),
    cardDate: text('card_date').notNull(),
    numbers: text('numbers').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memberId, t.scope, t.lotteryId, t.cardDate] }),
    // Serves GET /draws (one member, one card date, optional scopes, ordered by scope then lottery)
    // without reading the member's other days: the primary key starts with the scope, not the date.
    index('member_draws_member_date_idx').on(t.memberId, t.cardDate, t.scope, t.lotteryId),
  ],
)
