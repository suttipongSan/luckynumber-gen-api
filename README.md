# numbergen-api

NumberGen phase 2 API: Hono on Cloudflare Workers, TypeScript, Drizzle ORM + Cloudflare D1 (SQLite),
Cloudflare R2 for member assets, zod validation, vitest tests.

The HTTP contract is `../numbergen/API.md` and the agreed design is `../numbergen/DESIGN.md`.

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
src/lib/webpush.ts      Web Push for Workers (WebCrypto only): VAPID JWT, RFC 8291 encryption, push-service allow-list, sender
src/lib/reminders.ts    the per-minute cron: cursor, "who is due" query, notification text, sending, cleanup
src/middleware/         memberAuth (session + expiry/disabled check on every call), adminAuth
src/routes/             link, me, bootstrap, contacts, lotteries, news, sets, settings, render, assets, push, notifications, admin
drizzle/                generated SQL migrations
scripts/                seed-sql (writes seed.sql for D1), hash-password, vapid-generate, db (test helpers)
test/                   vitest: numbers, crypto/signed URLs, app (app.request + file:test.db + fake R2),
                        notifications (reminder + push endpoints), reminders (cron logic), webpush (RFC 8291 / VAPID)
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
| Files | R2 bucket `numbergen-assets` (binding `ASSETS`, private) |
| Web origin | `WEB_URL` in wrangler.toml → https://pnphoto.co (comma-separated list; first one is used in member links) |

Secrets: `SESSION_SECRET`, `ASSET_SIGNING_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`
(`npx wrangler secret put <NAME>`). Full step-by-step guide: `../numbergen/DEPLOY.md`.
For daily reminders also set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (`npm run vapid:generate` prints
both and the commands); `VAPID_SUBJECT` (a `mailto:` or `https:` contact, default `https://pnphoto.co`) is optional.
`wrangler.toml` has a cron trigger that runs every minute; it does nothing until both VAPID keys exist.

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
  render counters, sessions, reminder lines, push devices and v2 custom lotteries (and the set_lotteries /
  card_settings / member_notifications rows for them).
- **Site settings** (admin-editable): `site_settings(key, value, updated_at)` stores contact info
  shown on the lock / renew / no-session screens (Line + Telegram id and URL) and the default
  daily render limit. GET/PUT are at `/admin/settings`; public `GET /contacts` exposes just the
  two channel objects (null when the id is empty) with `Cache-Control: public, max-age=60`.
  Every key has a compiled-in default (`src/lib/siteSettings.ts`) so a fresh DB keeps working.

## Number generation (2 ตัว, 3 ตัว, เลขเด่น)

`src/lib/numbers.ts` draws every number of a card for `POST /render/numbers`. The two running digits
(เลขวิ่ง / รูด) are always distinct; call them r1 and r2 (a digit fixed in the request or in the saved
`fixedRunning1/2` is used slot by slot, the rest is random). The rules apply to every card; there is no
per-lottery switch.

| Block | exactly 1 row | 2 or more rows |
|---|---|---|
| 2 ตัว (`two`, 2-digit numbers) | every number starts with r1 or r2 | row 1 starts with r1, row 2 starts with r2, rows 3 and beyond are any 2-digit number (00-99) |
| 3 ตัว (`three`, 3-digit numbers) | every number contains r1 or r2 (any position) | row 1 contains r1, row 2 contains r2 (any position), rows 3 and beyond are any 3-digit number (000-999) |

With r1 = 8, r2 = 1, three rows of three, 2 ตัว could be `82 85 80 / 14 17 18 / 87 29 60`.

- `isDouble` off keeps 00, 11 .. 99 out of every 2 ตัว row and `allowTriple` off keeps 000, 111 .. 999 out of
  every 3 ตัว row, the random rows included.
- No number appears twice in one block (across all its rows).
- Each row is a uniform random sample, without replacement, of the numbers its rule allows that the earlier
  rows have not taken. The random rows sample everything that is left.
- `two` and `three` come back as one inner array per row, and every row holds exactly `perRow` numbers, so the
  rows of the card never shift (`top`, `drill` and `win` stay flat lists). `row` is validated to 0..6 and `perRow`
  to 1..6, and the smallest pool of a rule row is 9 numbers (row 1 or 2 of 2 ตัว with `isDouble` off, 10 with it
  on), so every allowed `perRow` fits and nothing is ever padded. If a direct caller of `generateCardNumbers` asks
  for a `perRow` above a rule row's pool (above 9, or 10 with `isDouble`), the row keeps its whole pool and the
  missing slots are topped up with unused numbers of any kind (the switches and the no-repeat rule still apply).
  A block that asks for more numbers than exist (above 90 / 100 two-digit, 990 / 1000 three-digit) comes back short.
- เลขเด่น (`single`): 2 digits (the default) is r1 followed by r2, so r1 = 8 and r2 = 1 give `81` (never a double,
  `isDouble` does not matter); 1 digit is one of the running digits at random; 3 digits is a random 3-digit number
  containing r1 or r2 (a triple only with `allowTriple`). A valid `fixedSingle` (digits only, exactly `singleDigits`
  long) always wins.
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
