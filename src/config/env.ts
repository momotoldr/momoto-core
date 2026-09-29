// Side-effect import: reads .env.local + .env into process.env. Must stay above every
// other import here, and `src/index.ts` imports it first of all for the same reason.
import './loadEnv.js'

import { logger } from '../lib/logger.js'

export interface Env {
  port: number
  corsOrigins: string[]
  /** How many reverse-proxy hops sit in front of us (Express `trust proxy`). */
  trustProxy: number
  // Rooms, session timing and TURN live in momoto-realtime's config, not here.
  // ── Auth ──
  /** Signs access tokens. momoto-realtime verifies them, so its value must be identical. */
  jwtSecret: string
  jwtAccessTtlSeconds: number
  jwtRefreshTtlSeconds: number
  googleClientId: string | null
  cookieSecure: boolean
  /**
   * Closed-beta switch: `true` refuses self-service signup, so the only accounts that
   * exist are the ones an operator seeded (the seeding script was retired 2026-09-19 —
   * no further accounts are created until release; recover it from git history if needed).
   *
   * Covers **both** ways in: `POST /auth/register` answers 403 outright, and
   * `POST /auth/google` will still authenticate an identity it already knows but
   * refuses to create a new account for one it doesn't. Shutting only the first would
   * accomplish nothing — the second mints accounts just as readily, and both are
   * reachable without a browser.
   */
  inviteOnly: boolean
  // ── Transactional email ──
  /**
   * Where `momoto-notify` lives. Null when unconfigured, which is not an error: the
   * client logs the message it would have sent (link included), so local development
   * needs neither a mailbox nor a second process running.
   */
  notify: NotifyConfig | null
  /**
   * Public origin of the **frontend**, used to build the links we mail.
   *
   * Never derive these from a request's `Host` header: an attacker who can set that
   * header gets us to mail a victim a link pointing at their own server, with the
   * victim's single-use token in it. Defaults to the first CORS origin, which is the
   * frontend by definition.
   */
  appBaseUrl: string
  /** How long an address-verification link stays good. */
  emailVerifyTtlHours: number
  /**
   * How long a password-reset link stays good. Much shorter than the verification
   * link: this one is a credential that can take over the account, and it sits in an
   * inbox where a shoulder-surfer or a synced device can reach it.
   */
  passwordResetTtlMinutes: number
  // ── Payments (Midtrans Snap) ──
  /** Midtrans server key (secret, server-only). Null disables payments. */
  midtransServerKey: string | null
  /** Midtrans client key (safe to expose; the FE has its own copy). */
  midtransClientKey: string | null
  /** Hit Midtrans production endpoints (vs sandbox). */
  midtransIsProduction: boolean
  /**
   * Payment channels Snap may offer, in the order they appear. Empty = let Midtrans
   * show everything the merchant account has active. Kept configurable because a
   * channel must be activated per Midtrans environment: sandbox enables everything,
   * production only what has been approved, so the two lists legitimately differ.
   */
  midtransEnabledPayments: string[]
  /** Price to unlock a strip's clean download/print, in whole rupiah. */
  stripPrintPriceIdr: number
  /** True when PAYMENTS_ENABLED=true and both Midtrans keys are set. */
  paymentsEnabled: boolean
  /**
   * How many *unpaid* strips one user may keep at a time. Paid strips are exempt —
   * the cap limits free storage, and nothing someone bought is ever refused or
   * counted against them here. (Paid strips have their own, separate ceiling: see
   * `galleryMaxItems`. Keeping them out of *this* count is what stops a full
   * gallery from blocking a capture.)
   *
   * Keep in step with the frontend's VITE_STRIP_MAX_ITEMS, which bounds the
   * signed-out IndexedDB cache: set higher there and a guest caches strips this
   * server will refuse on sign-in, stranding them in their browser.
   */
  stripMaxItems: number
  /**
   * How many **paid** strips one user may keep in the gallery at a time.
   *
   * The counterpart to `stripMaxItems`, and deliberately a separate number: that
   * one caps the cart (unpaid strips awaiting an unlock), this one caps the
   * library of unlocked ones. A full gallery must never block *saving* a strip to
   * the cart — only unlocking one — so the two caps never read each other.
   *
   * Enforced before money moves (at checkout and at the free unlock), never in the
   * Midtrans webhook: once a payment has settled the strip is flipped paid even if
   * that lands over the cap, because refusing would leave the user charged with
   * nothing to show. Nothing already unlocked is ever auto-evicted.
   */
  galleryMaxItems: number
  // ── Object storage (Cloudflare R2) ──
  /** R2 connection, or null when strip bytes should stay in Postgres. */
  r2: R2Config | null
}

