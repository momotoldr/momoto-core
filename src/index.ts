// FIRST, before any other import: populates process.env from .env.local + .env. Prisma
// loads `.env` itself on import, so anything evaluated ahead of this would pin the wrong
// database. See src/config/loadEnv.ts.
import './config/loadEnv.js'

import { createServer } from 'node:http'

import { sweepEmailVerificationTokens } from './auth/emailVerification.js'
import { sweepPasswordResetTokens } from './auth/passwordReset.js'
import { sweepRefreshTokens } from './auth/tokens.js'
import { env } from './config/env.js'
import { prisma } from './db/client.js'
import { createApp } from './http/app.js'
import { sweepAdminLimits } from './http/routes/admin.js'
import { sweepAuthLimits } from './http/routes/auth.js'
import { sweepFeedbackLimits } from './http/routes/feedback.js'
import { sweepLocationsLimits } from './http/routes/locations.js'
import { sweepPartnerInvites, sweepPartnerLimits } from './http/routes/partner.js'
import { sweepPaymentLimits } from './http/routes/payments.js'
import { sweepStatsLimits } from './http/routes/stats.js'
import { sweepTestimonialsLimits } from './http/routes/testimonials.js'
import { sweepStripLimits, sweepUnlockLimits } from './http/routes/strips.js'
import { logger } from './lib/logger.js'

// Rooms, Socket.io and TURN credentials are served by momoto-realtime, not here.
const app = createApp()
const httpServer = createServer(app)

// Periodic GC: reclaim elapsed rate-limit windows so no in-memory map grows unbounded. `unref` so
// the timer never blocks shutdown.
const sweeper = setInterval(() => {
  // A throw inside a timer callback has no caller to catch it — it would surface as
  // an uncaught exception and end the process. Contain it here.
  try {
    sweepStatsLimits()
    sweepTestimonialsLimits()
    sweepStripLimits()
    sweepUnlockLimits()
    sweepPaymentLimits()
    sweepFeedbackLimits()
    sweepLocationsLimits()
    sweepAuthLimits()
    sweepPartnerLimits()
    sweepAdminLimits()
  } catch (err) {
    logger.error('sweep.failed', { err: String(err) })
  }
  // Expired/long-revoked refresh tokens + used/expired partner invites (async;
  // log but don't crash on a DB error).
  void sweepRefreshTokens().catch((err) => logger.error('auth.sweep.failed', { err: String(err) }))
  void sweepEmailVerificationTokens().catch((err) =>
    logger.error('auth.email.sweep.failed', { err: String(err) }),
  )
  void sweepPasswordResetTokens().catch((err) =>
    logger.error('auth.reset.sweep.failed', { err: String(err) }),
  )
  void sweepPartnerInvites().catch((err) =>
    logger.error('partner.sweep.failed', { err: String(err) }),
  )
}, 30_000)
sweeper.unref()

httpServer.listen(env.port, () => {
  logger.info('server.listening', {
    port: env.port,
    corsOrigins: env.corsOrigins,
    // Say out loud whether mail can leave. An unset NOTIFY_URL makes every send a
    // silent no-op that still reports success to the caller, which is the one failure
    // here that otherwise looks exactly like everything working.
    notify: env.notify ? env.notify.url : 'NOT CONFIGURED — mail is logged, not sent',
    // The base every emailed link is built from. Wrong value = links that 404 or
    // point at the admin console; it falls back to the first CORS origin.
    appBaseUrl: env.appBaseUrl,
  })
})

function shutdown(signal: string): void {
  logger.info('server.shutdown', { signal })
  httpServer.close(() => {
    void prisma.$disconnect().finally(() => process.exit(0))
  })
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ── Last-resort process guards ───────────────────────────────────────────────
// Routes are wrapped in `asyncRoute`, so rejections normally reach `errorHandler`.
// This net catches anything outside that path (a stray sweep promise, a library's
// internal async work). Node's default for an unhandled rejection is to throw — which
// would end the process over one stray error, so we log and keep serving instead.
process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', {
    err: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})

// An uncaught exception is different: the process may be in an undefined state, so
// we log and let the platform restart us rather than serve from a corrupt process.
process.on('uncaughtException', (err) => {
  logger.error('process.uncaught_exception', { err: err.message, stack: err.stack })
  shutdown('uncaughtException')
  // Don't wait forever on in-flight connections to drain.
  setTimeout(() => process.exit(1), 5_000).unref()
})
