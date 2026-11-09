import { type Response, Router } from 'express'

import { signAdminSession } from '../../auth/adminSession.js'
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotp,
  otpauthUri,
} from '../../auth/totp.js'
import { prisma } from '../../db/client.js'
import { auditAdminRequest } from '../../lib/adminAudit.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { asyncRoute } from '../asyncRoute.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { requireAuth } from '../middleware/requireAuth.js'

/**
 * Enrolling in and passing the 6-digit check. The one part of `/admin` reachable without
 * an admin session, because this is how you get one. Still admin-only, and audited.
 *
 * Wrong codes answer 400, never 401: the portal treats a 401 as an expired login and
 * would refresh and retry.
 */
export const adminMfaRouter = Router()

adminMfaRouter.use(requireAuth, requireAdmin, auditAdminRequest)

/**
 * Attempts per admin, counted before the check and cleared on success, so parallel
 * guesses can't all slip through. A code space of a million with three steps live makes
 * this a very poor rate to guess at.
 */
const attemptLimiter = new RateLimiter(10, 15 * 60_000)
const enrollLimiter = new RateLimiter(20, 15 * 60_000)

/** Reclaim expired windows (wired into the periodic sweep). */
export function sweepAdminMfaLimits(now: number = Date.now()): number {
  return attemptLimiter.sweep(now) + enrollLimiter.sweep(now)
}

function spendAttempt(res: Response, userId: string): boolean {
  if (attemptLimiter.allow(userId)) return true
  logger.warn('admin.mfa.locked', { userId })
  res.status(429).json({ error: 'too_many_requests' })
  return false
}

function readString(value: unknown, maxLength: number): string {
  return typeof value === 'string' && value.length <= maxLength ? value.trim() : ''
}

// ── POST /admin/mfa/enroll ─── the secret and QR contents ────────────────────
// Answers the same pending secret until it's confirmed, so reloading the page doesn't
// invalidate a QR code that has already been scanned.
adminMfaRouter.post(
  '/enroll',
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!enrollLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { username: true, totpSecret: true, totpEnabledAt: true },
    })
    if (user.totpEnabledAt) {
      res.status(409).json({ error: 'mfa_already_enrolled' })
      return
    }
    let secret: string
    if (user.totpSecret) {
      secret = decryptTotpSecret(user.totpSecret)
    } else {
      secret = generateTotpSecret()
      await prisma.user.update({
        where: { id: userId },
        data: { totpSecret: encryptTotpSecret(secret) },
      })
    }
    res.json({ secret, otpauthUri: otpauthUri(secret, user.username) })
  }),
)

// ── POST /admin/mfa/enroll/confirm ─── first code proves the scan worked ─────
adminMfaRouter.post(
  '/enroll/confirm',
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!spendAttempt(res, userId)) return

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpSecret: true, totpEnabledAt: true },
    })
    if (user.totpEnabledAt) {
      res.status(409).json({ error: 'mfa_already_enrolled' })
      return
    }
    if (!user.totpSecret) {
      res.status(409).json({ error: 'mfa_not_started' })
      return
    }

    const body = (req.body ?? {}) as { code?: unknown }
    const step = matchTotp(decryptTotpSecret(user.totpSecret), readString(body.code, 16))
    if (step === null) {
      res.status(400).json({ error: 'invalid_code' })
      return
    }

    const recoveryCodes = generateRecoveryCodes()
    const enrolledAt = new Date()
    const confirmed = await prisma.$transaction(async (tx) => {
      // Conditional, so two racing confirmations can't each mint a set of codes.
      const { count } = await tx.user.updateMany({
        where: { id: userId, totpEnabledAt: null },
        data: { totpEnabledAt: enrolledAt, totpLastStep: step },
      })
      if (count === 0) return false
      await tx.totpRecoveryCode.deleteMany({ where: { userId } })
      await tx.totpRecoveryCode.createMany({
        data: recoveryCodes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
      })
      return true
    })
    if (!confirmed) {
      res.status(409).json({ error: 'mfa_already_enrolled' })
      return
    }

    attemptLimiter.reset(userId)
    logger.info('admin.mfa.enrolled', { userId })
    res.json({ recoveryCodes, ...signAdminSession(userId, enrolledAt) })
  }),
)

// ── POST /admin/mfa/verify ─── the 6-digit code, or a recovery code ──────────
adminMfaRouter.post(
  '/verify',
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!spendAttempt(res, userId)) return

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpSecret: true, totpEnabledAt: true, totpLastStep: true },
    })
    if (!user.totpSecret || !user.totpEnabledAt) {
      res.status(409).json({ error: 'mfa_not_enrolled' })
      return
    }

    const body = (req.body ?? {}) as { code?: unknown; recoveryCode?: unknown }
    const recoveryCode = readString(body.recoveryCode, 32)
    let passed: boolean
    if (recoveryCode) {
      // Conditional on being unused, which is what makes it one-time under a race.
      const { count } = await prisma.totpRecoveryCode.updateMany({
        where: { userId, codeHash: hashRecoveryCode(recoveryCode), usedAt: null },
        data: { usedAt: new Date() },
      })
      passed = count > 0
      if (passed) logger.warn('admin.mfa.recovery_code_used', { userId })
    } else {
      const step = matchTotp(decryptTotpSecret(user.totpSecret), readString(body.code, 16))
      // Only a step newer than the last one used, so a code that was seen can't be replayed.
      const { count } =
        step === null
          ? { count: 0 }
          : await prisma.user.updateMany({
              where: {
                id: userId,
                OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }],
              },
              data: { totpLastStep: step },
            })
      passed = count > 0
    }

    if (!passed) {
      res.status(400).json({ error: 'invalid_code' })
      return
    }
    attemptLimiter.reset(userId)
    res.json(signAdminSession(userId, user.totpEnabledAt))
  }),
)
