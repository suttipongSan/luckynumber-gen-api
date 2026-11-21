# numbergen-api

NumberGen phase 2 API: Hono on Cloudflare Workers, TypeScript, Drizzle ORM + Cloudflare D1 (SQLite),
Cloudflare R2 for member assets, zod validation, vitest tests.

The HTTP contract is `../numbergen/API.md` and the agreed design is `../numbergen/DESIGN.md`.

**Split (2026-11-21).** The official lottery results and everything that feeds the free public results site moved to a Worker of
its own, **`numbergen-results-api`** (repo `../numbergen-results-api`, Worker `results-api`), on the same D1 database. This API keeps
the members, cards, sets, assets, landing page, push reminders, saved draws, the lottery **catalogue** admin, `GET /results` and the members'
own results, the admin login, the database **schema and its migrations**, and one new endpoint, `GET /admin/results-token`. See
"Public results and the results API" below for who owns what, the token flow, the local run and the deploy order.

## Layout

```
src/index.ts            app, CORS (WEB_URL + http://localhost:5173, credentials), error handler
src/types.ts            shared API types (mirror of web src/api/types.ts) + limits
src/validation.ts       zod schemas (passthrough CardSettings with API.md bounds)
src/db/schema.ts        Drizzle tables (DESIGN.md data model)
src/db/catalog.ts       lottery catalog (seed data, 82 lotteries in 5 groups)
src/db/client.ts        getDb(env): D1 binding in Workers, libSQL file DB in Node tests
src/lib/chunk.ts        splits IN lists / multi-row inserts under D1's 100-parameter limit
src/lib/crypto.ts       PBKDF2 passwords, constant-time compare, HMAC, signed asset URLs
src/lib/session.ts      ng_session / ng_admin cookies (signed id + DB row, 24 h, not refreshed)
src/lib/numbers.ts      number generation: running digits, top, 2 ตัว / 3 ตัว row rules, drill, win, เลขเด่น ("Number generation" below)
src/lib/ids.ts          16-char base62 ids, 32-char tokens
src/lib/loginLimiter.ts 5 wrong passwords → 429 for 15 min (login_attempts table)
src/lib/siteSettings.ts site_settings key whitelist, compiled-in defaults, effective-limit helpers
src/lib/landing.ts      public landing page: landing_* settings keys + defaults, R2 image names / URLs, image signature check, article slugs, loaders, row -> JSON
src/lib/sanitizeHtml.ts allowlist HTML sanitizer for the long text of an article (tokenizer + element stack, no DOM, linear time)
src/lib/webpush.ts      Web Push for Workers (WebCrypto only): VAPID JWT, RFC 8291 encryption, push-service allow-list, sender
src/lib/reminders.ts    the per-minute cron: cursor, "who is due" query, notification text, sending, cleanup
src/lib/results.ts      lottery results as members meet them: row -> JSON, the upsert of a personal result, which results a member reads (their own win over the official one)
src/lib/draws.ts        a member's last drawn numbers (member_draws): save, read, the daily 14-day cleanup
src/lib/publicChange.ts    DB-only record of a catalogue change for the public results site (results_version + dirty marks); the results API publishes it
src/lib/adminToken.ts   the signed admin token for the results API (sign here, verify there; IDENTICAL file in both repos)
src/middleware/         memberAuth (session + expiry/disabled check on every call), adminAuth
src/routes/             link, me, bootstrap, contacts, landing, lotteries, news, sets, settings, render, assets, push, notifications,
                        results (GET /results + the members' own results, /results/mine), draws,
                        admin (+ adminLanding, mounted at /admin/landing, behind the same admin guard; GET /admin/results-token)
drizzle/                generated SQL migrations
scripts/                seed-sql (writes seed.sql for D1), hash-password, vapid-generate, db (test helpers)
test/                   vitest (test/helpers/officialResult.ts puts an official result in the database, the way the results API stores one): numbers, crypto/signed URLs, app (app.request + file:test.db + fake R2),
                        notifications (reminder + push endpoints), reminders (cron logic), webpush (RFC 8291 / VAPID),
                        landing (public landing page + its back office, own file:test-landing.db),
                        articles (article pages: migration 0007, slug / long text / date rules, own file:test-articles.db),
                        results (GET /results, migrations 0008 / 0009, a catalog lottery delete taking its results, own file:test-results.db),
                        memberResults (the members' own results: PUT / DELETE /results/mine, precedence over the official result, isolation, cascades, own file:test-memberresults.db),
                        draws (saved draws, GET /draws, the 14-day cleanup, cascades, own file:test-draws.db),
                        migration0010 (the schema of the public results site, which this repo owns),
                        catalogueRecording (a catalogue change is RECORDED in D1 and never published here: the cross-check vector shared with the results API, which changes count, no bucket access),
                        adminToken (the token format, the cross-check vector shared with the results API) / resultsToken (GET /admin/results-token),
                        sanitizeHtml (the HTML sanitizer: adversarial tables, random inputs, linear-time checks)
```

## Setup

```powershell
npm install
npm run db:migrate    # applies drizzle/ migrations to the local D1 copy (.wrangler/state)
npm run seed          # lottery catalog + demo member into local D1
```

The demo member link is `http://localhost:5173/m/demo0000000000000000000000000000` (name
`สมาชิกทดสอบ`, no password, expires in 30 days). Re-running `npm run seed` is safe: existing lotteries
are left as they are, and the demo member's password is cleared and its expiry reset.
Local admin login is `admin` / `admin1234` (hash in `.dev.vars`).

## Local development

`.dev.vars` holds the local secrets (git-ignored). A ready-made one is in the repo folder;
`.dev.vars.example` documents every variable. To recreate it, copy the example, fill in random
secrets and paste a hash from `npm run hash-password -- admin1234` (keep it in single quotes).

```powershell
npm run dev    # the Worker on http://localhost:8787; D1 and R2 are simulated locally by wrangler
```

`.dev.vars` also needs `RESULTS_ADMIN_SECRET` (at least 32 characters, the same value as in the `.dev.vars` of `numbergen-results-api`) for
`GET /admin/results-token`; `.dev.vars.example` documents it. The results API runs next to this one on **http://localhost:8788** (see "Public results and the
results API"). Local ports: this API 8787, the results API 8788, the web app 5173; the results site runs on its own dev server.

Tests run in Node against a libSQL file DB (`file:test.db`) with the same schema and migrations.

Quick check:

```powershell
curl http://localhost:8787/health
curl http://localhost:8787/link/demo0000000000000000000000000000
```

Other scripts:

| script | what it does |
|---|---|
| `npm run typecheck` / `npm run build` | `tsc --noEmit` |
| `npm test` | vitest (node environment, no Workers runtime needed) |
| `npm run db:generate` | generate a new migration in `drizzle/` after editing `src/db/schema.ts` |
| `npm run db:migrate` / `db:migrate:remote` | apply `drizzle/` migrations to local / production D1 |
| `npm run seed` / `seed:remote` | lottery catalog (+ demo member locally only) into local / production D1 |
| `npm run hash-password -- <password>` | print a PBKDF2 hash for `ADMIN_PASSWORD_HASH` |
| `npm run vapid:generate` | print a fresh Web Push (VAPID) key pair and the `wrangler secret put` commands; writes no file |

## Production

Live on the operator's Cloudflare account (all free plan):

