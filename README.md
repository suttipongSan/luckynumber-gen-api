# numbergen-api

NumberGen phase 2 API: Hono on Cloudflare Workers, TypeScript, Drizzle ORM + libSQL (Turso),
Cloudflare R2 for member assets, zod validation, vitest tests.

The HTTP contract is `../numbergen/API.md` and the agreed design is `../numbergen/DESIGN.md`.

## Layout

```
src/index.ts            app, CORS (WEB_URL + http://localhost:5173, credentials), error handler
src/types.ts            shared API types (mirror of web src/api/types.ts) + limits
src/validation.ts       zod schemas (passthrough CardSettings with API.md bounds)
src/db/schema.ts        Drizzle tables (DESIGN.md data model)
src/db/catalog.ts       lottery catalog (seed data, 82 lotteries in 5 groups)
src/db/client.ts        getDb(env)
src/lib/crypto.ts       PBKDF2 passwords, constant-time compare, HMAC, signed asset URLs
src/lib/session.ts      ng_session / ng_admin cookies (signed id + DB row, 24 h, not refreshed)
src/lib/numbers.ts      number generation (port of the mockup's lib/numbers.ts)
src/lib/ids.ts          16-char base62 ids, 32-char tokens
src/lib/loginLimiter.ts 5 wrong passwords → 429 for 15 min (login_attempts table)
src/middleware/         memberAuth (session + expiry/disabled check on every call), adminAuth
src/routes/             link, me, lotteries, news, sets, settings, render, assets, admin
drizzle/                generated SQL migrations
scripts/                migrate, seed, hash-password, dev-db-server (local libSQL bridge)
test/                   vitest: numbers, crypto/signed URLs, app (app.request + file:test.db + fake R2)
```

## Setup

```powershell
npm install
npm run seed          # applies migrations to file:local.db, seeds lotteries + demo member
```

`npm run seed` prints the demo member link
(`http://localhost:5173/m/demo0000000000000000000000000000`, name `สมาชิกทดสอบ`, no password,
expires in 30 days) and an `ADMIN_PASSWORD_HASH` for `admin` / `admin1234`. Re-running it is
safe: lotteries that already exist are left as they are, and the demo member's password is cleared and its
expiry reset.

## Local development

`.dev.vars` holds the local secrets (git-ignored). A ready-made one is in the repo folder;
`.dev.vars.example` documents every variable. To recreate it, copy the example, fill in random
secrets and paste the hash printed by `npm run seed` (keep it in single quotes).

workerd (the runtime behind `wrangler dev`) cannot open `file:` database URLs, because the Workers
build of `@libsql/client` only speaks HTTP or WebSocket. So local dev runs two processes:

```powershell
# terminal 1: serve local.db over the libSQL HTTP protocol on http://127.0.0.1:8080
npm run dev:db
# terminal 2: the Worker on http://localhost:8787 (R2 is simulated locally by wrangler)
npm run dev
```

`.dev.vars` points `TURSO_DATABASE_URL` at `http://127.0.0.1:8080`. Node scripts and tests use
`file:local.db` / `file:test.db` directly. The bridge is for development only: it has no auth and listens only on
127.0.0.1.

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
| `npm run db:migrate` | apply `drizzle/` migrations to `TURSO_DATABASE_URL` (default `file:local.db`) |
| `npm run hash-password -- <password>` | print a PBKDF2 hash for `ADMIN_PASSWORD_HASH` |

## Production

### 1. Turso database

```powershell
turso db create numbergen
turso db show numbergen --url          # libsql://numbergen-<org>.turso.io
turso db tokens create numbergen       # auth token
```

Apply the migrations from your machine (PowerShell):

```powershell
$env:TURSO_DATABASE_URL = "libsql://numbergen-<org>.turso.io"
$env:TURSO_AUTH_TOKEN = "<token>"
npm run db:migrate
npm run seed        # optional: lottery catalog + demo member (WEB_URL env var sets the printed link)
Remove-Item Env:TURSO_DATABASE_URL, Env:TURSO_AUTH_TOKEN
```

### 2. R2 bucket

```powershell
npx wrangler r2 bucket create numbergen-assets
```

The bucket stays private. Files are served only by the Worker through signed URLs
(`/assets/:id?exp=&sig=`, valid for 10 minutes).

### 3. Vars and secrets

In `wrangler.toml`, set `[vars] WEB_URL` to the Cloudflare Pages origin of the web app (for
example `https://numbergen-web.pages.dev`) and keep `COOKIE_SECURE = "true"`. That gives cookies
`Secure; HttpOnly; SameSite=None`, which cross-origin Pages → Workers calls need.

```powershell
npx wrangler secret put TURSO_DATABASE_URL
npx wrangler secret put TURSO_AUTH_TOKEN
npx wrangler secret put SESSION_SECRET          # long random string
npx wrangler secret put ASSET_SIGNING_SECRET    # another long random string
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD_HASH     # from: npm run hash-password -- <password>
```

### 4. Deploy

```powershell
npm run deploy      # wrangler deploy
```

Set the web app's `VITE_API_URL` to the Worker URL (for example `https://numbergen-api.<account>.workers.dev`).

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
- **Assets**: png, jpg, webp, gif and avif up to 5 MB, 20 per member. SVG is refused. Deleting an asset clears
  `backgroundAssetId` / `logo.assetId` in that member's saved settings.
- **Member delete** removes the member's sets, settings, assets (DB rows and R2 objects), news reads,
  render counters and sessions.
