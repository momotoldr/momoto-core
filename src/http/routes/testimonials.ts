import { Router } from 'express'

import { prisma } from '../../db/client.js'
import { placeFor } from '../../lib/locations.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import {
  MAX_PUBLISHED_TESTIMONIALS,
  coupleStatus,
  testimonialsRevision,
} from '../../lib/testimonials.js'
import { publicUrl } from '../../storage/objectStore.js'
import { asyncRoute } from '../asyncRoute.js'

export const testimonialsRouter = Router()

/**
 * The landing page's "What people say" cards: exactly the testimonials an admin has
 * published, in the admin's order, and nothing else.
 *
 * There is one query and it only ever reads published rows, capped at
 * `MAX_PUBLISHED_TESTIMONIALS`. The route takes no parameters — no paging, no limit, no
 * draft preview — so there's no way to ask it for anything more. Admins preview through
 * `/admin/testimonials`.
 *
 * What a card carries is deliberately thin: the two quotes, a feature tag, the author's
 * stars, and for each person a display name, a place and an uploaded picture's CDN URL.
 * No user ids, no email, no region codes, and never a Google-hosted picture — every
 * landing visitor would otherwise send their IP address to Google.
 */

/** People as a card needs them — nothing that identifies the account. */
const publicPersonSelect = {
  displayName: true,
  avatarKey: true,
  countryCode: true,
  regionCode: true,
  cityName: true,
} as const

type PersonRow = {
  displayName: string
  avatarKey: string | null
  countryCode: string | null
  regionCode: string | null
  cityName: string | null
}

function publicPerson(p: PersonRow) {
  return {
    name: p.displayName,
    place: placeFor(p),
    avatarUrl: p.avatarKey ? publicUrl('avatar', p.avatarKey) : null,
  }
}

type PublicTestimonial = {
  id: string
  quoteEn: string
  quoteId: string
  feature: string
  rating: number
  people: ReturnType<typeof publicPerson>[]
}

async function loadPublished(): Promise<PublicTestimonial[]> {
  const rows = await prisma.testimonial.findMany({
    where: { publishedAt: { not: null } },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    take: MAX_PUBLISHED_TESTIMONIALS,
    select: {
      id: true,
      quoteEn: true,
      quoteId: true,
      feature: true,
      rating: true,
      showPartner: true,
      partnerUserId: true,
      user: { select: { ...publicPersonSelect, partnerId: true } },
      partner: { select: publicPersonSelect },
    },
  })

  return rows.map((row) => {
    const people = [publicPerson(row.user)]
    // The partner appears only while the author is still linked to the partner they had
    // when they wrote it, and no admin has hidden them. Anything else: the author alone.
    const status = coupleStatus({
      partnerUserId: row.partnerUserId,
      showPartner: row.showPartner,
      authorPartnerId: row.user.partnerId,
    })
    if (status === 'shown' && row.partner) people.push(publicPerson(row.partner))
    return {
      id: row.id,
      quoteEn: row.quoteEn,
      quoteId: row.quoteId,
      feature: row.feature,
      rating: row.rating,
      people,
    }
  })
}

/**
 * How long a snapshot stands when nothing has changed. Admin changes and partner unlinks
 * don't wait for it — they bump `testimonialsRevision`, and a snapshot from an older
 * revision is never served. What this TTL bounds is the one thing that doesn't bump it: a
 * profile edit (a new name, picture or city) showing on a card.
 */
const CACHE_TTL_MS = 10 * 60_000

let cached: { at: number; revision: number; items: PublicTestimonial[] } | null = null

/** One query per revision however many visitors arrive while it runs. */
let inflight: { revision: number; promise: Promise<PublicTestimonial[]> } | null = null

function currentItems(): Promise<PublicTestimonial[]> {
  const revision = testimonialsRevision()
  if (cached && cached.revision === revision && Date.now() - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.items)
  }
  if (inflight?.revision === revision) return inflight.promise

  const promise = loadPublished()
    .then((items) => {
      // A change that landed while this query ran leaves the snapshot on the old revision,
      // so the next request loads again instead of serving it.
      cached = { at: Date.now(), revision, items }
      return items
    })
    .finally(() => {
      if (inflight?.promise === promise) inflight = null
    })
  inflight = { revision, promise }
  return promise
}

/** A per-IP ceiling; the snapshot already absorbs the database cost. */
const testimonialsLimiter = new RateLimiter(60, 60_000)

/** Reclaim expired testimonials rate windows (wired into the periodic sweep). */
export function sweepTestimonialsLimits(now: number = Date.now()): number {
  return testimonialsLimiter.sweep(now)
}

// ── GET /testimonials ─── published cards for the landing page ────────────────────
testimonialsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    if (!testimonialsLimiter.allow(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    // Revalidate every time: a browser or CDN copy could keep showing a card an admin has
    // since unpublished. The server-side snapshot is what keeps this cheap.
    res.set('Cache-Control', 'no-cache')

    try {
      res.json({ items: await currentItems() })
    } catch (err) {
      // Only a snapshot from the current revision may stand in: it still matches what's
      // published (at worst a profile edit behind). Unlike the stats counters, an older one
      // is never served — it might include a card since unpublished — so the landing page
      // drops the section on a 503 instead.
      logger.error('testimonials.query.failed', { err: String(err) })
      if (cached && cached.revision === testimonialsRevision()) {
        res.json({ items: cached.items })
        return
      }
      res.status(503).json({ error: 'testimonials_unavailable' })
    }
  }),
)
