import { randomUUID } from 'node:crypto'

import type { Prisma } from '@prisma/client'
import { Router } from 'express'

import { env } from '../../config/env.js'
import { prisma } from '../../db/client.js'
import { logger } from '../../lib/logger.js'
import { sendPaymentReceipt } from '../../notifications/client.js'
import { normalizeLang } from '../../notifications/lang.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import {
  cancelTransaction,
  chargeTotal,
  chargeTransaction,
  enabledPaymentMethods,
  fetchTransactionStatus,
  isPaymentMethod,
  midtransErrorStatus,
  verifyNotificationSignature,
} from '../../payments/midtrans.js'
import {
  adminFeesFor,
  applyPromosOnSettlement,
  quoteOrder,
  sameQuote,
} from '../../promos/promos.js'
import { asyncRoute } from '../asyncRoute.js'
import { requireAuth } from '../middleware/requireAuth.js'
import {
  coverUrlOf,
  findPurchasableScrapbook,
  hasLivePayment,
  lockScrapbook,
} from './scrapbooks.js'
import { findPurchasableStrips, galleryRoomFor, refusePurchase } from './strips.js'

export const paymentsRouter = Router()

/** Rate-limit checkout creation per user (each mints a Midtrans transaction). */
const checkoutLimiter = new RateLimiter(20, 10 * 60_000)
/** Quotes are re-asked on every change to the cart's selection, so a looser bound. */
const quoteLimiter = new RateLimiter(240, 10 * 60_000)
/** "I've paid" checks and cancels each ask Midtrans, so a tight bound. */
const statusCheckLimiter = new RateLimiter(10, 10 * 60_000)

/** Reclaim expired checkout rate windows (wired into the periodic sweep). */
export function sweepPaymentLimits(now: number = Date.now()): number {
  return checkoutLimiter.sweep(now) + quoteLimiter.sweep(now) + statusCheckLimiter.sweep(now)
}

/**
 * Cap how many strips one checkout can bundle (also bounds the Snap item total).
 *
 * Matched to the cart cap (`STRIP_MAX_ITEMS`, 20): checkout only accepts *unpaid* strips,
 * and the cart never holds more than that, so no honest request can carry more. Anything
 * larger is hand-crafted, and this stops it becoming a very large `IN` query.
 */
const MAX_CHECKOUT_STRIPS = 20

/**
 * Shape a Payment row into what the checkout modal renders. Only ever called with the
 * caller's own payment — ownership is checked before this point, never inside it.
 */
function serializePayment(payment: {
  orderId: string
  status: string
  grossAmount: number
  paymentType: string | null
  qrImageUrl: string | null
  deeplinkUrl: string | null
  expiresAt: Date | null
  bogo: boolean
  bundles: number
  adminFee: number
  strips: { id: string }[]
  scrapbooks: { id: string }[]
}) {
  return {
    // What the order is for: since 2026-10-17 one cart checkout can hold both kinds.
    kind:
      payment.scrapbooks.length === 0
        ? ('strips' as const)
        : payment.strips.length === 0
          ? ('scrapbook' as const)
          : ('mixed' as const),
    orderId: payment.orderId,
    status: payment.status,
    grossAmount: payment.grossAmount,
    method: payment.paymentType,
    qrImageUrl: payment.qrImageUrl,
    deeplinkUrl: payment.deeplinkUrl,
    expiresAt: payment.expiresAt?.toISOString() ?? null,
    stripIds: payment.strips.map((strip) => strip.id),
    scrapbookIds: payment.scrapbooks.map((scrapbook) => scrapbook.id),
    // Strips only, as it always was: the cart's "n strips" line reads it.
    count: payment.strips.length,
    // The promos it was priced with (docs/PLAN-promos.md), for the modal's summary.
    bogo: payment.bogo,
    bundled: payment.bundles,
    // Already inside `grossAmount`; the modal names it under the total.
    adminFee: payment.adminFee,
  }
}

/** Columns `serializePayment` needs — kept next to it so the two can't drift. */
const PAYMENT_SELECT = {
  orderId: true,
  status: true,
  grossAmount: true,
  paymentType: true,
  qrImageUrl: true,
  deeplinkUrl: true,
  expiresAt: true,
  bogo: true,
  bundles: true,
  adminFee: true,
  strips: { select: { id: true } },
  scrapbooks: { select: { id: true } },
} as const

