import { Prisma } from '@prisma/client'
import { type Response, Router } from 'express'

import { hashPassword } from '../../auth/passwords.js'
import { env } from '../../config/env.js'
import { prisma } from '../../db/client.js'
import { clientIp } from '../../lib/clientIp.js'
import { isValidEmail } from '../../lib/email.js'
import {
  metricDays,
  metricSumBetween,
  metricSums,
  metricTotals,
  utcDaysAgo,
} from '../../lib/dailyStats.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import {
  MAX_PUBLISHED_TESTIMONIALS,
  MAX_TESTIMONIAL_QUOTE,
  MIN_TESTIMONIAL_RATING,
  MIN_TESTIMONIALS_SHOWN,
  isTestimonialFeature,
  markTestimonialsChanged,
} from '../../lib/testimonials.js'
import { deleteImages } from '../../storage/objectStore.js'
import { asyncRoute } from '../asyncRoute.js'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { requireAuth } from '../middleware/requireAuth.js'
import {
  serializeAdminFeedback,
  serializeAdminPayment,
  serializeAdminStrip,
  serializeAdminSupportTicket,
  serializeAdminTestimonial,
  serializeAdminUser,
  serializeUserSummary,
} from './adminSerialize.js'
import { deleteStripObjects } from './strips.js'

/** Session modes the app records — the single list every mode filter reads. */
const SESSION_MODES = new Set(['solo', 'date', 'group'])

export const adminRouter = Router()

/**
 * The admin surface is read-only and gated to a handful of operator accounts, so the
 * budget is generous — this is a backstop against a runaway dashboard, not abuse.
 */
const adminLimiter = new RateLimiter(300, 60_000)

/** Reclaim expired admin rate windows (wired into the periodic sweep in `index.ts`). */
export function sweepAdminLimits(now: number = Date.now()): number {
  return adminLimiter.sweep(now)
}

// Every admin route: authenticated → is-admin → rate-limited.
adminRouter.use(requireAuth, requireAdmin, (req, res, next) => {
  if (!adminLimiter.allow(clientIp(req, env.clientIpHeader) ?? 'unknown')) {
    res.status(429).json({ error: 'too_many_requests' })
    return
  }
  next()
})

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Columns for a user row in the admin table (never returns secrets — see serializer). */
const userRowSelect = {
  id: true,
  username: true,
  email: true,
  displayName: true,
  avatarUrl: true,
  avatarUpdatedAt: true,
  avatarKey: true,
  passwordHash: true,
  googleId: true,
  role: true,
  partnerId: true,
  countryCode: true,
  regionCode: true,
  cityName: true,
  createdAt: true,
  updatedAt: true,
} as const

// ── Related-row counts ────────────────────────────────────────────────────────
//
// Not Prisma's `_count` select: it compiles to a LEFT JOIN against a GROUP BY over
// the *whole* related table, however few rows the outer query keeps — a full scan
// of Strip/Payment/Feedback (or the payment↔strip join table) on every request.
// These count only the rows on hand, through their indexed foreign keys.

/** Attach each user's strip/payment/feedback counts, as `serializeAdminUser` reads them. */
async function withUserCounts<T extends { id: string }>(
  users: T[],
): Promise<
  (T & {
    _count: { strips: number; payments: number; feedbacks: number; supportTickets: number }
  })[]
> {
  const ids = users.map((u) => u.id)
  const where = { userId: { in: ids } }
  const [strips, payments, feedbacks, tickets] = ids.length
    ? await Promise.all([
        prisma.strip.groupBy({ by: ['userId'], where, _count: { _all: true } }),
        prisma.payment.groupBy({ by: ['userId'], where, _count: { _all: true } }),
        prisma.feedback.groupBy({ by: ['userId'], where, _count: { _all: true } }),
        prisma.supportTicket.groupBy({ by: ['userId'], where, _count: { _all: true } }),
      ])
    : [[], [], [], []]
  const tally = (groups: { userId: string | null; _count: { _all: number } }[]) =>
    new Map(groups.map((g) => [g.userId, g._count._all]))
  const [s, p, f, t] = [tally(strips), tally(payments), tally(feedbacks), tally(tickets)]
  return users.map((u) => ({
    ...u,
    _count: {
      strips: s.get(u.id) ?? 0,
      payments: p.get(u.id) ?? 0,
      feedbacks: f.get(u.id) ?? 0,
      supportTickets: t.get(u.id) ?? 0,
    },
  }))
}

/** `withUserCounts` for one user. */
async function withUserCount<T extends { id: string }>(user: T) {
  const [counted] = await withUserCounts([user])
  return counted!
}

/** Attach each payment's strip count, as `serializeAdminPayment` reads it. */
async function withStripCounts<T extends { id: string }>(
  payments: T[],
): Promise<(T & { _count: { strips: number } })[]> {
  const ids = payments.map((p) => p.id)
  // Implicit many-to-many: "A" is the Payment id, led by the (A, B) primary key.
  const rows = ids.length
    ? await prisma.$queryRaw<{ paymentId: string; n: number }[]>`
        SELECT "A" AS "paymentId", count(*)::int AS n
        FROM "_PaymentToStrip" WHERE "A" = ANY(${ids}) GROUP BY "A"`
    : []
  const counts = new Map(rows.map((r) => [r.paymentId, r.n]))
  return payments.map((p) => ({ ...p, _count: { strips: counts.get(p.id) ?? 0 } }))
}

/** The embedded "who" reference on a payment/feedback/strip/session row. */
const userSummarySelect = { id: true, username: true, displayName: true } as const

