import { Prisma } from '@prisma/client'
import express, { Router, type CookieOptions, type Response } from 'express'

import {
  claimEmail,
  pendingEmailFor,
  resendClaim,
  verifyEmailClaim,
} from '../../auth/emailVerification.js'
import { verifyGoogleIdToken } from '../../auth/google.js'
import {
  consumePasswordReset,
  isResetTokenValid,
  issuePasswordReset,
} from '../../auth/passwordReset.js'
import { hashPassword, verifyDecoyPassword, verifyPassword } from '../../auth/passwords.js'
import { serializeUser } from '../../auth/serialize.js'
import {
  issueRefreshToken,
  revokeAllForUser,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
} from '../../auth/tokens.js'
import { env } from '../../config/env.js'
import { prisma } from '../../db/client.js'
import { isValidEmail, normalizeEmail } from '../../lib/email.js'
import { parseLocation } from '../../lib/locations.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { markTestimonialsChanged } from '../../lib/testimonials.js'
import { sendPasswordChanged } from '../../notifications/client.js'
import { normalizeLang } from '../../notifications/lang.js'
import {
  avatarKey as newAvatarKey,
  deleteImages,
  putImage,
  storageEnabled,
} from '../../storage/objectStore.js'
import { asyncRoute } from '../asyncRoute.js'
import { readImageSize, sniffImageType } from '../imageType.js'
import { requireAuth } from '../middleware/requireAuth.js'

export const authRouter = Router()

/** Refresh-token cookie — httpOnly so JS can't read it; scoped to the auth routes. */
const REFRESH_COOKIE = 'momoto_rt'
const REFRESH_COOKIE_PATH = '/auth'

/** Tight cap on credential endpoints (login/register/google) to blunt brute force. */
const authLimiter = new RateLimiter(20, 60_000)
/** Refresh is hit routinely by every active tab; allow more headroom. */
const refreshLimiter = new RateLimiter(60, 60_000)
/**
 * Failed logins per *account*, independent of source IP. The per-IP cap above does
 * nothing against a password spray spread over many addresses, which is how
 * credential stuffing actually arrives.
 *
 * Only failures count and a success clears the counter, so a user who knows their
 * password is never affected. The residual trade-off is that someone who knows a
 * username can deliberately burn the budget and lock that account out for the
 * window — which is why this is a generous 10 per 15 minutes rather than a tight
 * lockout, and why it expires on its own instead of needing an unlock.
 */
const loginFailureLimiter = new RateLimiter(10, 15 * 60_000)

/**
 * Mail-sending endpoints, capped harder than the rest — every allowed call puts a
 * message in somebody's inbox, and the somebody is not necessarily the caller.
 */
const emailClaimLimiter = new RateLimiter(5, 60 * 60_000)
const resendLimiter = new RateLimiter(3, 60 * 60_000)
/** Reset requests per source IP. */
const forgotIpLimiter = new RateLimiter(5, 15 * 60_000)
/**
 * Reset requests per *account*. The per-IP cap does nothing against a script that
 * spreads itself over many addresses to flood one person's inbox — the same gap
 * `loginFailureLimiter` exists to close on the login route.
 */
const forgotAccountLimiter = new RateLimiter(3, 60 * 60_000)
/** Token presentations (the pre-check and the redeem), per IP. */
const resetTokenLimiter = new RateLimiter(20, 15 * 60_000)

/** Reclaim expired auth rate windows (wired into the periodic sweep). */
export function sweepAuthLimits(now: number = Date.now()): number {
  return (
    authLimiter.sweep(now) +
    refreshLimiter.sweep(now) +
    loginFailureLimiter.sweep(now) +
    avatarLimiter.sweep(now) +
    emailClaimLimiter.sweep(now) +
    resendLimiter.sweep(now) +
    forgotIpLimiter.sweep(now) +
    forgotAccountLimiter.sweep(now) +
    resetTokenLimiter.sweep(now)
  )
}

