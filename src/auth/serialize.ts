import type { User } from '@prisma/client'

import { type PublicLocation, locationFor } from '../lib/locations.js'
import { publicUrl } from '../storage/objectStore.js'

/** A partner summary embedded in a user payload (never the partner's private fields). */
export interface PublicPartner {
  id: string
  displayName: string
  avatarUrl: string | null
}

/** The user shape sent to clients — no password hash, no raw tokens. */
export interface PublicUser {
  id: string
  username: string
  email: string | null
  /**
   * Whether `email` has been proven by opening a link we mailed. False with a
   * non-null `email` is a real state (an admin-minted address), not a bug.
   */
  emailVerified: boolean
  /**
   * An address the user is trying to prove but hasn't yet. Lives on the verification
   * token, never on the user row — see `auth/emailVerification.ts`. Only populated by
   * the routes that load it; null elsewhere.
   */
  pendingEmail: string | null
  displayName: string
  avatarUrl: string | null
  hasPassword: boolean
  googleLinked: boolean
  /**
   * Where the person lives, as they set it on their profile, or null. Deliberately
   * absent from `PublicPartner`: nothing in the partner UI uses it.
   */
  location: PublicLocation | null
  partner: PublicPartner | null
  /** When the account was opened (ISO-8601). The profile counts its age from this. */
  createdAt: string
}

/**
 * The picture to show for a user.
 *
 * An uploaded avatar wins over the one Google gave us, since it's the deliberate
 * choice. Three shapes come out of here, and the frontend (`avatarSrc` in
 * `momoto/src/utils/common.ts`) treats them all the same — absolute URLs pass
 * through, relative ones are resolved against the API origin:
 *
 * 1. An absolute CDN URL, when the avatar is in object storage and a public base URL
 *    is configured. This is the normal case: the browser fetches the picture from
 *    Cloudflare and this server is never in the path. No `?v=` — the key is a fresh
 *    UUID per upload, so a replaced picture is already a different URL.
 * 2. `/avatars/:userId?v=<upload time>`, when the bytes are reachable but not from a
 *    CDN — a stored avatar with no public base URL, or a legacy row still in
 *    Postgres. Here the timestamp is the cache-buster, because the path doesn't move.
 * 3. Google's own URL, for an account that never uploaded one.
 */
function avatarFor(
  user: Pick<User, 'id' | 'avatarUrl' | 'avatarUpdatedAt' | 'avatarKey'>,
): string | null {
  if (user.avatarKey) {
    const cdn = publicUrl('avatar', user.avatarKey)
    if (cdn) return cdn
  }
  if (user.avatarUpdatedAt) return `/avatars/${user.id}?v=${user.avatarUpdatedAt.getTime()}`
  return user.avatarUrl
}

/**
 * Maps a DB user (optionally with its `partner` relation loaded) to the public DTO.
 *
 * `pendingEmail` is passed in rather than looked up: this function is synchronous and
 * called on paths (refresh, login) that have no reason to pay for an extra query.
 * The profile routes, which do need it, fetch it and hand it over.
 */
export function serializeUser(
  user: User & { partner?: User | null },
  pendingEmail: string | null = null,
): PublicUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    pendingEmail,
    displayName: user.displayName,
    avatarUrl: avatarFor(user),
    hasPassword: user.passwordHash !== null,
    googleLinked: user.googleId !== null,
    location: locationFor(user),
    createdAt: user.createdAt.toISOString(),
    partner: user.partner
      ? {
          id: user.partner.id,
          displayName: user.partner.displayName,
          avatarUrl: avatarFor(user.partner),
        }
      : null,
  }
}