/** A person as a testimonial card shows them: summary, uploaded avatar, place. */
const testimonialPersonSelect = {
  ...userSummarySelect,
  avatarKey: true,
  avatarUpdatedAt: true,
  countryCode: true,
  regionCode: true,
  cityName: true,
} as const

/**
 * Feedback that can be featured — the database form of `isEligibleFeedback` in
 * `lib/testimonials.ts`. `testimonialCandidate` is its row-level half (author, comment,
 * MIN_TESTIMONIAL_RATING+), kept by a trigger and indexed, so this reads candidates only.
 */
const eligibleFeedbackWhere = {
  testimonialCandidate: true,
  testimonial: { is: null },
} satisfies Prisma.FeedbackWhereInput

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : NaN
  return Number.isInteger(n) ? n : fallback
}

// Account-creation rules — mirror the public register route (auth.ts) so an
// admin-minted account is indistinguishable from a self-registered one.
const USERNAME_RE = /^[a-z0-9]{3,20}$/
const MIN_PASSWORD = 8
const MAX_DISPLAY_NAME = 60

/** Shortest admin user search — one trigram, the least the pg_trgm indexes can use. */
const MIN_USER_SEARCH = 3

// ── List pagination: keyset ("load more") + time range ──────────────────────────
//
// Every list is newest-first on (createdAt, id) and pages by keyset, not OFFSET:
// the client hands back the opaque `nextCursor` from the last batch and the query
// seeks straight to it on the (createdAt, id) index. No OFFSET scan, and no COUNT —
// lists answer "is there more?" by fetching one extra row.

/** Where the previous batch ended: its last row's sort key. */
interface ListCursor {
  at: Date
  id: string
}

class InvalidListQuery extends Error {}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url')
}

function decodeCursor(raw: string): ListCursor {
  const [iso, id] = Buffer.from(raw, 'base64url').toString().split('|')
  const at = new Date(iso ?? '')
  if (!id || Number.isNaN(at.getTime())) throw new InvalidListQuery('invalid_cursor')
  return { at, id }
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) throw new InvalidListQuery('invalid_range')
  return d
}

const DAY_MS = 24 * 60 * 60 * 1000
/** A list with no `from` covers the day before `to` (or now). */
const DEFAULT_RANGE_MS = DAY_MS
/**
 * The widest window a list may cover — keeps every list query bounded. The portal's
 * custom-range picker clamps to the same (momoto-portal `MAX_RANGE_DAYS`): change both.
 */
const MAX_RANGE_MS = 30 * DAY_MS
/** Leeway on the cap for client clock skew and a custom range's end-of-day bound. */
const RANGE_SLACK_MS = DAY_MS

/**
 * `limit` (default 50, capped at 100), `cursor`, and the `from`/`to` time range (ISO instants,
 * both inclusive) shared by every list endpoint. The range is always bounded:
 * `from` defaults to a day before `to`, `to` to now, and a window wider than
 * `MAX_RANGE_MS` is refused. `unbounded` drops the range entirely — for a direct
 * lookup (a search) that must reach old rows. Throws `InvalidListQuery` on a
 * malformed cursor or range — see `listRoute`.
 */
function parseListQuery(
  query: Record<string, unknown>,
  { unbounded = false }: { unbounded?: boolean } = {},
): {
  limit: number
  cursor: ListCursor | null
  range: { gte: Date; lte?: Date } | undefined
} {
  // 50 rows per page by default — one page of the portal's Prev / Next tables.
  const limit = Math.min(100, Math.max(1, toInt(query.limit, 50)))
  const cursor =
    typeof query.cursor === 'string' && query.cursor ? decodeCursor(query.cursor) : null
  if (unbounded) return { limit, cursor, range: undefined }

  const lte = parseDate(query.to)
  const end = lte ?? new Date()
  const gte = parseDate(query.from) ?? new Date(end.getTime() - DEFAULT_RANGE_MS)
  if (gte > end) throw new InvalidListQuery('invalid_range')
  if (end.getTime() - gte.getTime() > MAX_RANGE_MS + RANGE_SLACK_MS) {
    throw new InvalidListQuery('range_too_wide')
  }
  return { limit, cursor, range: lte ? { gte, lte } : { gte } }
}

/** Rows strictly after `cursor` in (createdAt desc, id desc) order. */
function afterCursor(cursor: ListCursor | null) {
  return cursor
    ? {
        // The plain `lte` bound is what lets the index *start* at the cursor. The OR
        // alone is correct but can't seed an index range, so Postgres would walk from
        // the newest row and skip every earlier page — page N costing N pages.
        createdAt: { lte: cursor.at },
        OR: [{ createdAt: { lt: cursor.at } }, { createdAt: cursor.at, id: { lt: cursor.id } }],
      }
    : {}
}

/** The keyset sort every list uses; `afterCursor` must match it. */
const newestFirst = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]

/**
 * Trim a `limit + 1` fetch to `limit` rows and derive the cursor for the next batch
 * (null when the extra row didn't come back, i.e. this is the last batch).
 */
function keysetPage<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
): { rows: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { rows, nextCursor: null }
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]!
  return { rows: page, nextCursor: encodeCursor(last.createdAt, last.id) }
}

/** Run a list handler, answering 400 for a bad cursor or date instead of a 500. */
function listRoute(handler: (query: Record<string, unknown>, res: Response) => Promise<void>) {
  return asyncRoute(async (req, res) => {
    try {
      await handler(req.query as Record<string, unknown>, res)
    } catch (err) {
      if (err instanceof InvalidListQuery) {
        res.status(400).json({ error: err.message })
        return
      }
      throw err
    }
  })
}

