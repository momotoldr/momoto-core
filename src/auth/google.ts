import { OAuth2Client } from 'google-auth-library'

import { env } from '../config/env.js'

/** The identity fields we take from a verified Google ID token. */
export interface GoogleIdentity {
  googleId: string
  email: string
  name: string
  picture: string | null
}

const client = env.googleClientId ? new OAuth2Client(env.googleClientId) : null

/**
 * Verifies a Google ID token (obtained by the frontend via Google Identity
 * Services) and returns the user's identity. Throws if Google sign-in isn't
 * configured, the token is invalid, or the email isn't verified.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!client || !env.googleClientId) {
    throw new Error('google_not_configured')
  }
  const ticket = await client.verifyIdToken({ idToken, audience: env.googleClientId })
  const payload = ticket.getPayload()
  if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
    throw new Error('invalid_google_token')
  }
  return {
    googleId: payload.sub,
    email: payload.email,
    name: payload.name ?? payload.email.split('@')[0] ?? 'Friend',
    picture: payload.picture ?? null,
  }
}