/**
 * The caller's live payment attempt, if any: still `pending` and not past its expiry.
 *
 * Expiry is filtered here rather than trusted from `status` because the `expire`
 * notification arrives whenever Midtrans gets round to it. Between the QR going dead
 * and that POST landing, the row still says `pending` — resuming it would show a QR
 * that can no longer be paid.
 */
function findLivePayment(userId: string, now: Date = new Date()) {
  return prisma.payment.findFirst({
    where: { userId, status: 'pending', expiresAt: { gt: now } },
    orderBy: { createdAt: 'desc' },
    select: PAYMENT_SELECT,
  })
}

// ── POST /payments/charge ─── open a payment on one channel ──────────────────
/**
 * Charge what the user selected in the cart — strips, finished scrapbooks, or both in one
 * order (user decision, 2026-10-17) — on the channel they picked. Body:
 * `{ stripIds?, scrapbookIds?, method }`, at least one id between them.
 *
 * The amount is `strips × STRIP_PRINT_PRICE_IDR + scrapbooks × SCRAPBOOK_PRICE_IDR` with
 * the soft-launch promos applied (`quoteOrder`, docs/PLAN-promos.md): one scrapbook + 3 of
 * the order's unpaid strips at the bundle price, then two strips for one on an unused
 * partner reward. The method's admin fee (`ADMIN_FEE_<METHOD>`) goes on top as its own
 * line, on the discounted amount.
 * Computed here and never trusted from the client, and sent to Midtrans as one line per
 * kind. The promos are applied, not requested — each only lowers a line. Returns the artifacts our own checkout modal renders — a QR image, a wallet
 * deeplink, or both — rather than a hosted-popup token.
 *
 * Everything is checked before Midtrans is called, so an obvious refusal costs no
 * transaction. Scrapbooks are checked a second time **under their row locks** when the
 * payment is recorded, because the Midtrans call takes seconds and can't sit inside a
 * database transaction: a reopen (which deletes the PDF) or a second tab's checkout could
 * land in between, and either would leave money able to settle on a scrapbook with
 * nothing to download. If that second check fails, the transaction just opened is
 * cancelled at Midtrans — its QR was never sent to anyone — and the request is refused as
 * the first check would have been. (Strips need no second look: nothing between the two
 * moments can make a strip unsellable that the webhook can't live with.)
 */
