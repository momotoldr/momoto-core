/**
 * Serializers for the read-only admin monitoring surface (`/admin/*`).
 *
 * These are intentionally richer than the public `serializeUser` (they expose
 * `email`, `role`, `createdAt`, and related `_count`s an operator needs) but obey the
 * same hard rule as every other serializer: **never leak secrets or bytes** —
 * no `passwordHash`, no `tokenHash`, no strip/avatar image bytes. Everything here
 * operates on already-`select`ed shapes, so the bytes are never even loaded.
 */
import { placeLabel } from '../../lib/locations.js'
import { coupleStatus, isEligibleFeedback } from '../../lib/testimonials.js'
import { publicUrl } from '../../storage/objectStore.js'

/** Resolve the picture to show for a user — mirrors `avatarFor` in `auth/serialize.ts`. */
function avatarFor(u: {
  id: string
  avatarUrl: string | null
  avatarUpdatedAt: Date | null
  avatarKey: string | null
}): string | null {
  if (u.avatarKey) {
    const cdn = publicUrl('avatar', u.avatarKey)
    if (cdn) return cdn
  }
  if (u.avatarUpdatedAt) return `/avatars/${u.id}?v=${u.avatarUpdatedAt.getTime()}`
  return u.avatarUrl
}

// ── Embedded "who" summary ───────────────────────────────────────────────────
export interface UserSummaryInput {
  id: string
  username: string
  displayName: string
}

/** The minimal user reference embedded in a payment/feedback/strip/session row. */
export function serializeUserSummary(u: UserSummaryInput) {
  return { id: u.id, username: u.username, displayName: u.displayName }
}

// ── Users ─────────────────────────────────────────────────────────────────────
export interface AdminUserRowInput {
  id: string
  username: string
  email: string | null
  displayName: string
  avatarUrl: string | null
  avatarUpdatedAt: Date | null
  avatarKey: string | null
  passwordHash: string | null
  googleId: string | null
  role: 'USER' | 'ADMIN'
  partnerId: string | null
  countryCode: string | null
  regionCode: string | null
  cityName: string | null
  createdAt: Date
  updatedAt: Date
  _count: { strips: number; payments: number; feedbacks: number }
}

/** A user row for the admin users table. */
export function serializeAdminUser(u: AdminUserRowInput) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    avatarUrl: avatarFor(u),
    hasPassword: u.passwordHash !== null,
    googleLinked: u.googleId !== null,
    role: u.role,
    partnerId: u.partnerId,
    /** "Kota Bandung, Indonesia" / "Tokyo, Japan", or null. Read-only in the console. */
    location: placeLabel(u),
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    counts: {
      strips: u._count.strips,
      payments: u._count.payments,
      feedbacks: u._count.feedbacks,
    },
  }
}

// ── Payments (transactions) ────────────────────────────────────────────────────
export interface AdminPaymentInput {
  id: string
  orderId: string
  grossAmount: number
  currency: string
  status: string
  midtransStatus: string | null
  createdAt: Date
  updatedAt: Date
  paidAt: Date | null
  user: UserSummaryInput
  _count: { strips: number }
}

/** A payment row for the admin transactions table. */
export function serializeAdminPayment(p: AdminPaymentInput) {
  return {
    id: p.id,
    orderId: p.orderId,
    grossAmount: p.grossAmount,
    currency: p.currency,
    status: p.status,
    midtransStatus: p.midtransStatus,
    stripCount: p._count.strips,
    user: serializeUserSummary(p.user),
    createdAt: p.createdAt.toISOString(),
    paidAt: p.paidAt ? p.paidAt.toISOString() : null,
  }
}

// ── Feedback ────────────────────────────────────────────────────────────────────
export interface AdminFeedbackInput {
  id: string
  ticketNumber: number
  category: string
  rating: number | null
  message: string
  email: string | null
  context: string | null
  userAgent: string | null
  createdAt: Date
  resolvedAt: Date | null
  lang: string | null
  sessionMode: string | null
  partnerUserId: string | null
  user: (TestimonialPersonInput & { partnerId: string | null }) | null
  partner: TestimonialPersonInput | null
  testimonial: { id: string } | null
  sourceNote: string | null
  enteredBy: UserSummaryInput | null
}

