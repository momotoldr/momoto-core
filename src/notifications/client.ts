import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'

/**
 * Client for `momoto-notify`, the service that owns every outbound email.
 *
 * **The contract this preserves.** Callers are request handlers whose real work has
 * already succeeded — the account exists, the token is minted. Nothing here throws or
 * rejects, and nothing should be awaited on a request path: a mail service that is
 * down must never turn a successful signup into a 500 that tells the user their
 * signup failed.
 *
 * **Links are built here, not there.** The notification service has no business
 * knowing that a confirmation link lives at `/verify-email` on the frontend; that is
 * this app's routing, and duplicating it across two deployables means a route change
 * has to ship twice. So we hand over finished URLs.
 */

/** Mirrors `momoto-notify/src/types.ts`. Keep the two in step. */
type Lang = 'en' | 'id'

type Payload =
  | { type: 'verify_email'; data: { url: string; expiresInHours: number } }
  | { type: 'password_reset'; data: { url: string; expiresInMinutes: number } }
  | { type: 'password_changed'; data: { resetUrl: string } }
  | {
      type: 'beta_invite'
      data: {
        displayName: string
        username: string
        password: string
        // A second login for the partner, printed in the same email. Optional, and
        // both move together — momoto-notify rejects half a pair.
        partnerUsername?: string
        partnerPassword?: string
      }
    }
  | { type: 'booth_reminder'; data: { displayName: string; url: string } }

/** How long to wait on the service before giving up. It only has to accept, not send. */
const TIMEOUT_MS = 5_000

async function post(path: string, body: unknown): Promise<Response | null> {
  const notify = env.notify
  if (!notify) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(`${notify.url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(notify.apiKey ? { authorization: `Bearer ${notify.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Hands one message to the notification service. **Never throws**, whatever happens.
 *
 * Returns whether the service accepted it. Request-path callers ignore that and fire
 * this without awaiting — their work already succeeded and mail must not be able to
 * fail it. The operator scripts, whose entire purpose *is* the send, check it and
 * stop rather than logging fifty silent failures.
 *
 * With no service configured it logs what would have been sent, link included — the
 * same local-development affordance the in-process mailer used to provide, so
 * verification and reset stay testable without running a second process. That counts
 * as *not* accepted, because nothing was actually delivered anywhere.
 */
export async function notify(to: string, lang: Lang, payload: Payload): Promise<boolean> {
  if (!env.notify) {
    logger.info('notify.unsent_no_service', { to, type: payload.type, ...payload.data })
    return false
  }

  try {
    const res = await post('/notifications', { to, lang, ...payload })
    if (!res) return false
    if (!res.ok) {
      logger.error('notify.rejected', { type: payload.type, status: res.status })
      return false
    }
    logger.info('notify.accepted', { type: payload.type })
    return true
  } catch (err) {
    logger.error('notify.unreachable', { type: payload.type, ...describeFetchError(err) })
    return false
  }
}

/**
 * Unwraps a fetch failure into something a log reader can act on.
 *
 * `String(err)` on a failed fetch gives "TypeError: fetch failed" and nothing else —
 * the actual reason lives on `err.cause`. That distinction is the whole diagnosis:
 * `ENOTFOUND` is a hostname that doesn't resolve, `ECONNREFUSED` is nothing listening
 * on that port, and an abort is the service being too slow to answer. All three look
 * identical without this.
 */
function describeFetchError(err: unknown): Record<string, unknown> {
  if (err instanceof Error && err.name === 'AbortError') {
    return { err: 'timeout', timeoutMs: TIMEOUT_MS }
  }
  const cause = err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined) : undefined
  return {
    err: err instanceof Error ? err.message : String(err),
    ...(cause?.code ? { code: cause.code } : {}),
    ...(cause?.syscall ? { syscall: cause.syscall } : {}),
    ...(cause?.message && cause.message !== cause.code ? { detail: cause.message } : {}),
  }
}

/**
 * Renders a message without sending it — used by `send:invites --dry-run`.
 *
 * Like `notify`, this **never throws**: an unreachable service is the ordinary case
 * here (nobody remembers to start momoto-notify before a dry run), and letting the
 * raw failure escape reaches the operator as a bare "fetch failed" with the actual
 * reason buried on `err.cause`. Returning null instead lets the caller print its own
 * instructions, and the log line below names the reason.
 */
export async function previewNotification(
  to: string,
  lang: Lang,
  payload: Payload,
): Promise<{ subject: string; text: string; html: string } | null> {
  try {
    const res = await post('/notifications/preview', { to, lang, ...payload })
    if (!res) return null
    if (!res.ok) {
      logger.error('notify.preview_rejected', { type: payload.type, status: res.status })
      return null
    }
    return (await res.json()) as { subject: string; text: string; html: string }
  } catch (err) {
    logger.error('notify.preview_unreachable', { type: payload.type, ...describeFetchError(err) })
    return null
  }
}

// ── The messages this app sends ──────────────────────────────────────────────

export function sendVerifyEmail(to: string, token: string, lang: Lang): Promise<boolean> {
  return notify(to, lang, {
    type: 'verify_email',
    data: {
      url: `${env.appBaseUrl}/verify-email?token=${encodeURIComponent(token)}`,
      expiresInHours: env.emailVerifyTtlHours,
    },
  })
}

export function sendPasswordReset(to: string, token: string, lang: Lang): Promise<boolean> {
  return notify(to, lang, {
    type: 'password_reset',
    data: {
      url: `${env.appBaseUrl}/reset-password?token=${encodeURIComponent(token)}`,
      expiresInMinutes: env.passwordResetTtlMinutes,
    },
  })
}

export function sendPasswordChanged(to: string, lang: Lang): Promise<boolean> {
  return notify(to, lang, {
    type: 'password_changed',
    data: { resetUrl: `${env.appBaseUrl}/forgot-password` },
  })
}

/**
 * Nudges someone who has an account but has never made a strip. Sent in waves by
 * `npm run send:reminders`, never from a request path.
 *
 * Carries no token and no password — deliberately. This is the one message that goes
 * to an address nobody has proven, so a copy forwarded to the wrong person has to be
 * worth nothing more than the link anyone can already type.
 */
export function sendBoothReminder(to: string, displayName: string, lang: Lang): Promise<boolean> {
  return notify(to, lang, boothReminderPayload(displayName))
}

/** The same message, rendered but not sent — `send:reminders --dry-run`. */
export function previewBoothReminder(
  to: string,
  displayName: string,
  lang: Lang,
): Promise<{ subject: string; text: string; html: string } | null> {
  return previewNotification(to, lang, boothReminderPayload(displayName))
}

/**
 * Shared so the dry run renders the same thing the real send mails — and so the
 * script never has to know that the booth lives at `/photobooth`.
 */
function boothReminderPayload(displayName: string): Payload {
  return { type: 'booth_reminder', data: { displayName, url: `${env.appBaseUrl}/photobooth` } }
}