const MIN_PASSWORD = 8
const MAX_DISPLAY_NAME = 60
/** Usernames are alphanumeric only (no special characters), 3–20 chars. */
const USERNAME_RE = /^[a-z0-9]{3,20}$/

/**
 * Ceiling on an uploaded avatar.
 *
 * The browser crops to a 256px square and re-encodes before sending, which lands
 * around 20–40 KB; this is the backstop for a client that doesn't, not the expected
 * size. Kept modest even though the bytes go to a bucket now: the request still
 * buffers whole in this process's heap on the way there, and the fallback path
 * (no R2 configured) still writes them to a Postgres row.
 */
const AVATAR_MAX_BYTES = 256 * 1024

/**
 * Longest edge we'll store. The app's own client sends 256px squares (`AVATAR_SIZE`
 * in `momoto/src/utils/avatarImage.ts`), so this is four times the headroom any real
 * upload needs — it exists because "square" alone says nothing about scale. A flat
 * 2048×2048 PNG is 60 KB, well inside `AVATAR_MAX_BYTES`, so the byte cap alone
 * does not keep stored avatars anywhere near avatar-sized.
 */
const AVATAR_MAX_EDGE = 1024

/** Uploads are the one write here that stores real bytes — keep the rate modest. */
const avatarLimiter = new RateLimiter(20, 10 * 60_000)

/**
 * Accept the image as a raw body rather than multipart.
 *
 * There's exactly one file and no other fields, so multipart would buy nothing and
 * cost a parser dependency. `express.json` ignores these content types, so the two
 * body parsers don't collide.
 */
const avatarBody = express.raw({
  type: ['image/webp', 'image/jpeg', 'image/png'],
  limit: AVATAR_MAX_BYTES,
})

/**
 * Derive a unique, valid username from an arbitrary base (e.g. a Google email's
 * local-part or display name). Strips non-alphanumerics, pads short bases, and
 * appends numeric suffixes until it finds a free handle.
 */
async function generateUniqueUsername(base: string): Promise<string> {
  const root = (base.toLowerCase().replace(/[^a-z0-9]/g, '') || 'user').slice(0, 16) || 'user'
  const padded = root.length >= 3 ? root : `${root}user`.slice(0, 20)
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const candidate = attempt === 0 ? padded : `${padded}${attempt}`.slice(0, 20)
    if (!(await prisma.user.findUnique({ where: { username: candidate } }))) return candidate
  }
  // Astronomically unlikely fallback.
  return `user${Date.now()}`.slice(0, 20)
}

function refreshCookieOptions(expiresAt?: Date): CookieOptions {
  return {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    ...(expiresAt ? { expires: expiresAt } : {}),
  }
}

/** Issues a fresh session (refresh cookie + access token) and returns the payload. */
async function establishSession(res: Response, userId: string): Promise<{ accessToken: string }> {
  const { raw, expiresAt } = await issueRefreshToken(userId)
  res.cookie(REFRESH_COOKIE, raw, refreshCookieOptions(expiresAt))
  return { accessToken: signAccessToken(userId) }
}

function limited(res: Response, event: string, ip: string): boolean {
  logger.warn(event, { ip })
  res.status(429).json({ error: 'too_many_requests' })
  return true
}

