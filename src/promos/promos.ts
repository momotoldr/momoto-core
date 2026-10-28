import type { Prisma } from '@prisma/client'

import { env } from '../config/env.js'
import { prisma } from '../db/client.js'
import { logger } from '../lib/logger.js'

import { bundlePriceFor, partnerPromoEarners, priceOrder, type OrderPricing } from './pricing.js'

/**
 * The soft-launch promos' rules that need the database (docs/PLAN-promos.md). The money
 * arithmetic lives in `pricing.ts`; this decides who qualifies for what.
 *
 * Each promo answers to its own flag, and a flag off is total: nothing is earned and
 * nothing is priced. The end dates are the gentle stop — Promo A's only stops earning.
 */

/** `PromoGrant.kind` for Promo A. */
export const PARTNER_BOGO = 'partner_bogo'

type Db = Prisma.TransactionClient

// ── Promo A: partner buy 1 get 1 ─────────────────────────────────────────────

/** Whether a link made now earns the reward. */
export function partnerPromoEarning(now: Date = new Date()): boolean {
  return env.partnerPromoEnabled && (!env.partnerPromoEndsAt || now < env.partnerPromoEndsAt)
}

/** Whether the buyer has a reward checkout may spend. False while Promo A is off. */
export async function hasUnusedPartnerReward(userId: string, db: Db = prisma): Promise<boolean> {
  if (!env.partnerPromoEnabled) return false
  const grant = await db.promoGrant.findFirst({
    where: { userId, kind: PARTNER_BOGO, usedAt: null },
    select: { id: true },
  })
  return grant !== null
}

/**
 * Grant the reward for a link that just happened, inside the link's own transaction.
 * Returns the ids of the accounts that earned it (possibly none). Who earns it is
 * `partnerPromoEarners` (user's rules, 2026-10-27).
 */
export async function grantPartnerPromo(
  tx: Db,
  a: { id: string; createdAt: Date },
  b: { id: string; createdAt: Date },
  now: Date = new Date(),
): Promise<string[]> {
  if (!partnerPromoEarning(now)) return []
  const newSince = new Date(now.getTime() - env.promoNewAccountDays * 24 * 60 * 60 * 1000)
  const existing = await tx.promoGrant.findMany({
    where: { userId: { in: [a.id, b.id] }, kind: PARTNER_BOGO },
    select: { userId: true },
  })
  const rewarded = new Set(existing.map((grant) => grant.userId))
  const earners = partnerPromoEarners([a, b], rewarded, newSince)
  if (earners.length === 0) return []

  // skipDuplicates: the unique (userId, kind) index settles two links racing for one account.
  await tx.promoGrant.createMany({
    data: earners.map((id) => ({
      userId: id,
      kind: PARTNER_BOGO,
      reason: 'link',
      sourceUserId: id === a.id ? b.id : a.id,
    })),
    skipDuplicates: true,
  })
  return earners
}

// ── Promo B: scrapbook bundle ────────────────────────────────────────────────

/**
 * The bundle's price right now — one finished scrapbook + 3 unpaid strips, bought in one
 * checkout, `BUNDLE_DISCOUNT_PERCENT` off their list price (user, 2026-10-27) — or null
 * while Promo B is off or the scrapbook has no list price.
 */
export function currentBundlePrice(now: Date = new Date()): number | null {
  if (!env.bundlePromoEnabled || env.bundleDiscountPercent === null) return null
  if (env.scrapbookPriceIdr === null) return null
  if (env.bundleEndsAt && now >= env.bundleEndsAt) return null
  return bundlePriceFor(env.bundleDiscountPercent, env.scrapbookPriceIdr, env.stripPrintPriceIdr)
}

// ── Checkout and settlement ──────────────────────────────────────────────────

/**
 * Price an order for this buyer, every promo they qualify for applied. Server-side and
 * never from the client, like every price here. Run twice per checkout — before the
 * Midtrans call and again under the scrapbook locks before recording — and the two
 * must agree (`sameQuote`). A bundle needs nothing but the counts; the reward is the only
 * thing read from the database.
 */
export async function quoteOrder(
  userId: string,
  stripCount: number,
  scrapbookCount: number,
  db: Db = prisma,
): Promise<OrderPricing> {
  const bogo = stripCount >= 2 && (await hasUnusedPartnerReward(userId, db))
  return priceOrder({
    strips: stripCount,
    scrapbooks: scrapbookCount,
    bogo,
    stripPrice: env.stripPrintPriceIdr,
    scrapbookPrice: env.scrapbookPriceIdr ?? 0,
    bundlePrice: currentBundlePrice(),
  })
}

/** Whether two quotes for the same order charge the same thing. */
export function sameQuote(a: OrderPricing, b: OrderPricing): boolean {
  return (
    JSON.stringify([a.items, a.bogo, a.bundles]) === JSON.stringify([b.items, b.bogo, b.bundles])
  )
}

/**
 * Spend the partner reward a settling payment was priced with, inside the webhook's
 * settlement transaction. (A bundle spends nothing: it's a price, not a balance.)
 *
 * Never refuses — the money is already in. One live payment per buyer means nothing else
 * could have spent the reward in between, so a miss means something unexpected happened;
 * it's logged for a look, and the payment settles. Applied regardless of the flag: this
 * payment was priced while it was on.
 */
export async function applyPromosOnSettlement(
  tx: Db,
  payment: { id: string; orderId: string; userId: string | null; bogo: boolean },
  now: Date,
): Promise<void> {
  // No owner means the account was deleted while this was pending: its grant went with it.
  if (!payment.userId || !payment.bogo) return
  const { count } = await tx.promoGrant.updateMany({
    where: { userId: payment.userId, kind: PARTNER_BOGO, usedAt: null },
    data: { usedAt: now, usedByPaymentId: payment.id },
  })
  if (count === 0) logger.warn('promos.bogoAlreadyUsed', { orderId: payment.orderId })
}
