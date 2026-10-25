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
      type: 'payment_receipt'
      data: {
        orderId: string
        grossAmount: number
        paidAt: string
        method: 'gopay' | 'shopeepay' | 'qris' | null
        stripCount: number
        scrapbookTitles: string[]
      }
    }

/** How long to wait on the service before giving up. It only has to accept, not send. */
const TIMEOUT_MS = 5_000

/**
 * One retry, after this long, when the request provably never reached the service.
 *
 * That is the shape of a notify redeploy: the old instance stops listening a moment
 * before traffic moves to the new one, so a connection lands on nothing. Two seconds
 * is well past that switch, and costs no user anything — request-path callers don't
 * await the send.
 */
const RETRY_DELAY_MS = 2_000

/**
 * Failures where nothing was delivered, so a second attempt can't send the mail twice.
 *
 * Deliberately not here: a **timeout** (the service may have queued it and only the
 * reply was lost — retrying would mail it twice), `ECONNRESET` (same ambiguity), and
 * any HTTP status — a 400 or 401 won't fix itself, and a 503 `queue_full` means hours
 * behind, not seconds.
 */
const NEVER_ARRIVED = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'])

function neverArrived(err: unknown): boolean {
  const cause = err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined) : undefined
  return cause?.code !== undefined && NEVER_ARRIVED.has(cause.code)
}

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

  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await post('/notifications', { to, lang, ...payload })
      if (!res) return false
      if (!res.ok) {
        logger.error('notify.rejected', { type: payload.type, status: res.status })
        return false
      }
      logger.info('notify.accepted', { type: payload.type, attempt })
      return true
    } catch (err) {
      if (attempt === 1 && neverArrived(err)) {
        logger.warn('notify.retrying', { type: payload.type, ...describeFetchError(err) })
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        continue
      }
      logger.error('notify.unreachable', {
        type: payload.type,
        attempt,
        ...describeFetchError(err),
      })
      return false
    }
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

/** The receipt for a settled payment. */
export function sendPaymentReceipt(
  to: string,
  lang: Lang,
  order: {
    orderId: string
    grossAmount: number
    paidAt: Date
    method: 'gopay' | 'shopeepay' | 'qris' | null
    stripCount: number
    scrapbookTitles: string[]
  },
): Promise<boolean> {
  return notify(to, lang, {
    type: 'payment_receipt',
    data: { ...order, paidAt: order.paidAt.toISOString() },
  })
}
