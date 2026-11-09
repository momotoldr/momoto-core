import type { Request, RequestHandler } from 'express'

import { env } from '../config/env.js'
import { prisma } from '../db/client.js'
import { clientIp } from './clientIp.js'
import { ipPrefix } from './ipPrefix.js'
import { logger } from './logger.js'

/** The sweeper ticks every 30 s; retention only needs to run hourly. */
const SWEEP_EVERY_MS = 60 * 60_000
const RETENTION_MS = 365 * 24 * 60 * 60_000
const MAX_PATH_LENGTH = 200
let lastSweep = 0

/**
 * Record one request against the operator surface.
 *
 * The path only, never the query string: an admin search term is usually someone's name
 * or address. Not awaited by the request and never able to fail it, because an audit row
 * that can't be written mustn't take the console down. A failure is logged instead.
 */
export function recordAdminRequest(req: Request, actorId: string, status: number): void {
  void prisma.adminAuditLog
    .create({
      data: {
        actorId,
        method: req.method,
        path: req.originalUrl.split('?')[0]?.slice(0, MAX_PATH_LENGTH) ?? '',
        status,
        ipPrefix: ipPrefix(clientIp(req, env.clientIpHeader)),
      },
    })
    .catch((err: unknown) => logger.error('admin.audit.write_failed', { err: String(err) }))
}

/** Audits every request that passed the admin gate, reads included. */
export const auditAdminRequest: RequestHandler = (req, res, next) => {
  // `close` rather than `finish`, so a request the client abandoned is still recorded.
  res.once('close', () => recordAdminRequest(req, req.userId as string, res.statusCode))
  next()
}

/** Drops rows past retention. Wired into the periodic sweep, gated to hourly. */
export async function sweepAdminAudit(now: Date = new Date()): Promise<number> {
  if (now.getTime() - lastSweep < SWEEP_EVERY_MS) return 0
  lastSweep = now.getTime()
  const { count } = await prisma.adminAuditLog.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } },
  })
  return count
}