// ── GET /admin/me ─── confirm admin access + return the operator's profile ──────
adminRouter.get(
  '/me',
  asyncRoute(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId },
      select: userRowSelect,
    })
    res.json({ user: serializeAdminUser(await withUserCount(user)) })
  }),
)

/** Every counter the overview reads — fetched by key, see `metricSums`. */
const OVERVIEW_METRICS = [
  'users',
  'strips',
  'strips:solo',
  'strips:date',
  'strips:group',
  'feedback',
  'rating:1',
  'rating:2',
  'rating:3',
  'rating:4',
  'rating:5',
  'support',
  'support:open',
  'revenue',
  'paid_orders',
  'sessions:date',
  'sessions:group',
] as const

// ── GET /admin/stats ─── overview KPIs + trends ─────────────────────────────────
//
// Every figure but the recent-support list comes off the `DailyStat` counters (kept by
// database triggers), so the overview never counts a whole table. Windows are UTC
// calendar days: "last 7" is today plus the 6 days before.
adminRouter.get(
  '/stats',
  asyncRoute(async (_req, res) => {
    const now = new Date()
    const trendSince = utcDaysAgo(29, now)

    const [sums, recentSupport, signupTrend, stripTrend, revenueTrend] = await Promise.all([
      metricSums(OVERVIEW_METRICS, now),
      prisma.supportTicket.findMany({
        orderBy: newestFirst,
        take: 5,
        select: supportRowSelect,
      }),
      metricDays('users', trendSince),
      metricDays('strips', trendSince),
      metricDays('revenue', trendSince),
    ])
    const total = (metric: string) => sums(metric).total

    // `unknown` is for strips saved before the mode was recorded. A mode the app *does*
    // have must get its own bucket, or it silently reads as missing data — which is what
    // group strips did when they first shipped.
    const modeSplit = {
      solo: total('strips:solo'),
      date: total('strips:date'),
      group: total('strips:group'),
      unknown: 0,
    }
    modeSplit.unknown = total('strips') - modeSplit.solo - modeSplit.date - modeSplit.group

    // Rating distribution 1..5 (ratings are optional; only present ones counted).
    const ratingCounts = {
      1: total('rating:1'),
      2: total('rating:2'),
      3: total('rating:3'),
      4: total('rating:4'),
      5: total('rating:5'),
    }
    const rated = Object.values(ratingCounts).reduce((a, b) => a + b, 0)
    const ratingSum = Object.entries(ratingCounts).reduce((a, [r, n]) => a + Number(r) * n, 0)

    res.json({
      users: sums('users'),
      strips: sums('strips'),
      feedback: {
        total: total('feedback'),
        ratingCounts,
        averageRating: rated ? ratingSum / rated : null,
      },
      support: {
        total: total('support'),
        open: total('support:open'),
        recent: recentSupport.map(serializeAdminSupportTicket),
      },
      revenue: {
        // Whole rupiah (see STRIP_PRINT_PRICE_IDR) — no minor unit.
        ...sums('revenue'),
        paidOrders: total('paid_orders'),
      },
      sessions: {
        // Date and group rooms with at least one saved strip. Solo isn't counted — the
        // exact strip split by mode is `stripsByMode`.
        dateSessions: total('sessions:date'),
        groupSessions: total('sessions:group'),
        stripsByMode: modeSplit,
      },
      trends: { signups: signupTrend, strips: stripTrend, revenue: revenueTrend },
    })
  }),
)

