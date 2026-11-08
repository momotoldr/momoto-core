import { createHmac } from 'node:crypto'

import jwt from 'jsonwebtoken'

import { env } from '../config/env.js'

/**
 * Proof that an admin passed the 6-digit check, carried in `X-Admin-Session` on every
 * `/admin/*` call alongside their ordinary access token.
 *
 * Separate from the access token on purpose. Refreshing that token, the main app and
 * every other route stay exactly as they were, and a stolen ordinary token can't reach
 * the operator surface. Its own derived key and audience, so neither token passes as the
 * other (the reasoning in `storage/uploadGrant.ts`).
 *
 * `v` is when this admin's TOTP was enrolled: resetting or re-enrolling it changes that
 * value, which ends every session issued before.
 */
const AUDIENCE = 'momoto-admin-session'
const signingKey = createHmac('sha256', env.jwtSecret).update('momoto:admin-session:v1').digest()

export const ADMIN_SESSION_HEADER = 'x-admin-session'

export function signAdminSession(
  userId: string,
  enrolledAt: Date,
): { token: string; expiresAt: string } {
  const token = jwt.sign({ v: enrolledAt.getTime() }, signingKey, {
    subject: userId,
    audience: AUDIENCE,
    algorithm: 'HS256',
    expiresIn: env.adminSessionTtlSeconds,
  })
  const expiresAt = new Date(Date.now() + env.adminSessionTtlSeconds * 1000).toISOString()
  return { token, expiresAt }
}

/** Whether `token` is a live session for this admin at this enrolment. */
export function isValidAdminSession(
  token: string | undefined,
  userId: string,
  enrolledAt: Date | null,
): boolean {
  if (!token || !enrolledAt || token.length > 2048) return false
  try {
    const payload = jwt.verify(token, signingKey, {
      audience: AUDIENCE,
      subject: userId,
      algorithms: ['HS256'],
    })
    return typeof payload !== 'string' && payload.v === enrolledAt.getTime()
  } catch {
    return false
  }
}
