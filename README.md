# Momoto Core — accounts, strips & payments API

The persistent half of Momoto's backend: accounts and auth, saved strips and their
object storage, payments, partner linking, feedback and testimonials, the public
landing counters, and the operator (`/admin`) surface. Postgres via Prisma; strip and
avatar images in Cloudflare R2; outbound email handed to `../momoto-notify`.

It holds **no session state**. Rooms, the Socket.io signaling/sync server and TURN
credentials are `../momoto-realtime`, so redeploying this service never touches a booth
in progress. The one secret the two share is `JWT_SECRET`: core signs access tokens,
realtime verifies them.

It does no media processing — capture and strip composition happen in the browser
(`../momoto-fe`), which uploads the finished strip here.

## Stack

Node.js (≥20) · TypeScript (ESM, strict) · Express · **Prisma + Postgres** · R2 via the
S3 SDK · Midtrans. Tooling: `tsx` (dev),
ESLint (flat) + Prettier.

## Getting started

**Postgres is required** — it's the datasource in every environment (Prisma's `provider`
is a literal and migration history is provider-specific, so dev can't differ from prod).
On macOS with Homebrew:

```bash
brew install postgresql@17
brew services start postgresql@17          # starts now + on login
createdb momoto                            # if `createdb` isn't on PATH, prefix with
                                           # /opt/homebrew/opt/postgresql@17/bin/
```

Then the app itself:

```bash
npm install
cp .env.example .env      # set JWT_SECRET (required) and DATABASE_URL
npm run db:deploy         # apply the committed Postgres migrations
npm run dev               # tsx watch on http://localhost:3001
```

> `JWT_SECRET` is **required** — the server refuses to boot without it. `DATABASE_URL`
> for local Homebrew Postgres (trust auth, no password) is
> `postgresql://<your-macos-user>@127.0.0.1:5432/momoto?schema=public`.
>
> `postgresql@17` is keg-only, so `psql`/`createdb` aren't on `PATH` by default. Either
> prefix them with `/opt/homebrew/opt/postgresql@17/bin/` or add that to your `PATH`.
>
> Use `db:deploy` to apply existing migrations; use `db:migrate` only when you've changed
> `schema.prisma` and need to author a *new* migration.

The frontend (`../momoto-fe`) reaches this service through `VITE_API_URL` (default
`http://localhost:3001`). For anything in a room it also needs `../momoto-realtime`
running on `:3003`, started with the **same** `JWT_SECRET`.

### Scripts

| Script | Purpose |
| :--- | :--- |
| `npm run dev` | Dev server with reload (`tsx watch`). |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm start` | Run the compiled server (`node dist/index.js`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm run format` / `format:check` | Prettier write / check. |
| `npm run db:migrate` | Create + apply a dev migration (`prisma migrate dev`). |
| `npm run db:deploy` | Apply pending migrations in prod (`prisma migrate deploy`). |
| `npm run db:generate` | Regenerate the Prisma client. |
| `npm run db:studio` | Open Prisma Studio (browse the DB). |

## Configuration

All configuration is via environment variables — no hardcoded secrets, hosts, or
credentials. See `.env.example`.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3001` | HTTP listen port. |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated allowlist of FE origins. **Set explicitly in production.** (CORS runs with `credentials: true` for the refresh cookie.) |
| `DATABASE_URL` | *(none)* | **Required.** Prisma datasource — Postgres in every environment. A **secret** in production; load it from the platform's secret store. |
| `JWT_SECRET` | _(required)_ | Signs access JWTs. Server won't boot without it. `openssl rand -base64 48`. **`momoto-realtime` must be set to the same value.** |
| `JWT_ACCESS_TTL` | `3600` | Access-token lifetime (s), 1h. Recovered via refresh, so mainly bounds a stolen token. |
| `JWT_REFRESH_TTL` | `604800` | Refresh-token / "stay signed in" lifetime (s), 7d. |
| `COOKIE_SECURE` | `false` | Set `true` in production (HTTPS) so the refresh cookie is `Secure`. |
| `GOOGLE_CLIENT_ID` | _(unset)_ | Enables Google sign-in. Must match the FE's `VITE_GOOGLE_CLIENT_ID`. Leave unset to disable. |

R2, Midtrans, notify, closed-beta and strip-cap variables are documented in `.env.example`.
Session timing, room capacity, `REDIS_URL` and STUN/TURN moved to `momoto-realtime` and
do nothing here.

## HTTP surface

The endpoints most worth knowing; the full list by group is in `../TRD.md` §4.2.
`POST /rooms`, `GET /rooms/:id` and `GET /turn-credentials` are **not** here — they are
`momoto-realtime`.

| Method | Path | Response | Notes |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthz` | `{ status, uptime }` | Liveness/readiness. |
| `GET` | `/stats` | `{ users, sessions, strips }` | Public counters for the landing page. `sessions` is shared (date + group) sessions ever held — distinct room codes with a saved strip, the same figure as the admin dashboard's date + group sessions. All three are counted **once a day** and memoised (concurrent callers share one recompute). The frontend rounds the totals down for display ("2,000+"), which is what makes a daily figure good enough. Rate-limited (60 / min / IP → `429`); `503 stats_unavailable` if the database can't be reached and nothing was cached. |
| `POST` | `/auth/register` | `201 { user, accessToken }` | `{ username, password, displayName }`. Sets the refresh cookie. `409 username_taken` if taken. |
| `POST` | `/auth/login` | `{ user, accessToken }` | `{ username, password }`. `401 invalid_credentials` on mismatch. |
| `POST` | `/auth/google` | `{ user, accessToken }` | `{ idToken }`. Only when `GOOGLE_CLIENT_ID` is set; auto-generates a username on first sign-in. |
| `POST` | `/auth/refresh` | `{ user, accessToken }` | Rotates the refresh cookie → a fresh access token. `401` if the cookie is missing/expired. |
| `POST` | `/auth/logout` | `204` | Revokes the refresh token and clears the cookie. |
| `GET` / `PATCH` | `/auth/me` | `{ user }` | Current user / update `displayName`, `avatarUrl`. Requires a valid access token. |

