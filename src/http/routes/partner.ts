import { Router } from 'express'

import { serializeUser } from '../../auth/serialize.js'
import { prisma } from '../../db/client.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { generateInviteCode } from '../../lib/inviteCode.js'
import { grantPartnerPromo } from '../../promos/promos.js'
import { asyncRoute } from '../asyncRoute.js'
import { requireAuth } from '../middleware/requireAuth.js'

export const partnerRouter = Router()

/** All partner endpoints require a signed-in user. */
partnerRouter.use(requireAuth)

const partnerLimiter = new RateLimiter(30, 60_000)
const INVITE_TTL_MS = 24 * 60 * 60 * 1000

export function sweepPartnerLimits(now: number = Date.now()): number {
  return partnerLimiter.sweep(now)
}

/** Deletes expired / used partner invites. Wired into the periodic sweep. */
export async function sweepPartnerInvites(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.partnerInvite.deleteMany({
    where: { OR: [{ expiresAt: { lte: now } }, { usedAt: { not: null } }] },
  })
  return count
}

// ── POST /partner/invite ─── mint a code the user shares with their partner ────
partnerRouter.post(
  '/invite',
  asyncRoute(async (req, res) => {
    if (!partnerLimiter.allow(req.userId ?? 'unknown')) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const me = await prisma.user.findUnique({ where: { id: req.userId } })
    if (!me) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    if (me.partnerId) {
      res.status(409).json({ error: 'already_linked' })
      return
    }

    // Retry on the (rare) code collision.
    let code = generateInviteCode()
    for (let i = 0; i < 5 && (await prisma.partnerInvite.findUnique({ where: { code } })); i += 1) {
      code = generateInviteCode()
    }
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
    await prisma.partnerInvite.create({ data: { code, inviterId: me.id, expiresAt } })
    logger.info('partner.invited', { userId: me.id })
    res.status(201).json({ code, expiresAt })
  }),
)

// ── POST /partner/accept ─── link the two accounts using an invite code ────────
partnerRouter.post(
  '/accept',
  asyncRoute(async (req, res) => {
    if (!partnerLimiter.allow(req.userId ?? 'unknown')) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const code = String(req.body?.code ?? '')
      .trim()
      .toUpperCase()

    const invite = await prisma.partnerInvite.findUnique({ where: { code } })
    if (!invite || invite.usedAt || invite.expiresAt <= new Date()) {
      res.status(400).json({ error: 'invite_invalid' })
      return
    }
    if (invite.inviterId === req.userId) {
      res.status(400).json({ error: 'invite_self' })
      return
    }

    const [me, inviter] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.userId } }),
      prisma.user.findUnique({ where: { id: invite.inviterId } }),
    ])
    if (!me || !inviter) {
      res.status(400).json({ error: 'invite_invalid' })
      return
    }
    if (me.partnerId) {
      res.status(409).json({ error: 'already_linked' })
      return
    }
    if (inviter.partnerId) {
      res.status(409).json({ error: 'partner_linked' })
      return
    }

    // Consume the invite, link both directions and grant the partner promo in one
    // transaction. The invite update is conditional on it still being unused, so two
    // people racing to accept the same code can't both link: the loser's `updateMany`
    // matches nothing and nothing else is written.
    const now = new Date()
    const linked = await prisma.$transaction(async (tx) => {
      const consumed = await tx.partnerInvite.updateMany({
        where: { code, usedAt: null },
        data: { usedAt: now },
      })
      if (consumed.count === 0) return null
      await tx.user.update({ where: { id: me.id }, data: { partnerId: inviter.id } })
      await tx.user.update({ where: { id: inviter.id }, data: { partnerId: me.id } })
      // Promo A (docs/PLAN-promos.md §1b): both sides, once per account, one must be new.
      return { earned: await grantPartnerPromo(tx, me, inviter, now) }
    })
    if (!linked) {
      res.status(400).json({ error: 'invite_invalid' })
      return
    }
    logger.info('partner.linked', { userId: me.id, partnerId: inviter.id })
    if (linked.earned.length > 0) {
      logger.info('promos.partnerGranted', { userIds: linked.earned, reason: 'link' })
    }

    const updated = await prisma.user.findUnique({
      where: { id: me.id },
      include: { partner: true },
    })
    res.json({
      user: updated ? serializeUser(updated) : null,
      // So the accepter's UI can celebrate; the inviter finds out from GET /promos.
      promo: { partnerBogo: linked.earned.includes(me.id) ? 'earned' : null },
    })
  }),
)