paymentsRouter.post(
  '/charge',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!env.paymentsEnabled) {
      res.status(503).json({ error: 'payments_unavailable' })
      return
    }
    const userId = req.userId as string
    if (!checkoutLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    const body = req.body as {
      stripIds?: unknown
      scrapbookIds?: unknown
      method?: unknown
      lang?: unknown
    }
    if (!isPaymentMethod(body.method)) {
      res.status(400).json({ error: 'invalid_method' })
      return
    }
    const method = body.method
    // A known channel switched off here (MIDTRANS_ENABLED_PAYMENTS) — a cart that loaded
    // before it was, or a hand-made request.
    if (!enabledPaymentMethods().includes(method)) {
      res.status(400).json({ error: 'method_unavailable' })
      return
    }

    const stripIds = readIds(body.stripIds)
    // Sorted: the row locks below are taken in this order, so two checkouts naming the
    // same scrapbooks can't deadlock on each other.
    const scrapbookIds = readIds(body.scrapbookIds)?.sort()
    if (
      !stripIds ||
      !scrapbookIds ||
      stripIds.length + scrapbookIds.length === 0 ||
      stripIds.length > MAX_CHECKOUT_STRIPS ||
      scrapbookIds.length > env.scrapbookMaxItems
    ) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    // No default price on purpose (see `env.scrapbookPriceIdr`): unset, nothing is charged.
    const scrapbookPrice = env.scrapbookPriceIdr
    if (scrapbookIds.length > 0 && scrapbookPrice === null) {
      logger.warn('payments.charge.scrapbookPriceUnset', { userId })
      res.status(503).json({ error: 'scrapbook_price_unset' })
      return
    }

    // One live attempt at a time. Charging again while a QR is still payable would let
    // two orders settle for the same items — the second one paying for nothing, since
    // the first already unlocked them. The client resumes the existing attempt instead.
    const live = await findLivePayment(userId)
    if (live) {
      logger.info('payments.charge.inProgress', { userId, orderId: live.orderId })
      res.status(409).json({ error: 'payment_in_progress', payment: serializePayment(live) })
      return
    }

    // Every strip must be the caller's, unpaid, and have a clean copy to deliver. Shared
    // with the free unlock path so both refuse on identical grounds.
    if (stripIds.length > 0) {
      const purchasable = await findPurchasableStrips(userId, stripIds)
      if (!purchasable.ok) {
        refusePurchase(res, 'charge', userId, purchasable)
        return
      }
      // The gallery has to be able to hold what this payment would unlock. Refusing here
      // means no Midtrans transaction exists — the only place this check is safe to make.
      // (The webhook deliberately does not repeat it.) Scrapbooks don't live in the
      // gallery, so only the strips count.
      const room = await galleryRoomFor(userId, stripIds.length)
      if (!room.ok) {
        logger.info('gallery.full', { userId, used: room.used, limit: room.limit })
        res.status(409).json({ error: 'gallery_full', used: room.used, limit: room.limit })
        return
      }
    }

    const scrapbookRefusal = await refuseScrapbooks(userId, scrapbookIds)
    if (scrapbookRefusal) {
      logger.info('scrapbooks.notPurchasable', {
        route: 'charge',
        userId,
        error: scrapbookRefusal.error,
      })
      res.status(scrapbookRefusal.status).json({ error: scrapbookRefusal.error })
      return
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, email: true },
    })
    const quote = await quoteOrder(userId, stripIds.length, scrapbookIds.length, method)
    const { items } = quote
    const grossAmount = chargeTotal(items)
    const orderId = `pay_${randomUUID()}`

    const charge = await chargeTransaction({
      orderId,
      items,
      returnPath: '/cart',
      customer: { name: user?.displayName ?? 'Momoto user', email: user?.email ?? null },
      method,
    })

    const recorded = await prisma.$transaction(async (tx) => {
      for (const id of scrapbookIds) await lockScrapbook(tx, id)
      const refusal = await refuseScrapbooks(userId, scrapbookIds, tx)
      if (refusal) return { ok: false as const, refusal }
      // The promos too: the Midtrans call took seconds, and the price it was opened at
      // must still be the price. Anything that moved it (a reward spent by a late
      // settlement, a promo switched off) abandons this attempt like any other refusal;
      // the cart re-quotes on the retry.
      const requote = await quoteOrder(userId, stripIds.length, scrapbookIds.length, method, tx)
      if (!sameQuote(quote, requote)) {
        return { ok: false as const, refusal: { status: 409, error: 'price_changed' } }
      }
      const payment = await tx.payment.create({
        data: {
          orderId,
          userId,
          grossAmount,
          paymentType: method,
          qrImageUrl: charge.qrImageUrl,
          deeplinkUrl: charge.deeplinkUrl,
          expiresAt: charge.expiresAt,
          midtransStatus: charge.transactionStatus,
          // For the receipt the webhook sends: it has no request of the payer's to read.
          lang: normalizeLang(body.lang),
          bogo: quote.bogo,
          bundles: quote.bundles,
          adminFee: quote.adminFee,
          strips: { connect: stripIds.map((id) => ({ id })) },
          scrapbooks: { connect: scrapbookIds.map((id) => ({ id })) },
        },
        select: PAYMENT_SELECT,
      })
      return { ok: true as const, payment }
    })

    if (!recorded.ok) {
      try {
        await cancelTransaction(orderId)
      } catch (error) {
        // Unrecorded and never shown, so it can't be paid; it expires on its own.
        logger.warn('payments.charge.cancelFailed', { orderId, err: String(error) })
      }
      logger.info('payments.charge.abandoned', { userId, orderId, error: recorded.refusal.error })
      res.status(recorded.refusal.status).json({ error: recorded.refusal.error })
      return
    }
    logger.info('payments.charge.created', {
      userId,
      orderId,
      method,
      strips: stripIds.length,
      scrapbooks: scrapbookIds.length,
      grossAmount,
      adminFee: quote.adminFee,
      bogo: quote.bogo,
      bundles: quote.bundles,
    })
    res.status(201).json(serializePayment(recorded.payment))
  }),
)

