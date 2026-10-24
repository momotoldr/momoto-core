import { OAuth2Client } from 'google-auth-library'

import { env } from '../config/env.js'
import { normalizeEmail } from '../lib/email.js'
import { logger } from '../lib/logger.js'

/** The identity fields we take from a verified Google ID token. */
export interface GoogleIdentity {
  googleId: string
  /** Normalized like every other address we store (`normalizeEmail`). */
  email: string
  /**
   * Whether Google *owns* this address rather than merely once confirmed it: a Gmail
   * address, or a Workspace one (the token carries `hd`). For anything else,
   * `email_verified` only means the mailbox worked when the Google account was made — a
   * domain can lapse and be re-registered since. Only an authoritative address may be
   * used to link this Google account into an existing Momoto account.
   */
  emailAuthoritative: boolean
  name: string
  picture: string | null
}

/** Addresses Google itself hosts — `email_verified` on these is ownership, not history. */
const GOOGLE_HOSTED = /@(gmail|googlemail)\.com$/

const client = env.googleClientId
  ? new OAuth2Client({
      clientId: env.googleClientId,
      clientSecret: env.googleClientSecret ?? undefined,
    })
  : null

/**
 * The FE page Google sends the browser back to. Every `CORS_ORIGINS` entry plus this
 * path must be listed under the OAuth client's **Authorized redirect URIs** in Google
 * Cloud, or Google refuses to start the sign-in (`redirect_uri_mismatch`).
 */
export const GOOGLE_CALLBACK_PATH = '/auth/google/callback'

/**
 * Whether `redirectUri` is one of our own callback pages. Google already refuses a URI
 * that isn't registered, but the registered list spans every environment — this keeps
 * each deployment to the origins it actually serves.
 */
export function isOwnGoogleCallback(redirectUri: string): boolean {
  return env.corsOrigins.some((origin) => `${origin}${GOOGLE_CALLBACK_PATH}` === redirectUri)
}

/**
 * Redeems the authorization code Google handed our callback page for the user's ID
 * token, and verifies that (signature, audience, expiry, `email_verified`). Needs the
 * client secret.
 *
 * `redirectUri` must be the one the sign-in started with (Google compares them), and
 * `codeVerifier` is the PKCE secret whose hash the FE sent then, so a code lifted from
 * the callback URL is useless without the tab that asked for it.
 */
export async function exchangeGoogleCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<GoogleIdentity> {
  if (!client || !env.googleClientSecret) {
    throw new Error('google_not_configured')
  }
  // Same reason as below: the library's own error prose must not become our code.
  const { tokens } = await client
    .getToken({ code, redirect_uri: redirectUri, codeVerifier })
    .catch((err: unknown) => {
      // Google's OAuth error code (`invalid_grant`, `redirect_uri_mismatch`,
      // `invalid_client`…) is the only clue to *which* half is misconfigured, so it goes
      // to the log; the client still just gets ours.
      const data = (err as { response?: { data?: { error?: unknown } } }).response?.data
      logger.warn('auth.google.exchange_failed', {
        reason: typeof data?.error === 'string' ? data.error : 'unknown',
        redirectUri,
      })
      throw new Error('invalid_google_token')
    })
  if (!tokens.id_token) throw new Error('invalid_google_token')
  return verifyGoogleIdToken(tokens.id_token)
}

/**
 * Verifies a Google ID token and returns the user's identity. Throws if Google
 * sign-in isn't configured, the token is invalid, or the email isn't verified.
 *
 * Not exported: the only ID token we accept is one Google just gave *us* in exchange
 * for a code. An endpoint taking an ID token from the client would honour any token
 * minted for our client id that leaked during its hour of life.
 */
async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  if (!client || !env.googleClientId) {
    throw new Error('google_not_configured')
  }
  // The library throws its own prose ("Wrong number of segments…", "Token used too
  // late…"), and the route sends the message back as the error code. Collapse it into
  // ours so a client only ever sees a code it has copy for.
  const ticket = await client.verifyIdToken({ idToken, audience: env.googleClientId }).catch(() => {
    throw new Error('invalid_google_token')
  })
  const payload = ticket.getPayload()
  if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
    throw new Error('invalid_google_token')
  }
  const email = normalizeEmail(payload.email)
  return {
    googleId: payload.sub,
    email,
    emailAuthoritative: GOOGLE_HOSTED.test(email) || Boolean(payload.hd),
    name: payload.name ?? email.split('@')[0] ?? 'Friend',
    picture: payload.picture ?? null,
  }
}
