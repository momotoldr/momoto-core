import { createHash } from 'node:crypto'

import { Router } from 'express'

import { COUNTRY_CODES, provinces, regionsInProvince } from '../../lib/locations.js'
import { RateLimiter } from '../../lib/rateLimiter.js'

export const locationsRouter = Router()

/**
 * The lists behind the profile's location field: provinces first, then one province's
 * cities and regencies on demand, plus the country codes offered under "Outside Indonesia".
 *
 * Public on purpose — there is nothing personal in them — and built once at startup,
 * since the lists only change with a deploy (`npm run import:regions`). `version` hashes
 * every list, so a client can tell a changed set from the one it cached.
 */
const regionBodies = new Map(
  provinces.map((province) => [
    province.code,
    JSON.stringify({
      regions: (regionsInProvince(province.code) ?? []).map(({ code, name, shortName }) => ({
        code,
        name,
        shortName,
      })),
    }),
  ]),
)

const version = createHash('sha256')
  .update(JSON.stringify({ provinces, regions: [...regionBodies.values()], COUNTRY_CODES }))
  .digest('hex')
  .slice(0, 12)

const indexBody = JSON.stringify({ version, provinces, countries: COUNTRY_CODES })

/**
 * Browsers must check back every time. These bodies are constant between deploys, but a
 * `max-age` pins whatever a browser saw last across a deploy that changes them — an early
 * `max-age=1d` on the old all-regions `/locations` kept serving that shape to the new
 * province-first field. With `no-cache` the browser revalidates, and Express's ETag turns
 * an unchanged list into a bodiless 304.
 */
function send(res: import('express').Response, body: string): void {
  res.set('Cache-Control', 'no-cache')
  res.type('application/json').send(body)
}

/** Only stops a busy-loop: every response is a small constant. */
const locationsLimiter = new RateLimiter(60, 60_000)

/** Reclaim expired locations rate windows (wired into the periodic sweep). */
export function sweepLocationsLimits(now: number = Date.now()): number {
  return locationsLimiter.sweep(now)
}

// ── GET /locations/provinces ─── provinces + countries ────────────────────────────
// Deliberately not `GET /locations`: that path once served a different shape with a
// day-long cache, and a new path is the only thing that reaches browsers still holding it.
locationsRouter.get('/provinces', (req, res) => {
  if (!locationsLimiter.allow(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'too_many_requests' })
    return
  }
  send(res, indexBody)
})

// ── GET /locations/provinces/:code/regions ─── one province's cities and regencies ──
locationsRouter.get('/provinces/:code/regions', (req, res) => {
  if (!locationsLimiter.allow(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'too_many_requests' })
    return
  }
  const body = regionBodies.get(req.params.code)
  if (!body) {
    res.status(404).json({ error: 'not_found' })
    return
  }
  send(res, body)
})
