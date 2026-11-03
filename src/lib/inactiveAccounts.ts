import type { Prisma } from '@prisma/client'

import { env } from '../config/env.js'
import { prisma } from '../db/client.js'
import { sendInactiveWarning } from '../notifications/client.js'
import { normalizeLang } from '../notifications/lang.js'
import { deleteAccount } from './deleteAccount.js'
import { logger } from './logger.js'

/** The sweeper ticks every 30 s; this only needs to run hourly. */
const RUN_EVERY_MS = 60 * 60_000
let lastRun = 0

const DAY_MS = 24 * 60 * 60_000
/** The first warning goes this many days before deletion… */
const WARN_DAYS_BEFORE = 14
/** …and the final one this many. */
const FINAL_DAYS_BEFORE = 3
/** Accounts read per query. Each pass pages until it runs out or hits the per-run cap. */
const BATCH = 100

export interface InactiveSweepResult {
  warned: number
  finalWarned: number
  deleted: number
}

/**
 * Delete accounts nobody has opened in a long time (docs/PLAN-inactive-accounts.md).
 * Wired into the periodic sweep in `index.ts`, gated to once an hour.
 *
 * Activity is `User.lastActiveAt` (lib/activity.ts). Admins are never touched.
 * Everything else is eligible, including accounts with purchases, which are not refunded
 * (user, 2026-11-03). There are two schedules:
 *
 * - **Verified email:** a warning 14 days before deletion, a final one 3 days before,
 *   then deletion at `INACTIVE_DELETE_DAYS` (90). Signing in at any point clears both
 *   warnings and restarts the clock.
 * - **No verified email** (none, or never confirmed): it can't be warned, so it is
 *   deleted silently at `INACTIVE_DELETE_SILENT_DAYS` (180).
 *
 * **Notice is guaranteed, not just scheduled.** The final warning needs the first one to
 * be 11 days old, and deletion needs the final one to be 3 days old. A warning that went
 * out late (the job was off, the per-run cap was hit, notify was down) pushes the deletion
 * back instead of shortening the notice. A send that fails is un-recorded and retried
 * the next hour. With no notify service configured nothing is ever sent, so no warned
 * account is ever deleted either.
 *
 * Safe on every instance. A warning is claimed by a conditional update before it is sent,
 * so two instances never send the same one. A deletion re-checks inactivity in its own
 * `DELETE`, so someone who signs in mid-run is kept.
 *
 * With `INACTIVE_DELETE_ENABLED` off, the job only counts what it would do and logs
 * `inactive.dryrun`.
 */
export async function sweepInactiveAccounts(now: Date = new Date()): Promise<InactiveSweepResult> {
  const result: InactiveSweepResult = { warned: 0, finalWarned: 0, deleted: 0 }
  if (now.getTime() - lastRun < RUN_EVERY_MS) return result
  lastRun = now.getTime()

  const w = windows(now)
  if (!env.inactiveDeleteEnabled) {
    await logDryRun(w)
    return result
  }

  const cap = env.inactiveDeleteMaxPerRun
  result.warned = await warnPass(w.warn, now, cap, 'first')
  result.finalWarned = await warnPass(w.final, now, cap, 'final')
  result.deleted = await deletePass(w.delete, cap)
  result.deleted += await deletePass(w.silent, cap - result.deleted)
  return result
}

/**
 * Where one account stands on the schedule, for the admin console. Mirrors the passes
 * below, so it predicts what the job will do rather than restating the rules.
 *
 * - `exempt`: an admin, never deleted.
 * - `scheduled`: verified email, not warned yet. `warnOn` is when the first warning is
 *   due. `deleteOn` is the earliest possible deletion: a late warning pushes it back.
 * - `warned` / `final`: the first or final warning went out. `deleteOn` follows from it.
 * - `silent`: no verified email, so deleted without notice on `deleteOn`.
 *
 * Every date moves the moment the person signs in. `enabled` says whether the job acts
 * on any of it, or is still a dry run.
 */
