import { createHash } from 'node:crypto'

// midtrans-client is CommonJS and its named exports aren't visible to Node's ESM
// lexer, so import the default and destructure the classes at runtime; the type
// names come from the ambient declaration via `import type`.
import type { CoreApi as CoreApiType } from 'midtrans-client'
import midtransClient from 'midtrans-client'

import { env } from '../config/env.js'

const { CoreApi } = midtransClient

/**
 * Thin wrapper around the Midtrans Core API. `charge` opens a transaction on one
 * specific channel and hands back the artifacts we render ourselves (a QR image, a
 * wallet deeplink); `transaction.status` re-queries an order. Created lazily so the
 * server boots without Midtrans keys (payments disabled).
 *
 * Core API rather than Snap because checkout is our own UI. Entitlement is unaffected
 * by that choice: both fire the identical signed notification, which remains the only
 * thing that flips `Strip.paid`.
 */
let core: CoreApiType | null = null

function getCore(): CoreApiType {
  core ??= new CoreApi({
    // Non-null: callers gate on `env.paymentsEnabled` before reaching here.
    isProduction: env.midtransIsProduction,
    serverKey: env.midtransServerKey as string,
    clientKey: env.midtransClientKey as string,
  })
  return core
}

/** The channels our checkout offers. Anything else is rejected before we call Midtrans. */
export const PAYMENT_METHODS = ['gopay', 'shopeepay', 'qris'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value)
}

export interface ChargeOrder {
  orderId: string
  /** Price per strip, in whole rupiah. */
  unitPrice: number
  /** How many strips this checkout unlocks. */
  quantity: number
  itemName: string
  customer: { name: string; email: string | null }
  method: PaymentMethod
}

export interface ChargeResult {
  /** Midtrans-hosted QR image. Null on channels that only return a deeplink. */
  qrImageUrl: string | null
  /** Wallet deeplink — opens the app on mobile. Null on QR-only channels. */
  deeplinkUrl: string | null
  /** When Midtrans stops accepting this payment, or null if it didn't say. */
  expiresAt: Date | null
  /** Raw `transaction_status` from the charge response (normally `pending`). */
  transactionStatus: string
}

/**
 * Midtrans returns `expiry_time` as a wall-clock string in the merchant's timezone
 * (WIB) with no offset — `"2026-09-07 15:04:05"`. Parsing that with `new Date()` would
 * read it as local time, which is only correct on a machine already in WIB and silently
 * wrong by hours everywhere else, so pin the offset explicitly.
 */
const WIB_OFFSET = '+07:00'

function parseExpiry(raw: unknown): Date | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const parsed = new Date(`${raw.replace(' ', 'T')}${WIB_OFFSET}`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Pull one named action's URL out of a charge response. */
function actionUrl(actions: unknown, name: string): string | null {
  if (!Array.isArray(actions)) return null
  const hit = actions.find(
    (action): action is { name: string; url: string } =>
      typeof action === 'object' &&
      action !== null &&
      (action as { name?: unknown }).name === name &&
      typeof (action as { url?: unknown }).url === 'string',
  )
  return hit?.url ?? null
}

/** Per-channel charge parameters. Shared fields are merged in by `chargeTransaction`. */
function channelParams(method: PaymentMethod): Record<string, unknown> {
  switch (method) {
    case 'gopay':
      // `enable_callback` off: we own the return journey, and the notification — not the
      // browser coming back — is what settles the order.
      return { gopay: { enable_callback: false } }
    case 'shopeepay':
      return { shopeepay: { callback_url: `${env.appBaseUrl}/cart` } }
    case 'qris':
      // GoPay as acquirer; the QR is still QRIS, scannable by any Indonesian wallet.
      return { qris: { acquirer: 'gopay' } }
  }
}

/** Open a transaction on one channel and return what the client needs to render. */
export async function chargeTransaction(order: ChargeOrder): Promise<ChargeResult> {
  // gross_amount must equal Σ(price × quantity); one line item, quantity = #strips.
  const grossAmount = order.unitPrice * order.quantity
  const response = (await getCore().charge({
    payment_type: order.method,
    transaction_details: { order_id: order.orderId, gross_amount: grossAmount },
    item_details: [
      { id: 'strip-print', price: order.unitPrice, quantity: order.quantity, name: order.itemName },
    ],
    customer_details: {
      first_name: order.customer.name,
      ...(order.customer.email ? { email: order.customer.email } : {}),
    },
    ...channelParams(order.method),
  })) as Record<string, unknown>

  return {
    qrImageUrl: actionUrl(response.actions, 'generate-qr-code'),
    deeplinkUrl: actionUrl(response.actions, 'deeplink-redirect'),
    expiresAt: parseExpiry(response.expiry_time),
    transactionStatus:
      typeof response.transaction_status === 'string' ? response.transaction_status : 'pending',
  }
}

/**
 * Verify a notification's signature: `sha512(order_id + status_code + gross_amount +
 * serverKey)` must equal `signature_key`. This is what makes a POST to the webhook
 * trustworthy — anyone can hit the URL, but only Midtrans can produce the hash.
 */
export function verifyNotificationSignature(payload: {
  order_id: string
  status_code: string
  gross_amount: string
  signature_key: string
}): boolean {
  const expected = createHash('sha512')
    .update(
      payload.order_id +
        payload.status_code +
        payload.gross_amount +
        (env.midtransServerKey as string),
    )
    .digest('hex')
  return expected === payload.signature_key
}

/** Re-query a transaction's authoritative status straight from Midtrans. */
export async function fetchTransactionStatus(orderId: string) {
  return getCore().transaction.status(orderId)
}