// ── GET /admin/sessions ─── photo sessions (room codes with saved strips) ───────
//
// Read from the `Session` summary table, newest-first by last strip; the keyset is
// that (lastAt, id) pair. The time range picks sessions whose last strip falls in it.
adminRouter.get(
  '/sessions',
  listRoute(async (query, res) => {
    const { limit, cursor, range } = parseListQuery(query)
    const mode = typeof query.mode === 'string' ? query.mode : ''

    const rows = await prisma.session.findMany({
      where: {
        AND: [
          SESSION_MODES.has(mode) ? { mode } : {},
          range ? { lastAt: range } : {},
          cursor
            ? {
                // `lte` lets the index start at the cursor — see `afterCursor`.
                lastAt: { lte: cursor.at },
                OR: [{ lastAt: { lt: cursor.at } }, { lastAt: cursor.at, id: { lt: cursor.id } }],
              }
            : {},
        ],
      },
      orderBy: [{ lastAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    })
    const sessions = rows.slice(0, limit)
    const last = sessions[sessions.length - 1]
    const nextCursor = rows.length > limit && last ? encodeCursor(last.lastAt, last.id) : null

    // Who took part: one SessionMember row per person per session (a date room's two
    // members each save strips under the same room-code sessionId), then their names.
    const members = sessions.length
      ? await prisma.sessionMember.findMany({
          where: { sessionId: { in: sessions.map((x) => x.id) } },
          select: { sessionId: true, userId: true },
        })
      : []
    const people = members.length
      ? await prisma.user.findMany({
          where: { id: { in: [...new Set(members.map((m) => m.userId))] } },
          select: userSummarySelect,
        })
      : []
    const byId = new Map(people.map((p) => [p.id, serializeUserSummary(p)]))
    const users = new Map<string, ReturnType<typeof serializeUserSummary>[]>()
    for (const m of members) {
      const person = byId.get(m.userId)
      if (person) users.set(m.sessionId, [...(users.get(m.sessionId) ?? []), person])
    }

    const items = sessions.map((x) => ({
      sessionId: x.id,
      sessionMode: x.mode,
      stripCount: x.stripCount,
      firstAt: x.firstAt.toISOString(),
      lastAt: x.lastAt.toISOString(),
      users: users.get(x.id) ?? [],
    }))

    res.json({ items, nextCursor, limit })
  }),
)

// ── GET /admin/users ─── searchable users table (by signup time) ────────────────
adminRouter.get(
  '/users',
  listRoute(async (query, res) => {
    const q = typeof query.q === 'string' ? query.q.trim() : ''
    // The trigram indexes behind this `contains` need 3+ characters; anything shorter
    // would fall back to scanning every account, so it's refused instead.
    if (q && q.length < MIN_USER_SEARCH) {
      res.status(400).json({ error: 'search_too_short' })
      return
    }
    // A search looks up a specific account, so it reaches past the time range.
    const { limit, cursor, range } = parseListQuery(query, { unbounded: q !== '' })
    const search = q
      ? {
          OR: [
            { username: { contains: q, mode: 'insensitive' as const } },
            { displayName: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}

    const rows = await prisma.user.findMany({
      where: { AND: [search, range ? { createdAt: range } : {}, afterCursor(cursor)] },
      select: userRowSelect,
      orderBy: newestFirst,
      take: limit + 1,
    })
    const { rows: items, nextCursor } = keysetPage(rows, limit)

    res.json({ items: (await withUserCounts(items)).map(serializeAdminUser), nextCursor, limit })
  }),
)

// ── POST /admin/users ─── create an account (admin-minted) ──────────────────────
adminRouter.post(
  '/users',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const username = String(body.username ?? '')
      .trim()
      .toLowerCase()
    const password = String(body.password ?? '')
    const displayName = String(body.displayName ?? '').trim()
    const rawEmail = typeof body.email === 'string' ? body.email.trim() : ''
    const role = body.role === 'ADMIN' ? 'ADMIN' : 'USER'

    if (!USERNAME_RE.test(username) || password.length < MIN_PASSWORD || displayName.length === 0) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    // Email is optional here (unlike the FE support flow), but if present it must be
    // shaped like one and fit the column — it's a real, uniquely-indexed field.
    const email = rawEmail.length > 0 ? rawEmail : null
    if (email && !isValidEmail(email)) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    if (await prisma.user.findUnique({ where: { username } })) {
      res.status(409).json({ error: 'username_taken' })
      return
    }
    if (email && (await prisma.user.findUnique({ where: { email } }))) {
      res.status(409).json({ error: 'email_taken' })
      return
    }

    let created
    try {
      created = await prisma.user.create({
        data: {
          username,
          email,
          passwordHash: await hashPassword(password),
          displayName: displayName.slice(0, MAX_DISPLAY_NAME),
          role,
        },
      })
    } catch (err) {
      // The unique index is the real arbiter (a race past the checks above).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        res.status(409).json({ error: 'conflict' })
        return
      }
      throw err
    }

    logger.info('admin.user.created', { by: req.userId, userId: created.id, role })
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: created.id },
      select: userRowSelect,
    })
    res.status(201).json({ user: serializeAdminUser(await withUserCount(user)) })
  }),
)

// ── GET /admin/users/:id ─── one user + recent related activity ─────────────────
adminRouter.get(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: {
        ...userRowSelect,
        partner: { select: userSummarySelect },
      },
    })
    if (!user) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    const [strips, payments, feedback, support] = await Promise.all([
      prisma.strip.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          storageKey: true,
          thumbnailKey: true,
          width: true,
          height: true,
          sessionId: true,
          sessionMode: true,
          paid: true,
          paidAt: true,
          removedAt: true,
          createdAt: true,
          user: { select: userSummarySelect },
        },
      }),
      prisma.payment.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: {
          id: true,
          orderId: true,
          grossAmount: true,
          currency: true,
          status: true,
          midtransStatus: true,
          createdAt: true,
          updatedAt: true,
          paidAt: true,
          user: { select: userSummarySelect },
        },
      }),
      prisma.feedback.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: feedbackRowSelect,
      }),
      prisma.supportTicket.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: supportRowSelect,
      }),
    ])

    res.json({
      user: serializeAdminUser(await withUserCount(user)),
      partner: user.partner ? serializeUserSummary(user.partner) : null,
      recent: {
        strips: strips.map(serializeAdminStrip),
        payments: (await withStripCounts(payments)).map(serializeAdminPayment),
        feedback: feedback.map(serializeAdminFeedback),
        support: support.map(serializeAdminSupportTicket),
      },
    })
  }),
)

// ── DELETE /admin/users/:id ─── remove an account ───────────────────────────────
// Guardrails: an admin can't delete themselves, and an account with payment records
// is refused here — only its owner can delete it (`DELETE /auth/me`). Strips, avatar
// and tokens cascade; feedback, support tickets and payments are detached
// (userId → null), so that history survives the account. Testimonials the account
// authored cascade away; ones where it was the partner fall back to solo (SetNull).
adminRouter.delete(
  '/users/:id',
  asyncRoute(async (req, res) => {
    const id = req.params.id
    if (id === req.userId) {
      res.status(400).json({ error: 'cannot_delete_self' })
      return
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, avatarKey: true, _count: { select: { payments: true } } },
    })
    if (!target) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    if (target._count.payments > 0) {
      res.status(409).json({ error: 'user_has_payments' })
      return
    }

    // Strip rows cascade with the account, but the images they point at live in
    // object storage and don't — collect the keys before the rows are gone. Same for
    // the avatar, whose key came back on `target` above.
    const strips = await prisma.strip.findMany({
      where: { userId: id },
      select: {
        storageKey: true,
        thumbnailKey: true,
        printImage: { select: { storageKey: true } },
      },
    })

    await prisma.user.delete({ where: { id } })
    // Their testimonials cascaded away (or dropped them as a partner) — refresh the landing cache.
    markTestimonialsChanged()
    await deleteStripObjects(strips)
    if (target.avatarKey) await deleteImages('avatar', [target.avatarKey])
    logger.info('admin.user.deleted', { by: req.userId, userId: id })
    res.json({ ok: true })
  }),
)

