import type { ChargeItem } from '../payments/midtrans.js'

// The soft-launch promos' pure rules (docs/PLAN-promos.md): no database, no env, so every
// money rule here is unit-tested (test/promos.test.ts). `promos.ts` feeds them.

/**
 * Strips in one scrapbook bundle — the "3" in "scrapbook + 3 strips only Rp 48,999". A
 * constant rather than env: it's what the offer promises, so it changes with a release
 * and new copy, never with a variable. The FE has the same constant.
 */
export const BUNDLE_STRIPS = 3

/**
 * A bundle's price at `percent` off its list price: one scrapbook + `BUNDLE_STRIPS`
 * strips. Rounded to the whole rupiah — IDR has no minor unit — and never below 1.
 * 25% off 24,999 + 3 × 12,999 = 63,996 is 47,997.
 */
export function bundlePriceFor(
  percent: number,
  scrapbookPrice: number,
  stripPrice: number,
): number {
  const list = scrapbookPrice + BUNDLE_STRIPS * stripPrice
  return Math.max(1, Math.round((list * (100 - percent)) / 100))
}

/**
 * The admin fee one payment method adds to an order: a flat amount, a percentage of the
 * order after promos, or both (env `ADMIN_FEE_<METHOD>`). The percentage is in basis
 * points — 0.7% is 70 — so the arithmetic stays in whole numbers.
 */
export interface AdminFeeRule {
  /** Whole rupiah. */
  flat: number
  /** Hundredths of a percent. */
  basisPoints: number
}

/**
 * The admin fee on `subtotal` under `rule`, in whole rupiah. The percentage rounds **up**,
 * so the fee never falls short of a channel's percentage cost. Promos never touch it
 * (user, 2026-11-02): it is charged on what the items cost after their discounts.
 */
export function adminFeeFor(rule: AdminFeeRule | null, subtotal: number): number {
  if (!rule || subtotal <= 0) return 0
  return rule.flat + Math.ceil((subtotal * rule.basisPoints) / 10_000)
}

/** What an order holds, and which promos the caller has already found it qualifies for. */
export interface OrderPricingInput {
  /** Unpaid strips in the order. */
  strips: number
  /** Finished scrapbooks in the order. */
  scrapbooks: number
  /** The buyer holds an unused partner reward and Promo A is on. */
  bogo: boolean
  stripPrice: number
  scrapbookPrice: number
  /** One scrapbook + `BUNDLE_STRIPS` strips. Null while Promo B is off (flag, price, end). */
  bundlePrice: number | null
  /** The chosen payment method's admin fee. Null (or absent) when none applies yet. */
  adminFee?: AdminFeeRule | null
}

export interface OrderPricing {
  /** The Midtrans lines. Zero-quantity lines are left in; `chargeTransaction` drops them. */
  items: ChargeItem[]
  /** Whether buy 1 get 1 was applied. */
  bogo: boolean
  /** How many scrapbook bundles the order was priced with. */
  bundles: number
  /** The admin fee line's amount, in whole rupiah; 0 when there is none. */
  adminFee: number
}

/**
 * Price an order with the soft-launch promos applied (docs/PLAN-promos.md). Pure, so the
 * money rules can be tested without a database or Midtrans.
 *
 * **Bundles first** (user, 2026-10-27): each finished scrapbook in the order takes
 * `BUNDLE_STRIPS` of its unpaid strips — any of them, not the ones inside the book — and
 * the set is one line at the bundle price. **Then buy 1 get 1** on the strips left over,
 * which needs two: a reward is never spent on strips a bundle already discounted.
 * Whatever remains is list price.
 *
 * Every promo here only ever lowers the total, so applying one is never worse for the
 * buyer than list price — which is why nothing is opt-in. A bundle priced at or above
 * what its parts cost is ignored rather than charged.
 */
export function priceOrder(input: OrderPricingInput): OrderPricing {
  const bundlePays =
    input.bundlePrice !== null &&
    input.bundlePrice < input.scrapbookPrice + BUNDLE_STRIPS * input.stripPrice
  const bundles = bundlePays
    ? Math.max(0, Math.min(input.scrapbooks, Math.floor(input.strips / BUNDLE_STRIPS)))
    : 0
  const looseStrips = input.strips - bundles * BUNDLE_STRIPS
  const bogo = input.bogo && looseStrips >= 2
  const items: ChargeItem[] = [
    {
      id: 'scrapbook-bundle',
      // Midtrans caps item names at 50 characters; plain ASCII keeps every channel happy.
      name: `Momoto scrapbook + ${BUNDLE_STRIPS} strips (bundle)`,
      price: input.bundlePrice ?? 0,
      quantity: bundles,
    },
    {
      id: 'strip-bogo',
      name: 'Momoto strips - buy 1 get 1 (2 strips)',
      price: input.stripPrice,
      quantity: bogo ? 1 : 0,
    },
    {
      id: 'strip-print',
      name: 'Momoto strip print',
      price: input.stripPrice,
      quantity: looseStrips - (bogo ? 2 : 0),
    },
    {
      id: 'scrapbook',
      name: 'Momoto scrapbook',
      price: input.scrapbookPrice,
      quantity: input.scrapbooks - bundles,
    },
  ]
  // Last, on the discounted subtotal: a promo lowers what the items cost, never the fee.
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const adminFee = adminFeeFor(input.adminFee ?? null, subtotal)
  items.push({
    id: 'admin-fee',
    name: 'Admin fee',
    price: adminFee,
    quantity: adminFee > 0 ? 1 : 0,
  })
  return { items, bogo, bundles, adminFee }
}

/**
 * Which of two just-linked accounts earn the partner reward (Promo A).
 *
 * Both sides earn it, once per account ever, and only if one of the two is new — created
 * at or after `newSince`. "New" alone isn't enough: a new account that has already earned
 * it can't be passed around to reward one existing user after another, so the pair needs
 * at least one account that is new **and** not yet rewarded.
 */
export function partnerPromoEarners(
  pair: [{ id: string; createdAt: Date }, { id: string; createdAt: Date }],
  rewarded: ReadonlySet<string>,
  newSince: Date,
): string[] {
  const fresh = pair.filter((user) => user.createdAt.getTime() >= newSince.getTime())
  if (fresh.every((user) => rewarded.has(user.id))) return []
  return pair.filter((user) => !rewarded.has(user.id)).map((user) => user.id)
}