export interface InactivitySchedule {
  state: 'exempt' | 'scheduled' | 'warned' | 'final' | 'silent'
  warnOn: Date | null
  deleteOn: Date | null
  enabled: boolean
}

export function inactivitySchedule(
  user: {
    role: 'USER' | 'ADMIN'
    email: string | null
    emailVerifiedAt: Date | null
    lastActiveAt: Date
    inactiveWarnedAt: Date | null
    inactiveFinalAt: Date | null
  },
  now: Date = new Date(),
): InactivitySchedule {
  const enabled = env.inactiveDeleteEnabled
  if (user.role === 'ADMIN') return { state: 'exempt', warnOn: null, deleteOn: null, enabled }
  const at = (from: Date, days: number): Date => new Date(from.getTime() + days * DAY_MS)
  const later = (a: Date, b: Date): Date => (a > b ? a : b)

  if (!user.email || !user.emailVerifiedAt) {
    return {
      state: 'silent',
      warnOn: null,
      deleteOn: at(user.lastActiveAt, env.inactiveDeleteSilentDays),
      enabled,
    }
  }
  const due = at(user.lastActiveAt, env.inactiveDeleteDays)
  if (user.inactiveFinalAt) {
    return {
      state: 'final',
      warnOn: null,
      deleteOn: later(due, at(user.inactiveFinalAt, FINAL_DAYS_BEFORE)),
      enabled,
    }
  }
  if (user.inactiveWarnedAt) {
    return {
      state: 'warned',
      warnOn: null,
      deleteOn: later(due, at(user.inactiveWarnedAt, WARN_DAYS_BEFORE)),
      enabled,
    }
  }
  const warnOn = at(user.lastActiveAt, env.inactiveDeleteDays - WARN_DAYS_BEFORE)
  return {
    state: 'scheduled',
    warnOn,
    deleteOn: later(due, at(later(warnOn, now), WARN_DAYS_BEFORE)),
    enabled,
  }
}

/** The `where` of each pass. Pure, so the schedule can be read in one place. */
function windows(now: Date): {
  warn: Prisma.UserWhereInput
  final: Prisma.UserWhereInput
  delete: Prisma.UserWhereInput
  silent: Prisma.UserWhereInput
} {
  const daysAgo = (days: number): Date => new Date(now.getTime() - days * DAY_MS)
  const days = env.inactiveDeleteDays
  const verified = { role: 'USER', email: { not: null }, emailVerifiedAt: { not: null } } as const
  return {
    warn: {
      ...verified,
      lastActiveAt: { lt: daysAgo(days - WARN_DAYS_BEFORE) },
      inactiveWarnedAt: null,
    },
    final: {
      ...verified,
      lastActiveAt: { lt: daysAgo(days - FINAL_DAYS_BEFORE) },
      inactiveWarnedAt: { lte: daysAgo(WARN_DAYS_BEFORE - FINAL_DAYS_BEFORE) },
      inactiveFinalAt: null,
    },
    delete: {
      ...verified,
      lastActiveAt: { lt: daysAgo(days) },
      inactiveWarnedAt: { not: null },
      inactiveFinalAt: { lte: daysAgo(FINAL_DAYS_BEFORE) },
    },
    silent: {
      role: 'USER',
      emailVerifiedAt: null,
      lastActiveAt: { lt: daysAgo(env.inactiveDeleteSilentDays) },
    },
  }
}

/**
 * Pages through `where` in (lastActiveAt, id) order, oldest first, so the longest-idle
 * accounts go first when the cap cuts a run short. The cursor only moves forward, so a
 * row a pass couldn't act on (a failed send) isn't retried within the same run.
 */
const CANDIDATE_SELECT = {
  id: true,
  lastActiveAt: true,
  email: true,
  emailVerifiedAt: true,
  username: true,
  lang: true,
} as const satisfies Prisma.UserSelect

