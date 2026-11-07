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
src/lib/numbers.ts      number generation (port of the mockup's lib/numbers.ts)
src/lib/ids.ts          16-char base62 ids, 32-char tokens
src/lib/loginLimiter.ts 5 wrong passwords → 429 for 15 min (login_attempts table)
src/middleware/         memberAuth (session + expiry/disabled check on every call), adminAuth
src/routes/             link, me, lotteries, news, sets, settings, render, assets, admin
drizzle/                generated SQL migrations
scripts/                seed-sql (writes seed.sql for D1), hash-password, db (test helpers)
test/                   vitest: numbers, crypto/signed URLs, app (app.request + file:test.db + fake R2)
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

## Production

Live on the operator's Cloudflare account (all free plan):

| Piece | Resource |
|---|---|
| Worker | `numbergen-api` → https://numbergen-api.luckynumber-01-fpn.workers.dev |
| Database | D1 `numbergen` (binding `DB`, APAC) |
| Files | R2 bucket `numbergen-assets` (binding `ASSETS`, private) |
| Web origin | `WEB_URL` in wrangler.toml → https://numbergen-web.luckynumber-01-fpn.workers.dev |

Secrets: `SESSION_SECRET`, `ASSET_SIGNING_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`
(`npx wrangler secret put <NAME>`). Full step-by-step guide: `../numbergen/DEPLOY.md`.

```powershell
npm run db:migrate:remote   # after adding a migration
npm run deploy              # wrangler deploy
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
- **Render limit**: each `POST /render/numbers` call counts `items.length` renders against 600 per UTC
  day (`render_counters`). The counter is incremented atomically first and rolled back when it goes over the limit.
- **CSRF**: on top of CORS, any non-GET request that carries an `Origin` header outside the allow-list is
  rejected with 403. Multipart uploads are "simple" requests and skip the CORS preflight, which is why this check exists.
- **Assets**: png, jpg, webp, gif and avif up to 5 MB, 20 per member. SVG is refused. Kinds are
  `background`, `logo` and `qr` (v2); deleting an asset clears `backgroundAssetId`, `logo.assetId`
  and `qr.assetId` in that member's saved settings.
- **Member delete** removes the member's sets, settings, assets (DB rows and R2 objects), news reads,
  render counters, sessions and v2 custom lotteries (and the set_lotteries / card_settings rows for them).

## v2 additions (2026-11-07)

Five member-review requests (see `../numbergen/API.md` "v2 additions" for the contract).

- **F2 QR code image**: `POST /assets` accepts `kind=qr` (shares the 20-file quota); `CardSettings.qr`
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