/** A list of ids from the body, de-duplicated; absent is empty, anything else is null. */
function readIds(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  return [...new Set(value.filter((id): id is string => typeof id === 'string'))]
}

/**
 * The first reason one of these scrapbooks can't be bought, or null if all can: each must
 * be purchasable (the same test as the free unlock), and none may already sit in another
 * live payment — a second tab that charged it a moment ago.
 */
async function refuseScrapbooks(
  userId: string,
  scrapbookIds: string[],
  db: Prisma.TransactionClient = prisma,
): Promise<{ status: number; error: string } | null> {
  for (const id of scrapbookIds) {
    const purchasable = await findPurchasableScrapbook(userId, id, db)
    if (!purchasable.ok) return { status: purchasable.status, error: purchasable.error }
    if (await hasLivePayment(id, db)) return { status: 409, error: 'payment_in_progress' }
  }
  return null
}

// ── POST /payments/quote ─── what a selection would cost, promos applied ──────
/**
 * The price `/charge` would ask for these items, with the soft-launch promos applied
 * (docs/PLAN-promos.md): what the cart shows before anything is charged. The pricing is
 * `quoteOrder`, the very function `/charge` runs, so the cart's total and the order's can't
 * drift apart — the FE keeps no copy of the rules.
 *
 * Display only, and nothing is written: ids aren't checked for ownership or state here
 * (that's `/charge`'s job) — the price depends only on how many of each there are and on
 * the caller's partner reward. Body `{ stripIds?, scrapbookIds? }`. Answers
 * `{ grossAmount, listAmount, bogo, bundles, methods, adminFees }`; amounts are null when
 * a scrapbook is in it and its list price isn't set.
 *
 * No method is chosen yet, so `grossAmount` is the items alone and `adminFees` says what
 * each method would add on top — exactly what `/charge` on that method would ask for.
 * `methods` is the channels switched on here, which the checkout modal offers.
 */
paymentsRouter.post(
  '/quote',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!quoteLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const body = req.body as { stripIds?: unknown; scrapbookIds?: unknown }
    const stripIds = readIds(body.stripIds)
    const scrapbookIds = readIds(body.scrapbookIds)
    if (
      !stripIds ||
      !scrapbookIds ||
      stripIds.length > MAX_CHECKOUT_STRIPS ||
      scrapbookIds.length > env.scrapbookMaxItems
    ) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const quote = await quoteOrder(userId, stripIds.length, scrapbookIds.length, null)
    const priced = scrapbookIds.length === 0 || env.scrapbookPriceIdr !== null
    const subtotal = chargeTotal(quote.items)
    res.json({
      grossAmount: priced ? subtotal : null,
      listAmount: priced
        ? stripIds.length * env.stripPrintPriceIdr +
          scrapbookIds.length * (env.scrapbookPriceIdr ?? 0)
        : null,
      bogo: quote.bogo,
      bundles: quote.bundles,
      methods: enabledPaymentMethods(),
      adminFees: priced ? adminFeesFor(subtotal) : null,
    })
  }),
)

// ── GET /payments/pending ─── resume an attempt the user walked away from ────
/**
 * The caller's live payment attempt, or `null`. The cart calls this on load so a
 * half-finished payment reopens with the same QR instead of stranding the user with
 * strips they can neither pay for nor re-charge.
 *
 * Declared before `/:orderId`, or that route would swallow the word "pending".
 *
 * Answers `null` rather than the 503 `/charge` gives while checkout is dark. This is a
 * query, and "there is no live attempt" is the honest answer when nothing can be
 * charged — the cart resumes nothing and carries on, instead of treating a disabled
 * feature as a failure. It also keeps us off the Payment table entirely, so a
 * deployment whose payment columns aren't migrated yet can't 500 here.
 */
paymentsRouter.get(
  '/pending',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!env.paymentsEnabled) {
      res.json({ payment: null })
      return
    }
    const live = await findLivePayment(req.userId as string)
    res.json({ payment: live ? serializePayment(live) : null })
  }),
)

/** Statuses no notification moves a payment out of. */
const FINAL_STATUSES = ['paid', 'refunded']

/**
 * Map a Midtrans `transaction_status` (+ `fraud_status`) to our Payment status.
 * `null` means "leave it as-is" (e.g. a `pending` we don't need to persist over an
 * already-terminal state).
 */
