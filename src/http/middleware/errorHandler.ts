import { Prisma } from '@prisma/client'
import type { ErrorRequestHandler, RequestHandler } from 'express'

import { logger } from '../../lib/logger.js'

/** Unmatched route — answer with the same JSON error shape as everything else. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(404).json({ error: 'not_found' })
}

/**
 * Terminal error handler. Every route rejection routed through `asyncRoute` lands
 * here, so a transient DB fault becomes a 500 instead of killing the process.
 *
 * Responses carry a stable machine code only — never a driver message or stack, which
 * can name tables, columns, and connection details. The detail goes to the logs.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // The response already started streaming; only Express's default handler can
  // sensibly finish it (it destroys the socket).
  if (res.headersSent) {
    next(err)
    return
  }

  // Malformed JSON from `express.json()` — a client error, not ours.
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: 'invalid_json' })
    return
  }

  // A body over the parser's limit (e.g. an oversized avatar). raw-body throws this
  // with its own status; report it as the 413 it is rather than a 500.
  if (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: string }).type === 'entity.too.large'
  ) {
    res.status(413).json({ error: 'payload_too_large' })
    return
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    logger.warn('http.prisma_error', { path: req.path, code: err.code })
    // P2002 unique violation, P2025 record-not-found: both are races against a
    // concurrent request rather than server faults.
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'conflict' })
      return
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: 'not_found' })
      return
    }
  }

  logger.error('http.unhandled_error', {
    path: req.path,
    method: req.method,
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
  res.status(500).json({ error: 'internal_error' })
}