// ── POST /auth/register ──────────────────────────────────────────────────────
authRouter.post(
  '/register',
  asyncRoute(async (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (!authLimiter.allow(ip)) return void limited(res, 'auth.register.ratelimited', ip)

    // Closed beta: accounts are seeded by an operator, never self-served. Hiding the
    // frontend's /register route is not enough on its own — this endpoint is reachable
    // directly, so the door has to be shut here.
    if (env.inviteOnly) {
      logger.info('auth.register.closed', { ip })
      res.status(403).json({ error: 'registration_closed' })
      return
    }

    const username = String(req.body?.username ?? '')
      .trim()
      .toLowerCase()
    const password = String(req.body?.password ?? '')
    const displayName = String(req.body?.displayName ?? '').trim()
    const email = normalizeEmail(req.body?.email)
    const lang = normalizeLang(req.body?.lang)

    if (
      !USERNAME_RE.test(username) ||
      password.length < MIN_PASSWORD ||
      displayName.length === 0 ||
      !isValidEmail(email)
    ) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    // Advisory: refuse early when a *proven* account already holds this address, so
    // the user fixes it here instead of getting a verification link that can never
    // succeed. Not the real guard — the unique index at verification time is.
    const emailHolder = await prisma.user.findUnique({ where: { email } })
    if (emailHolder?.emailVerifiedAt) {
      res.status(409).json({ error: 'email_taken' })
      return
    }

    // Fast path for the common case (a name that's plainly taken), so the user gets a
    // clean 409 without waiting on an argon2 hash.
    const existing = await prisma.user.findUnique({ where: { username } })
    if (existing) {
      res.status(409).json({ error: 'username_taken' })
      return
    }

    // The check above is advisory only: hashing takes ~100ms, and two concurrent
    // registrations for the same name both clear it before either inserts. The unique
    // index is the real arbiter, so translate its violation instead of letting it
    // bubble up as a 500.
    // Note what is *not* in this create: `email`. The address the user just typed is
    // unproven, and an unproven address never touches the uniquely-indexed column —
    // otherwise signing up with someone else's address would permanently block them
    // from using it. It goes on a verification token instead; `verifyEmailClaim` is
    // the only writer of `User.email`. See `auth/emailVerification.ts`.
    let user
    try {
      user = await prisma.user.create({
        data: {
          username,
          passwordHash: await hashPassword(password),
          displayName: displayName.slice(0, MAX_DISPLAY_NAME),
        },
      })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        res.status(409).json({ error: 'username_taken' })
        return
      }
      throw err
    }
    logger.info('auth.registered', { userId: user.id })

    // The account exists and the user is signed in whether or not this succeeds —
    // verification is a follow-up, not a gate, and a dead SMTP host must not turn a
    // successful signup into an error. `sendMail` already swallows its own failures.
    await claimEmail(user.id, email, lang)

    const { accessToken } = await establishSession(res, user.id)
    res.status(201).json({ user: serializeUser(user, email), accessToken })
  }),
)