function mapStatus(transactionStatus: string, fraudStatus?: string): string | null {
  switch (transactionStatus) {
    case 'capture':
      // Card flow: only an accepted capture is a real payment; a challenge stays pending.
      return fraudStatus === 'accept' ? 'paid' : 'pending'
    case 'settlement':
      return 'paid'
    case 'deny':
      return 'failed'
    case 'cancel':
      return 'cancelled'
    case 'expire':
      return 'expired'
    // A full refund made in the Midtrans dashboard on an order we never recorded as paid
    // (the case an admin refund is for — see `Payment.refundedAt`). On a paid order it
    // never gets this far: paid orders ignore every later notification.
    case 'refund':
      return 'refunded'
    case 'pending':
      return 'pending'
    default:
      return null
  }
}

/**
 * Move a payment to what Midtrans says its `transaction_status` is — unlocking what it
 * covers on settlement, once, and mailing the receipt. Shared by the signed notification
 * and the buyer's own check (`POST /payments/:orderId/check`), so both settle the same
 * way. Idempotent: an unknown order, a paid or refunded one, and a replay all do nothing.
 */
async function applyMidtransStatus(
  orderId: string,
  transactionStatus: string,
  fraudStatus?: string,
): Promise<void> {
  const payment = await prisma.payment.findUnique({
    where: { orderId },
    include: {
      strips: { select: { id: true } },
      scrapbooks: { select: { id: true, title: true } },
      user: { select: { email: true, emailVerifiedAt: true } },
    },
  })
  if (!payment) {
    // Unknown order — ack so Midtrans stops retrying, but do nothing.
    logger.warn('payments.notification.unknown_order', { orderId })
    return
  }

  // Idempotent: once paid, later notifications don't change entitlement. A refunded
  // order is final the same way — a late settlement must not unlock what was given
  // back, and Midtrans sends each refund twice.
  if (payment.status === 'paid' || payment.status === 'refunded') {
    return
  }

  const next = mapStatus(transactionStatus, fraudStatus)
  if (next === null) {
    return
  }

  if (next === 'paid') {
    const now = new Date()
    const stripIds = payment.strips.map((s) => s.id)
    // **No gallery-cap check here, deliberately.** Midtrans has taken the money; refusing
    // to unlock now would leave the user charged with nothing to show. Checkout already
    // refused anything that wouldn't fit, so landing over the cap means the gallery filled
    // between the two — rare, tolerated, and logged rather than enforced. The overflow
    // drains itself: the next unlock is refused until the user frees a slot.
    // No owner means they deleted their account while this was pending: there's no
    // gallery to fit into (their strips went with them), but the money was still taken,
    // so it settles as paid like any other — it's the record of what we received.
    const room = payment.userId
      ? await galleryRoomFor(payment.userId, stripIds.length)
      : ({ ok: true } as const)
    if (!room.ok) {
      logger.warn('gallery.overCap', {
        orderId,
        userId: payment.userId,
        used: room.used,
        limit: room.limit,
        settling: stripIds.length,
      })
    }
    const scrapbookIds = payment.scrapbooks.map((s) => s.id)
    // Flip the payment and unlock everything it covers in one transaction. A scrapbook
    // under a live payment can't have been reopened or deleted (both refuse under its row
    // lock), so it is still finished with its PDF; only account deletion removes it, and
    // then there is nothing left to flip.
    //
    // The flip is conditional on the row not being paid yet, because Midtrans can deliver
    // the same settlement twice at once and both would pass the `paid` check above. Only
    // the one that flips it goes on to unlock and send the receipt — otherwise the payer
    // gets two.
    const flipped = await prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { orderId, status: { notIn: FINAL_STATUSES } },
        data: { status: 'paid', midtransStatus: transactionStatus, paidAt: now },
      })
      if (count === 0) return false
      await tx.strip.updateMany({
        where: { id: { in: stripIds } },
        data: { paid: true, paidAt: now },
      })
      await tx.scrapbook.updateMany({
        where: { id: { in: scrapbookIds } },
        data: { paid: true, paidAt: now },
      })
      await applyPromosOnSettlement(tx, payment, now)
      return true
    })
    if (!flipped) {
      return
    }
    logger.info('payments.paid', {
      orderId,
      strips: stripIds.length,
      scrapbooks: scrapbookIds.length,
      bogo: payment.bogo,
      bundles: payment.bundles,
    })

    // Verified addresses only, as with the password mail: an operator-typed address
    // nobody has proven could be a typo, and this one says what someone bought. Not
    // awaited — the money is in and the items are unlocked; mail can't undo that.
    if (payment.user?.email && payment.user.emailVerifiedAt) {
      void sendPaymentReceipt(payment.user.email, normalizeLang(payment.lang), {
        orderId,
        grossAmount: payment.grossAmount,
        paidAt: now,
        method: isPaymentMethod(payment.paymentType) ? payment.paymentType : null,
        stripCount: stripIds.length,
        scrapbookTitles: payment.scrapbooks.map((s) => s.title),
        bogo: payment.bogo,
        // Each bundle is one of these books with 3 of these strips; which ones doesn't
        // matter, they're all priced alike.
        bundled: payment.bundles,
        adminFee: payment.adminFee,
      })
    }
  } else {
    // Conditional for the same reason as the flip above: an admin refund or a settlement
    // can land between the read and this write, and neither may be overwritten.
    const { count } = await prisma.payment.updateMany({
      where: { orderId, status: { notIn: FINAL_STATUSES } },
      data: {
        status: next,
        midtransStatus: transactionStatus,
        ...(next === 'refunded' ? { refundedAt: new Date() } : {}),
      },
    })
    if (count > 0) logger.info('payments.status', { orderId, status: next })
  }
}

