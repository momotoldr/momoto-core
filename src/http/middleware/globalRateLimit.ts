import { isIP } from 'node:net'

import type { RequestHandler } from 'express'

import { env } from '../../config/env.js'
import { rateLimitKey } from '../../lib/clientIp.js'
import { ipPrefix } from '../../lib/ipPrefix.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'

const limiter = new RateLimiter(env.apiRateLimitPerMinute, 60_000)
/** One log line per address per minute, however long it keeps hammering. */
const logLimiter = new RateLimiter(1, 60_000)

/** Reclaim expired windows (wired into the periodic sweep). */
export function sweepGlobalRateLimit(now: number = Date.now()): number {
  return limiter.sweep(now) + logLimiter.sweep(now)
}

/**
 * A per-address ceiling across the whole API, behind the per-route limits: the backstop
 * for the many routes that have no limit of their own. High on purpose, because a mobile
 * carrier can put a lot of real people behind one address.
 *
 * Only applies when the CDN's visitor-address header is present. Without it the fallback
 * address is often shared infrastructure, and one bucket for everybody would turn this
 * into an outage.
 */
export const globalRateLimit: RequestHandler = (req, res, next) => {
  const ip = env.clientIpHeader ? req.get(env.clientIpHeader)?.split(',')[0]?.trim() : undefined
  if (!ip || isIP(ip) === 0) {
    next()
    return
  }
  const key = rateLimitKey(ip)
  if (limiter.allow(key)) {
    next()
    return
  }
  if (logLimiter.allow(key)) logger.warn('http.global_ratelimited', { ipPrefix: ipPrefix(ip) })
  res.setHeader('Retry-After', '60')
  res.status(429).json({ error: 'too_many_requests' })
}