/**
 * Cloudflare R2 (S3-compatible) settings for the images we store. All-or-nothing:
 * either every required field is present and new images are written to a bucket, or
 * `env.r2` is null (strips then refuse; avatars fall back to Postgres).
 */
export interface R2Config {
  endpoint: string
  accessKeyId: string
  secretAccessKey: string
  /** Bucket holding the watermarked strips — safe to expose publicly. */
  bucket: string
  /** Bucket holding the clean, paid copies — must NOT be publicly readable. */
  printBucket: string
  /**
   * Bucket holding uploaded avatars — their own, never the strips bucket. Publicly
   * readable, like `bucket`: an avatar goes in an `<img src>` and has never been
   * authenticated.
   */
  avatarBucket: string
  /**
   * Public CDN origin for `bucket` (R2 public dev URL or a custom domain). When set,
   * strip URLs point straight at Cloudflare and image loads never reach this server.
   */
  publicBaseUrl: string | null
  /**
   * Public CDN origin for `avatarBucket`. A Cloudflare custom domain maps to exactly
   * one bucket, so this can never be `publicBaseUrl` — that origin serves the strips
   * bucket, which the avatars are not in.
   *
   * Null is a supported choice, not a broken one: avatars then stream out of the
   * bucket through `GET /avatars/:userId` instead of off the edge.
   */
  avatarPublicBaseUrl: string | null
}

/** Connection to the notification service. */
export interface NotifyConfig {
  /** Base URL, no trailing slash — e.g. `https://notify.momotoldr.com`. */
  url: string
  /**
   * Shared secret sent as `Authorization: Bearer …`.
   *
   * Null is tolerated so a local service can run without one, but over any real
   * network an unauthenticated send endpoint is a spam relay wearing our domain's
   * reputation — see the same warning in the service's own config.
   */
  apiKey: string | null
}

const DEFAULT_DEV_ORIGIN = 'http://localhost:5173'

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseOrigins(raw: string | undefined): string[] {
  const origins = (raw ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)

  if (origins.length === 0) {
    // No allowlist configured — fall back to the Vite dev origin so local dev works,
    // but make it loud: production MUST set CORS_ORIGINS explicitly.
    logger.warn('config.cors.default', {
      msg: 'CORS_ORIGINS not set; defaulting to the dev origin. Set it in production.',
      origin: DEFAULT_DEV_ORIGIN,
    })
    return [DEFAULT_DEV_ORIGIN]
  }
  return origins
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a positive integer)`)
  }
  return n
}

function nonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a non-negative integer)`)
  }
  return n
}

/** Require a non-empty secret from the environment (never hardcode secrets). */
function requiredSecret(name: string, raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) {
    throw new Error(`Missing ${name}: set it in the environment (see .env.example).`)
  }
  return value
}

/**
 * Read the R2 configuration, or null when it isn't set up (bytes stay in Postgres).
 *
 * Presence is decided by the account id alone, so a half-filled config fails loudly
 * at startup instead of silently falling back to the database — an operator who set
 * three of five variables meant to enable storage, and would otherwise only find out
 * when their backups kept growing.
 */