// ── POST /payments/midtrans/notification ─── the entitlement source of truth ──
/**
 * Midtrans calls this on every status change. **Unauthenticated but
 * signature-verified** — anyone can POST here, but only Midtrans can produce the
 * signature. Idempotent: replays and already-settled orders are no-ops. This and the
 * buyer's check (`/:orderId/check`, which asks Midtrans itself) are the only things that
 * flip `Strip.paid` and `Scrapbook.paid` for money, both through `applyMidtransStatus`
 * (the free unlocks flip them only while payments are off); the client is never trusted.
 */
paymentsRouter.post(
  '/midtrans/notification',
  asyncRoute(async (req, res) => {
    const body = req.body as Record<string, unknown>
    const orderId = typeof body.order_id === 'string' ? body.order_id : ''
    const statusCode = typeof body.status_code === 'string' ? body.status_code : ''
    const grossAmount = typeof body.gross_amount === 'string' ? body.gross_amount : ''
    const signatureKey = typeof body.signature_key === 'string' ? body.signature_key : ''
    const transactionStatus =
      typeof body.transaction_status === 'string' ? body.transaction_status : ''
    const fraudStatus = typeof body.fraud_status === 'string' ? body.fraud_status : undefined

    if (
      !verifyNotificationSignature({
        order_id: orderId,
        status_code: statusCode,
        gross_amount: grossAmount,
        signature_key: signatureKey,
      })
    ) {
      logger.warn('payments.notification.bad_signature', { orderId })
      res.status(403).json({ error: 'invalid_signature' })
      return
    }

    await applyMidtransStatus(orderId, transactionStatus, fraudStatus)
    res.status(200).json({ ok: true })
  }),
)

/**
 * Ask Midtrans for an order's status and apply it (`applyMidtransStatus`). Returns false
 * when Midtrans doesn't know the transaction at all — an answer, not a failure; any
 * other Midtrans error is thrown.
 */
async function syncFromMidtrans(orderId: string): Promise<boolean> {
  try {
    const t = (await fetchTransactionStatus(orderId)) as Record<string, unknown>
    const transactionStatus = typeof t.transaction_status === 'string' ? t.transaction_status : ''
    const fraudStatus = typeof t.fraud_status === 'string' ? t.fraud_status : undefined
    await applyMidtransStatus(orderId, transactionStatus, fraudStatus)
    return true
  } catch (error) {
    if (midtransErrorStatus(error) === 404) return false
    throw error
  }
}

