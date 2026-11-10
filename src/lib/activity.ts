import { prisma } from '../db/client.js'
import { normalizeLang } from '../notifications/lang.js'
import { logger } from './logger.js'

/** `lastActiveAt` only needs day precision; a refresh runs hourly per open tab. */
const TOUCH_EVERY_MS = 24 * 60 * 60_000

/**
 * Record that the person opened the app signed in: login, register, Google, a password
 * change's new session, and every `/auth/refresh`. The inactive-account deletion reads
 * nothing else (docs/PLAN-inactive-accounts.md).
 *
 * At most one write per user per day, so refreshes don't add a write per hour per tab,
 * with two exceptions that always write. A pending inactivity warning is cleared straight
 * away, since signing in is how a warned person cancels the deletion. A new language
 * is stored, so the warning mail matches it.
 *
 * `rawLang` is the request's `lang`, when it sent one. Absent means "unknown", not
 * English: it leaves the stored language alone.
 */
export async function touchActivity(
  userId: string,
  rawLang?: unknown,
  now: Date = new Date(),
): Promise<void> {
  const lang = rawLang === undefined || rawLang === null ? undefined : normalizeLang(rawLang)
  await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [
        { lastActiveAt: { lt: new Date(now.getTime() - TOUCH_EVERY_MS) } },
        { inactiveWarnedAt: { not: null } },
        { inactiveFinalAt: { not: null } },
        ...(lang ? [{ lang: null }, { lang: { not: lang } }] : []),
      ],
    },
    data: {
      lastActiveAt: now,
      inactiveWarnedAt: null,
      inactiveFinalAt: null,
      ...(lang ? { lang } : {}),
    },
  })
}

/**
 * Fire-and-forget `touchActivity` for the auth routes: a failed stamp is logged and
 * never fails the sign-in or refresh it rode on.
 */
export function noteActivity(userId: string, rawLang?: unknown): void {
  void touchActivity(userId, rawLang).catch((err) =>
    logger.error('auth.activity.failed', { userId, err: String(err) }),
  )
}
