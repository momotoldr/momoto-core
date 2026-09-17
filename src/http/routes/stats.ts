import { Router } from 'express'

import { prisma } from '../../db/client.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { asyncRoute } from '../asyncRoute.js'

export const statsRouter = Router()

/**
 * The public counters on the landing page: how many people have accounts, how many
 * shared sessions have ever been held, and how many strips have been made.
 *
 * Deliberately separate from `GET /admin/stats`, which is the operator dashboard —
 * that one is auth-gated, reports revenue and feedback, and runs a dozen queries per
 * call. This is three numbers with nothing behind them worth protecting, so it stays
 * open: the landing page is the first thing a signed-out visitor sees.
 */

/**
 * How long the three counts stand before they're asked again.
 *
 * A day, because the frontend rounds them down for display ("2000+") and a day of
 * growth almost never crosses a rounding step — so a fresher number would cost
 * queries to render the same pixels. Both tables grow forever and neither is indexed
 * for counting, which is exactly the shape of query that gets slower as the product
 * succeeds; pinning it to once a day means that cost never scales with traffic.
 */
const CACHE_TTL_MS = 24 * 60 * 60_000

/** The totals, all from Postgres. */
interface Totals {
  /** Registered accounts. */
  users: number
  /**
   * Shared sessions ever held — distinct date and group room codes that produced at least
   * one saved strip. Solo booths never share a code, so they aren't in here: this is
   * people taking strips *together*.
   *
   * A lower bound, and knowingly so. A session nobody saved from, or one whose strips
   * stayed in a guest's browser and were never synced to an account, left no row to
   * count. The frontend shows it as "at least this many", which that is.
   *
   * The same definition as `dateSessions + groupSessions` on `GET /admin/stats` — the
   * filter and the (mode, code) pairing are copied from there on purpose, so the landing
   * page and the operator dashboard can never disagree about the number.
   */
  sessions: number
  /** Strips created, ever — locked and unlocked alike. */
  strips: number
}

let cached: { at: number; value: Totals } | null = null

/**
 * The recompute in flight, if any. Without it, the first burst of arrivals after the
 * day's snapshot expires would each start their own set of queries — the one moment in
 * the day when this endpoint could actually hurt. Sharing the promise makes the daily
 * refresh exactly one set however many callers land on it.
 */
let inflight: Promise<Totals> | null = null

/**
 * Counted in the database rather than with `groupBy(...).length` (which is how the admin
 * route gets the same figure): that would ship every distinct room code back to this
 * process just to measure the array. This endpoint is public, so it gets the version
 * whose cost doesn't grow with the answer.
 */
async function countSharedSessions(): Promise<number> {
  const rows = await prisma.$queryRaw<{ value: number }[]>`
    SELECT count(DISTINCT ("sessionMode", "sessionId"))::int AS value
    FROM "Strip"
    WHERE "sessionMode" IN ('date', 'group') AND "sessionId" IS NOT NULL`
  return rows[0]?.value ?? 0
}

function loadTotals(): Promise<Totals> {
  inflight ??= Promise.all([prisma.user.count(), countSharedSessions(), prisma.strip.count()])
    .then(([users, sessions, strips]) => {
      const value: Totals = { users, sessions, strips }
      cached = { at: Date.now(), value }
      return value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/**
 * A cheap per-IP ceiling. The snapshot already absorbs the database cost, so this is
 * only here to stop one client turning the endpoint into a busy-loop against the
 * process.
 */
const statsLimiter = new RateLimiter(60, 60_000)

/** Reclaim expired stats rate windows (wired into the periodic sweep). */
export function sweepStatsLimits(now: number = Date.now()): number {
  return statsLimiter.sweep(now)
}

// ── GET /stats ─── public counters for the landing page ─────────────────────────
statsRouter.get(
  '/',
  asyncRoute(async (req, res) => {
    if (!statsLimiter.allow(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      res.json(cached.value)
      return
    }

    try {
      res.json(await loadTotals())
    } catch (err) {
      // A dead database shouldn't blank the landing page. If we ever had a snapshot,
      // serve the stale one; if we never did, say so with a 503 and let the frontend
      // drop the section rather than render three zeros as if they were true.
      logger.error('stats.query.failed', { err: String(err) })
      if (cached) {
        res.json(cached.value)
        return
      }
      res.status(503).json({ error: 'stats_unavailable' })
    }
  }),
)