// ── POST /payments/:orderId/check ─── "I've paid": ask Midtrans ourselves ─────
/**
 * The buyer says they've paid but the order still reads pending — the notification is
 * late or lost. Ask Midtrans directly (server key, so its answer is as good as a signed
 * notification) and apply it exactly as the webhook would: if Midtrans has the money,
 * the order settles and unlocks now.
 *
 * Answers `{ payment, seen }`: the order as it now stands, and whether Midtrans knows the
 * transaction at all. The checkout modal offers "Report a problem" only when this comes
 * back still unpaid (user, 2026-11-02) — a report is for money Midtrans hasn't shown us.
 */
paymentsRouter.post(
  '/:orderId/check',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!env.paymentsEnabled) {
      res.status(503).json({ error: 'payments_unavailable' })
      return
    }
    const userId = req.userId as string
    if (!statusCheckLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const orderId = req.params.orderId as string
    const owned = await prisma.payment.findUnique({
      where: { orderId },
      select: { userId: true, status: true },
    })
    if (!owned || owned.userId !== userId) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    let seen = true
    if (!FINAL_STATUSES.includes(owned.status)) {
      try {
        seen = await syncFromMidtrans(orderId)
      } catch (error) {
        logger.warn('payments.check.midtransFailed', { orderId, err: String(error) })
        res.status(502).json({ error: 'midtrans_unavailable' })
        return
      }
    }

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId },
      select: PAYMENT_SELECT,
    })
    logger.info('payments.check', { userId, orderId, status: payment.status, seen })
    res.json({ payment: serializePayment(payment), seen })
  }),
)

// ── POST /payments/:orderId/cancel ─── the buyer gives up on this attempt ─────
/**
 * Cancel a pending payment now instead of waiting for its QR to expire (user,
 * 2026-11-02) — to switch method, or because they changed their mind. The cart can
 * then open a new one at once: only a `pending` row blocks a new charge.
 *
 * Midtrans decides, not us: we ask it to cancel and record its answer. It refuses to
 * cancel money it has already taken, so a buyer who paid a moment before pressing
 * Cancel isn't cancelled — we read Midtrans's real status instead and settle the order
 * like any other (the unlock wins over the cancel). Answers `{ payment }` as it now
 * stands; an order that is no longer pending is returned as it is.
 */
paymentsRouter.post(
  '/:orderId/cancel',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!env.paymentsEnabled) {
      res.status(503).json({ error: 'payments_unavailable' })
      return
    }
    const userId = req.userId as string
    if (!statusCheckLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const orderId = req.params.orderId as string
    const owned = await prisma.payment.findUnique({
      where: { orderId },
      select: { userId: true, status: true },
    })
    if (!owned || owned.userId !== userId) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    if (owned.status === 'pending') {
      try {
        await cancelTransaction(orderId)
        await applyMidtransStatus(orderId, 'cancel')
      } catch (cancelError) {
        // Refused — most likely because it's already settled (or expired). Take Midtrans's
        // word for what it is. Unknown to Midtrans means there is nothing it could take.
        try {
          if (!(await syncFromMidtrans(orderId))) await applyMidtransStatus(orderId, 'cancel')
        } catch (error) {
          logger.warn('payments.cancel.midtransFailed', {
            orderId,
            cancelErr: String(cancelError),
            err: String(error),
          })
          res.status(502).json({ error: 'midtrans_unavailable' })
          return
        }
      }
    }

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { orderId },
      select: PAYMENT_SELECT,
    })
    logger.info('payments.cancel', { userId, orderId, status: payment.status })
    res.json({ payment: serializePayment(payment) })
  }),
)

// ── GET /payments ─── the account's own order history ────────────────────────
/**
 * The profile's Purchases tab: the most recent **settled** orders plus lifetime spend.
 *
 * Settled only, matching what `spent` has always summed. An attempt that was abandoned,
 * expired or refused bought nothing, so listing it as a purchase is wrong twice over: it
 * claims a receipt that does not exist, and — because a status only moves when Midtrans
 * says so — a lost `expire` notification would leave it reading "Pending" indefinitely.
 * The cart is where a payment still in flight belongs; this tab is the record of what
 * was actually bought.
 *
 * Capped at five rows because the tab is a receipt strip, not an accounting page —
 * anyone needing the full history has the Midtrans receipts we emailed.
 */
const ORDER_HISTORY_LIMIT = 5

