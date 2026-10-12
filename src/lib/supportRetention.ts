import { prisma } from '../db/client.js'
import { logger } from './logger.js'

/** Resolved support tickets are kept this long (findable by number, reopenable), then deleted. */
export const SUPPORT_RESOLVED_RETENTION_DAYS = 3

/** The sweeper ticks every 30 s; this only needs to run hourly. */
const RUN_EVERY_MS = 60 * 60_000
let lastRun = 0

/**
 * Delete tickets resolved more than `SUPPORT_RESOLVED_RETENTION_DAYS` ago. Open tickets
 * are never touched, however old. The delete walks the (resolvedAt, createdAt, id) index.
 *
 * The transaction sets `momoto.support_retention`, which the `support_daily_stat` trigger
 * reads to leave the all-time `support` counter alone: a purge is housekeeping, and the
 * Overview keeps counting every request ever raised. A manual delete (spam) still counts
 * the ticket out. Wired into the periodic sweep in `index.ts`; safe on every instance.
 */
export async function sweepResolvedSupportTickets(now: Date = new Date()): Promise<number> {
  if (now.getTime() - lastRun < RUN_EVERY_MS) return 0
  lastRun = now.getTime()
  const cutoff = new Date(now.getTime() - SUPPORT_RESOLVED_RETENTION_DAYS * 24 * 60 * 60_000)
  const [, { count }] = await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL momoto.support_retention = 'on'`),
    prisma.supportTicket.deleteMany({ where: { resolvedAt: { lt: cutoff } } }),
  ])
  if (count > 0) logger.info('support.retention.purged', { count, cutoff: cutoff.toISOString() })
  return count
}
