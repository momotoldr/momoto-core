/**
 * Rules shared by the admin testimonial routes and, later, the public landing endpoint.
 * See `PLAN-testimonials.md` at the repo root.
 */

/** Feature tag keys. Labels live in the frontend locales, so an admin never translates one. */
export const TESTIMONIAL_FEATURES = [
  'date',
  'group',
  'solo',
  'templates',
  'stickers',
  'print',
  'invite',
] as const

export type TestimonialFeature = (typeof TESTIMONIAL_FEATURES)[number]

export function isTestimonialFeature(value: unknown): value is TestimonialFeature {
  return typeof value === 'string' && (TESTIMONIAL_FEATURES as readonly string[]).includes(value)
}

/** The most testimonials published at once. Enforced on publish, and again when read. */
export const MAX_PUBLISHED_TESTIMONIALS = 10

/** Below this many published, the landing section doesn't render at all. */
export const MIN_TESTIMONIALS_SHOWN = 3

/** Matches the rating card's comment cap (`FEEDBACK_NOTE_MAX` in the frontend). */
export const MAX_TESTIMONIAL_QUOTE = 500

/** A rating needs at least this many stars to be featured. */
export const MIN_TESTIMONIAL_RATING = 4

/**
 * Whether a feedback row can become a testimonial: a star rating from the strip result
 * screen (category `feedback`), from a signed-in author, with a written comment, rated
 * `MIN_TESTIMONIAL_RATING`+, and not already featured. The admin feedback route's
 * `eligibleFeedbackWhere` is the same rule as a database filter — keep them in step.
 */
export function isEligibleFeedback(f: {
  category: string
  hasAuthor: boolean
  message: string
  rating: number | null
  hasTestimonial: boolean
}): boolean {
  return (
    f.category === 'feedback' &&
    f.hasAuthor &&
    f.message.trim() !== '' &&
    f.rating !== null &&
    f.rating >= MIN_TESTIMONIAL_RATING &&
    !f.hasTestimonial
  )
}

/**
 * Whether a couple card shows the partner, for a testimonial that has one:
 *
 * - `shown` — the author is still linked to the partner they had when they wrote it, and
 *   no admin has hidden them;
 * - `unlinked` — they've since unlinked (or the author relinked with someone else);
 * - `hidden` — still linked, but an admin took the partner off the card.
 *
 * Null when there is no partner to show (solo, or the partner's account is gone). Every
 * case but `shown` renders the author alone.
 */
export type CoupleStatus = 'shown' | 'unlinked' | 'hidden'

export function coupleStatus(input: {
  partnerUserId: string | null
  showPartner: boolean
  authorPartnerId: string | null
}): CoupleStatus | null {
  if (!input.partnerUserId) return null
  if (input.authorPartnerId !== input.partnerUserId) return 'unlinked'
  return input.showPartner ? 'shown' : 'hidden'
}

/**
 * Bumped whenever something a published card shows may have changed: any admin
 * testimonial mutation, or a partner unlink. The public endpoint's cache keys on it, so
 * a change is visible on the next request rather than after the cache's TTL.
 */
let revision = 0

export function markTestimonialsChanged(): void {
  revision += 1
}

export function testimonialsRevision(): number {
  return revision
}
