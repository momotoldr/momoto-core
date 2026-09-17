import { randomUUID } from 'node:crypto'

import { Router } from 'express'

import { env } from '../../config/env.js'
import { prisma } from '../../db/client.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import {
  chargeTransaction,
  isPaymentMethod,
  verifyNotificationSignature,
} from '../../payments/midtrans.js'
import { asyncRoute } from '../asyncRoute.js'
import { requireAuth } from '../middleware/requireAuth.js'
import { findPurchasableStrips, galleryRoomFor, refusePurchase } from './strips.js'

export const paymentsRouter = Router()

/** Rate-limit checkout creation per user (each mints a Midtrans transaction). */
const checkoutLimiter = new RateLimiter(20, 10 * 60_000)

/** Reclaim expired checkout rate windows (wired into the periodic sweep). */
export function sweepPaymentLimits(now: number = Date.now()): number {
  return checkoutLimiter.sweep(now)
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
  strips: { id: string }[]
}) {
  return {
    orderId: payment.orderId,
    status: payment.status,
    grossAmount: payment.grossAmount,
    method: payment.paymentType,
    qrImageUrl: payment.qrImageUrl,
    deeplinkUrl: payment.deeplinkUrl,
    expiresAt: payment.expiresAt?.toISOString() ?? null,
    stripIds: payment.strips.map((strip) => strip.id),
    count: payment.strips.length,
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
  strips: { select: { id: true } },
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
 * Charge the strips the user selected in the cart, on the channel they picked. The
 * amount is `count × STRIP_PRINT_PRICE_IDR`, computed here and never trusted from the
 * client. Returns the artifacts our own checkout modal renders — a QR image, a wallet
 * deeplink, or both — rather than a hosted-popup token.
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

    const body = req.body as { stripIds?: unknown; method?: unknown }
    if (!isPaymentMethod(body.method)) {
      res.status(400).json({ error: 'invalid_method' })
      return
    }
    const method = body.method

    // De-dupe + validate the requested ids.
    const stripIds = Array.isArray(body.stripIds)
      ? [...new Set(body.stripIds.filter((id): id is string => typeof id === 'string'))]
      : []
    if (stripIds.length === 0 || stripIds.length > MAX_CHECKOUT_STRIPS) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    // One live attempt at a time. Charging again while a QR is still payable would let
    // two orders settle for the same strips — the second one paying for nothing, since
    // the first already unlocked them. The client resumes the existing attempt instead.
    const live = await findLivePayment(userId)
    if (live) {
      logger.info('payments.charge.inProgress', { userId, orderId: live.orderId })
      res.status(409).json({ error: 'payment_in_progress', payment: serializePayment(live) })
      return
    }

    // Every strip must be the caller's, unpaid, and have a clean copy to deliver. Shared
    // with the free unlock path so both refuse on identical grounds — and refuse here,
    // before a Midtrans transaction exists, so nothing has been charged.
    const purchasable = await findPurchasableStrips(userId, stripIds)
    if (!purchasable.ok) {
      refusePurchase(res, 'charge', userId, purchasable)
      return
    }
    const { strips } = purchasable

    // The gallery has to be able to hold what this payment would unlock. Refusing here
    // means no Midtrans transaction exists and nothing has been charged — the only place
    // this check is safe to make. (The webhook deliberately does not repeat it.)
    const room = await galleryRoomFor(userId, strips.length)
    if (!room.ok) {
      logger.info('gallery.full', { userId, used: room.used, limit: room.limit })
      res.status(409).json({ error: 'gallery_full', used: room.used, limit: room.limit })
      return
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { displayName: true, email: true },
    })

    const unitPrice = env.stripPrintPriceIdr
    const grossAmount = unitPrice * strips.length
    const orderId = `pay_${randomUUID()}`

    const charge = await chargeTransaction({
      orderId,
      unitPrice,
      quantity: strips.length,
      itemName: 'Momoto strip print',
      customer: { name: user?.displayName ?? 'Momoto user', email: user?.email ?? null },
      method,
    })

    const payment = await prisma.payment.create({
      data: {
        orderId,
        userId,
        grossAmount,
        paymentType: method,
        qrImageUrl: charge.qrImageUrl,
        deeplinkUrl: charge.deeplinkUrl,
        expiresAt: charge.expiresAt,
        midtransStatus: charge.transactionStatus,
        strips: { connect: strips.map((s) => ({ id: s.id })) },
      },
      select: PAYMENT_SELECT,
    })
    logger.info('payments.charge.created', {
      userId,
      orderId,
      method,
      count: strips.length,
      grossAmount,
    })
    res.status(201).json(serializePayment(payment))
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
    case 'pending':
      return 'pending'
    default:
      return null
  }
}

// ── POST /payments/midtrans/notification ─── the entitlement source of truth ──
/**
 * Midtrans calls this on every status change. **Unauthenticated but
 * signature-verified** — anyone can POST here, but only Midtrans can produce the
 * signature. Idempotent: replays and already-settled orders are no-ops. This is the
 * only thing that flips `Strip.paid`; the client callback is never trusted.
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

    const payment = await prisma.payment.findUnique({
      where: { orderId },
      include: { strips: { select: { id: true } } },
    })
    if (!payment) {
      // Unknown order — ack so Midtrans stops retrying, but do nothing.
      logger.warn('payments.notification.unknown_order', { orderId })
      res.status(200).json({ ok: true })
      return
    }

    // Idempotent: once paid, later notifications don't change entitlement.
    if (payment.status === 'paid') {
      res.status(200).json({ ok: true })
      return
    }

    const next = mapStatus(transactionStatus, fraudStatus)
    if (next === null) {
      res.status(200).json({ ok: true })
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
      const room = await galleryRoomFor(payment.userId, stripIds.length)
      if (!room.ok) {
        logger.warn('gallery.overCap', {
          orderId,
          userId: payment.userId,
          used: room.used,
          limit: room.limit,
          settling: stripIds.length,
        })
      }
      // Flip the payment and unlock every strip it covers in one transaction.
      await prisma.$transaction([
        prisma.payment.update({
          where: { orderId },
          data: { status: 'paid', midtransStatus: transactionStatus, paidAt: now },
        }),
        prisma.strip.updateMany({
          where: { id: { in: stripIds } },
          data: { paid: true, paidAt: now },
        }),
      ])
      logger.info('payments.paid', { orderId, strips: stripIds.length })
    } else {
      await prisma.payment.update({
        where: { orderId },
        data: { status: next, midtransStatus: transactionStatus },
      })
      logger.info('payments.status', { orderId, status: next })
    }

    res.status(200).json({ ok: true })
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
          // The ids, not a count: the client already holds every strip it owns, so it
          // renders the row's thumbnails from its own store rather than us re-deriving
          // storage URLs here. Deleting a strip drops the join row, so this is "what
          // this order bought that you still have" — which is also what the row shows.
          strips: { select: { id: true } },
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
        createdAt: row.createdAt.toISOString(),
        paidAt: row.paidAt?.toISOString() ?? null,
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