// ── POST /auth/login ─────────────────────────────────────────────────────────
authRouter.post(
  '/login',
  asyncRoute(async (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (!authLimiter.allow(ip)) return void limited(res, 'auth.login.ratelimited', ip)

    const username = String(req.body?.username ?? '')
      .trim()
      .toLowerCase()
    const password = String(req.body?.password ?? '')

    // Per-account failure budget, checked without spending a hit (only failures below
    // count). Answer 429 rather than 401 so a legitimate user learns to wait instead
    // of retyping a password that would have worked.
    if (!loginFailureLimiter.peek(username)) {
      logger.warn('auth.login.account_locked', { ip })
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    const user = await prisma.user.findUnique({ where: { username }, include: { partner: true } })

    // Always spend one argon2 verification, even when there's nothing to verify
    // against — otherwise the response time reveals whether the account exists.
    const ok = user?.passwordHash
      ? await verifyPassword(user.passwordHash, password)
      : await verifyDecoyPassword(password)

    if (!user || !ok) {
      loginFailureLimiter.allow(username)
      res.status(401).json({ error: 'invalid_credentials' })
      return
    }

    loginFailureLimiter.reset(username)
    const { accessToken } = await establishSession(res, user.id)
    res.json({ user: serializeUser(user), accessToken })
  }),
)

// ── POST /auth/google ────────────────────────────────────────────────────────
authRouter.post(
  '/google',
  asyncRoute(async (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (!authLimiter.allow(ip)) return void limited(res, 'auth.google.ratelimited', ip)

    const idToken = String(req.body?.idToken ?? '')
    if (!idToken) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    let identity
    try {
      identity = await verifyGoogleIdToken(idToken)
    } catch (err) {
      const code = err instanceof Error ? err.message : 'invalid_google_token'
      res.status(code === 'google_not_configured' ? 503 : 401).json({ error: code })
      return
    }

    // Reconcile: match by googleId, else link to an existing email account, else create.
    let user = await prisma.user.findUnique({
      where: { googleId: identity.googleId },
      include: { partner: true },
    })
    if (!user) {
      const byEmail = await prisma.user.findUnique({ where: { email: identity.email } })
      // Closed beta: Google may still *authenticate* an account that already exists —
      // anyone already linked keeps their way in — but it may no longer *create* one.
      // Without this, `/auth/register` being shut means nothing: this route is the other
      // way to mint an account, and it is just as reachable from outside the browser.
      if (!byEmail && env.inviteOnly) {
        logger.info('auth.google.closed', { ip })
        res.status(403).json({ error: 'registration_closed' })
        return
      }

      // Google is the one source we take an address from without mailing our own
      // link: `verifyGoogleIdToken` rejects any token whose `email_verified` isn't
      // true, so the mailbox was proven before it reached us. Stamping
      // `emailVerifiedAt` here is what lets these accounts reset their password.
      user = byEmail
        ? await prisma.user.update({
            where: { id: byEmail.id },
            data: {
              googleId: identity.googleId,
              avatarUrl: byEmail.avatarUrl ?? identity.picture,
              // Also promotes an admin-minted address that was sitting unproven.
              emailVerifiedAt: byEmail.emailVerifiedAt ?? new Date(),
            },
            include: { partner: true },
          })
        : await prisma.user.create({
            data: {
              username: await generateUniqueUsername(identity.email.split('@')[0] ?? identity.name),
              email: identity.email,
              emailVerifiedAt: new Date(),
              displayName: identity.name.slice(0, MAX_DISPLAY_NAME),
              avatarUrl: identity.picture,
              googleId: identity.googleId,
            },
            include: { partner: true },
          })
    }
    logger.info('auth.google', { userId: user.id })

    const { accessToken } = await establishSession(res, user.id)
    res.json({ user: serializeUser(user), accessToken })
  }),
)

// ── POST /auth/refresh ───────────────────────────────────────────────────────
authRouter.post(
  '/refresh',
  asyncRoute(async (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (!refreshLimiter.allow(ip)) return void limited(res, 'auth.refresh.ratelimited', ip)

    const raw = req.cookies?.[REFRESH_COOKIE]
    if (typeof raw !== 'string' || !raw) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    const rotated = await rotateRefreshToken(raw)
    if (!rotated) {
      res.clearCookie(REFRESH_COOKIE, refreshCookieOptions())
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    res.cookie(REFRESH_COOKIE, rotated.raw, refreshCookieOptions(rotated.expiresAt))
    const user = await prisma.user.findUnique({
      where: { id: rotated.userId },
      include: { partner: true },
    })
    if (!user) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    // Carry `pendingEmail` on the refresh path too. It costs one indexed lookup per
    // access-token expiry (an hour, per tab), and without it a refresh would quietly
    // replace the store's user with one that has forgotten it is mid-verification —
    // the "confirm your address" prompt would vanish until the next full load.
    res.json({
      user: serializeUser(user, await pendingEmailFor(user.id)),
      accessToken: signAccessToken(user.id),
    })
  }),
)

// ── POST /auth/logout ────────────────────────────────────────────────────────
authRouter.post(
  '/logout',
  asyncRoute(async (req, res) => {
    const raw = req.cookies?.[REFRESH_COOKIE]
    if (typeof raw === 'string' && raw) await revokeRefreshToken(raw)
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions())
    res.status(204).end()
  }),
)

// ── GET /auth/me ─────────────────────────────────────────────────────────────
authRouter.get(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      include: { partner: true },
    })
    if (!user) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    res.json({ user: serializeUser(user, await pendingEmailFor(user.id)) })
  }),
)

