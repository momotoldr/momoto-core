import type { User } from '@prisma/client'

import { env } from '../config/env.js'
import { prisma } from '../db/client.js'
import { logger } from '../lib/logger.js'
import { sendPasswordChanged, sendPasswordReset } from '../notifications/client.js'
import type { Lang } from '../notifications/lang.js'

import { hashLinkToken, mintToken } from './linkTokens.js'
import { hashPassword } from './passwords.js'
import { revokeAllForUser } from './tokens.js'

/**
 * Password recovery by emailed link.
 *
 * Two rules shape everything here:
 *
 * 1. **Only a proven address gets a link.** An unverified address is either a typo or
 *    somebody else's inbox; mailing a recovery credential to either is how an account
 *    gets taken over by accident.
 * 2. **A completed reset ends every session.** If the reset was a real user taking
 *    their account back, leaving the other party's refresh cookie alive defeats the
 *    entire exercise.
 */

/**
 * Mints a reset token for a user who has a proven address, and mails it.
 *
 * Callers must not branch on the return value in a way the client can observe — see
 * the enumeration note on `POST /auth/forgot-password`. It returns a boolean only so
 * the server log can tell "we sent one" from "there was nothing to send".
 */
export async function issuePasswordReset(
  user: Pick<User, 'id' | 'email' | 'emailVerifiedAt'>,
  lang: Lang,
): Promise<boolean> {
  if (!user.email || !user.emailVerifiedAt) return false

  const raw = mintToken()
  const expiresAt = new Date(Date.now() + env.passwordResetTtlMinutes * 60_000)

  // Supersede any outstanding link. Someone who asks twice expects the newest mail to
  // be the one that works, and leaving older links live widens the window for a
  // token that leaked out of an inbox.
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: hashLinkToken(raw), expiresAt },
    }),
  ])

  logger.info('auth.reset.issued', { userId: user.id })
  void sendPasswordReset(user.email, raw, lang)
  return true
}

/**
 * Is this raw token currently redeemable? Used by the page-load pre-check so an
 * expired link can say so before the user types a new password twice.
 *
 * Returns a bare boolean on purpose: never the address, never the username. The
 * token is a bearer credential, and anyone holding a *spent* one shouldn't learn
 * whose account it belonged to.
 */
export async function isResetTokenValid(raw: string): Promise<boolean> {
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashLinkToken(raw) },
    select: { usedAt: true, expiresAt: true },
  })
  return Boolean(token && !token.usedAt && token.expiresAt > new Date())
}

/**
 * Redeems a reset token: sets the new password, spends the token, and signs every
 * device out.
 *
 * The password hash, the token's `usedAt` stamp and the deletion of the user's other
 * reset tokens go in one transaction — a partial apply here would either leave a
 * redeemable link against a password that already changed, or change a password
 * while the link stays live.
 */
export async function consumePasswordReset(
  raw: string,
  newPassword: string,
  lang: Lang,
): Promise<boolean> {
  const token = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashLinkToken(raw) },
  })
  if (!token || token.usedAt || token.expiresAt <= new Date()) {
    logger.warn('auth.reset.invalid_token', { reason: token ? 'spent_or_expired' : 'unknown' })
    return false
  }

  const passwordHash = await hashPassword(newPassword)
  const [, , user] = await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: token.id }, data: { usedAt: new Date() } }),
    prisma.passwordResetToken.deleteMany({
      where: { userId: token.userId, id: { not: token.id } },
    }),
    prisma.user.update({ where: { id: token.userId }, data: { passwordHash } }),
  ])

  // Outside the transaction: revoking sessions is idempotent and safe to retry, and
  // holding the write lock across it buys nothing.
  const revoked = await revokeAllForUser(token.userId)
  logger.info('auth.reset.completed', { userId: token.userId, sessionsRevoked: revoked })

  // The one mail that tells a victim something happened. Sent even though it asks
  // nothing of the reader — if this reset wasn't theirs, this is how they find out.
  //
  // Verified, not merely present: an address on the row that nobody proved is either
  // a typo or somebody else's inbox (see `issuePasswordReset`), and a security notice
  // is the last thing that should be the first mail a stranger gets from us. Today
  // that state can't reach here — a token is only ever issued against a proven
  // address — but the predicate should say what it means rather than rely on a
  // caller two files away to keep being careful.
  if (user.email && user.emailVerifiedAt) void sendPasswordChanged(user.email, lang)
  return true
}

/** Deletes spent / expired reset tokens. Wired into the periodic sweep. */
export async function sweepPasswordResetTokens(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.passwordResetToken.deleteMany({
    where: { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] },
  })
  return count
}