function parseR2(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim()
  if (!accountId) return null

  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || null
  const bucket = requiredSecret('R2_BUCKET', process.env.R2_BUCKET)
  const printBucket = process.env.R2_PRINT_BUCKET?.trim()

  // The clean copy is the paid deliverable, so it must never sit in a bucket the
  // world can read. Sharing one bucket is only safe while nothing is public — once
  // a public base URL exists, a separate private bucket is mandatory, not advisory.
  if (publicBaseUrl && !printBucket) {
    throw new Error(
      'Missing R2_PRINT_BUCKET: R2_PUBLIC_BASE_URL makes R2_BUCKET publicly readable, ' +
        'so the clean (paid) strips need their own non-public bucket.',
    )
  }
  if (printBucket && printBucket === bucket && publicBaseUrl) {
    throw new Error('R2_PRINT_BUCKET must differ from R2_BUCKET when R2_PUBLIC_BASE_URL is set.')
  }

  // Avatars get their own bucket, and it is required rather than defaulted: there is
  // no sensible fallback. Silently sharing the strips bucket is what this replaced,
  // and quietly resuming it on a missing variable would put avatars somewhere the
  // operator didn't ask for and wouldn't think to look.
  const avatarBucket = requiredSecret('R2_AVATAR_BUCKET', process.env.R2_AVATAR_BUCKET)
  const avatarPublicBaseUrl =
    process.env.R2_AVATAR_PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || null

  // Avatars are served to anyone with the URL. Putting them in the bucket reserved
  // for paid, gated copies would either expose that bucket or break avatars,
  // depending on which rule won — neither is a thing to discover in production.
  if (avatarBucket === printBucket) {
    throw new Error('R2_AVATAR_BUCKET must not be R2_PRINT_BUCKET: avatars are public.')
  }

  return {
    endpoint: process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
    accessKeyId: requiredSecret('R2_ACCESS_KEY_ID', process.env.R2_ACCESS_KEY_ID),
    secretAccessKey: requiredSecret('R2_SECRET_ACCESS_KEY', process.env.R2_SECRET_ACCESS_KEY),
    bucket,
    printBucket: printBucket || bucket,
    avatarBucket,
    publicBaseUrl,
    avatarPublicBaseUrl,
  }
}

/**
 * Read the notification service's location, or null when it isn't set up.
 *
 * Unset is the local-development default and is deliberately not an error: the client
 * logs what it would have sent so links stay clickable from the terminal. A deployed
 * environment must set both variables — mail silently going nowhere is the failure
 * this app can least afford to make quiet.
 */
function parseNotify(): NotifyConfig | null {
  const url = process.env.NOTIFY_URL?.trim().replace(/\/+$/, '')
  if (!url) return null

  // Validated here rather than at the first send. A URL with no scheme parses fine as
  // a string and fails only when `fetch` tries to use it — by which time the failure
  // is one line in a log, on a code path nobody is watching, for a message the user
  // was told was sent. Boot is the moment an operator is actually looking.
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(
      `Invalid NOTIFY_URL: "${url}" is not a URL — it needs a scheme, a host and a port.\n` +
        `Did you mean: http://${url}.railway.internal:3002 ?\n` +
        'On Railway private networking the port is mandatory: nothing proxies it for you.',
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid NOTIFY_URL: "${url}" must be http:// or https://.`)
  }
  if (!parsed.port && parsed.hostname.endsWith('.railway.internal')) {
    throw new Error(
      `Invalid NOTIFY_URL: "${url}" has no port.\n` +
        'Railway does not proxy private traffic, so the internal URL must name the port\n' +
        `the service listens on, e.g. ${url}:3002`,
    )
  }

  const apiKey = process.env.NOTIFY_API_KEY?.trim() || null
  if (!apiKey) {
    logger.warn('config.notify.unauthenticated', {
      msg: 'NOTIFY_URL is set without NOTIFY_API_KEY — the service will accept anyone.',
    })
  }
  return { url, apiKey }
}

/**
 * The origin every emailed link is built from.
 *
 * Falls back to the first CORS origin, which is the frontend by definition — but only
 * if that value is actually a URL. A bare host like `momotoldr.com` concatenates into
 * `momotoldr.com/verify-email?token=…`, which is not a link at all: the notification
 * service rejects it, and the user is told their mail was sent. Catching it here turns
 * a per-send 400 nobody sees into a startup failure naming the fix.
 */