// ── PATCH /admin/users/:id/role ─── promote/demote an account ───────────────────
// An admin can't change their own role — this both avoids an accidental self-lockout
// and guarantees the acting admin always remains, so the last admin can't be removed.
adminRouter.patch(
  '/users/:id/role',
  asyncRoute(async (req, res) => {
    const id = req.params.id
    const role = (req.body as { role?: unknown } | undefined)?.role
    if (role !== 'USER' && role !== 'ADMIN') {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    if (id === req.userId) {
      res.status(400).json({ error: 'cannot_change_own_role' })
      return
    }

    const existing = await prisma.user.findUnique({ where: { id }, select: { id: true } })
    if (!existing) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    await prisma.user.update({ where: { id }, data: { role } })
    logger.info('admin.user.role_changed', { by: req.userId, userId: id, role })
    const user = await prisma.user.findUniqueOrThrow({ where: { id }, select: userRowSelect })
    res.json({ user: serializeAdminUser(await withUserCount(user)) })
  }),
)

// ── Settled revenue for a Transactions filter ─────────────────────────────────
//
// Paid payments' gross amount, by *when they were paid* (creation time for a paid row
// with no `paidAt`) — the same bucketing as the `revenue` DailyStat counter, so the
// Overview and this agree. Only "paid" is settled: any other status filter is Rp 0.
//
// Whole UTC days come off the counter; only the range's partial first and last day
// are summed from Payment, each at most one day of rows on the paidAt / createdAt
// indexes. So the cost is days-in-range counter rows plus ≤ 2 days of payments,
// whatever the sales volume.

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** UTC midnight at or before `at`. */
function utcDayStart(at: Date): Date {
  return new Date(Math.floor(at.getTime() / MS_PER_DAY) * MS_PER_DAY)
}

/** Paid revenue with a payment time in [gte, lt) or [gte, lte] — a sub-day slice. */
async function liveRevenue(window: { gte: Date; lt?: Date; lte?: Date }): Promise<number> {
  const { _sum } = await prisma.payment.aggregate({
    where: {
      status: 'paid',
      OR: [{ paidAt: window }, { paidAt: null, createdAt: window }],
    },
    _sum: { grossAmount: true },
  })
  return _sum.grossAmount ?? 0
}

async function settledRevenue(
  range: { gte: Date; lte?: Date } | undefined,
  status: string | undefined,
): Promise<number> {
  if (status && status !== 'paid') return 0
  // Lists are always ranged (parseListQuery); all-time is the counter's total.
  if (!range) return (await metricTotals(['revenue']))('revenue')

  const { gte: from, lte: to } = range
  // First whole day: `from` itself when it's a UTC midnight, else the next one.
  const fromDay = utcDayStart(from)
  const wholeFrom =
    fromDay.getTime() === from.getTime() ? from : new Date(fromDay.getTime() + MS_PER_DAY)
  // End (exclusive) of the whole days: with no `to` the range runs to now, so every
  // day through today is whole — nothing later exists yet.
  const wholeTo = to ? utcDayStart(new Date(to.getTime() + 1)) : undefined

  if (wholeTo && wholeTo <= wholeFrom) return liveRevenue({ gte: from, lte: to })

  const [head, days, tail] = await Promise.all([
    from < wholeFrom ? liveRevenue({ gte: from, lt: wholeFrom }) : 0,
    metricSumBetween('revenue', wholeFrom, wholeTo),
    to && wholeTo && wholeTo <= to ? liveRevenue({ gte: wholeTo, lte: to }) : 0,
  ])
  return head + days + tail
}

// ── GET /admin/payments ─── transactions table + revenue for the filter ─────────
//
// `revenue` comes with the first batch only (no cursor) — a "load more" doesn't
// change the filter, so it doesn't re-sum it. See `settledRevenue`.
adminRouter.get(
  '/payments',
  listRoute(async (query, res) => {
    const { limit, cursor, range } = parseListQuery(query)
    const status = typeof query.status === 'string' && query.status ? query.status : undefined
    const where = {
      ...(status ? { status } : {}),
      ...(range ? { createdAt: range } : {}),
    }

    const paymentSelect = {
      id: true,
      orderId: true,
      grossAmount: true,
      currency: true,
      status: true,
      midtransStatus: true,
      createdAt: true,
      updatedAt: true,
      paidAt: true,
      user: { select: userSummarySelect },
    } as const

    const [rows, revenue] = await Promise.all([
      prisma.payment.findMany({
        where: { AND: [where, afterCursor(cursor)] },
        select: paymentSelect,
        orderBy: newestFirst,
        take: limit + 1,
      }),
      cursor ? null : settledRevenue(range, status),
    ])
    const { rows: items, nextCursor } = keysetPage(rows, limit)

    res.json({
      items: (await withStripCounts(items)).map(serializeAdminPayment),
      nextCursor,
      limit,
      ...(revenue !== null ? { revenue } : {}),
    })
  }),
)

// ── GET /admin/feedback ─── ratings & comments inbox ──────────────────────────────
adminRouter.get(
  '/feedback',
  listRoute(async (query, res) => {
    const { limit, cursor, range } = parseListQuery(query)
    const ratingInt = toInt(query.rating, 0)
    const rating = ratingInt >= 1 && ratingInt <= 5 ? ratingInt : undefined
    // eligible=1: only rows an admin can turn into a testimonial.
    const eligible = query.eligible === '1' || query.eligible === 'true'
    // An eligible row is rated MIN_TESTIMONIAL_RATING+, so a lower rating with Eligible on
    // can't match anything — answer now rather than walk every candidate in the range.
    if (eligible && rating !== undefined && rating < MIN_TESTIMONIAL_RATING) {
      res.json({ items: [], nextCursor: null, limit })
      return
    }
    // A rating filter walks the (rating, createdAt, id) index, written as a one-value
    // range with the sort led by rating so Postgres can't skip it — the same trick and
    // reason as the strips Mode filter (see /admin/strips). With Eligible on, the
    // candidates index is the narrow walk, and Postgres already picks it.
    const forceRatingIndex = rating !== undefined && !eligible
    const where = {
      ...(rating ? { rating: forceRatingIndex ? { gte: rating, lte: rating } : rating } : {}),
      ...(eligible ? eligibleFeedbackWhere : {}),
      ...(range ? { createdAt: range } : {}),
    }

    const rows = await prisma.feedback.findMany({
      where: { AND: [where, afterCursor(cursor)] },
      orderBy: [...(forceRatingIndex ? [{ rating: 'desc' as const }] : []), ...newestFirst],
      take: limit + 1,
      select: feedbackRowSelect,
    })
    const { rows: items, nextCursor } = keysetPage(rows, limit)

    res.json({ items: items.map(serializeAdminFeedback), nextCursor, limit })
  }),
)

/** The columns `serializeAdminFeedback` needs — shared by every route that returns feedback. */
const feedbackRowSelect = {
  id: true,
  rating: true,
  message: true,
  email: true,
  context: true,
  analyticsSessionId: true,
  userAgent: true,
  createdAt: true,
  lang: true,
  sessionMode: true,
  partnerUserId: true,
  user: { select: { ...testimonialPersonSelect, partnerId: true } },
  partner: { select: testimonialPersonSelect },
  testimonial: { select: { id: true } },
  sourceNote: true,
  enteredBy: { select: userSummarySelect },
} as const

// ── POST /admin/feedback ─── enter feedback received outside the app ─────────────
// For a rating someone sent by DM or message. It becomes an ordinary feedback row on
// their account — featurable like an in-app rating — but always carries who entered it
// and where it came from (`sourceNote`), so any published quote can be traced back.
// There is no way to enter feedback for someone without an account.
const MAX_SOURCE_NOTE = 200

adminRouter.post(
  '/feedback',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const userId = typeof body.userId === 'string' ? body.userId : ''
    const rating = body.rating
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    const sourceNote = typeof body.sourceNote === 'string' ? body.sourceNote.trim() : ''
    const lang = body.lang === 'en' || body.lang === 'id' ? body.lang : null
    // Optional: absent/empty means "not recorded"; anything else must be a real mode.
    const rawMode = body.sessionMode
    const sessionMode =
      rawMode === undefined || rawMode === null || rawMode === ''
        ? null
        : typeof rawMode === 'string' && SESSION_MODES.has(rawMode)
          ? rawMode
          : undefined

    if (
      !userId ||
      typeof rating !== 'number' ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5 ||
      !message ||
      message.length > MAX_TESTIMONIAL_QUOTE ||
      !lang ||
      !sourceNote ||
      sourceNote.length > MAX_SOURCE_NOTE ||
      sessionMode === undefined
    ) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, partnerId: true },
    })
    if (!user) {
      res.status(404).json({ error: 'user_not_found' })
      return
    }

    const item = await prisma.feedback.create({
      data: {
        rating,
        message,
        lang,
        sessionMode,
        userId: user.id,
        // Same as an in-app rating: the partner they're linked to right now.
        partnerUserId: user.partnerId,
        sourceNote,
        enteredById: req.userId,
      },
      select: feedbackRowSelect,
    })
    logger.info('admin.feedback.created', {
      by: req.userId,
      feedbackId: item.id,
      userId: user.id,
      rating,
    })
    res.status(201).json({ item: serializeAdminFeedback(item) })
  }),
)