| Piece | Resource |
|---|---|
| Worker | `numbergen-api` → https://api.pnphoto.co |
| Database | D1 `numbergen` (binding `DB`, APAC) |
| Files | R2 bucket `numbergen-assets` (binding `ASSETS`, private; member assets are only served through signed URLs, and only the `landing/` prefix is public, through `GET /landing/image/:name`) |
| Results API | Worker `results-api` (repo `../numbergen-results-api`): the official results, `/admin/public/*`, the snapshot files in R2 `pnresult-public` and their cron. Same D1 database; this Worker has no binding to that bucket. See "Public results and the results API" |
| Web origin | `WEB_URL` in wrangler.toml → https://pnphoto.co (comma-separated list; first one is used in member links) |

Secrets: `SESSION_SECRET`, `ASSET_SIGNING_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`
(`npx wrangler secret put <NAME>`). Full step-by-step guide: `../numbergen/DEPLOY.md`.
For daily reminders also set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (`npm run vapid:generate` prints
both and the commands); `VAPID_SUBJECT` (a `mailto:` or `https:` contact, default `https://pnphoto.co`) is optional.
`wrangler.toml` has a cron trigger that runs every minute; the reminders do nothing until both VAPID keys exist. The same
trigger deletes the saved draws older than 14 days once a day (03:17 Bangkok time), which needs no key. (Publishing the public
results is the results API's cron, not this one.)
For the results API set `RESULTS_ADMIN_SECRET` (at least 32 characters, for example
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`): it signs the 10 minute tokens of `GET /admin/results-token`
and must be **exactly the same** on `results-api`. Without it that endpoint answers `503 RESULTS_TOKEN_NOT_CONFIGURED`.
Secrets belong to one Worker each, so the test Worker (`--env test`) needs its own copy of every secret it should have,
`RESULTS_ADMIN_SECRET` included: `npx wrangler secret put RESULTS_ADMIN_SECRET` and `npx wrangler secret put RESULTS_ADMIN_SECRET --env test`
(the results API serves both back offices). The results robot's `RESULTS_API_KEY` is the results API's now: once the robot calls that
API, remove the old copies from this repo's Workers (`npx wrangler secret delete RESULTS_API_KEY`, and `--env test`).
For local development put `RESULTS_ADMIN_SECRET=...` in `.dev.vars` (`.dev.vars.example` documents it).
`TEST_STACK` is a plain var (not a secret) that is the string `"true"` (quoted; a TOML boolean does not count) only
on the separate test Worker `numbergen-api-test` (https://api-test.pnphoto.co: the same code deployed with
`wrangler --env test`, same D1 database). Leave it unset everywhere else, including the live Worker; see
"Test site switch" under Behaviour notes. The test Worker has no schedule: only production sends the reminders and cleans up the draws.

```powershell
npm run db:migrate:remote   # after adding a migration
npm run deploy              # runs db:migrate:remote first (predeploy), then wrangler deploy
```

D1 free-plan limits the code respects: at most 100 bound parameters per statement and 50 statements
per request (each statement in a batch counts). Use `src/lib/chunk.ts` for long `IN` lists and
multi-row inserts.

## Behaviour notes

- **Sessions**: the cookie value is `<sessionId>.<HMAC(SESSION_SECRET)>`, and the session row in the DB expires
  after 24 h and is never refreshed. Member expiry and the disabled flag are checked on every authenticated request.
  `/me`, `/logout` and `/news` keep working for expired or disabled members, and everything else returns
  403 `EXPIRED` / `DISABLED`.
- **Login limit**: 5 wrong passwords for one link token lock it for 15 minutes (the 5th try already
  returns 429). The back office login has the same limit per client IP (`CF-Connecting-IP`). Counters live in
  the `login_attempts` table (migration `0001_auth_hardening`, not in DESIGN.md's table list) so the lock holds
  across all Worker isolates. A password reset or member delete clears the link's counter.
- **Default set**: a partial unique index (`sets_one_default_idx`) allows one Default set per member, so two
  concurrent first `GET /sets` calls cannot create two.
- **Render limit**: each `POST /render/numbers` call counts `items.length` renders against the
  per-member daily cap, computed as `members.render_limit ?? site_settings.render_limit_default
  ?? RENDERS_PER_DAY (600)`. The counter is incremented atomically in a single upsert whose
  `setWhere` checks the effective limit (bound as a parameter); an over-limit request is a
  SQLite no-op (no row modified → `changes() = 0`) and the guarded `members.renders_total`
  update is skipped. The limit is read in the same read batch as the lottery/settings/assets
  queries (one D1 round trip, no extra sequential hop on the hot path). Admin overrides are
  set via `PATCH /admin/members/:id { renderLimit: int | null }`; the back-office default is
  set via `PUT /admin/settings { renderLimitDefault }`. A rescue op is available at
  `POST /admin/members/:id/reset-renders` (resets today's counter to 0).
- **CSRF**: on top of CORS, any non-GET request that carries an `Origin` header outside the allow-list is
  rejected with 403. Multipart uploads are "simple" requests and skip the CORS preflight, which is why this check exists.
- **Assets**: png, jpg, webp, gif and avif up to 5 MB, 2 per kind per member. SVG is refused. Kinds are
  `background`, `logo` and `qr` (v2); deleting an asset clears `backgroundAssetId`, `logo.assetId`
  and `qr.assetId` in that member's saved settings.
- **Member delete** removes the member's sets, settings, assets (DB rows and R2 objects), news reads,
  render counters, sessions, reminder lines, saved draws, push devices and v2 custom lotteries (and the set_lotteries /
  card_settings / member_notifications / member_draws rows for them).
- **Site settings** (admin-editable): `site_settings(key, value, updated_at)` stores contact info
  shown on the lock / renew / no-session screens (Line + Telegram id and URL) and the default
  daily render limit. GET/PUT are at `/admin/settings`; public `GET /contacts` exposes just the
  two channel objects (null when the id is empty) with `Cache-Control: public, max-age=60`.
  Every key has a compiled-in default (`src/lib/siteSettings.ts`) so a fresh DB keeps working.
  The landing page values also live in `site_settings`, but under their own `landing_*` keys that are NOT in this
  whitelist, so these endpoints and the `AdminSettings` shape do not change (see "Landing page" below).
- **Test site switch**: `site_settings` key `testsite_enabled` (`"true"` or `"false"`; no row = on). `GET` and
  `PUT /admin/settings` carry it as `testsiteEnabled: boolean`. On PUT it is optional: leaving it out leaves the stored
  value alone, so an older back office build that does not send it can never flip it. Only the exact text `"false"`
  means off. `src/middleware/testStack.ts` (registered right after CORS in `src/index.ts`) enforces it, and only on the
  test Worker, the one with the var `TEST_STACK = "true"`: while the switch is off, EVERY request to that Worker gets
  `503 {"error":{"code":"TESTSITE_OFF","message":"เว็บทดสอบปิดอยู่"}}`, with the CORS headers so the browser can read
  it (the OPTIONS preflight is still answered by CORS). The switch is cached in module memory for 15 seconds at most
  (per Worker isolate), so a flip shows within about 15 s; if the database read fails the test stack counts as on, and
  the failure is not remembered. Without `TEST_STACK` (live Worker, local dev, tests) the middleware does nothing and
  reads nothing. The cron trigger is not an HTTP request and is not gated.

## Number generation (2 ตัว, 3 ตัว, เลขเด่น)

`src/lib/numbers.ts` draws every number of a card for `POST /render/numbers`. The two running digits
(เลขวิ่ง / รูด) are always distinct; call them r1 and r2 (a digit fixed in the request or in the saved
`fixedRunning1/2` is used slot by slot, the rest is random). The rules apply to every card; there is no
per-lottery switch.

| Block | exactly 1 row | 2 or more rows |
|---|---|---|
| 2 ตัว (`two`, 2-digit numbers) | every number starts with r1 or r2 | row 1 starts with r1, row 2 starts with r2, rows 3 and beyond are any 2-digit number (00-99) |
| 3 ตัว (`three`, 3-digit numbers) | every number contains r1 or r2 (any position) | row 1 contains r1, row 2 contains r2 (any position), rows 3 and beyond are any 3-digit number (000-999) |

With r1 = 8, r2 = 1, the default เลขเด่น `81` and three rows of three, 2 ตัว could be
`82 85 80 / 14 17 19 / 87 29 60` (never 81 or 18, see "เลขเด่น and 2 ตัว" below).

- `isDouble` off keeps 00, 11 .. 99 out of every 2 ตัว row and `allowTriple` off keeps 000, 111 .. 999 out of
  every 3 ตัว row, the random rows included.
- No number appears twice in one block (across all its rows).
- Each row is a uniform random sample, without replacement, of the numbers its rule allows that the earlier
  rows have not taken, less the numbers the เลขเด่น rule below keeps out of 2 ตัว. The random rows sample
  everything that is left.
- `two` and `three` come back as one inner array per row, and every row holds exactly `perRow` numbers, so the
  rows of the card never shift (`top`, `drill` and `win` stay flat lists). `row` is validated to 0..6 and `perRow`
  to 1..6, and the smallest pool of a rule row is 9 numbers (row 1 or 2 of 2 ตัว with `isDouble` off, 10 with it
  on; 8 and 9 when the เลขเด่น rule takes one of them out), so every allowed `perRow` fits and nothing is ever
  padded. If a direct caller of `generateCardNumbers` asks for a `perRow` above a rule row's pool (9 numbers, 10
  with `isDouble`, one fewer when the เลขเด่น rule takes one out), the row keeps its whole pool and the missing slots
  are topped up with unused numbers of any kind (the switches, the no-repeat rule and the เลขเด่น rule still apply).
  A block that asks for more numbers than exist (above 90 / 100 two-digit, 990 / 1000 three-digit, less the numbers
  the เลขเด่น rule keeps out) comes back short.
- เลขเด่น (`single`): 2 digits (the default) is r1 followed by r2, so r1 = 8 and r2 = 1 give `81` (never a double,
  `isDouble` does not matter); 1 digit is one of the running digits at random; 3 digits is a random 3-digit number
  containing r1 or r2 (a triple only with `allowTriple`). A valid `fixedSingle` (digits only, exactly `singleDigits`
  long) always wins.
- เลขเด่น and 2 ตัว: when the เลขเด่น has 2 digits (a valid 2-digit `fixedSingle`, else r1 followed by r2), the 2 ตัว
  block never contains that number or its reverse, in any row (rows 3 and beyond and any top-up included). With
  รูด 4 - 1 and เลขเด่น 41, neither 41 nor 14 appears in 2 ตัว; a fixed `93` keeps out 93 and 39, whatever the running
  digits are. A number that is its own reverse, such as a fixed `77`, keeps out only itself (a repeated-digit number
  is out already while `isDouble` is off). The เลขเด่น is settled before 2 ตัว is drawn and exactly that value comes
  back as `single`; every other allowed number stays equally likely. The API cannot tell whether the card shows the
  เลขเด่น element (`elements.single.visible` is not read), so the rule holds for a hidden เลขเด่น too. With a 1 or 3
  digit เลขเด่น nothing changes: 2 ตัว is drawn as before (r1 r2 and r2 r1 may appear), and 3 ตัว is never affected.
- `top` (cycles r1, r2), `drill` (one prefix digit from `drillPrefixFrom`, at most 9 numbers) and `win` (distinct
  digits that include the running or top digits) are unchanged. With `drillPrefixFrom: "two"` the prefix is the first
  digit of the first 2 ตัว number, which is now r1 (r1 or r2 when 2 ตัว has a single row).
- `runningDouble` is a display-only card setting (optional boolean, default false): the card draws each running digit
  twice, `8 - 1` becomes `88 - 11`. It is validated and stored with the other card settings (`PUT /settings`,
  `PUT /settings/:lotteryId`, and the `settings` override of `POST /render/numbers`); the generator ignores it, so the
  running digits and every number are the same with it on or off.

## v2 additions (2026-11-07)

Five member-review requests (see `../numbergen/API.md` "v2 additions" for the contract).

- **F2 QR code image**: `POST /assets` accepts `kind=qr` (2 per kind, like the other kinds); `CardSettings.qr`
  is validated the same way as `logo`; `POST /render/numbers` signs `qr.assetId`; `DELETE /assets/:id`
  clears it.
- **F4 rounds**: `set_lotteries.round INTEGER NOT NULL DEFAULT 1` (1..20); `LotterySet.rounds`
  parallels `lotteryIds`; `PATCH /sets/:id { rounds? }` must be sent together with `lotteryIds` and
  match its length. `set_lotteries` inserts are chunked at 25 rows (4 params each → 100 bound params).
- **F5 member-created lotteries**: `lotteries.owner_member_id TEXT NULL` (+ index). `GET /lotteries`
  returns active global lotteries plus every lottery owned by the caller, sorted by `GROUP_ORDER` then
  `sortOrder`. `POST /lotteries { name, shortName?, group }` creates one (id `m-<16>`, accent from the
  group palette, sortOrder 10000+, 30-per-member quota → 409 `QUOTA`); `PATCH /lotteries/:id` and
  `DELETE /lotteries/:id` operate on own lotteries only (delete cascades `set_lotteries` and
  `card_settings`). Every member-side lottery lookup (sets, single and bulk settings, render) accepts
  only global ids or the member's own via `memberLotteryIds`; another member's custom id behaves like
  an unknown id. `/admin/lotteries` lists and edits global lotteries only; admin member delete also
  drops that member's custom lotteries and their references.

## Daily reminders (เวลาลง, 2026-11-13)

A reminder per lottery at its "time to post", **HH:MM in Asia/Bangkok**, delivered as Web Push to the member's
registered browsers (works with the site closed). The web app additionally shows an in-app card while it is open.

**Data** (migration `0005_add_push_reminders`). `lotteries.notify_time` / `notify_enabled` are the admin default for a
catalog lottery. `member_notifications(member_id, lottery_id, notify_time, enabled, last_sent_day, updated_at)` holds a
member's own lines. `push_subscriptions(id, member_id, endpoint UNIQUE, p256dh, auth, created_at)` holds browsers.
Foreign keys are declared, but like everywhere else deletes are cascaded explicitly in code (member delete, admin
lottery delete and member lottery delete remove the new rows too).

**Effective setting** of a (member, lottery): the member's own row if it exists (it wins, even when it is off),
otherwise, for catalog lotteries only, the admin default. Private lotteries have no default (off, no time). Inactive
catalog lotteries never fire. Members who never saved have no rows and follow the default.

| Endpoint | Auth | Body and response |
|---|---|---|
| `GET /push/key` | none | `200 {publicKey}` (base64url VAPID public key); `503` when push is not configured |
| `POST /push/subscribe` | member | `{endpoint, keys: {p256dh, auth}}` gives `{ok: true}` |
| `DELETE /push/subscribe` | member | `{endpoint}` gives `{ok: true}` (only the caller's own device; anything else is a no-op) |
| `GET /notifications` | member | `{items: [{lotteryId, name, groupKey, own, notifyTime, enabled, saved}]}`, one per lottery the member can see, in `GET /lotteries` order; `saved` = the member has their own row |
| `PUT /notifications` | member | `{items: [{lotteryId, notifyTime: "HH:MM" or null, enabled}]}`, answers like GET. Every listed line is stored as the member's own (upsert); lines not listed are left as they are |
| `GET /admin/lotteries` | admin | the existing list, plus `notifyTime` and `notifyEnabled` per lottery |
| `POST /admin/lotteries`, `PATCH /admin/lotteries/:id` | admin | additionally accept optional `notifyTime` ("HH:MM" or null) and `notifyEnabled` (boolean) |
| `PUT /admin/notifications` | admin | `{items: [{lotteryId, notifyTime, enabled}]}` gives `{ok: true}`; catalog lotteries only (inactive ones included) |

Rules: `notifyTime` matches `^([01]\d|2[0-3]):[0-5]\d$`; `enabled: true` needs a time (400, also for the state a PATCH
would leave behind); at most 500 lines per request and no duplicate `lotteryId` (a 400 writes nothing). A member can
only save lotteries they can see (active catalog + their own): a line for any other id (unknown, someone else's, switched
off, or deleted while the page was open) is skipped and the rest is saved, so the answer, which is the refreshed list,
just no longer has that lottery. Expired and disabled members get 403 `EXPIRED` / `DISABLED` like on every other member route.
Subscribing: `endpoint` must be an https URL, without credentials or port, on a known push service
(`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`,
`*.push.apple.com`), so the Worker can never be made to POST elsewhere; `p256dh` must be a base64url 65-byte P-256 point
(checked to be on the curve) and `auth` a base64url 16-byte secret. A member keeps at most 10 devices (the oldest
registration is dropped); an endpoint registered to another member moves to the caller.

**Push message** (JSON, encrypted per RFC 8291): `{title, body, lotteryIds, url}`. One lottery: title
`ถึงเวลาลง {name}`, body `แตะเพื่อเปิดหวยนี้`. Several due in the same run for one member: ONE message, title
`ถึงเวลาลง {n} หวย`, body the names joined with `, ` (cut to whole names plus `และอีก N หวย` beyond 120 characters).
`url` is `<first WEB_URL origin>/?lottery=<first lotteryId>`. Sent with `TTL: 600`, `Urgency: high`,
`Content-Encoding: aes128gcm` and a VAPID `Authorization` (ES256 JWT, 12 h, `aud` = the push service origin).

**The cron** (`src/lib/reminders.ts`, every minute). The last processed Bangkok minute is a cursor row in
`site_settings` (`notify_cursor`, `YYYY-MM-DDTHH:MM`). A run handles the minutes in (cursor, now] (first run: only the
current minute; never more than 5 minutes back; never before today's 00:00) and moves the cursor with a
compare-and-set BEFORE it sends, so overlapping runs cannot both send. A run that dies after claiming loses those
reminders; they are not retried. Who is due is one set-based query (the member's own enabled lines, plus the due admin
defaults for members without a line), limited to members that are not disabled, not expired and have a device.
Sends run 6 at a time and at most 40 per run (a Worker invocation allows 50 subrequests on the free plan, shared with
its D1 calls; raise `MAX_SENDS_PER_RUN` on the paid plan); when the cap is hit the run logs what it dropped. A failing
send never stops the others; devices answering 404 or 410 are deleted; `last_sent_day` is stamped on the existing
member rows that fired (informational). Logs name the push service host, never the endpoint URL.

## Landing page (2026-11-14)

A public page for visitors who have no member session (pnphoto.co). Its content is edited in the back office and the
web app only reads it. Code: `src/lib/landing.ts` (keys, defaults, image names and signatures, loaders, row -> JSON),
`src/routes/landing.ts` (public) and `src/routes/adminLanding.ts` (back office, mounted by `admin.ts` under
`/admin/landing` after the admin guard, so the session and CSRF rules are the same as for the rest of `/admin`).

**Data** (migration `0006_add_landing_page`, additive only).

- `landing_items(id, kind 'article' | 'howto', title, body, image_key, sort_order, active, created_at, updated_at)` with an
  index on `(kind, sort_order)`. The migration seeds three articles and three how-to steps (`landing-article-1..3`,
  `landing-howto-1..3`) so the page is not empty at launch. `title` and `body` are **plain text, never HTML**: they are
  stored and returned as typed (after trimming), and clients must render them as text. Migration `0007_add_article_pages`
  added `slug`, `content_html` and `published_at` (see "Articles as full pages" below).
- The single values are `site_settings` rows under `landing_*` keys. They are kept in their own list
  (`LANDING_SETTING_KEYS`), not in `SITE_SETTING_KEYS`, so `GET/PUT /admin/settings` and `AdminSettings` do not change.
  Every key has a compiled-in default, so a database with none of these rows (fresh, or before an admin saved anything)
  still serves a complete page. Only a missing row falls back to the default; a saved empty string stays empty.

| Key (`PUT` field) | Default | Rule |
|---|---|---|
| `landing_hero_color` (`heroColor`) | `#7c2d12` | exactly `^#[0-9a-fA-F]{6}$`, stored as typed |
| `landing_hero_title` (`heroTitle`) | `โปรแกรมทำใบใบ้หวย สวย ไว ในคลิกเดียว` | up to 120 characters, may be empty |
| `landing_hero_subtitle` (`heroSubtitle`) | `สุ่มเลข จัดหน้าตา ดาวน์โหลดพร้อมโพสต์ ครบทุกหวยทุกรอบ` | up to 200, may be empty |
| `landing_articles_title` (`articlesTitle`) | `ทำไมต้อง PNPHOTO` | up to 120, may be empty |
| `landing_articles_subtitle` (`articlesSubtitle`) | empty | up to 200 |
| `landing_howto_title` (`howtoTitle`) | `วิธีใช้งาน` | up to 120, may be empty |
| `landing_howto_subtitle` (`howtoSubtitle`) | `เริ่มใช้ได้ใน 3 ขั้นตอน` | up to 200, may be empty |
| `landing_logo_image`, `landing_promo_image` | empty | R2 file name; written only by the image endpoints |

The texts are trimmed. A stored hero colour that is not `#RRGGBB` (only possible by editing the database by hand) is
ignored in favour of the default, so the page never receives anything but a plain hex colour.

**Public endpoints** (no auth, no cookies; CORS is the app-level allow-list, like `GET /contacts`):

| Endpoint | Response |
|---|---|
| `GET /landing` | `200 {heroColor, heroTitle, heroSubtitle, logoUrl, promoUrl, articlesTitle, articlesSubtitle, howtoTitle, howtoSubtitle, articles: [{id, title, body, slug, imageUrl, publishedAt}], steps: [{id, title, body, imageUrl}]}` with `Cache-Control: public, max-age=60`. Active items only (an inactive item, and so its image, is never listed), ordered by `sort_order`. The `*Url` fields are absolute URLs (`<origin of the request>/landing/image/<file name>`) or `null`. An article card carries its cover picture, its `slug` (`string \| null`, the address of its page) and `publishedAt` (`string \| null`); the long text is NOT in this list |
| `GET /landing/articles/:slug` | `200 {id, slug, title, body, contentHtml, imageUrl, publishedAt}` with `Cache-Control: public, max-age=60`, for an ACTIVE article with that slug. `404 NOT_FOUND` for an inactive article, a how-to step, an unknown slug and a slug that fails the slug rules (that one without a database lookup). `contentHtml` is sanitized HTML; when it is `""` the page shows `body` as plain text instead. The path has its own `/articles/` segment, so it cannot shadow or be shadowed by `/landing/image/:name` |
| `GET /landing/image/:name` | the image bytes with their content type and `Cache-Control: public, max-age=31536000, immutable` (plus `X-Content-Type-Options: nosniff`). `:name` must match `^[A-Za-z0-9_-]{8,64}\.(png\|jpg\|jpeg\|webp)$`, otherwise 404 without touching R2; the lookup key is always `landing/` + the name. 404 when the object is missing |

**Back office endpoints** (admin session; every one is `401 UNAUTHENTICATED` without it). Types: `AdminLandingSettings` is the
seven text fields plus `logoUrl` / `promoUrl` (`string | null`); `AdminLandingItem` is
`{id, kind, title, body, imageUrl, sortOrder, active, slug, contentHtml, publishedAt}` (`slug` and `publishedAt` are
`string | null`, `contentHtml` a string; for a how-to step they are `null`, `""` and `null`); `AdminLanding` is
`{settings, items}` where `items` are ALL items (active or not) ordered by kind, then `sortOrder`.

| Endpoint | Body and response |
|---|---|
| `GET /admin/landing` | `AdminLanding` |
| `PUT /admin/landing` | any subset of the seven text fields (unknown keys, including `logoUrl` / `promoUrl`, are ignored), all-or-nothing, answers `AdminLanding`. 400 for a bad colour or a too long text |
| `POST /admin/landing/image/:slot` | `slot` is `logo` or `promo` (anything else 404); multipart `file` field; answers `AdminLanding` |
| `DELETE /admin/landing/image/:slot` | clears the slot; answers `AdminLanding` |
| `POST /admin/landing/items` | `{kind, title, body, active?, slug?, contentHtml?, publishedAt?}`: title 1..80, body 0..600 (required, may be `""`), `active` defaults to true; the item is appended at the end of its kind; answers `AdminLandingItem`. For an article: `slug` omitted / `null` / `""` = generated (`a-` + 8 hex characters), `contentHtml` is sanitized (default `""`), `publishedAt` omitted = now, `null` = no date. For a `howto`, sending `slug`, `contentHtml` or `publishedAt` at all is `400`. The 13th item of a kind is `409 QUOTA` (inactive items count); a slug another article has is `409 SLUG_TAKEN` |
| `PATCH /admin/landing/items/:id` | `{title?, body?, active?, slug?, contentHtml?, publishedAt?}` (kind and position cannot be changed here); answers `AdminLandingItem`, 404 when missing. `slug` must be a valid slug (`null` / `""` are `400`: an article always keeps one), `contentHtml` is sanitized (`""` clears it), `publishedAt` is a date-time or `null`. On a `howto` the last three are `400`, whatever the value. A slug another article has is `409 SLUG_TAKEN` and nothing else of that PATCH is applied |
| `DELETE /admin/landing/items/:id` | `204`; also deletes the item's image; 404 when missing |
| `POST /admin/landing/items/:id/image` | multipart `file`; answers `AdminLandingItem` (the cover picture of an article, the picture of a step; both are shown on the public page) |
| `DELETE /admin/landing/items/:id/image` | answers `AdminLandingItem` |
| `PUT /admin/landing/items/order` | `{kind, ids}`: `ids` must be exactly the set of that kind's item ids (400 otherwise, also for duplicates); `sort_order` becomes the position (0, 1, 2 ...); answers the `AdminLandingItem[]` of that kind in the new order |

**Images.** PNG, JPEG or WebP (declared `Content-Type`; SVG, GIF and AVIF are refused), 1 byte to 5 MB (`MAX_ASSET_BYTES`).
The declared type is client-controlled, so the first bytes of the file must also be the file signature (magic bytes) of
that type (PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WebP `RIFF` + 4 size bytes + `WEBP`; `hasImageSignature` in
`src/lib/landing.ts`): text, HTML or another format labelled `image/png` is `400 VALIDATION` before R2 is touched. Files are
stored in the `ASSETS` bucket as `landing/<16 random characters>.<png|jpg|webp>`. Unlike member assets they are public
(no signed URL), which is safe because every upload gets a fresh random name: the bytes behind a name never change, hence
`immutable`. Replacing or removing an image deletes the old object, best effort (a failing R2 delete is logged and never
fails the request). The old name is read in the same D1 batch that writes the new one, so concurrent replacements cannot
orphan a file, and a file whose database write failed is removed again.

**Limits and concurrency.** At most 12 items per kind; the count, the next `sort_order` and the insert are one SQL statement
(atomic under D1's single writer), so parallel creates cannot exceed it or share a position. The request body of
`POST` / `PATCH /admin/landing/items` is capped at 512 KB.

Run `npm run db:migrate` (local) or `npm run db:migrate:remote` / `npm run deploy` (production) to create the table and the
six starter rows (and, with 0007, their addresses and dates).

### Articles as full pages (migration `0007_add_article_pages`, 2026-11-15)

An `article` row is a full article. On the landing page it is a card (cover picture, `title`, `body` as the short
summary) that links to the article page (`GET /landing/articles/:slug`), which shows the formatted long text. A `howto`
row is unchanged. Field meaning for an article: `title` = headline, `body` = summary on the card (plain text),
`image_key` = cover picture, `content_html` = the long text. When `content_html` is empty the article page shows `body` as
plain text instead.

**Data** (additive only, `ALTER TABLE landing_items ADD ...`):

| Column | Meaning |
|---|---|
| `slug TEXT NULL` | the address of the article page; `NULL` for a `howto`. A **partial unique index** `landing_items_slug_unique_idx ON (slug) WHERE slug IS NOT NULL` keeps two articles from sharing one |
| `content_html TEXT NOT NULL DEFAULT ''` | the long text as sanitized HTML (`""` = none). Written only through `sanitizeHtml`, on every write |
| `published_at TEXT NULL` | ISO-8601 UTC timestamp shown on the article |

The migration also has a hand-written data step that works on a database where 0006 is already applied, whatever an admin
did to the rows since: `landing-article-1..3` get the slugs `all-lotteries`, `customize-card` and `notify-time` (only where
the row still exists, is still an article and has no slug, so an edited row keeps its new text and a deleted one is
skipped); every other article gets `a-` + 8 random lower case hex characters (`lower(hex(randomblob(4)))`); every article
without a date gets `published_at = created_at`. Steps are not touched. The migration was generated by `drizzle-kit`
(`src/db/schema.ts`, `drizzle/meta/0007_snapshot.json` and `_journal.json` are in sync) and the data step added by hand.

**Slugs.** `^[a-z0-9]+(?:-[a-z0-9]+)*$`, 3..80 characters (lower case letters and digits in groups joined by single
hyphens). Anything else is `400 VALIDATION` (a slug is never lower-cased or trimmed for you). On create a missing / `null` /
`""` slug is generated; a generated one that happens to clash is drawn again (up to 5 times). Uniqueness is decided by the
unique index, not by a check before the write: when two requests race for one slug, the loser's `INSERT` / `UPDATE` fails
with the constraint error and the route answers `409 SLUG_TAKEN` (Thai message). `GET /landing/articles/:slug` answers 404
for a slug that fails the rules without querying the database.

**`publishedAt`.** A strict ISO-8601 date or date-time: `2026-11-14`, `2026-11-14T10:30`, `2026-11-14T10:30:00.123Z`,
`2026-11-14T17:30:00+07:00` (a space instead of `T` is accepted too). Real days and times only (no February 30, no
`24:00`); free-form text such as `Nov 14` is refused even though `Date.parse` would take it. A value without a zone is
read as UTC, so the result does not depend on the time zone of the server. It is stored and returned as a UTC
`toISOString()` string.

**`contentHtml` and the sanitizer** (`src/lib/sanitizeHtml.ts`). The API accepts any HTML text and stores only the
sanitized result; the web app runs an allowlist sanitizer with the same rules again before it renders.

- Allowed tags: `p br strong b em i u h2 h3 ul ol li blockquote a`. Output tag names are lower case and `<br>` is the void
  form.
- Allowed attribute: only `href` of an `<a>`, and only an absolute `http://`, `https://` or `mailto:` URL. It is judged the
  way a browser reads it (character references decoded, tab / CR / LF ignored, control characters and spaces around it
  stripped), so `jav&#x09;ascript:`, `&#106;avascript:` or a leading control character do not get through; any other value
  (`javascript:`, `data:`, `vbscript:`, a relative URL, no value) unwraps the `<a>` and keeps its text. Every kept `<a>`
  gets `rel="noopener noreferrer nofollow" target="_blank"` from the sanitizer, whatever the input said. All other
  attributes (`style`, `class`, `id`, `on*` ...) are dropped.
- Any other tag is removed and its text kept (`<div>`, `<span>`, `<h1>`, `<table>` ...), EXCEPT these, whose whole content
  goes with them: `script style iframe object embed svg math template noscript title textarea select option form input
  button link meta base head img video audio source picture canvas`. Comments, CDATA, doctype and processing instructions
  are dropped.
- The output is well formed (an unclosed tag is closed at the end, a stray end tag is dropped; a block closes an open `<p>`,
  an `<li>` closes an `<li>`, a heading closes a heading, an `<a>` closes an `<a>`) and `& < > "` are
  escaped in text and in the `href` (a no-break space stays one raw character, like in the web app's serializer, so the
  length the editor counts is the length that is stored). NUL and other control characters are removed. Leading / trailing whitespace is trimmed,
  so a text with nothing visible comes out as `""`.
- It is idempotent (`sanitizeHtml(sanitizeHtml(x)) === sanitizeHtml(x)`) and linear in the input size: a small tokenizer
  follows the HTML tokenization rules and the output is rebuilt from an allowlist. There is no regex over the document and
  no DOM, HTMLRewriter or dependency, so it runs the same in the Workers runtime and in the Node tests. Because the output is
  generated and not copied, a difference between this tokenizer and a browser can change which text survives, never let
  markup through.
- Limits: the raw `contentHtml` of a request is at most 60000 characters and the sanitized result at most 20000, otherwise
  `400 VALIDATION` with a Thai message (entity escaping can make the result longer than the input, and an `<a>` gains its
  `rel` / `target`).

## Lottery results and saved draws (2026-11-19)

Two additions behind the web app's "highlight what the card got right" feature. Migration `0008_add_results_and_draws` is
additive only (two new tables; no existing endpoint changes shape, `POST /render/numbers` gets one optional field). Migration
`0009_add_personal_results` then lets members type results of their own ("Personal results" below): `GET /results` gets two
more fields per row and the back office keeps listing the official results only. Since the split the official results are written
and listed by the **results API** (`numbergen-results-api`); this API reads them for the members.

### Lottery results

The numbers of each draw: `3 ตัวบน` (`top3`, exactly 3 digits), `2 ตัวบน` (`top2`) and `2 ตัวล่าง` (`bottom2`, exactly 2
digits). The **official** result of a **catalog** lottery is written by the results robot (a script holding `RESULTS_API_KEY`)
or by an admin, **through the results API** (`PUT /results`, see its README), and seen by every member here (`GET /results`); a **personal**
result is typed by one member for a lottery they can see, is seen by that member only and wins over the official one for them. The
web app compares what a member reads with the numbers on a card. A member's own (custom) lotteries never have an official result.

**Data** (`lottery_results`): `id`, `lottery_id` (foreign key to `lotteries`), `draw_date` (Thai calendar day `YYYY-MM-DD`),
`draw_time` (`HH:MM`, or `''` for a lottery that draws once a day, so the column is never NULL), `member_id` (`''` = official,
otherwise the member who typed a personal result; migration 0009, see below), `top3`, `top2`, `bottom2` (NULL while unknown;
the API never stores a row with none of them), `source` (free text from the writer, members never see it, NULL on a personal
result), `created_at`, `updated_at`. A **unique index** on `(lottery_id, draw_date, draw_time, member_id)` is the upsert
target (one row per draw and kind, however many writers race) and `(member_id, draw_date)` serves the readers. No row = no
result yet. Rows are never deleted automatically (at most a few hundred official ones a day); the admin lottery delete removes
the lottery's results explicitly.

| Endpoint | Where | Request and response |
|---|---|---|
| `GET /results?date=YYYY-MM-DD` | **here**, member | `200 {date, results: MemberLotteryResult[]}`: what applies to this member, see "Personal results"; `400` without a real date |
| `PUT /results/mine`, `DELETE /results/mine` | **here**, member | the member's own result, see "Personal results" |
| `PUT /results`, `DELETE /results/:id`, `GET /admin/results?date=`, `POST /admin/results/import` | the **results API** | official results written and listed by the robot (`X-API-Key`) or the back office (admin token). **`404` on this API** |

Shapes: `LotteryResult` = `{lotteryId, date, time, top3, top2, bottom2}` (`date` and `time` as stored; the three numbers are strings,
so a leading zero survives, or `null`); `MemberLotteryResult` = `LotteryResult` plus `{mine, official}` (see "Personal results"). The back
office / robot shape `AdminLotteryResult` (plus `id`, `source`, timestamps) is the results API's. Lists are ordered by `lotteryId`, then `time`
(`''` first, then `HH:MM` ascending).

- **Members** (`GET /results`) get the results of the date for the lotteries they can see (active catalog lotteries and their
  own; the same rule as `GET /lotteries`): the official results and their own, resolved as described in "Personal results",
  all draws of that date, no `id` / `source` / timestamps. A lottery with several draws on one date has several rows; the last
  one by `time` is the latest draw. There is no caching: a replaced or deleted result shows on the next request.
- A member typing, replacing or removing their own result is **not** a change of the public results (the free site shows official
  results only): nothing is recorded for the results API's publisher.

### Personal results (members type their own)

A member can type the result of a draw for themselves, for **any lottery they can see** (an active catalog lottery or one of
their own: a private lottery has no official result at all, and an official one can be late or wrong). It is private to that
member. For them a personal result **wins** over the official result of the same lottery and date, and removing it makes the
official one apply again.

**Data.** Migration `0009_add_personal_results` adds `member_id TEXT NOT NULL DEFAULT ''` to `lottery_results`: `''` is an
official result (every row that existed before is one, the default makes them so), anything else is the member who typed a
personal one. It is `''` and not NULL because a unique index treats NULLs as distinct (two official results of one draw would be
allowed). The unique index of a draw became `(lottery_id, draw_date, draw_time, member_id)`, so a personal and the official
result of one draw sit side by side, and `lottery_results_member_date_idx (member_id, draw_date)` replaced the index on the
date alone: it serves `GET /results` (`member_id IN ('', me)` for one date), `GET /admin/results` (`member_id = ''`) and the
delete of all rows of a member. `member_id` has **no foreign key** (`''` is no member), so a member's personal results are
deleted explicitly with the member. A new result is about 4 D1 rows written (the row and its three index entries), a replace
about 1.

| Endpoint | Auth | Request and response |
|---|---|---|
| `PUT /results/mine` | member session cookie | body below; `201` when the member had no result of that draw yet, `200` when theirs was replaced; both answer `{date, lotteryId, results}` |
| `DELETE /results/mine?lotteryId=&date=&time=` | member session cookie | `200 {date, lotteryId, results}`; idempotent: also `200` when there was nothing to remove; `time` absent = `''` |
| `GET /results?date=YYYY-MM-DD` | member session cookie | `200 {date, results: MemberLotteryResult[]}` |

Only the member's own cookie counts: no cookie, an admin cookie or the results key is `401 UNAUTHENTICATED`; a disabled or
expired member is `403 DISABLED` / `EXPIRED`; a foreign `Origin` is `403` (the CSRF guard).

**`MemberLotteryResult`** = `{lotteryId, date, time, top3, top2, bottom2, mine, official}`:

- `mine`: `true` = the member typed these numbers, `false` = it is the official result.
- `official`: `{time, top3, top2, bottom2}` of the official result a personal row hides (the latest draw by `time` of that
  lottery and date), `null` when there is none, and always `null` on an official row. The web app can say that an official
  result exists, or show it.
- Nothing else about a row: no `id`, no `source`, no timestamps, no member id.

**Which rows a member reads** (`GET /results?date=` and the answers of the two writes). Per lottery: when the member has at
least one personal result of it on that date, only their personal results are listed (by `time`) and every official result of
that lottery and date is hidden, whatever its draw time (so a result typed without a time, as the web app does, still wins over
an official draw at 16:30); otherwise the official results are listed as they are. Rows are never merged: a personal
result with only `top3` is judged by `top3` alone. Lotteries the member cannot see (a switched-off catalog lottery, someone
else's own lottery) are not listed, and their personal rows wait unchanged until the lottery is visible again. A member never
reads another member's row.

**`PUT /results/mine` body** (a JSON object of at most 1 KB; any key other than these is `400`, `source`, `lotteryName` and
anything that says whose result it is included: the row is always the caller's own):

| Field | Rule |
|---|---|
| `lotteryId` | required, the id of a lottery the member can see. |
| `date` | required, a real day written `YYYY-MM-DD` (`400` for `2026-02-30`, `19-11-2026`, a date-time ...). |
| `time` | optional, as in `PUT /results`: `HH:MM`, or `""` / `null` / omitted. Leave it out unless the card is about one particular draw time. |
| `top3`, `top2`, `bottom2` | as in `PUT /results`: each optional (`null` = not given), at least one required, strings of ASCII digits of the exact length (3, 2, 2). |

- **Replace semantics** as in `PUT /results`: the stored result becomes exactly what was sent (a number left out is cleared);
  `id` and `createdAt` stay. A personal result has no `source`.
- **Errors**: `400 VALIDATION` (checked before the lottery is looked up; nothing is stored on any error), `404 LOTTERY_NOT_FOUND`
  when the member cannot see the lottery (another member's own lottery, a catalog lottery that is switched off, an unknown id:
  all answer alike, so nothing tells whether such a lottery exists). The same for `DELETE`.
- **`DELETE /results/mine`** removes the caller's result of that lottery, date and time (`time` absent or empty = the draw
  without a time): never an official result and never another member's (the row is matched on the session's member, no parameter
  can name another one; unknown query parameters are ignored). `lotteryId` and `date` are required (`400`).
- **The answers** `{date, lotteryId, results}` hold the rows `GET /results?date=` lists for that one lottery (empty list = no
  result), so the page can update its card at once: after a `DELETE` they are the official results again when no personal one is left.
- **Back office and robot** (the results API): `PUT /results` always writes an official row (a `memberId` in its body is `400`), also when members
  have personal results of the same draw; `DELETE /results/:id` and `GET /admin/results` only touch and list official rows. Its tests
  (`test/officialAndPersonal.test.ts` there) cover that; here the members' side is tested.
- **Cascades** (explicit in code): deleting a member (back office) deletes their personal results and every result of their own
  lotteries; deleting an own lottery (member) deletes the results typed for it; deleting a catalog lottery (back office, `DELETE /admin/lotteries/:id`) deletes
  its official results and every member's personal results of it (and records the change for the public site, see below).
- **Not limited.** Like the official results, personal ones are never pruned and a member has no quota of them; the date only has
  to be a real day.
- **Deploy order.** The unique index changed, so the code before 0009 cannot upsert official results once the migration ran
  (its `ON CONFLICT` target no longer exists) and this code needs the column: run `npm run deploy` (migrates, then deploys) and,
  because the test Worker shares the database, `npm run deploy:test` right after. (The results API needs the same migrations: deploy
  this API's migrations first, see "Public results and the results API".)

### Saved draws (`member_draws`)

The numbers a member drew used to live only in the browser. Now `POST /render/numbers` also keeps the last ones, so the single
and multiple pages can show them again after a reload (the browser cache is empty in a new tab or on another device).

**Data** (`member_draws`): `member_id`, `scope`, `lottery_id`, `card_date` (`YYYY-MM-DD`), `numbers` (the JSON of the `CardNumbers`
exactly as the render call returned it), `updated_at`. Primary key `(member_id, scope, lottery_id, card_date)`, so a new สุ่ม of
the same card overwrites the row. `scope` is `single` (the single-card page) or the **id of a set** (a section of the multiple
page). The table is write-heavy (a page of the multiple page saves up to about 140 cards) and D1 counts every index entry as a row
written, so it has only the indexes the hot paths need: the primary key (the overwrite) and `(member_id, card_date, scope,
lottery_id)` (the read; the primary key starts with the scope, so it cannot serve a one-day lookup). The foreign key to `members`
is declared; there is **no foreign key to `lotteries`** (it would need an index of its own, or each lottery delete would scan the
table) and **no index for the cleanup** (see below); the rows of a lottery are deleted explicitly instead.

- **`POST /render/numbers`** takes one new optional field, `scope` (`"single"` or a set id; letters and digits, 1 to 64
  characters). The existing `date` is the card date. Without `scope` nothing is saved and the call is exactly what it was
  (older web builds keep working, including a `date` that only looks like a date). With `scope`: `date` must be a real day
  (`400` otherwise), and a set id that is not one of the caller's sets is `404 NOT_FOUND` (`ไม่พบชุดรายการ`), both before anything
  is counted. A malformed `scope` (for example `__single__`) is `400`. The cards are saved after the render has been counted (an
  over-limit `429` and an unknown lottery `404` save nothing), one row per lottery (a lottery listed twice keeps its last
  numbers), in one extra D1 batch. **A failure to save is logged and ignored**: the numbers are returned and counted anyway.
  The response is unchanged.
- **`GET /draws?date=YYYY-MM-DD[&scope=...]`** (member) answers `200 {date, draws: [{scope, lotteryId, numbers, updatedAt}]}`: the
  member's saved draws for that card date. `scope` may repeat (`?scope=single&scope=<setId>`, at most 50) to limit the answer;
  without it every scope is returned (a set id that has nothing, or is not the caller's, just matches nothing). Ordered by `scope`,
  then `lotteryId`. `400` for a missing or unreal date or a malformed `scope`. A member only ever reads their own rows.
- **Cleanup.** Rows whose `updated_at` is more than 14 days old are deleted by the cron trigger once a day, in the invocation due
  at **03:17 Bangkok time** (`src/lib/draws.ts`, called from `scheduled` in `src/index.ts`; the other 1439 minutes read nothing). The
  age is the time of the last สุ่ม, not the card date. It is one `DELETE ... WHERE updated_at < cutoff` (one pass over the table,
  no index needed for a daily job; it also clears a backlog after a cron outage in one run). The reminders and the cleanup are
  independent: one that throws is logged and does not stop the other, then the first error is rethrown so the run shows as failed.
  The test Worker has no cron, the live Worker's trigger cleans the shared table.
- **D1 write cost.** D1 counts index entries as rows written, so a card saved for the first time under a (member, scope, date) is
  about 3 rows written (the row, its primary key entry and the read index entry), a new สุ่ม of the same card about 1, and its
  cleanup 3 more. The multiple page draws around 140 cards per page load and date, so on the free plan (a daily cap on rows
  written for the whole database, 100,000 at the time of writing) keep an eye on the usage: the web app should restore the
  saved draws with `GET /draws` before drawing anything, and draw only what is missing.
- **Cascades** (explicit in code, like everywhere else). Deleting a set deletes its draws (`scope` = the set id; a scope cannot have
  a foreign key), deleting a member (back office) deletes all theirs (a custom lottery's included), deleting a custom lottery
  (member) deletes that member's draws of it, and deleting a catalog lottery (back office) deletes every member's draws of it
  and its results too (the official ones and the members' personal ones, see "Personal results"). Removing a lottery from a set with `PATCH /sets/:id` leaves that lottery's saved draw alone (invisible, gone
  after 14 days). A draw that a stale tab saves for a set in the very instant the set is being deleted can survive for up to 14
  days, never visible.

## Public results and the results API (split, 2026-11-21)

The free public results site (the separate repo `numbergen-results`: static, no login, nothing of the number generator) shows the **official** lottery results and
per-lottery statistics from small JSON files in the R2 bucket `pnresult-public`. The code that writes the official results, decides what is public, builds
the files, publishes them (cron, versions, guards against an older build, statistics, the import, the local `GET /public-data/*`) is **not in this repo any more**:
it is the **results API**, `../numbergen-results-api` (Worker `results-api`). Its README has the endpoint contract, the file shapes and the publishing rules.
The database is shared; the schema is this repo's.

| | numbergen-api (this repo) | numbergen-results-api |
|---|---|---|
| Members, cards, sets, assets, landing, push, draws, `GET /results`, `PUT` / `DELETE /results/mine` | **owns** | no |
| Admin login (`ng_admin` cookie), `GET /admin/results-token` | **owns** | verifies the token it issues |
| The lottery catalogue admin (`/admin/lotteries`) | **owns**; **records** a change in D1 and publishes nothing | publishes it from its cron |
| Official results: `PUT /results`, `DELETE /results/:id`, `GET /admin/results`, `POST /admin/results/import` | no (**404**) | **owns** |
| `/admin/public/*` (public switch, schedules, closed date, status, kill switch, publish), the snapshot files, the `PUBLIC_RESULTS` binding, `GET /public-data/*` | no (**404**, no binding) | **owns** |
| **The database schema and its migrations** (`drizzle/`) | **owns, the only place** | describes the tables it uses and keeps a copy of the SQL (`npm run sync:schema`) |

### Recording a catalogue change (DB only)

An admin creating, renaming, switching off or deleting a catalog lottery can change what the public site shows. `POST` / `PATCH` / `DELETE /admin/lotteries` therefore **record** the
change in D1, in the same batch as the change itself (`src/lib/publicChange.ts`, a minimal copy of the results API's `recordChangeStatements`): the counter `results_version` goes up by one and
the dirty marks `results_dirty:l:<lottery id>` (its `lottery/<id>.json` file) and, when the lottery becomes public or hidden or is deleted, `results_dirty:d:<date>` for every date it has official results on.
This API publishes nothing and **never calls the bucket** (there is no `PUBLIC_RESULTS` binding on the live or the test Worker, and the test Worker has no schedule); the results API's cron
(every minute) builds and uploads the files, so a change reaches the public site within about a minute.

What counts (decided here, in `routes/admin.ts`): only a real change of a lottery's name, short name, group, accent, sort order or `active`, of a lottery that is public before or after (`active` AND `public_enabled`);
the reminder default (`notifyTime` / `notifyEnabled`), the same values again, a change of a lottery that is not public, and a member's own lotteries and results count nothing. The `public_enabled` switch itself is the results API's
(`PATCH /admin/public/lotteries/:id`). The keys are a contract between the two Workers: `test/catalogueRecording.test.ts` pins the exact `site_settings` rows that a fixed sequence of changes leaves, and the results API's test of the
same name pins the same rows for its own copy of the statements. None of these rows is in `SITE_SETTING_KEYS`, so `/admin/settings` does not change.

### `GET /admin/results-token`: the token for the results API

The results API does not know the `ng_admin` cookie and uses no cookie of its own. The signed-in admin takes a short-lived token here and sends it there:

```
GET /admin/results-token                 needs the normal ng_admin admin session (cookie, credentials), nothing else
  200 { "token": "<payload>.<signature>", "expiresAt": "2026-11-21T10:10:00.000Z" }     Cache-Control: no-store
  401 UNAUTHENTICATED                    no / damaged / member session
  503 RESULTS_TOKEN_NOT_CONFIGURED       RESULTS_ADMIN_SECRET is unset or shorter than 32 characters (checked after the session)
  503 TESTSITE_OFF                       the test Worker with the test site switched off, like every route of that Worker
then, on the results API:   Authorization: Bearer <token>      (no cookie, credentials omitted; CORS allows the origins of its WEB_URL)
```

The token is `base64url(payload) "." base64url(HMAC-SHA256(secret, base64url(payload)))` with the payload `{"sub":"admin","iat":<s>,"exp":<s>}`, `exp = iat + 600` (10 minutes), signed with
`RESULTS_ADMIN_SECRET`. The format is written once, in `src/lib/adminToken.ts`, **byte-for-byte the same file as `numbergen-results-api/src/lib/adminToken.ts`** (this repo signs, that one verifies);
`test/adminToken.test.ts` is identical in both repos and pins the format with a fixed vector (a fixed secret and payload give exactly one token, computed with `node:crypto`), so changing the format in
one repo fails both test suites until the other is changed too. A web client refreshes the token shortly before `expiresAt` or when the results API answers 401. The secret is trimmed on both sides.
A token is no credential for this API: a bearer token never replaces the cookie on any route here.

### Local run, deploy order, the shared secret

- **Local** (three terminals): this API `npm run dev` on 8787; the results API `npm run dev:shared` on 8788 (it uses this repo's `.wrangler/state`, so both see ONE local D1; `npm run db:migrate` and `npm run seed` here once);
  the results site `$env:VITE_DATA_URL = 'http://localhost:8788/public-data/'; npm run dev`. Both `.dev.vars` need the same `RESULTS_ADMIN_SECRET`. After a migration here: `npm run sync:schema` in the results API.
- **Deploy order**: (1) this API's migrations (`npm run db:migrate:remote`, a no-op when applied), (2) the results API with its secrets (`RESULTS_API_KEY` = the robot's key, `RESULTS_ADMIN_SECRET`), (3) point the results robot at the results API,
  (4) set `RESULTS_ADMIN_SECRET` here (`npx wrangler secret put RESULTS_ADMIN_SECRET`, and `--env test`), then `npm run deploy` and `npm run deploy:test` (this removes the moved routes, the `PUBLIC_RESULTS` bindings and the test schedule) **together with
  the web app** (its results pages call the results API with the token; until then the old pages get 404), (5) `npx wrangler secret delete RESULTS_API_KEY` here (and `--env test`). The step-by-step text is in the README of the results API.
- **A schema change** for a table the results API uses is made here first (`src/db/schema.ts`, `npm run db:generate`, `npm run db:migrate:remote`), then `npm run sync:schema` in the results API and its `src/db/schema.ts` if the table or column it uses changed (its `schemaSync` test fails when they drift).
