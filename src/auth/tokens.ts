import jwt from 'jsonwebtoken'

import { env } from '../config/env.js'
import { prisma } from '../db/client.js'
import { logger } from '../lib/logger.js'

import { hashLinkToken, mintToken } from './linkTokens.js'

/** Verified access-token claims we rely on. */
export interface AccessClaims {
  /** User id. */
  sub: string
}

/** Signs a short-lived access JWT for the given user. */
export function signAccessToken(userId: string): string {
  return jwt.sign({}, env.jwtSecret, {
    subject: userId,
    expiresIn: env.jwtAccessTtlSeconds,
  })
}

/** Verifies an access JWT, returning its claims. Throws if invalid/expired. */
export function verifyAccessToken(token: string): AccessClaims {
  const payload = jwt.verify(token, env.jwtSecret)
  if (typeof payload === 'string' || typeof payload.sub !== 'string') {
    throw new Error('malformed access token')
  }
  return { sub: payload.sub }
}

/**
 * Refresh tokens are opaque high-entropy randoms; we persist only their SHA-256.
 * Shared with the email/reset links — see `linkTokens.ts` for why the hash is fast.
 */
const hashToken = hashLinkToken

/**
 * Mints a new refresh token for `userId`, storing only its hash. Returns the raw
 * token (to set as the client cookie) and its absolute expiry.
 */
export async function issueRefreshToken(userId: string): Promise<{ raw: string; expiresAt: Date }> {
  const raw = mintToken()
  const expiresAt = new Date(Date.now() + env.jwtRefreshTtlSeconds * 1000)
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(raw), expiresAt },
  })
  return { raw, expiresAt }
}

/**
 * How long after rotation a presentation of the old token is treated as a benign
 * race rather than theft. Two tabs whose access tokens expire together will each
 * refresh with the same cookie; the loser arrives moments late through no fault of
 * its own, and must not cost the user every session.
 */
const REUSE_GRACE_MS = 60_000

/** Revokes every live refresh token for a user (reuse detected / "sign out everywhere"). */
export async function revokeAllForUser(userId: string): Promise<number> {
  const { count } = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  })
  return count
}

/**
 * Validates a raw refresh token and rotates it: the presented token is revoked and
 * a fresh one is issued (single-use rotation limits replay of a leaked token).
 * Returns the owning userId + the new token, or null if the token is
 * unknown / expired / already revoked.
 *
 * **Reuse detection.** A token that was already rotated should never appear again.
 * Outside the race window above, a replay means someone is holding a copy of a cookie
 * that has since moved on — the signature of a stolen session — so every token for
 * that account is revoked. The legitimate user signs in again; the thief is evicted.
 */
export async function rotateRefreshToken(
  raw: string,
): Promise<{ userId: string; raw: string; expiresAt: Date } | null> {
  const existing = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(raw) } })
  if (!existing) return null

  if (existing.revokedAt) {
    if (Date.now() - existing.revokedAt.getTime() > REUSE_GRACE_MS) {
      const revoked = await revokeAllForUser(existing.userId)
      logger.warn('auth.refresh.reuse_detected', { userId: existing.userId, revoked })
    } else {
      logger.info('auth.refresh.rotation_race', { userId: existing.userId })
    }
    return null
  }

  if (existing.expiresAt <= new Date()) return null

  await prisma.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  })
  const next = await issueRefreshToken(existing.userId)
  return { userId: existing.userId, ...next }
}

/** Revokes a refresh token (logout). No-op if it doesn't exist. */
export async function revokeRefreshToken(raw: string): Promise<void> {
  await prisma.refreshToken
    .updateMany({
      where: { tokenHash: hashToken(raw), revokedAt: null },
      data: { revokedAt: new Date() },
    })
    .catch(() => undefined)
}

/** Deletes expired / long-revoked refresh tokens. Wired into the periodic sweep. */
export async function sweepRefreshTokens(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.refreshToken.deleteMany({
    where: {
      OR: [
        { expiresAt: { lte: now } },
        { revokedAt: { lte: new Date(now.getTime() - 86_400_000) } },
      ],
    },
  })
  return count
}