// ── POST /auth/me/email ─── claim an address (or replace the current one) ─────
authRouter.post(
  '/me/email',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!emailClaimLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    const email = normalizeEmail(req.body?.email)
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const result = await claimEmail(userId, email, normalizeLang(req.body?.lang))
    if (!result.ok) {
      res.status(409).json({ error: result.reason })
      return
    }
    // 202: we've accepted the claim, but nothing about the account has changed yet
    // and won't until the link is opened. The address is echoed back so the client
    // can show the user exactly where the mail went — a typo is the whole failure
    // mode, and it's much easier to spot on screen than in an inbox that stays empty.
    res.status(202).json({ ok: true, pendingEmail: email })
  }),
)

// ── POST /auth/me/email/resend ─── re-send the pending link ──────────────────
authRouter.post(
  '/me/email/resend',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!resendLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    const email = await resendClaim(userId, normalizeLang(req.body?.lang))
    if (!email) {
      res.status(409).json({ error: 'nothing_pending' })
      return
    }
    res.status(202).json({ ok: true, pendingEmail: email })
  }),
)

// ── POST /auth/verify-email ─── prove the address ────────────────────────────
//
// Deliberately unauthenticated. This link gets opened on a phone, in a webmail
// preview pane, in whatever browser the mail app happens to use — signed in is the
// exception, not the rule. The token is the proof; demanding a session on top of it
// would strand exactly the person the link exists for.
authRouter.post(
  '/verify-email',
  asyncRoute(async (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (!resetTokenLimiter.allow(ip)) return void limited(res, 'auth.verify_email.ratelimited', ip)

    const token = String(req.body?.token ?? '')
    if (!token) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const result = await verifyEmailClaim(token)
    if (!result.ok) {
      res.status(result.reason === 'email_taken' ? 409 : 400).json({ error: result.reason })
      return
    }
    res.json({ user: serializeUser(result.user) })
  }),
)

// ── POST /auth/me/password ─── change it while signed in ─────────────────────
authRouter.post(
  '/me/password',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true, email: true, emailVerifiedAt: true },
    })
    if (!user) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    // **A password nobody can reset is a lock with no spare key.**
    // `POST /auth/forgot-password` mails a link only to a *proven* address
    // (`issuePasswordReset` bails on an unverified one), so an account without one
    // that fumbles the new password — a typo into a password manager, a half-saved
    // autofill — is locked out for good, with no path back that doesn't go through an
    // operator. Refuse the change until the address is confirmed; the profile's email
    // row sits directly above this control, so the fix is one click away.
    //
    // Checked before the current-password compare so a request that cannot succeed
    // doesn't spend ~100ms of argon2. Google-linked accounts are unaffected — that
    // flow stamps `emailVerifiedAt` itself — so "set a first password" still works.
    if (!user.emailVerifiedAt) {
      logger.info('auth.password.change_blocked', { userId, reason: 'email_unverified' })
      res.status(403).json({ error: 'email_unverified' })
      return
    }

    const newPassword = String(req.body?.newPassword ?? '')
    if (newPassword.length < MIN_PASSWORD) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    // An account with a password must re-supply it — same reasoning as
    // `DELETE /auth/me`: an access token left behind on a shared device shouldn't be
    // enough to lock the real owner out. A Google-only account has nothing to
    // re-supply, so for them this route *sets* a first password.
    if (user.passwordHash) {
      const ok = await verifyPassword(user.passwordHash, String(req.body?.currentPassword ?? ''))
      if (!ok) {
        res.status(403).json({ error: 'invalid_password' })
        return
      }
    }

    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword) },
    })

    // Sign every device out, then immediately re-establish *this* one: the point is
    // to evict anyone else holding a session, not to log the user out of the tab
    // they just used to succeed.
    const revoked = await revokeAllForUser(userId)
    const { accessToken } = await establishSession(res, userId)
    logger.info('auth.password.changed', { userId, sessionsRevoked: revoked })

    // **The one mail that tells a victim something happened.** Revoking every session
    // evicts a thief who is *already in*; it says nothing to the owner, who by then
    // can no longer sign in to discover why. This is the only signal that reaches
    // them, and it carries a reset link so the answer to "that wasn't me" is one
    // click — the same message `consumePasswordReset` sends for the same reason.
    //
    // The `if` is the type narrowing `email` needs, not a policy branch: the gate at
    // the top of this handler already established a proven address, so there is no
    // reachable state here where a change goes unannounced. Not awaited, like every
    // other send — a slow notification service must not hold the response open, and
    // `sendMail` swallows its own failures.
    if (user.email) void sendPasswordChanged(user.email, normalizeLang(req.body?.lang))

    res.json({ accessToken })
  }),
)

