import type { Request } from 'express'
import { Router } from 'express'

import { verifyAccessToken } from '../../auth/tokens.js'
import { env } from '../../config/env.js'
import { prisma } from '../../db/client.js'
import { clientIp } from '../../lib/clientIp.js'
import { isValidEmail } from '../../lib/email.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { asyncRoute } from '../asyncRoute.js'

export const feedbackRouter = Router()

/**
 * Anonymous-friendly (the floating button shows on public pages too) and it writes a
 * row per call, so keep the per-IP budget tight to blunt spam. The global
 * `express.json` body parser (see `app.ts`) already has this covered for size.
 */
const feedbackLimiter = new RateLimiter(10, 10 * 60_000)

/** Reclaim expired feedback rate windows (wired into the periodic sweep). */
export function sweepFeedbackLimits(now: number = Date.now()): number {
  return feedbackLimiter.sweep(now)
}

const CATEGORIES = new Set(['feedback', 'support'])
/** What a support request is about — picked in the support dialog before writing. */
const SUPPORT_TOPICS = new Set(['session', 'strip', 'payment', 'account', 'other'])
const LANGS = new Set(['en', 'id'])
const SESSION_MODES = new Set(['solo', 'date', 'group'])
const MAX_MESSAGE = 4000
const MAX_CONTEXT = 200
const MAX_USER_AGENT = 400
/** The tracker's visit id is a UUID; anything else isn't one of its ids. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BEARER = 'Bearer '

/**
 * Attach the signed-in user if a valid access token rides along, else null. Feedback
 * isn't auth-gated, but tying a message to its author (when known) helps triage — and
 * the client's axios interceptor already sends the token when there is one.
 */
function optionalUserId(req: Request): string | null {
  const header = req.headers.authorization
  if (!header || !header.startsWith(BEARER)) return null
  try {
    return verifyAccessToken(header.slice(BEARER.length).trim()).sub
  } catch {
    return null
  }
}

/** A string from the body, kept only if it's one of `allowed`. */
function oneOf(value: unknown, allowed: Set<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null
}

// ── POST /feedback ─── store a rating/comment, or open a support ticket ───────
//
// One endpoint for both, as the app has always sent them: `category: 'support'` (the
// support button) opens a `SupportTicket`; anything else is `Feedback` (the star rating
// beside a finished strip). They're separate tables since 2026-10-10.
feedbackRouter.post(
  '/',
  asyncRoute(async (req, res) => {
    if (!feedbackLimiter.allow(clientIp(req, env.clientIpHeader) ?? 'unknown')) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>

    const category =
      typeof body.category === 'string' && CATEGORIES.has(body.category)
        ? body.category
        : 'feedback'

    // A triage hint, so an unknown value is dropped rather than rejected — an older
    // client (or a topic added to the dialog before the server) still gets through.
    const topic = oneOf(body.topic, SUPPORT_TOPICS)

    const isSupport = category === 'support'

    let rating: number | null = null
    if (
      typeof body.rating === 'number' &&
      Number.isInteger(body.rating) &&
      body.rating >= 1 &&
      body.rating <= 5
    ) {
      rating = body.rating
    }

    // A submission has to carry something: a message, or a star rating on its own. The
    // star rating beside a finished strip is one tap with no comment attached, so an
    // empty message is a valid row as long as a rating came with it.
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    // A support ticket is the message; a rating is the only thing that stands alone.
    const empty = message.length === 0 && (isSupport || rating === null)
    if (message.length > MAX_MESSAGE || empty) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const rawEmail = typeof body.email === 'string' ? body.email.trim() : ''
    const email = rawEmail && isValidEmail(rawEmail) ? rawEmail : null

    const rawContext = typeof body.context === 'string' ? body.context.trim() : ''
    const context = rawContext ? rawContext.slice(0, MAX_CONTEXT) : null

    // Context for a testimonial built from this row later: the language it was written
    // in, and which kind of session the rated strip came from. Anything unexpected is
    // dropped rather than rejected — these are hints, not part of the message.
    // The sender's analytics visit, so their event timeline can be looked up from the
    // message. A hint like the rest: a malformed one is dropped, not rejected.
    const analyticsSessionId =
      typeof body.sessionId === 'string' && UUID_RE.test(body.sessionId)
        ? body.sessionId.toLowerCase()
        : null

    const lang = oneOf(body.lang, LANGS)
    const sessionMode = oneOf(body.sessionMode, SESSION_MODES)

    const uaHeader = req.headers['user-agent']
    const userAgent = typeof uaHeader === 'string' ? uaHeader.slice(0, MAX_USER_AGENT) : null

    const userId = optionalUserId(req)

    if (isSupport) {
      const ticket = await prisma.supportTicket.create({
        data: { userId, topic, message, email, context, analyticsSessionId, userAgent, lang },
        select: { ticketNumber: true },
      })
      logger.info('support.received', {
        ticketNumber: ticket.ticketNumber,
        topic: topic ?? undefined,
        hasEmail: Boolean(email),
        userId: userId ?? undefined,
      })
      res.status(201).json({ ok: true })
      return
    }

    // Read from the link, never from the body: a couple testimonial shows this person,
    // so the client must not be able to name someone.
    const partnerUserId = userId
      ? ((await prisma.user.findUnique({ where: { id: userId }, select: { partnerId: true } }))
          ?.partnerId ?? null)
      : null

    await prisma.feedback.create({
      data: {
        userId,
        rating,
        message,
        email,
        context,
        analyticsSessionId,
        userAgent,
        lang,
        sessionMode,
        partnerUserId,
      },
    })
    logger.info('feedback.received', {
      rating: rating ?? undefined,
      hasEmail: Boolean(email),
      userId: userId ?? undefined,
      lang: lang ?? undefined,
      linked: Boolean(partnerUserId),
    })
    res.status(201).json({ ok: true })
  }),
)
