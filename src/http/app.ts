import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'

import { env } from '../config/env.js'
import { prisma } from '../db/client.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { globalRateLimit } from './middleware/globalRateLimit.js'
import { responseEnvelope } from './middleware/responseEnvelope.js'
import { adminRouter } from './routes/admin.js'
import { adminMfaRouter } from './routes/adminMfa.js'
import { authRouter } from './routes/auth.js'
import { avatarsRouter } from './routes/avatars.js'
import { feedbackRouter } from './routes/feedback.js'
import { locationsRouter } from './routes/locations.js'
import { partnerRouter } from './routes/partner.js'
import { paymentsRouter } from './routes/payments.js'
import { promosRouter } from './routes/promos.js'
import { scrapbooksRouter } from './routes/scrapbooks.js'
import { statsRouter } from './routes/stats.js'
import { testimonialsRouter } from './routes/testimonials.js'
import { stripsRouter } from './routes/strips.js'

/** `/readyz` is public, so one database round trip serves everyone for this long. */
const READINESS_CACHE_MS = 5_000
/** Under Prisma's own wait for a pooled connection, so a stuck pool reads as not ready. */
const READINESS_TIMEOUT_MS = 3_000
let readiness: { at: number; check: Promise<boolean> } | null = null

function databaseReachable(now: number = Date.now()): Promise<boolean> {
  if (readiness && now - readiness.at < READINESS_CACHE_MS) return readiness.check
  let timer: NodeJS.Timeout
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), READINESS_TIMEOUT_MS)
  })
  const query = prisma.$queryRaw`SELECT 1`.then(
    () => true,
    () => false,
  )
  const check = Promise.race([query, timeout]).finally(() => clearTimeout(timer))
  readiness = { at: now, check }
  return check
}

/**
 * Builds the Express app for everything that persists: accounts (`/auth`, `/partner`),
 * strips and payments, avatars, feedback, testimonials, the public counters, and the
 * operator surface (`/admin`).
 *
 * **Nothing live is here.** Room minting, the Socket.io signaling/sync server and TURN
 * credentials belong to `momoto-realtime`, and the PeerJS broker to `momoto-peer`. This
 * app holds no in-memory session state, so redeploying it never touches a booth in
 * progress — keep it that way rather than mounting a socket or a room route here.
 */
export function createApp(): Express {
  const app = express()

  // `req.ip` from the proxy chain. Behind Cloudflare + Railway it never resolves to the
  // visitor (X-Forwarded-For carries only infrastructure addresses there), so every
  // per-IP rate limit keys on `clientIp()` instead, which prefers `CLIENT_IP_HEADER`
  // (`cf-connecting-ip`); this setting only matters for that fallback.
  app.set('trust proxy', env.trustProxy)

  // First, so every JSON body below — routes, 404s, `errorHandler` — goes out as
  // `{ statusCode, result }`.
  app.use(responseEnvelope)

  // Baseline response headers (nosniff, HSTS, referrer policy, frame denial). This is
  // a JSON API that renders nothing, so the CSP and the cross-origin resource policy
  // that helmet enables by default would only get in the way of the browser fetching
  // us cross-origin from the frontend; the frontend ships its own CSP in `_headers`.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  )

  // `credentials: true` so the browser sends/stores the refresh-token cookie on
  // cross-origin auth calls (origin must be an explicit allowlist, never `*`).
  app.use(cors({ origin: env.corsOrigins, credentials: true }))

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() })
  })

  // For uptime monitors: can this instance reach Postgres? `/healthz` deliberately can't
  // tell, because the frontend's server-down probe reads it and a database blip must not
  // take the whole app to the "we're down" page.
  app.get('/readyz', (_req, res) => {
    void databaseReachable().then((ok) => {
      res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'database_unreachable' })
    })
  })

  // After CORS so a browser can read the 429, before parsing so a flood isn't parsed, and
  // after the health routes so a monitor is never throttled.
  app.use(globalRateLimit)
  app.use(express.json({ limit: '64kb' }))
  app.use(cookieParser())

  // Before `/admin`, whose guard would refuse the very requests that earn a session.
  app.use('/admin/mfa', adminMfaRouter)
  app.use('/admin', adminRouter)
  app.use('/auth', authRouter)
  app.use('/avatars', avatarsRouter)
  app.use('/feedback', feedbackRouter)
  app.use('/locations', locationsRouter)
  app.use('/partner', partnerRouter)
  app.use('/stats', statsRouter)
  app.use('/testimonials', testimonialsRouter)
  app.use('/strips', stripsRouter)
  app.use('/scrapbooks', scrapbooksRouter)
  app.use('/payments', paymentsRouter)
  app.use('/promos', promosRouter)

  // Must stay last: `notFoundHandler` catches unmatched paths, and `errorHandler` is
  // the sink every `asyncRoute` rejection is funnelled into.
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