// ── DELETE /admin/feedback/:id ─── remove a message (spam / handled) ─────────────
adminRouter.delete(
  '/feedback/:id',
  asyncRoute(async (req, res) => {
    // deleteMany so a missing id is a clean 404, not a P2025 throw.
    const { count } = await prisma.feedback.deleteMany({ where: { id: req.params.id } })
    if (count === 0) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    logger.info('admin.feedback.deleted', { by: req.userId, feedbackId: req.params.id })
    res.json({ ok: true })
  }),
)

// ── GET /admin/support ─── help-request inbox: every open ticket ─────────────────────
// The inbox lists all open tickets, newest first, however old — no time range: an
// unanswered ticket is work to do, and age shouldn't hide it. Resolving one takes it off
// the list. A ticket # search is the exception: it finds that ticket whatever its status
// (resolved ones last 3 days, see lib/supportRetention.ts), so it can be reopened.
adminRouter.get(
  '/support',
  listRoute(async (query, res) => {
    // Ticket search: accept "5", "SUP-0005", "sup 5" — match on the digits only.
    const ticketDigits = typeof query.ticket === 'string' ? query.ticket.replace(/\D/g, '') : ''
    const ticketNumber = ticketDigits ? Number(ticketDigits) : undefined
    const { limit, cursor } = parseListQuery(query, { unbounded: true })
    const topic = typeof query.topic === 'string' && query.topic ? query.topic : undefined
    const where = {
      ...(topic ? { topic } : {}),
      ...(ticketNumber ? { ticketNumber } : { resolvedAt: null }),
    }

    const rows = await prisma.supportTicket.findMany({
      where: { AND: [where, afterCursor(cursor)] },
      orderBy: newestFirst,
      take: limit + 1,
      select: supportRowSelect,
    })
    const { rows: items, nextCursor } = keysetPage(rows, limit)

    res.json({ items: items.map(serializeAdminSupportTicket), nextCursor, limit })
  }),
)