/** A feedback/support row for the admin feedback inbox. */
export function serializeAdminFeedback(f: AdminFeedbackInput) {
  return {
    id: f.id,
    ticketNumber: f.ticketNumber,
    category: f.category,
    rating: f.rating,
    message: f.message,
    email: f.email,
    context: f.context,
    userAgent: f.userAgent,
    user: f.user ? serializeUserSummary(f.user) : null,
    createdAt: f.createdAt.toISOString(),
    resolvedAt: f.resolvedAt ? f.resolvedAt.toISOString() : null,
    lang: f.lang,
    sessionMode: f.sessionMode,
    testimonialId: f.testimonial?.id ?? null,
    // Admin-entered feedback: where it came from, and who typed it in (null once that
    // admin's account is gone — the note still marks the row).
    sourceNote: f.sourceNote,
    enteredBy: f.enteredBy ? serializeUserSummary(f.enteredBy) : null,
    eligible: isEligibleFeedback({
      category: f.category,
      hasAuthor: f.user !== null,
      message: f.message,
      rating: f.rating,
      hasTestimonial: f.testimonial !== null,
    }),
    author: f.user ? serializeTestimonialPerson(f.user) : null,
    // Who a testimonial built from this row would show beside the author: the partner
    // captured with the comment, and only while the author is still linked to them.
    partner:
      f.partner && f.user?.partnerId === f.partnerUserId
        ? serializeTestimonialPerson(f.partner)
        : null,
  }
}

// ── Testimonials ──────────────────────────────────────────────────────────────
export interface TestimonialPersonInput extends UserSummaryInput {
  avatarKey: string | null
  avatarUpdatedAt: Date | null
  countryCode: string | null
  regionCode: string | null
  cityName: string | null
}

/** Someone who appears on a testimonial card, as the console previews them. */
export function serializeTestimonialPerson(p: TestimonialPersonInput) {
  return {
    id: p.id,
    username: p.username,
    displayName: p.displayName,
    place: placeLabel(p),
    // The card only ever shows an uploaded picture from the CDN (never a Google-hosted
    // one), so the preview follows the same rule. `hasUploadedAvatar` is separate because
    // a setup without a public bucket URL has uploads but no CDN link to show.
    avatarUrl: p.avatarKey ? publicUrl('avatar', p.avatarKey) : null,
    hasUploadedAvatar: p.avatarUpdatedAt !== null,
  }
}

export interface AdminTestimonialInput {
  id: string
  feedbackId: string | null
  originalText: string
  originalLang: string | null
  quoteEn: string
  quoteId: string
  feature: string
  rating: number
  position: number
  publishedAt: Date | null
  showPartner: boolean
  partnerUserId: string | null
  createdAt: Date
  updatedAt: Date
  user: TestimonialPersonInput & { partnerId: string | null }
  partner: TestimonialPersonInput | null
}

/** A testimonial row for the console, drafts and published alike. */
export function serializeAdminTestimonial(t: AdminTestimonialInput) {
  return {
    id: t.id,
    feedbackId: t.feedbackId,
    originalText: t.originalText,
    originalLang: t.originalLang,
    quoteEn: t.quoteEn,
    quoteId: t.quoteId,
    feature: t.feature,
    rating: t.rating,
    position: t.position,
    published: t.publishedAt !== null,
    publishedAt: t.publishedAt ? t.publishedAt.toISOString() : null,
    showPartner: t.showPartner,
    author: serializeTestimonialPerson(t.user),
    partner: t.partner ? serializeTestimonialPerson(t.partner) : null,
    coupleStatus: coupleStatus({
      partnerUserId: t.partnerUserId,
      showPartner: t.showPartner,
      authorPartnerId: t.user.partnerId,
    }),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }
}

// ── Strips ────────────────────────────────────────────────────────────────────
export interface AdminStripInput {
  id: string
  storageKey: string | null
  thumbnailKey: string | null
  width: number
  height: number
  sessionId: string | null
  sessionMode: string | null
  paid: boolean
  paidAt: Date | null
  createdAt: Date
  user: UserSummaryInput
}

/** A strip row (metadata only — never bytes) for the admin strips table. */
export function serializeAdminStrip(s: AdminStripInput) {
  const cdn = s.storageKey ? publicUrl('public', s.storageKey) : null
  // The CDN URL when the image is in storage — this table renders a page of images
  // at once, so keeping them off the API is where it matters most. Otherwise
  // relative to the API origin, which the admin app prefixes.
  const url = cdn ?? `/strips/${s.id}`
  const thumbCdn = s.thumbnailKey ? publicUrl('public', s.thumbnailKey) : null
  return {
    id: s.id,
    url,
    // What the table actually renders, in an 80px-tall row. Falls back to the full
    // image so the column is never empty.
    thumbnailUrl: thumbCdn ?? (s.thumbnailKey ? `/strips/${s.id}/thumb` : url),
    width: s.width,
    height: s.height,
    sessionId: s.sessionId,
    sessionMode: s.sessionMode,
    paid: s.paid,
    user: serializeUserSummary(s.user),
    paidAt: s.paidAt ? s.paidAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  }
}
