/**
 * Email address handling, in one place.
 *
 * The shape check is deliberately loose. A regex that tries to implement RFC 5321
 * rejects addresses that genuinely work (`+` tags, new TLDs, quoted local parts) and
 * still can't tell you whether a mailbox exists — only delivery can. So this catches
 * fat-finger mistakes ("no @", a trailing space) and nothing more; the verification
 * link is what actually proves an address.
 *
 * `feedback.ts` and `admin.ts` each grew their own copy of these two constants. This
 * module is the one both should import — a third copy is how the rules drift apart.
 */

/** Longest address we'll store. The RFC's practical ceiling for a full address. */
export const MAX_EMAIL = 254

/** Deliberately loose — see the note above. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Trim and lowercase an address for storage and comparison.
 *
 * Case matters in the local part per the RFC, but no mail provider anyone uses
 * actually treats `Andi@` and `andi@` as different mailboxes — and because
 * `User.email` is uniquely indexed, storing both casings would let one person hold
 * an address twice and a second person be told it was taken by a row they can't see.
 * Normalizing on the way in makes the unique index mean what we want it to mean.
 */
export function normalizeEmail(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
}

/** True if `email` is storable: right shape, within the column's ceiling. */
export function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL && EMAIL_RE.test(email)
}