/** The columns `serializeAdminSupportTicket` needs. */
const supportRowSelect = {
  id: true,
  ticketNumber: true,
  topic: true,
  message: true,
  email: true,
  context: true,
  analyticsSessionId: true,
  userAgent: true,
  lang: true,
  createdAt: true,
  resolvedAt: true,
  user: { select: userSummarySelect },
} as const

// ── PATCH /admin/support/:id ─── mark a ticket resolved / reopen it ─────────────
adminRouter.patch(
  '/support/:id',
  asyncRoute(async (req, res) => {
    const resolved = (req.body as { resolved?: unknown } | undefined)?.resolved
    if (typeof resolved !== 'boolean') {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    // updateMany so a missing id is a clean 404, not a P2025 throw.
    const { count } = await prisma.supportTicket.updateMany({
      where: { id: req.params.id },
      data: { resolvedAt: resolved ? new Date() : null },
    })
    if (count === 0) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const item = await prisma.supportTicket.findUniqueOrThrow({
      where: { id: req.params.id },
      select: supportRowSelect,
    })
    logger.info('admin.support.resolved', { by: req.userId, ticketId: item.id, resolved })
    res.json({ item: serializeAdminSupportTicket(item) })
  }),
)

// ── DELETE /admin/support/:id ─── remove a ticket (spam) ────────────────────────
adminRouter.delete(
  '/support/:id',
  asyncRoute(async (req, res) => {
    const { count } = await prisma.supportTicket.deleteMany({ where: { id: req.params.id } })
    if (count === 0) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    logger.info('admin.support.deleted', { by: req.userId, ticketId: req.params.id })
    res.json({ ok: true })
  }),
)

// ── Testimonials ──────────────────────────────────────────────────────────────
// Rating comments featured on the landing page. See `PLAN-testimonials.md`. Every
// mutation calls `markTestimonialsChanged` so the public cache refreshes on the next read.

const testimonialRowSelect = {
  id: true,
  feedbackId: true,
  originalText: true,
  originalLang: true,
  quoteEn: true,
  quoteId: true,
  feature: true,
  rating: true,
  publishedAt: true,
  showPartner: true,
  partnerUserId: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { ...testimonialPersonSelect, partnerId: true } },
  partner: { select: testimonialPersonSelect },
} as const

/** A quote from a request body: trimmed and 1–`MAX_TESTIMONIAL_QUOTE` chars, else null. */
function readQuote(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const quote = value.trim()
  return quote.length > 0 && quote.length <= MAX_TESTIMONIAL_QUOTE ? quote : null
}

// ── GET /admin/testimonials ─── testimonials, drafts included, newest first ─────────
// Keyset-paged like the other lists, with no time range (it's a curated list, not a
// feed). The published count — what the cap and the "hidden below N" banner need —
// comes with the first batch only.
adminRouter.get(
  '/testimonials',
  listRoute(async (query, res) => {
    const { limit, cursor } = parseListQuery(query, { unbounded: true })
    const [rows, published] = await Promise.all([
      prisma.testimonial.findMany({
        where: afterCursor(cursor),
        orderBy: newestFirst,
        take: limit + 1,
        select: testimonialRowSelect,
      }),
      cursor ? null : prisma.testimonial.count({ where: { publishedAt: { not: null } } }),
    ])
    const { rows: items, nextCursor } = keysetPage(rows, limit)
    res.json({
      items: items.map(serializeAdminTestimonial),
      nextCursor,
      limit,
      ...(published !== null
        ? { published, maxPublished: MAX_PUBLISHED_TESTIMONIALS, minShown: MIN_TESTIMONIALS_SHOWN }
        : {}),
    })
  }),
)

