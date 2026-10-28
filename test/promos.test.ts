// The soft-launch promos' money rules (docs/PLAN-promos.md). Pure functions only: the
// database-backed parts are exercised end to end against a local core.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  bundlePriceFor,
  partnerPromoEarners,
  priceOrder,
  type OrderPricingInput,
} from '../src/promos/pricing.js'

const STRIP = 12_999
const BOOK = 24_999
const BUNDLE = 47_997 // 25% off 63,996

function order(input: Partial<OrderPricingInput>): OrderPricingInput {
  return {
    strips: 0,
    scrapbooks: 0,
    bogo: false,
    stripPrice: STRIP,
    scrapbookPrice: BOOK,
    bundlePrice: BUNDLE,
    ...input,
  }
}

function total(input: Partial<OrderPricingInput>): number {
  return priceOrder(order(input)).items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

function lines(input: Partial<OrderPricingInput>): Record<string, number> {
  return Object.fromEntries(
    priceOrder(order(input))
      .items.filter((item) => item.quantity > 0)
      .map((item) => [item.id, item.quantity]),
  )
}

describe('priceOrder', () => {
  it('charges list price with no promos', () => {
    assert.equal(total({ strips: 2, scrapbooks: 1 }), 2 * STRIP + BOOK)
    assert.deepEqual(lines({ strips: 2, scrapbooks: 1 }), { 'strip-print': 2, scrapbook: 1 })
  })

  it('prices a scrapbook + 3 unpaid strips as one bundle: Rp 47,997', () => {
    assert.equal(total({ strips: 3, scrapbooks: 1 }), BUNDLE)
    assert.deepEqual(lines({ strips: 3, scrapbooks: 1 }), { 'scrapbook-bundle': 1 })
    assert.equal(priceOrder(order({ strips: 3, scrapbooks: 1 })).bundles, 1)
  })

  it('needs all 3 strips: a scrapbook + 2 strips is list price', () => {
    assert.equal(total({ strips: 2, scrapbooks: 1 }), 2 * STRIP + BOOK)
  })

  it('needs a scrapbook: 3 strips alone are list price', () => {
    assert.equal(total({ strips: 3 }), 3 * STRIP)
  })

  it('charges strips past the bundle at list price', () => {
    assert.equal(total({ strips: 4, scrapbooks: 1 }), BUNDLE + STRIP)
    assert.deepEqual(lines({ strips: 4, scrapbooks: 1 }), {
      'scrapbook-bundle': 1,
      'strip-print': 1,
    })
  })

  it('makes one bundle per scrapbook, 3 strips each', () => {
    assert.equal(total({ strips: 6, scrapbooks: 2 }), 2 * BUNDLE)
    assert.equal(total({ strips: 5, scrapbooks: 2 }), BUNDLE + 2 * STRIP + BOOK)
  })

  it('ignores the bundle while it is off', () => {
    assert.equal(total({ strips: 3, scrapbooks: 1, bundlePrice: null }), 3 * STRIP + BOOK)
  })

  it('ignores a bundle priced at or above its parts', () => {
    const parts = BOOK + 3 * STRIP
    assert.equal(priceOrder(order({ strips: 3, scrapbooks: 1, bundlePrice: parts })).bundles, 0)
  })

  it('prices two strips as one on buy 1 get 1', () => {
    assert.equal(total({ strips: 2, bogo: true }), STRIP)
    assert.deepEqual(lines({ strips: 2, bogo: true }), { 'strip-bogo': 1 })
  })

  it("doesn't apply (or spend) buy 1 get 1 on a single strip", () => {
    assert.equal(priceOrder(order({ strips: 1, bogo: true })).bogo, false)
  })

  it('bundles first, then buy 1 get 1 on the strips left over', () => {
    // 5 strips + a book: bundle takes 3, the reward covers the other 2.
    assert.equal(total({ strips: 5, scrapbooks: 1, bogo: true }), BUNDLE + STRIP)
    assert.deepEqual(lines({ strips: 5, scrapbooks: 1, bogo: true }), {
      'scrapbook-bundle': 1,
      'strip-bogo': 1,
    })
  })

  it("doesn't spend the reward on strips a bundle already took", () => {
    const pricing = priceOrder(order({ strips: 3, scrapbooks: 1, bogo: true }))
    assert.equal(pricing.bogo, false)
    assert.equal(pricing.bundles, 1)
  })

  it('never charges more than list price', () => {
    for (const strips of [0, 1, 2, 3, 4, 5, 6, 7])
      for (const scrapbooks of [0, 1, 2])
        for (const bogo of [false, true]) {
          const promo = total({ strips, scrapbooks, bogo })
          assert.ok(promo <= strips * STRIP + scrapbooks * BOOK)
          assert.ok(promo >= 0)
        }
  })
})

describe('bundlePriceFor', () => {
  it('is 25% off a scrapbook + 3 strips: Rp 47,997', () => {
    assert.equal(bundlePriceFor(25, BOOK, STRIP), 47_997)
  })

  it('follows list prices', () => {
    assert.equal(bundlePriceFor(25, 20_000, 10_000), 37_500)
  })

  it('rounds to the whole rupiah', () => {
    // 63,996 × 0.67 = 42,877.32
    assert.equal(bundlePriceFor(33, BOOK, STRIP), 42_877)
  })

  it('never reaches zero', () => {
    assert.equal(bundlePriceFor(99, 1, 0), 1)
  })
})

describe('partnerPromoEarners', () => {
  const newSince = new Date('2026-11-03T00:00:00Z') // 7 days
  const fresh = (id: string) => ({ id, createdAt: new Date('2026-11-09T00:00:00Z') })
  const old = (id: string) => ({ id, createdAt: new Date('2026-09-01T00:00:00Z') })
  const none = new Set<string>()

  it('rewards both sides when one account is new', () => {
    assert.deepEqual(partnerPromoEarners([old('a'), fresh('x')], none, newSince), ['a', 'x'])
  })

  it('rewards nobody when both accounts are old', () => {
    assert.deepEqual(partnerPromoEarners([old('a'), old('b')], none, newSince), [])
  })

  it('counts an account created exactly at the cut-off as new', () => {
    const edge = { id: 'x', createdAt: newSince }
    assert.deepEqual(partnerPromoEarners([old('a'), edge], none, newSince), ['a', 'x'])
  })

  it("doesn't reward an account twice (relink after unlink)", () => {
    // a and x linked, unlinked, and x links with b: x is still new but already rewarded.
    assert.deepEqual(partnerPromoEarners([fresh('x'), old('b')], new Set(['x']), newSince), [])
  })

  it('rewards only the side that has not had it', () => {
    // a earned it from an earlier link; a now links a brand-new y.
    assert.deepEqual(partnerPromoEarners([old('a'), fresh('y')], new Set(['a']), newSince), ['y'])
  })

  it('rewards a second new account even if the first new one already had it', () => {
    assert.deepEqual(partnerPromoEarners([fresh('x'), fresh('y')], new Set(['x']), newSince), ['y'])
  })

  it('rewards nobody when both already have it', () => {
    assert.deepEqual(partnerPromoEarners([fresh('x'), old('a')], new Set(['x', 'a']), newSince), [])
  })
})