function parseAppBaseUrl(corsOrigins: string[]): string {
  const raw = (process.env.APP_BASE_URL?.trim() || corsOrigins[0] || DEFAULT_DEV_ORIGIN).replace(
    /\/+$/,
    '',
  )
  const source = process.env.APP_BASE_URL?.trim() ? 'APP_BASE_URL' : 'CORS_ORIGINS[0]'

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(
      `Invalid ${source}: "${raw}" is not a URL — every emailed link is built from it.\n` +
        `Did you mean: https://${raw} ?\n` +
        'Set APP_BASE_URL explicitly to the frontend origin, scheme included.',
    )
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid ${source}: "${raw}" must be http:// or https://.`)
  }
  return raw
}

/**
 * Resolved once: `parseOrigins` warns when the allowlist is missing, and both
 * `corsOrigins` and the `appBaseUrl` fallback read it. Calling it twice would log
 * that warning twice and imply two separate misconfigurations.
 */
const corsOrigins = parseOrigins(process.env.CORS_ORIGINS)

export const env: Env = {
  port: positiveInt('PORT', process.env.PORT, 3001),
  corsOrigins,
  // Number of proxies between the client and us. Getting this wrong silently breaks
  // every per-IP rate limit: too low and `req.ip` is a proxy address shared by all
  // users (one bucket for everyone); too high and a client can spoof `X-Forwarded-For`
  // to mint unlimited buckets. Railway alone = 1. Railway behind a proxying Cloudflare
  // ("orange cloud") = 2. Verify after deploy by logging `req.ip`.
  trustProxy: nonNegativeInt('TRUST_PROXY', process.env.TRUST_PROXY, 1),
  jwtSecret: requiredSecret('JWT_SECRET', process.env.JWT_SECRET),
  jwtAccessTtlSeconds: positiveInt('JWT_ACCESS_TTL', process.env.JWT_ACCESS_TTL, 3600),
  jwtRefreshTtlSeconds: positiveInt('JWT_REFRESH_TTL', process.env.JWT_REFRESH_TTL, 604_800),
  googleClientId: process.env.GOOGLE_CLIENT_ID?.trim() || null,
  cookieSecure: process.env.COOKIE_SECURE?.trim() === 'true',
  inviteOnly: process.env.INVITE_ONLY?.trim() === 'true',
  notify: parseNotify(),
  appBaseUrl: parseAppBaseUrl(corsOrigins),
  emailVerifyTtlHours: positiveInt(
    'EMAIL_VERIFY_TTL_HOURS',
    process.env.EMAIL_VERIFY_TTL_HOURS,
    24,
  ),
  passwordResetTtlMinutes: positiveInt(
    'PASSWORD_RESET_TTL_MINUTES',
    process.env.PASSWORD_RESET_TTL_MINUTES,
    30,
  ),
  midtransServerKey: process.env.MIDTRANS_SERVER_KEY?.trim() || null,
  midtransClientKey: process.env.MIDTRANS_CLIENT_KEY?.trim() || null,
  midtransIsProduction: process.env.MIDTRANS_IS_PRODUCTION?.trim() === 'true',
  // Defaults to the three QR/e-wallet channels — no cards, no VA, no convenience store.
  midtransEnabledPayments: parseCsv(
    process.env.MIDTRANS_ENABLED_PAYMENTS ?? 'gopay,shopeepay,qris',
  ),
  // Whole rupiah (IDR has no minor unit). Default Rp8.999 per strip.
  stripPrintPriceIdr: positiveInt('STRIP_PRINT_PRICE_IDR', process.env.STRIP_PRINT_PRICE_IDR, 8999),
  // Explicit flag plus both Midtrans keys — so checkout can stay off even if keys exist.
  paymentsEnabled:
    process.env.PAYMENTS_ENABLED?.trim() === 'true' &&
    Boolean(process.env.MIDTRANS_SERVER_KEY?.trim() && process.env.MIDTRANS_CLIENT_KEY?.trim()),
  stripMaxItems: positiveInt('STRIP_MAX_ITEMS', process.env.STRIP_MAX_ITEMS, 5),
  galleryMaxItems: positiveInt('GALLERY_MAX_ITEMS', process.env.GALLERY_MAX_ITEMS, 25),
  r2: parseR2(),
}