// ── POST /auth/forgot-password ─── ask for a reset link ──────────────────────
//
// **This route tells the caller nothing.** Same status, same body, whether the
// identifier is unknown, known-without-a-verified-address, or known-and-mailed.
// `POST /auth/login` already spends a decoy argon2 hash for exactly this reason
// (`verifyDecoyPassword`) — it would be pointless for that route to buy silence at
// ~100ms a request while this one answers "no such user" for free.
//
// The send is not awaited for the same reason: SMTP latency is as good an oracle as
// a status code.
authRouter.post(
  '/forgot-password',
  asyncRoute(async (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (!forgotIpLimiter.allow(ip)) return void limited(res, 'auth.forgot.ratelimited', ip)

    const identifier = String(req.body?.identifier ?? '')
      .trim()
      .toLowerCase()
    const lang = normalizeLang(req.body?.lang)

    // Accepted and answered identically even when malformed — a 400 here would say
    // "that isn't one of ours", which is the same leak by another route.
    if (identifier && forgotAccountLimiter.allow(identifier)) {
      // Sign-in is username-first, but people remember their email. Take either.
      const user = identifier.includes('@')
        ? await prisma.user.findUnique({ where: { email: identifier } })
        : await prisma.user.findUnique({ where: { username: identifier } })

      if (user) {
        const sent = await issuePasswordReset(user, lang)
        if (!sent) logger.info('auth.forgot.no_verified_email', { userId: user.id })
      } else {
        logger.info('auth.forgot.unknown_identifier', { ip })
      }
    }

    res.status(202).json({ ok: true })
  }),
)

// ── GET /auth/reset-password ─── is this link still good? ────────────────────
//
// Returns a bare boolean: never the address, never the username. Someone holding a
// spent token should not be able to learn whose account it was.
authRouter.get(
  '/reset-password',
  asyncRoute(async (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (!resetTokenLimiter.allow(ip)) return void limited(res, 'auth.reset.ratelimited', ip)

    const token = typeof req.query.token === 'string' ? req.query.token : ''
    res.json({ valid: token ? await isResetTokenValid(token) : false })
  }),
)

// ── POST /auth/reset-password ─── redeem the link ────────────────────────────
authRouter.post(
  '/reset-password',
  asyncRoute(async (req, res) => {
    const ip = req.ip ?? 'unknown'
    if (!resetTokenLimiter.allow(ip)) return void limited(res, 'auth.reset.ratelimited', ip)

    const token = String(req.body?.token ?? '')
    const password = String(req.body?.password ?? '')
    if (!token || password.length < MIN_PASSWORD) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const ok = await consumePasswordReset(token, password, normalizeLang(req.body?.lang))
    if (!ok) {
      res.status(400).json({ error: 'invalid_token' })
      return
    }

    // No session is issued. The link is a recovery credential, not a sign-in: the
    // user takes the password they just chose to the login form. That also means a
    // link intercepted in transit can't be turned straight into a live session
    // without the interceptor also knowing what they set it to.
    res.status(204).end()
  }),
)