// ── POST /admin/testimonials ─── feature an eligible feedback row, as a draft ────────
adminRouter.post(
  '/testimonials',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const feedbackId = typeof body.feedbackId === 'string' ? body.feedbackId : ''
    const quoteEn = readQuote(body.quoteEn)
    const quoteId = readQuote(body.quoteId)
    const feature = body.feature
    if (!feedbackId || !quoteEn || !quoteId || !isTestimonialFeature(feature)) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    // Eligibility is re-checked here, not trusted from the list the admin saw.
    const feedback = await prisma.feedback.findFirst({
      where: { id: feedbackId, ...eligibleFeedbackWhere },
      select: {
        id: true,
        userId: true,
        message: true,
        rating: true,
        lang: true,
        partnerUserId: true,
      },
    })
    if (!feedback || !feedback.userId || feedback.rating === null) {
      res.status(400).json({ error: 'not_eligible' })
      return
    }

    let item
    try {
      item = await prisma.testimonial.create({
        data: {
          userId: feedback.userId,
          partnerUserId: feedback.partnerUserId,
          feedbackId: feedback.id,
          originalText: feedback.message,
          originalLang: feedback.lang,
          quoteEn,
          quoteId,
          feature,
          rating: feedback.rating,
        },
        select: testimonialRowSelect,
      })
    } catch (error) {
      // Two admins featuring the same row at once: `feedbackId` is unique.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        res.status(409).json({ error: 'already_featured' })
        return
      }
      throw error
    }

    logger.info('admin.testimonial.created', {
      by: req.userId,
      testimonialId: item.id,
      feedbackId: feedback.id,
    })
    markTestimonialsChanged()
    res.status(201).json({ item: serializeAdminTestimonial(item) })
  }),
)

// ── PATCH /admin/testimonials/:id ─── edit wording/tag, publish, hide the partner ────
// Location, rating and who the partner is are never editable here: they're the user's.
adminRouter.patch(
  '/testimonials/:id',
  asyncRoute(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const data: Prisma.TestimonialUpdateInput = {}

    for (const field of ['quoteEn', 'quoteId'] as const) {
      if (body[field] === undefined) continue
      const quote = readQuote(body[field])
      if (!quote) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      data[field] = quote
    }
    if (body.feature !== undefined) {
      if (!isTestimonialFeature(body.feature)) {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      data.feature = body.feature
    }
    if (body.showPartner !== undefined) {
      if (typeof body.showPartner !== 'boolean') {
        res.status(400).json({ error: 'invalid_input' })
        return
      }
      data.showPartner = body.showPartner
    }
    if (body.published !== undefined && typeof body.published !== 'boolean') {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    const publish = body.published as boolean | undefined
    if (Object.keys(data).length === 0 && publish === undefined) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const existing = await prisma.testimonial.findUnique({
      where: { id: req.params.id },
      select: { publishedAt: true },
    })
    if (!existing) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    if (publish === true && existing.publishedAt === null) {
      // Two admins publishing the 10th and 11th at the same instant could both pass this;
      // the public endpoint also takes at most the cap, so the page never shows more.
      const published = await prisma.testimonial.count({ where: { publishedAt: { not: null } } })
      if (published >= MAX_PUBLISHED_TESTIMONIALS) {
        res.status(409).json({ error: 'testimonials_full' })
        return
      }
      data.publishedAt = new Date()
    } else if (publish === false) {
      data.publishedAt = null
    }

    const item = await prisma.testimonial.update({
      where: { id: req.params.id },
      data,
      select: testimonialRowSelect,
    })
    logger.info('admin.testimonial.updated', {
      by: req.userId,
      testimonialId: item.id,
      fields: [...Object.keys(data)],
    })
    markTestimonialsChanged()
    res.json({ item: serializeAdminTestimonial(item) })
  }),
)

// ── DELETE /admin/testimonials/:id ─── remove it; its feedback becomes eligible again ──
adminRouter.delete(
  '/testimonials/:id',
  asyncRoute(async (req, res) => {
    const { count } = await prisma.testimonial.deleteMany({ where: { id: req.params.id } })
    if (count === 0) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    logger.info('admin.testimonial.deleted', { by: req.userId, testimonialId: req.params.id })
    markTestimonialsChanged()
    res.status(204).end()
  }),
)

// ── GET /admin/strips ─── strips table (metadata only, never bytes) ─────────────
adminRouter.get(
  '/strips',
  listRoute(async (query, res) => {
    const { limit, cursor, range } = parseListQuery(query)
    const paid = query.paid === 'true' ? true : query.paid === 'false' ? false : undefined
    const mode =
      typeof query.sessionMode === 'string' && query.sessionMode ? query.sessionMode : undefined
    // A mode filter walks the (sessionMode, createdAt, id) index, so a page reads only
    // strips of that mode. Postgres won't pick it on its own: it guesses modes are spread
    // evenly over time, so it walks every recent strip by createdAt and drops the other
    // modes — and when one mode is rare lately, that's the whole range for one page. The
    // fix is in the query's shape: the mode is a one-value range rather than `=` (Postgres
    // drops a sort key fixed by `=`, but not one bounded by a range), and the sort leads
    // with it. Same rows and order; only that index can produce it without a sort.
    // With paid=true the paid index is the narrow walk, and Postgres already picks it.
    const forceModeIndex = mode !== undefined && paid !== true
    const where = {
      ...(paid !== undefined ? { paid } : {}),
      ...(mode ? { sessionMode: forceModeIndex ? { gte: mode, lte: mode } : mode } : {}),
      ...(range ? { createdAt: range } : {}),
    }

    const rows = await prisma.strip.findMany({
      where: { AND: [where, afterCursor(cursor)] },
      orderBy: [...(forceModeIndex ? [{ sessionMode: 'desc' as const }] : []), ...newestFirst],
      take: limit + 1,
      select: {
        id: true,
        storageKey: true,
        thumbnailKey: true,
        width: true,
        height: true,
        sessionId: true,
        sessionMode: true,
        paid: true,
        paidAt: true,
        removedAt: true,
        createdAt: true,
        user: { select: userSummarySelect },
      },
    })
    const { rows: items, nextCursor } = keysetPage(rows, limit)

    res.json({ items: items.map(serializeAdminStrip), nextCursor, limit })
  }),
)
