import { Prisma, type User } from '@prisma/client'

import { env } from '../config/env.js'
import { prisma } from '../db/client.js'
import { logger } from '../lib/logger.js'
import { sendVerifyEmail } from '../notifications/client.js'
import type { Lang } from '../notifications/lang.js'

import { hashLinkToken, mintToken } from './linkTokens.js'

/**
 * Claiming and proving an email address.
 *
 * The invariant this module exists to hold: **`User.email` is written in exactly one
 * place — `verifyEmailClaim` — and only against a token someone opened from their
 * inbox.** Registration, the profile form and everything else route through
 * `claimEmail`, which writes only to the token table. See the model docs in
 * `schema.prisma` for why (address squatting against a unique index, and typos
 * destroying a working address).
 */

/** Outcome of claiming an address. */
export type ClaimResult = { ok: true } | { ok: false; reason: 'email_taken' }

/** Outcome of opening a verification link. */
export type VerifyResult =
  | { ok: true; user: User & { partner: User | null } }
  | { ok: false; reason: 'invalid_token' | 'email_taken' }

/**
 * Records a claim on `email` for `userId` and mails the proof link.
 *
 * `email` must already be normalized and shape-checked (`lib/email.ts`) — this is the
 * storage layer, not the parser.
 *
 * The `email_taken` check here is **advisory**: it gives an honest user a clean error
 * instead of a link that will fail 30 seconds later. It is not the security control —
 * the unique index at verification time is, because two people can hold pending
 * claims on one address and only one of them can win.
 */
export async function claimEmail(userId: string, email: string, lang: Lang): Promise<ClaimResult> {
  const raw = await mintEmailClaim(userId, email)
  if (raw === null) return { ok: false, reason: 'email_taken' }

  // Not awaited: the caller is a request handler whose work is already done, and a
  // slow notification service must not hold the response open.
  void sendVerifyEmail(email, raw, lang)
  return { ok: true }
}

/**
 * Records the claim and returns the raw token **without mailing anything**, or null
 * if a proven holder already has the address.
 *
 * Kept separate from the send so the two concerns stay legible: this one owns the
 * "one live claim per user" rule and the taken-address check, `claimEmail` owns the
 * message. Private — every caller wants the mail sent.
 */
async function mintEmailClaim(userId: string, email: string): Promise<string | null> {
  const holder = await prisma.user.findUnique({ where: { email } })
  // Only a *proven* holder blocks the claim. An account that merely has the address
  // sitting in its column unverified (operator-typed, seeded) shouldn't be able to
  // keep the real owner from proving it.
  if (holder && holder.id !== userId && holder.emailVerifiedAt !== null) return null

  const raw = mintToken()
  const expiresAt = new Date(Date.now() + env.emailVerifyTtlHours * 3_600_000)

  // One live claim per user: a second address supersedes the first rather than
  // leaving two openable links, which would let whichever mail arrived first win a
  // race the user didn't know they were running.
  await prisma.$transaction([
    prisma.emailVerificationToken.deleteMany({ where: { userId } }),
    prisma.emailVerificationToken.create({
      data: { userId, email, tokenHash: hashLinkToken(raw), expiresAt },
    }),
  ])

  logger.info('auth.email.claimed', { userId })
  return raw
}

/** The address a user is currently trying to prove, if any. Null when none is live. */
export async function pendingEmailFor(userId: string): Promise<string | null> {
  const token = await prisma.emailVerificationToken.findFirst({
    where: { userId, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { email: true },
  })
  return token?.email ?? null
}

/** Re-sends the live claim's link. Null when there's nothing pending to re-send. */
export async function resendClaim(userId: string, lang: Lang): Promise<string | null> {
  const email = await pendingEmailFor(userId)
  if (!email) return null
  // Mint a fresh token rather than re-mailing the old one, so the TTL restarts and
  // the link in the older message stops working — a user who re-sends usually
  // believes the first mail went astray, and two live links is the wrong answer.
  await claimEmail(userId, email, lang)
  return email
}

/**
 * Consumes a verification link: proves the address and copies it onto the user.
 *
 * Deliberately takes no session — the link is routinely opened on a phone that isn't
 * signed in, and the token *is* the proof. Requiring auth here would strand exactly
 * the person we're trying to help.
 */
export async function verifyEmailClaim(raw: string): Promise<VerifyResult> {
  const token = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashLinkToken(raw) },
  })
  if (!token || token.usedAt || token.expiresAt <= new Date()) {
    logger.info('auth.email.verify_failed', { reason: token ? 'spent_or_expired' : 'unknown' })
    return { ok: false, reason: 'invalid_token' }
  }

  try {
    const [, , user] = await prisma.$transaction([
      prisma.emailVerificationToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() },
      }),
      // **Proven beats unproven.** The column is uniquely indexed, so an account
      // sitting on this address *without* having proved it would otherwise block the
      // person who actually owns the mailbox — and the two ways an unproven address
      // gets there (an operator typing it into `POST /admin/users`, a seeding script)
      // are exactly the ways it ends up on the wrong account. Release it first.
      //
      // The loser keeps their account and every strip in it; they lose an address
      // they never confirmed, and the next thing they do in Profile is claim a real
      // one. A *verified* holder is untouched by this — that collision falls through
      // to the unique index below and comes back as `email_taken`, which is correct:
      // two proven owners of one mailbox is not a state we can resolve ourselves.
      prisma.user.updateMany({
        where: { email: token.email, emailVerifiedAt: null, id: { not: token.userId } },
        data: { email: null },
      }),
      prisma.user.update({
        where: { id: token.userId },
        data: { email: token.email, emailVerifiedAt: new Date() },
        include: { partner: true },
      }),
    ])
    logger.info('auth.email.verified', { userId: token.userId })
    return { ok: true, user }
  } catch (err) {
    // Someone else proved this address first. The unique index is the arbiter, and
    // this is the losing side of that race — a real outcome, not a server fault.
    if (isUniqueEmailViolation(err)) {
      logger.info('auth.email.verify_failed', { userId: token.userId, reason: 'email_taken' })
      return { ok: false, reason: 'email_taken' }
    }
    throw err
  }
}

/** True for a P2002 unique-constraint violation on `User.email`. */
function isUniqueEmailViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    String(err.meta?.target ?? '').includes('email')
  )
}

/** Deletes spent / expired claims. Wired into the periodic sweep. */
export async function sweepEmailVerificationTokens(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.emailVerificationToken.deleteMany({
    where: { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] },
  })
  return count
}