// ── PATCH /auth/me ───────────────────────────────────────────────────────────
authRouter.patch(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const data: {
      displayName?: string
      countryCode?: string | null
      regionCode?: string | null
      cityName?: string | null
    } = {}

    if (req.body?.displayName !== undefined) {
      const displayName = String(req.body.displayName).trim()
      if (displayName.length === 0) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      data.displayName = displayName.slice(0, MAX_DISPLAY_NAME)
    }
    if (req.body?.location !== undefined) {
      // The current region is read so a retired code can still be re-saved untouched
      // (see `parseLocation`). Absent `location` leaves all three columns alone.
      const current = await prisma.user.findUnique({
        where: { id: req.userId },
        select: { regionCode: true },
      })
      const location = parseLocation(req.body.location, current?.regionCode ?? null)
      if (!location) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      Object.assign(data, location)
    }
    // `avatarUrl` is intentionally not settable here. It holds the picture Google
    // gave us, and a user-supplied URL would be fetched by their partner's browser —
    // handing whoever hosts it that person's IP address. Pictures come in through
    // the upload route below, where we hold the bytes ourselves.

    const user = await prisma.user.update({
      where: { id: req.userId },
      data,
      include: { partner: true },
    })
    res.json({ user: serializeUser(user, await pendingEmailFor(user.id)) })
  }),
)

// ── POST /auth/me/avatar ─── replace the profile picture ─────────────────────
authRouter.post(
  '/me/avatar',
  requireAuth,
  avatarBody,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!avatarLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    const bytes: unknown = req.body
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    // Trust the bytes, not the header the client sent with them.
    const mimeType = sniffImageType(bytes)
    if (!mimeType) {
      res.status(400).json({ error: 'unsupported_image' })
      return
    }

    /**
     * An avatar is square, and that is enforced here rather than only in the browser.
     *
     * Our own client center-crops to a 256px square before it uploads, so nothing in
     * the app can trip these — but this is a plain HTTP endpoint, and a request that
     * skips the client entirely is one `curl` away. Without the check, a 4000×100
     * banner would be stored and then rendered into the partner's profile and the
     * admin console, both of which lay avatars out as squares.
     *
     * A separate lookup from `sniffImageType`: that one decides *whether these bytes
     * are an image we serve*, this one decides *whether the image is a usable avatar*.
     */
    const size = await readImageSize(bytes)
    if (!size) {
      res.status(400).json({ error: 'unsupported_image' })
      return
    }
    if (size.width !== size.height) {
      res.status(400).json({ error: 'image_not_square' })
      return
    }
    if (size.width > AVATAR_MAX_EDGE) {
      res.status(400).json({ error: 'image_too_large' })
      return
    }

    // What the picture is replacing, read before anything overwrites it: the old
    // object has to be cleaned up by hand, since nothing else names it once the
    // column moves on.
    const previous = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarKey: true },
    })

    let user
    if (storageEnabled) {
      // Upload first, then point the row at it — in that order, so a failed upload
      // leaves the old picture intact rather than a row pointing at nothing.
      const key = newAvatarKey(mimeType)
      try {
        await putImage('avatar', key, bytes, mimeType)
      } catch (error) {
        // A refused write is an operational fault, not a bad request, and it must not
        // surface as a bare `internal_error` — that reads as "the app is broken" when
        // the real answer is usually one bucket setting. 503, because the request was
        // fine and the rest of the API still works; the log names the bucket so the
        // cause is in the line you already have rather than in a stack trace.
        logger.error('auth.avatar.storageFailed', {
          userId,
          bucket: 'avatar',
          message: (error as Error).message,
          hint: 'Check R2_AVATAR_BUCKET exists and the R2 API token is scoped to it.',
        })
        res.status(503).json({ error: 'storage_unavailable' })
        return
      }

      // Clearing the legacy row is part of the same transaction: a user must never
      // hold both, or the two paths in `GET /avatars/:userId` would disagree about
      // which picture is current.
      const [, updated] = await prisma.$transaction([
        prisma.avatarImage.deleteMany({ where: { userId } }),
        prisma.user.update({
          where: { id: userId },
          data: { avatarKey: key, avatarUpdatedAt: new Date() },
          include: { partner: true },
        }),
      ])
      user = updated
    } else {
      // No bucket configured — keep the bytes in Postgres, as they were before
      // avatars moved to object storage. Small enough that this stays a workable
      // local-dev path rather than a hard failure (a strip, by contrast, refuses).
      //
      // Prisma types a `Bytes` column as a plain Uint8Array; copy out of the Buffer so
      // the value doesn't carry Node's wider ArrayBufferLike backing type.
      const data = new Uint8Array(bytes)

      // Write the image and flag the user in one transaction: a stamped user with no
      // row behind it would render a broken picture for them and their partner.
      const [, updated] = await prisma.$transaction([
        prisma.avatarImage.upsert({
          where: { userId },
          create: { userId, bytes: data, mimeType },
          update: { bytes: data, mimeType },
        }),
        prisma.user.update({
          where: { id: userId },
          data: { avatarKey: null, avatarUpdatedAt: new Date() },
          include: { partner: true },
        }),
      ])
      user = updated
    }

    // Best-effort, and only after the row is committed: a leftover object costs
    // storage, while deleting one the row still points at costs the user their
    // picture.
    if (previous?.avatarKey) await deleteImages('avatar', [previous.avatarKey])

    logger.info('auth.avatar.uploaded', { userId, bytes: bytes.length, mimeType, edge: size.width })
    res.json({ user: serializeUser(user) })
  }),
)