type Candidate = Prisma.UserGetPayload<{ select: typeof CANDIDATE_SELECT }>

async function* candidates(where: Prisma.UserWhereInput, limit: number): AsyncGenerator<Candidate> {
  let cursor: { lastActiveAt: Date; id: string } | null = null
  let yielded = 0
  while (yielded < limit) {
    const page: Candidate[] = await prisma.user.findMany({
      where: cursor
        ? {
            AND: [
              where,
              {
                OR: [
                  { lastActiveAt: { gt: cursor.lastActiveAt } },
                  { lastActiveAt: cursor.lastActiveAt, id: { gt: cursor.id } },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ lastActiveAt: 'asc' }, { id: 'asc' }],
      take: Math.min(BATCH, limit - yielded),
      select: CANDIDATE_SELECT,
    })
    for (const row of page) {
      yield row
      yielded += 1
    }
    const last = page.at(-1)
    if (!last || page.length < BATCH) return
    cursor = { lastActiveAt: last.lastActiveAt, id: last.id }
  }
}

async function warnPass(
  where: Prisma.UserWhereInput,
  now: Date,
  cap: number,
  stage: 'first' | 'final',
): Promise<number> {
  const daysBefore = stage === 'first' ? WARN_DAYS_BEFORE : FINAL_DAYS_BEFORE
  const column = stage === 'first' ? 'inactiveWarnedAt' : 'inactiveFinalAt'
  let sent = 0
  for await (const user of candidates(where, cap)) {
    // Claim first: only the instance whose update lands sends the mail.
    const claim = await prisma.user.updateMany({
      where: { ...where, id: user.id },
      data: { [column]: now },
    })
    if (claim.count === 0) continue

    // The later of "90 days after the last visit" and "the notice this mail promises".
    const deleteOn = new Date(
      Math.max(
        user.lastActiveAt.getTime() + env.inactiveDeleteDays * DAY_MS,
        now.getTime() + daysBefore * DAY_MS,
      ),
    )
    const ok = await sendInactiveWarning(user.email as string, normalizeLang(user.lang), {
      username: user.username,
      deleteOn,
      daysLeft: Math.round((deleteOn.getTime() - now.getTime()) / DAY_MS),
    })
    if (!ok) {
      // Un-record it, unless activity already cleared it, so it is retried next hour and
      // the deletion clock never starts on a warning nobody got.
      await prisma.user.updateMany({
        where: { id: user.id, [column]: now },
        data: { [column]: null },
      })
      logger.warn('inactive.warn_failed', { userId: user.id, stage })
      continue
    }
    logger.info('inactive.warned', { userId: user.id, stage, deleteOn: deleteOn.toISOString() })
    sent += 1
  }
  return sent
}

async function deletePass(where: Prisma.UserWhereInput, cap: number): Promise<number> {
  if (cap <= 0) return 0
  let deleted = 0
  for await (const user of candidates(where, cap)) {
    try {
      if (await deleteAccount(user.id, 'inactive', where)) {
        logger.info('inactive.deleted', {
          userId: user.id,
          silent: user.emailVerifiedAt === null,
          lastActiveAt: user.lastActiveAt.toISOString(),
        })
        deleted += 1
      }
    } catch (err) {
      // One account failing must not stop the rest; it's retried next run.
      logger.error('inactive.delete_failed', { userId: user.id, err: String(err) })
    }
  }
  return deleted
}

async function logDryRun(w: ReturnType<typeof windows>): Promise<void> {
  const [warn, final, deleteWarned, deleteSilent] = await Promise.all([
    prisma.user.count({ where: w.warn }),
    prisma.user.count({ where: w.final }),
    prisma.user.count({ where: w.delete }),
    prisma.user.count({ where: w.silent }),
  ])
  logger.info('inactive.dryrun', { warn, final, deleteWarned, deleteSilent })
}
