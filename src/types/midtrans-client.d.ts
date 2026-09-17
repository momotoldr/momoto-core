/**
 * Minimal type surface for `midtrans-client` (the package ships no types). Covers only
 * what `src/payments/midtrans.ts` uses: CoreApi for charging a transaction on a single
 * channel, re-querying its status, and parsing notifications.
 */
declare module 'midtrans-client' {
  interface Config {
    isProduction: boolean
    serverKey: string
    clientKey?: string
  }

  /**
   * Core API charge body. The shared fields are named; the per-channel object
   * (`gopay`, `shopeepay`, `qris`, …) arrives through the index signature, since its
   * shape differs per `payment_type` and we only ever set one at a time.
   */
  interface ChargeParameter {
    payment_type: string
    transaction_details: { order_id: string; gross_amount: number }
    item_details?: Array<{
      id?: string
      price: number
      quantity: number
      name: string
    }>
    customer_details?: {
      first_name?: string
      last_name?: string
      email?: string
      phone?: string
    }
    [key: string]: unknown
  }

  /** The notification body Midtrans POSTs; only the fields we read are named. */
  interface NotificationPayload {
    order_id: string
    status_code: string
    gross_amount: string
    signature_key: string
    transaction_status: string
    fraud_status?: string
    payment_type?: string
    [key: string]: unknown
  }

  export class CoreApi {
    constructor(config: Config)
    /**
     * Resolves to the raw charge response. Deliberately `unknown`: the useful parts
     * (`actions`, `expiry_time`) vary by channel, so the caller narrows them rather
     * than trusting a shape we'd be inventing here.
     */
    charge(parameter: ChargeParameter): Promise<unknown>
    transaction: {
      notification(body: unknown): Promise<NotificationPayload>
      status(orderId: string): Promise<NotificationPayload>
    }
  }

  const _default: { CoreApi: typeof CoreApi }
  export default _default
}