// ── DELETE /auth/me/avatar ─── back to the initial-letter fallback ───────────
authRouter.delete(
  '/me/avatar',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const previous = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarKey: true },
    })
    // `deleteMany` rather than `delete` so removing an avatar that isn't there is a
    // no-op instead of a P2025.
    const [, user] = await prisma.$transaction([
      prisma.avatarImage.deleteMany({ where: { userId } }),
      prisma.user.update({
        where: { id: userId },
        data: { avatarKey: null, avatarUpdatedAt: null },
        include: { partner: true },
      }),
    ])
    // Rows go with the transaction; the object in the bucket doesn't — drop it here
    // or removing a picture just hides it. Best-effort, as ever.
    if (previous?.avatarKey) await deleteImages('avatar', [previous.avatarKey])
    logger.info('auth.avatar.removed', { userId })
    res.json({ user: serializeUser(user) })
  }),
)

// ── DELETE /auth/me ─── permanently delete the caller's own account ──────────
// Self-service account deletion. For an account that has a password, we re-verify
// it here: an access token alone (which could be lingering on a shared device)
// shouldn't be enough to erase an account. Google-only accounts have no password to
// check — the valid session is the proof. The delete cascades the user's strips,
// avatar, refresh tokens and partner invites, unlinks any partner, and detaches
// feedback (kept for triage); their payment records are removed with the account.
authRouter.delete(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const user = await prisma.user.findUnique({
      where: { id: userId },
      // `avatarKey` because the row cascades away but the object it names doesn't —
      // read it while the row still exists.
      select: { passwordHash: true, avatarKey: true },
    })
    if (!user) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }

    if (user.passwordHash) {
      const password = String(req.body?.password ?? '')
      const ok = await verifyPassword(user.passwordHash, password)
      if (!ok) {
        res.status(403).json({ error: 'invalid_password' })
        return
      }
    }

    await prisma.user.delete({ where: { id: userId } })
    // Their testimonials cascaded away (or dropped them as a partner) — refresh the landing cache.
    markTestimonialsChanged()
    if (user.avatarKey) await deleteImages('avatar', [user.avatarKey])
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions())
    logger.info('auth.account.deleted', { userId })
    res.status(204).end()
  }),
)
