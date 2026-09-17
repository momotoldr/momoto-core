import { createHash, randomBytes } from 'node:crypto'

/**
 * The shared mechanics behind every token we put in a URL or a cookie: refresh
 * tokens, email-verification links, password-reset links.
 *
 * All three are opaque high-entropy randoms rather than signed claims, and all three
 * are stored as a SHA-256 digest so a database leak yields values that can't be
 * presented back to us.
 *
 * **Why a fast hash is right here, when passwords get argon2.** Argon2 is slow on
 * purpose because a password has maybe 40 bits of entropy and an attacker who steals
 * the hashes will guess it offline. These tokens have 256 bits from the system CSPRNG
 * — there is nothing to guess, so the only property the hash needs is
 * irreversibility. Paying argon2's ~100ms on every refresh would buy nothing.
 */

/** Mints a raw token for an email link or a cookie. URL-safe, 256 bits. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

/** The stored form of a raw token. */
export function hashLinkToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}