Auth/credential endpoints are rate-limited (20 / min / IP for login/register/google, 60 / min / IP for refresh → `429`).

## Accounts & auth

Accounts are persisted in **Postgres via Prisma** (`prisma/schema.prisma`): `User`,
`RefreshToken` (hashed, rotatable), and `PartnerInvite`.

- **Identity is a `username`** — alphanumeric only (no special characters), 3–20 chars,
  stored lowercased and **unique** (case-insensitive). `email` is stored but **nullable**
  and currently unused for login — it's reserved for a future email-verification feature
  and is populated by Google sign-in.
- **Tokens** — a short-lived **access JWT** (returned in the body; the FE sends it as a
  `Bearer` header) plus a long-lived **refresh token** in an httpOnly `momoto_rt` cookie
  (`SameSite=Lax`, path `/auth`, `Secure` when `COOKIE_SECURE=true`). Refresh tokens are
  stored **hashed** and **rotate** on every use; `/auth/refresh` mints a new access token.
- **Google sign-in** is optional (enabled by `GOOGLE_CLIENT_ID`); on first sign-in it
  creates an account and auto-generates a unique username from the email/name.
- **Database** — **Postgres everywhere**, dev and prod alike; only `DATABASE_URL` differs.
  Prisma's `provider` can't be driven by an env var and a migration history is
  provider-specific, so a SQLite dev / Postgres prod split would mean two parallel
  migration trees and prod-only type and constraint bugs. Each release runs
  `npm run db:deploy` (`prisma migrate deploy`). The superseded SQLite migrations are
  parked in `prisma/migrations-sqlite-archive/`, off Prisma's path — delete once this is
  in version control.

## Deployment

1. `npm ci && npm run build`
2. Set env vars (at minimum `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGINS` = your real FE
   and admin origins).
3. `npm run db:deploy && npm start` behind a TLS-terminating reverse proxy. Point the FE's
   `VITE_API_URL` and the operator portal's `VITE_API_URL` at the public URL.
4. `GET /healthz` for liveness/readiness probes.

**Scaling:** no room state lives here, so several instances can run behind a load
balancer today. In-memory rate limits and the `/stats` cache are per instance, and each
instance opens its own Prisma pool — past a handful, add a Postgres pooler.

## Project structure

```
src/
  auth/                    passwords, tokens (sign + refresh rotation), Google, email + reset links
  config/env.ts            validated env loader — refuses to boot on bad config
  db/client.ts             Prisma client
  http/app.ts              Express app (helmet, CORS, routers)
  http/middleware/         requireAuth · requireAdmin · errorHandler
  http/routes/             auth · strips · payments · avatars · partner · feedback ·
                           testimonials · stats · locations · admin
  lib/                     email · logger · rateLimiter · inviteCode · locations · testimonials
  notifications/           momoto-notify client
  payments/midtrans.ts     Midtrans SDK wrapper + signature check
  storage/                 R2 object store + thumbnails
  index.ts                 entry: HTTP + periodic sweep + shutdown
prisma/                    schema + migrations
scripts/                   operator scripts (make-admin, send:invites, backfill:*, check:*, purge:strips)
```

Split from the old `momoto-be` on 2026-09-16: rooms, Socket.io and TURN moved to
`../momoto-realtime`. Plans for work in progress live in `docs/plans/`.