paymentsRouter.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string

    const [rows, settled] = await Promise.all([
      prisma.payment.findMany({
        where: { userId, status: 'paid' },
        orderBy: { createdAt: 'desc' },
        take: ORDER_HISTORY_LIMIT,
        select: {
          orderId: true,
          grossAmount: true,
          currency: true,
          status: true,
          createdAt: true,
          paidAt: true,
          bogo: true,
          bundles: true,
          // The ids, not a count: the client already holds every strip it owns, so it
          // renders the row's thumbnails from its own store rather than us re-deriving
          // storage URLs here. Deleting a strip drops the join row, so this is "what
          // this order bought that you still have" — which is also what the row shows.
          strips: { select: { id: true } },
          // Unlike strips, the client keeps no store of scrapbooks to draw these from, so
          // the order carries what its row shows: the title and the cover.
          scrapbooks: { select: { id: true, title: true, coverKey: true } },
        },
      }),
      prisma.payment.aggregate({
        where: { userId, status: 'paid' },
        _sum: { grossAmount: true },
      }),
    ])

    res.json({
      orders: rows.map((row) => ({
        orderId: row.orderId,
        grossAmount: row.grossAmount,
        currency: row.currency,
        status: row.status,
        stripIds: row.strips.map((strip) => strip.id),
        // A removed scrapbook keeps its row (and this join), with no cover left to show.
        scrapbooks: row.scrapbooks.map((scrapbook) => ({
          id: scrapbook.id,
          title: scrapbook.title,
          coverUrl: coverUrlOf(scrapbook),
        })),
        createdAt: row.createdAt.toISOString(),
        paidAt: row.paidAt?.toISOString() ?? null,
        bogo: row.bogo,
        bundled: row.bundles,
      })),
      // Never null: `_sum` is null when nothing matched, which is a zero total here.
      spent: settled._sum.grossAmount ?? 0,
    })
  }),
)

// ── GET /payments/:orderId/qr ─── save the QR as a file ──────────────────────
/**
 * Stream the attempt's QR image back as a download.
 *
 * Proxied rather than linked because Midtrans hosts the image on its own origin: the
 * `download` attribute is ignored cross-origin (the browser navigates instead), and
 * fetching it from the page would need CORS headers Midtrans does not send. Going
 * through here also means the QR is fetched by us, not by the user's browser reaching
 * out to a payment provider.
 *
 * Buffered, not piped: these images are a few kilobytes, so the streaming machinery
 * would cost more than it saves.
 */
const QR_FETCH_TIMEOUT_MS = 10_000

paymentsRouter.get(
  '/:orderId/qr',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const payment = await prisma.payment.findUnique({
      where: { orderId: req.params.orderId },
      select: { userId: true, qrImageUrl: true },
    })
    if (!payment || payment.userId !== userId) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    if (!payment.qrImageUrl) {
      // A real order, but on a deeplink-only channel — there is no QR to hand over.
      res.status(404).json({ error: 'no_qr' })
      return
    }

    let upstream: Response
    try {
      upstream = await fetch(payment.qrImageUrl, {
        signal: AbortSignal.timeout(QR_FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      logger.warn('payments.qr.fetchFailed', { orderId: req.params.orderId, err: String(err) })
      res.status(502).json({ error: 'qr_unavailable' })
      return
    }
    if (!upstream.ok) {
      logger.warn('payments.qr.upstreamStatus', {
        orderId: req.params.orderId,
        status: upstream.status,
      })
      res.status(502).json({ error: 'qr_unavailable' })
      return
    }

    const body = Buffer.from(await upstream.arrayBuffer())
    const contentType = upstream.headers.get('content-type') ?? 'image/png'
    res.setHeader('Content-Type', contentType)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="momoto-qris-${req.params.orderId}.png"`,
    )
    // Tied to one person's in-flight payment — never let a shared cache keep it.
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(body)
  }),
)

// ── GET /payments/:orderId ─── poll one attempt while the modal is open ──────
/**
 * The full payment, not just its status: the modal re-renders from this on every poll,
 * so a reopened tab rebuilds the QR without re-charging. The webhook remains the only
 * thing that moves `status` — this just reports it.
 */
paymentsRouter.get(
  '/:orderId',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const payment = await prisma.payment.findUnique({
      where: { orderId: req.params.orderId },
      select: { ...PAYMENT_SELECT, userId: true },
    })
    if (!payment || payment.userId !== userId) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.json(serializePayment(payment))
  }),
)
