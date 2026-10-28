import { Router } from 'express'

import { env } from '../../config/env.js'
import { prisma } from '../../db/client.js'
import { BUNDLE_STRIPS } from '../../promos/pricing.js'
import { currentBundlePrice, PARTNER_BOGO, partnerPromoEarning } from '../../promos/promos.js'
import { asyncRoute } from '../asyncRoute.js'
import { optionalAuth } from '../middleware/requireAuth.js'

export const promosRouter = Router()

/**
 * Where the partner promo stands for one account:
 * - `available` — not earned yet, and a link made now could earn it;
 * - `ready` — earned and unused;
 * - `used` — spent by a settled payment;
 * - `unavailable` — not earned, and links no longer earn it (past its end date).
 */
type PartnerState = 'available' | 'ready' | 'used' | 'unavailable'

// ── GET /promos ─── what the promo cards should say ──────────────────────────
/**
 * One call for every promo surface (docs/PLAN-promos.md §3): the result screen, the
 * profile card and the cart. Guests get the offers without a `state`; a signed-in caller
 * gets where they stand with the partner promo too.
 *
 * `enabled` is the core flag (and, for the bundle, its price and end date). The FE shows
 * a promo only when this and its own UI flag are both on. Prices are only for display:
 * checkout prices every order itself.
 */
promosRouter.get(
  '/',
  optionalAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId
    const now = new Date()
    const bundlePrice = currentBundlePrice(now)

    const partner: {
      enabled: boolean
      endsAt: string | null
      newAccountDays: number
      state?: PartnerState
    } = {
      enabled: env.partnerPromoEnabled,
      endsAt: env.partnerPromoEndsAt?.toISOString() ?? null,
      newAccountDays: env.promoNewAccountDays,
    }
    // One finished scrapbook + 3 unpaid strips in one checkout, for one price.
    const bundle = {
      enabled: bundlePrice !== null,
      endsAt: env.bundleEndsAt?.toISOString() ?? null,
      strips: BUNDLE_STRIPS,
      price: bundlePrice,
      discountPercent: bundlePrice === null ? null : env.bundleDiscountPercent,
      // The same items at list price, for the struck-through figure.
      listPrice:
        env.scrapbookPriceIdr === null
          ? null
          : env.scrapbookPriceIdr + BUNDLE_STRIPS * env.stripPrintPriceIdr,
    }

    if (userId) {
      if (partner.enabled) {
        const grant = await prisma.promoGrant.findUnique({
          where: { userId_kind: { userId, kind: PARTNER_BOGO } },
          select: { usedAt: true },
        })
        partner.state = grant
          ? grant.usedAt
            ? 'used'
            : 'ready'
          : partnerPromoEarning(now)
            ? 'available'
            : 'unavailable'
      }
    }

    // Per account and changes with every purchase: never cache it anywhere shared.
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ partner, bundle })
  }),
)
