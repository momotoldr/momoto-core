import { createHmac } from 'node:crypto'

import jwt from 'jsonwebtoken'

import { env } from '../config/env.js'

/**
 * The receipt a direct upload carries from its start to its completion.
 *
 * Starting an upload (`POST /strips/uploads`, `POST /auth/me/avatar/uploads`) runs the
 * checks, mints the `incoming/` keys and signs this; completing it hands the token back.
 * That is what stops a client completing with keys it chose itself — say, someone
 * else's upload, or an object already promoted — and what carries the strip's metadata
 * across without a table to park it in. Stateless on purpose: nothing to sweep, and any
 * instance can complete an upload another one started.
 *
 * Signed with a key *derived* from `JWT_SECRET` rather than the secret itself, and with
 * its own audience. An access token is a JWT under the raw secret, and `verifyAccessToken`
 * checks no audience — so a grant signed with the same key and a `sub` would pass as a
 * login. The derived key makes that impossible rather than merely unlikely.
 */

/** How long a grant can be completed for: the PUT TTL, plus the upload itself. */
const UPLOAD_GRANT_TTL_SECONDS = 20 * 60

const AUDIENCE = 'momoto-direct-upload'

const signingKey = createHmac('sha256', env.jwtSecret).update('momoto:direct-upload:v1').digest()

/** One file the grant covers: where it was uploaded and what it was declared to be. */
export interface GrantedFile {
  key: string
  contentType: string
  size: number
}

export interface StripUploadGrant {
  kind: 'strip'
  userId: string
  watermarked: GrantedFile
  clean: GrantedFile
  thumbnail: GrantedFile | null
  clientKey: string
  sessionId: string | null
  sessionMode: string | null
  /** ISO-8601, or null to let the row default to `now()`. */
  createdAt: string | null
}

export interface AvatarUploadGrant {
  kind: 'avatar'
  userId: string
  file: GrantedFile
}

export type UploadGrant = StripUploadGrant | AvatarUploadGrant

export function signUploadGrant(grant: UploadGrant): string {
  return jwt.sign({ grant }, signingKey, {
    audience: AUDIENCE,
    expiresIn: UPLOAD_GRANT_TTL_SECONDS,
  })
}

/**
 * The grant inside `token`, or null if it is forged, expired, of another kind, or not
 * this user's. All of those answer the same way: the client can't complete, and has
 * nothing to learn about why.
 */
export function verifyUploadGrant<K extends UploadGrant['kind']>(
  token: unknown,
  kind: K,
  userId: string,
): Extract<UploadGrant, { kind: K }> | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 8192) return null
  try {
    const payload = jwt.verify(token, signingKey, { audience: AUDIENCE })
    if (typeof payload === 'string') return null
    const grant = (payload as { grant?: UploadGrant }).grant
    if (!grant || grant.kind !== kind || grant.userId !== userId) return null
    return grant as Extract<UploadGrant, { kind: K }>
  } catch {
    return null
  }
}
