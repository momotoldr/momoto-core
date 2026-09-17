import { Router } from 'express'

import { serializeUser } from '../../auth/serialize.js'
import { prisma } from '../../db/client.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { markTestimonialsChanged } from '../../lib/testimonials.js'
import { generateInviteCode } from '../../lib/inviteCode.js'
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

    // Link both directions + consume the invite in one transaction. The invite update
    // is conditional on it still being unused, so two people racing to accept the same
    // code can't both link: the loser's `updateMany` matches nothing and we roll back.
    const [, , consumed] = await prisma.$transaction([
      prisma.user.update({ where: { id: me.id }, data: { partnerId: inviter.id } }),
      prisma.user.update({ where: { id: inviter.id }, data: { partnerId: me.id } }),
      prisma.partnerInvite.updateMany({
        where: { code, usedAt: null },
        data: { usedAt: new Date() },
      }),
    ])
    if (consumed.count === 0) {
      res.status(400).json({ error: 'invite_invalid' })
      return
    }
    logger.info('partner.linked', { userId: me.id, partnerId: inviter.id })

    const updated = await prisma.user.findUnique({
      where: { id: me.id },
      include: { partner: true },
    })
    res.json({ user: updated ? serializeUser(updated) : null })
  }),
)

// ── DELETE /partner ─── unlink both accounts ───────────────────────────────────
partnerRouter.delete(
  '/',
  asyncRoute(async (req, res) => {
    const me = await prisma.user.findUnique({ where: { id: req.userId } })
    if (!me) {
      res.status(401).json({ error: 'unauthorized' })
      return
    }
    if (me.partnerId) {
      const partnerId = me.partnerId
      await prisma.$transaction([
        prisma.user.update({ where: { id: me.id }, data: { partnerId: null } }),
        prisma.user.update({ where: { id: partnerId }, data: { partnerId: null } }),
      ])
      logger.info('partner.unlinked', { userId: me.id })
      // A couple testimonial stops showing the partner the moment they unlink.
      markTestimonialsChanged()
    }
    const updated = await prisma.user.findUnique({
      where: { id: me.id },
      include: { partner: true },
    })
    res.json({ user: updated ? serializeUser(updated) : null })
  }),
)
