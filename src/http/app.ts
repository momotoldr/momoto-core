import cookieParser from 'cookie-parser'
import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'

import { env } from '../config/env.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { adminRouter } from './routes/admin.js'
import { authRouter } from './routes/auth.js'
import { avatarsRouter } from './routes/avatars.js'
import { feedbackRouter } from './routes/feedback.js'
import { locationsRouter } from './routes/locations.js'
import { partnerRouter } from './routes/partner.js'
import { paymentsRouter } from './routes/payments.js'
import { statsRouter } from './routes/stats.js'
import { testimonialsRouter } from './routes/testimonials.js'
import { stripsRouter } from './routes/strips.js'

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

  // In production we sit behind a reverse proxy (Render/Cloudflare), which puts the
  // real client IP in `X-Forwarded-For`. Without this, `req.ip` is the proxy's address
  // for every request, so the per-IP rate limits (auth, strips) would throttle all
  // users as if they were one. The hop count is env-driven because it depends on the
  // deploy topology — see `TRUST_PROXY` in config/env.ts.
  app.set('trust proxy', env.trustProxy)

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
  app.use(express.json({ limit: '64kb' }))
  app.use(cookieParser())

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() })
  })

  app.use('/admin', adminRouter)
  app.use('/auth', authRouter)
  app.use('/avatars', avatarsRouter)
  app.use('/feedback', feedbackRouter)
  app.use('/locations', locationsRouter)
  app.use('/partner', partnerRouter)
  app.use('/stats', statsRouter)
  app.use('/testimonials', testimonialsRouter)
  app.use('/strips', stripsRouter)
  app.use('/payments', paymentsRouter)

  // Must stay last: `notFoundHandler` catches unmatched paths, and `errorHandler` is
  // the sink every `asyncRoute` rejection is funnelled into.
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
