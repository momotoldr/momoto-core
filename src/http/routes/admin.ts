import { Prisma } from '@prisma/client'
import { Router } from 'express'

import { hashPassword } from '../../auth/passwords.js'
import { prisma } from '../../db/client.js'
import { isValidEmail } from '../../lib/email.js'
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
  if (!adminLimiter.allow(req.ip ?? 'unknown')) {
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
  _count: { select: { strips: true, payments: true, feedbacks: true } },
} as const

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
 * `lib/testimonials.ts`; keep the two in step.
 */
const eligibleFeedbackWhere = {
  category: 'feedback',
  userId: { not: null },
  message: { not: '' },
  rating: { gte: MIN_TESTIMONIAL_RATING },
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

/** Offset pagination shared by every list endpoint. `limit` is capped at 100. */
function parsePagination(query: Record<string, unknown>): {
  page: number
  limit: number
  skip: number
  take: number
} {
  const page = Math.max(1, toInt(query.page, 1))
  const limit = Math.min(100, Math.max(1, toInt(query.limit, 25)))
  return { page, limit, skip: (page - 1) * limit, take: limit }
}

/** A day/value point in a stats trend series. */
interface TrendPoint {
  day: string
  value: number
}

function toTrend(rows: { day: Date; value: number }[]): TrendPoint[] {
  return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), value: r.value }))
}

// ── GET /admin/me ─── confirm admin access + return the operator's profile ──────
adminRouter.get(
  '/me',
  asyncRoute(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: req.userId },
      select: userRowSelect,
    })
    res.json({ user: serializeAdminUser(user) })
  }),
)

// ── GET /admin/stats ─── overview KPIs + trends ─────────────────────────────────
adminRouter.get(
  '/stats',
  asyncRoute(async (_req, res) => {
    const now = Date.now()
    const since7 = new Date(now - 7 * 24 * 60 * 60_000)
    const since30 = new Date(now - 30 * 24 * 60 * 60_000)
    const paid = { status: 'paid' as const }

    const [
      users,
      usersLast7,
      usersLast30,
      strips,
      stripsLast7,
      stripsLast30,
      feedback,
      revenueAll,
      revenueLast7,
      revenueLast30,
      modeGroups,
      roomSessionGroups,
      feedbackByCategory,
      ratingGroups,
      ratingAvg,
      recentSupport,
      signupTrendRaw,
      stripTrendRaw,
      revenueTrendRaw,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: since7 } } }),
      prisma.user.count({ where: { createdAt: { gte: since30 } } }),
      prisma.strip.count(),
      prisma.strip.count({ where: { createdAt: { gte: since7 } } }),
      prisma.strip.count({ where: { createdAt: { gte: since30 } } }),
      prisma.feedback.count(),
      prisma.payment.aggregate({ where: paid, _sum: { grossAmount: true }, _count: true }),
      prisma.payment.aggregate({
        where: { ...paid, paidAt: { gte: since7 } },
        _sum: { grossAmount: true },
      }),
      prisma.payment.aggregate({
        where: { ...paid, paidAt: { gte: since30 } },
        _sum: { grossAmount: true },
      }),
      prisma.strip.groupBy({ by: ['sessionMode'], _count: { _all: true } }),
      prisma.strip.groupBy({
        by: ['sessionMode', 'sessionId'],
        where: { sessionMode: { in: ['date', 'group'] }, sessionId: { not: null } },
      }),
      prisma.feedback.groupBy({ by: ['category'], _count: { _all: true } }),
      prisma.feedback.groupBy({
        by: ['rating'],
        where: { rating: { not: null } },
        _count: { _all: true },
      }),
      prisma.feedback.aggregate({ where: { rating: { not: null } }, _avg: { rating: true } }),
      prisma.feedback.findMany({
        where: { category: 'support' },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: feedbackRowSelect,
      }),
      prisma.$queryRaw<{ day: Date; value: number }[]>`
        SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS value
        FROM "User" WHERE "createdAt" >= ${since30} GROUP BY day ORDER BY day`,
      prisma.$queryRaw<{ day: Date; value: number }[]>`
        SELECT date_trunc('day', "createdAt") AS day, count(*)::int AS value
        FROM "Strip" WHERE "createdAt" >= ${since30} GROUP BY day ORDER BY day`,
      prisma.$queryRaw<{ day: Date; value: number }[]>`
        SELECT date_trunc('day', "paidAt") AS day, coalesce(sum("grossAmount"), 0)::int AS value
        FROM "Payment" WHERE "status" = 'paid' AND "paidAt" >= ${since30}
        GROUP BY day ORDER BY day`,
    ])

    // `unknown` is for strips saved before the mode was recorded. A mode the app *does*
    // have must get its own bucket, or it silently reads as missing data — which is what
    // group strips did when they first shipped.
    const modeSplit = { solo: 0, date: 0, group: 0, unknown: 0 }
    for (const g of modeGroups) {
      if (g.sessionMode === 'solo') modeSplit.solo += g._count._all
      else if (g.sessionMode === 'date') modeSplit.date += g._count._all
      else if (g.sessionMode === 'group') modeSplit.group += g._count._all
      else modeSplit.unknown += g._count._all
    }
    // Distinct room codes, split by the kind of room. Solo strips carry no shared
    // session id, so they are never counted here.
    const dateSessions = roomSessionGroups.filter((g) => g.sessionMode === 'date').length
    const groupSessions = roomSessionGroups.filter((g) => g.sessionMode === 'group').length

    // Feedback split by category ("feedback" | "support"), free-form so fall back to 0.
    const byCategory = { feedback: 0, support: 0 }
    for (const g of feedbackByCategory) {
      if (g.category === 'feedback') byCategory.feedback += g._count._all
      else if (g.category === 'support') byCategory.support += g._count._all
    }

    // Rating distribution 1..5 (ratings are optional; only present ones counted).
    const ratingCounts: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
    for (const g of ratingGroups) {
      const r = g.rating
      if (r !== null && r >= 1 && r <= 5) ratingCounts[r as 1 | 2 | 3 | 4 | 5] += g._count._all
    }

    res.json({
      users: { total: users, last7: usersLast7, last30: usersLast30 },
      strips: { total: strips, last7: stripsLast7, last30: stripsLast30 },
      feedback: {
        total: feedback,
        byCategory,
        ratingCounts,
        averageRating: ratingAvg._avg.rating,
        recentSupport: recentSupport.map(serializeAdminFeedback),
      },
      revenue: {
        // Whole rupiah (see STRIP_PRINT_PRICE_IDR) — no minor unit.
        total: revenueAll._sum.grossAmount ?? 0,
        last7: revenueLast7._sum.grossAmount ?? 0,
        last30: revenueLast30._sum.grossAmount ?? 0,
        paidOrders: revenueAll._count,
      },
      sessions: {
        // Distinct date-room codes with at least one saved strip. Solo strips have no
        // distinct id, so they're not grouped — the exact solo/date split is `modeSplit`.
        dateSessions,
        groupSessions,
        stripsByMode: modeSplit,
      },
      trends: {
        signups: toTrend(signupTrendRaw),
        strips: toTrend(stripTrendRaw),
        revenue: toTrend(revenueTrendRaw),
      },
    })
  }),
)

// ── GET /admin/sessions ─── photo sessions derived from strips ──────────────────
adminRouter.get(
  '/sessions',
  asyncRoute(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const { page, limit, skip, take } = parsePagination(query)
    const mode = typeof query.mode === 'string' ? query.mode : ''
    const modeWhere = SESSION_MODES.has(mode) ? { sessionMode: mode } : {}
    const where = { sessionId: { not: null }, ...modeWhere }

    const [groups, allGroups] = await Promise.all([
      prisma.strip.groupBy({
        by: ['sessionId'],
        where,
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
        orderBy: { _max: { createdAt: 'desc' } },
        skip,
        take,
      }),
      // Total distinct sessions matching the filter (small dataset — length is fine).
      prisma.strip.groupBy({ by: ['sessionId'], where }),
    ])

    // Enrich the page's sessions with mode + contributing users (a date room's two
    // members each save strips under the same room-code sessionId).
    const ids = groups.map((g) => g.sessionId).filter((v): v is string => v !== null)
    const strips = ids.length
      ? await prisma.strip.findMany({
          where: { sessionId: { in: ids } },
          select: { sessionId: true, sessionMode: true, user: { select: userSummarySelect } },
        })
      : []

    const meta = new Map<
      string,
      { mode: string | null; users: Map<string, ReturnType<typeof serializeUserSummary>> }
    >()
    for (const s of strips) {
      if (!s.sessionId) continue
      const entry = meta.get(s.sessionId) ?? { mode: s.sessionMode, users: new Map() }
      entry.users.set(s.user.id, serializeUserSummary(s.user))
      meta.set(s.sessionId, entry)
    }

    const items = groups.map((g) => {
      const info = g.sessionId ? meta.get(g.sessionId) : undefined
      return {
        sessionId: g.sessionId,
        sessionMode: info?.mode ?? null,
        stripCount: g._count._all,
        firstAt: g._min.createdAt?.toISOString() ?? null,
        lastAt: g._max.createdAt?.toISOString() ?? null,
        users: info ? [...info.users.values()] : [],
      }
    })

    res.json({ items, total: allGroups.length, page, limit })
  }),
)

// ── GET /admin/users ─── searchable, paginated users table ──────────────────────
adminRouter.get(
  '/users',
  asyncRoute(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const { page, limit, skip, take } = parsePagination(query)
    const q = typeof query.q === 'string' ? query.q.trim() : ''
    const where = q
      ? {
          OR: [
            { username: { contains: q, mode: 'insensitive' as const } },
            { displayName: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : {}

    const [items, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: userRowSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.user.count({ where }),
    ])

    res.json({ items: items.map(serializeAdminUser), total, page, limit })
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
    res.status(201).json({ user: serializeAdminUser(user) })
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

    const [strips, payments, feedback] = await Promise.all([
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
          _count: { select: { strips: true } },
        },
      }),
      prisma.feedback.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: feedbackRowSelect,
      }),
    ])

    res.json({
      user: serializeAdminUser(user),
      partner: user.partner ? serializeUserSummary(user.partner) : null,
      recent: {
        strips: strips.map(serializeAdminStrip),
        payments: payments.map(serializeAdminPayment),
        feedback: feedback.map(serializeAdminFeedback),
      },
    })
  }),
)

// ── DELETE /admin/users/:id ─── remove an account ───────────────────────────────
// Guardrails: an admin can't delete themselves, and a user with settled/pending
// payment records is protected (deleting cascades those rows away — we keep the
// financial history). Everything else (strips, avatar, tokens) cascades; feedback
// is detached (userId → null) so support history survives. Testimonials the account
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
    res.json({ user: serializeAdminUser(user) })
  }),
)

// ── GET /admin/payments ─── transactions table + revenue for the filter ─────────
adminRouter.get(
  '/payments',
  asyncRoute(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const { page, limit, skip, take } = parsePagination(query)
    const status = typeof query.status === 'string' && query.status ? query.status : undefined

    const createdAt: { gte?: Date; lte?: Date } = {}
    if (typeof query.from === 'string' && !Number.isNaN(Date.parse(query.from))) {
      createdAt.gte = new Date(query.from)
    }
    if (typeof query.to === 'string' && !Number.isNaN(Date.parse(query.to))) {
      createdAt.lte = new Date(query.to)
    }
    const where = {
      ...(status ? { status } : {}),
      ...(createdAt.gte || createdAt.lte ? { createdAt } : {}),
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
      _count: { select: { strips: true } },
    } as const

    const [items, total, revenue] = await Promise.all([
      prisma.payment.findMany({
        where,
        select: paymentSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.payment.count({ where }),
      // Settled revenue within the current filter.
      prisma.payment.aggregate({
        where: { ...where, status: 'paid' },
        _sum: { grossAmount: true },
      }),
    ])

    res.json({
      items: items.map(serializeAdminPayment),
      total,
      page,
      limit,
      revenue: revenue._sum.grossAmount ?? 0,
    })
  }),
)

// ── GET /admin/feedback ─── feedback / support inbox ────────────────────────────
adminRouter.get(
  '/feedback',
  asyncRoute(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const { page, limit, skip, take } = parsePagination(query)
    const category =
      typeof query.category === 'string' && query.category ? query.category : undefined
    const ratingInt = toInt(query.rating, 0)
    const rating = ratingInt >= 1 && ratingInt <= 5 ? ratingInt : undefined
    // Ticket search: accept "5", "SUP-0005", "sup 5" — match on the digits only.
    const ticketDigits = typeof query.ticket === 'string' ? query.ticket.replace(/\D/g, '') : ''
    const ticketNumber = ticketDigits ? Number(ticketDigits) : undefined
    // status: "open" (never resolved) | "resolved" | undefined (all).
    const statusWhere =
      query.status === 'open'
        ? { resolvedAt: null }
        : query.status === 'resolved'
          ? { resolvedAt: { not: null } }
          : {}
    // eligible=1: only rows an admin can turn into a testimonial.
    const eligible = query.eligible === '1' || query.eligible === 'true'
    const where = {
      ...(category ? { category } : {}),
      ...(rating ? { rating } : {}),
      ...(ticketNumber ? { ticketNumber } : {}),
      ...statusWhere,
      ...(eligible ? eligibleFeedbackWhere : {}),
    }

    const [items, total] = await Promise.all([
      prisma.feedback.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: feedbackRowSelect,
      }),
      prisma.feedback.count({ where }),
    ])

    res.json({ items: items.map(serializeAdminFeedback), total, page, limit })
  }),
)

/** The columns `serializeAdminFeedback` needs — shared by every route that returns feedback. */
const feedbackRowSelect = {
  id: true,
  ticketNumber: true,
  category: true,
  rating: true,
  message: true,
  email: true,
  context: true,
  userAgent: true,
  createdAt: true,
  resolvedAt: true,
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
// For a rating someone sent by DM or message. It becomes an ordinary `feedback` row on
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
        category: 'feedback',
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

// ── PATCH /admin/feedback/:id ─── mark a message resolved / reopen it ────────────
adminRouter.patch(
  '/feedback/:id',
  asyncRoute(async (req, res) => {
    const resolved = (req.body as { resolved?: unknown } | undefined)?.resolved
    if (typeof resolved !== 'boolean') {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    const existing = await prisma.feedback.findUnique({
      where: { id: req.params.id },
      select: { id: true },
    })
    if (!existing) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    const item = await prisma.feedback.update({
      where: { id: req.params.id },
      data: { resolvedAt: resolved ? new Date() : null },
      select: feedbackRowSelect,
    })
    logger.info('admin.feedback.resolved', { by: req.userId, feedbackId: item.id, resolved })
    res.json({ item: serializeAdminFeedback(item) })
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
  position: true,
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

// ── GET /admin/testimonials ─── every testimonial, drafts included, in display order ──
adminRouter.get(
  '/testimonials',
  asyncRoute(async (_req, res) => {
    const items = await prisma.testimonial.findMany({
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: testimonialRowSelect,
    })
    res.json({
      items: items.map(serializeAdminTestimonial),
      published: items.filter((t) => t.publishedAt !== null).length,
      maxPublished: MAX_PUBLISHED_TESTIMONIALS,
      minShown: MIN_TESTIMONIALS_SHOWN,
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

    // New drafts go to the end; the admin orders them from there.
    const last = await prisma.testimonial.aggregate({ _max: { position: true } })

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
          position: (last._max.position ?? -1) + 1,
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

// ── PUT /admin/testimonials/order ─── set the display order in one go ───────────────
// Takes every testimonial id in the new order. Positions are rewritten 0..n-1 in one
// transaction, so "move up" can't leave two rows sharing a position halfway through. A
// list that doesn't match the current set (someone else added or deleted one) is refused;
// the console reloads and tries again.
adminRouter.put(
  '/testimonials/order',
  asyncRoute(async (req, res) => {
    const ids = (req.body as { ids?: unknown } | undefined)?.ids
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    const existing = await prisma.testimonial.findMany({ select: { id: true } })
    const known = new Set(existing.map((t) => t.id))
    if (
      new Set(ids).size !== ids.length ||
      ids.length !== known.size ||
      !ids.every((id) => known.has(id))
    ) {
      res.status(409).json({ error: 'order_out_of_date' })
      return
    }

    await prisma.$transaction(
      (ids as string[]).map((id, position) =>
        prisma.testimonial.update({ where: { id }, data: { position } }),
      ),
    )
    logger.info('admin.testimonial.reordered', { by: req.userId, count: ids.length })
    markTestimonialsChanged()
    res.status(204).end()
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
  asyncRoute(async (req, res) => {
    const query = req.query as Record<string, unknown>
    const { page, limit, skip, take } = parsePagination(query)
    const paid = query.paid === 'true' ? true : query.paid === 'false' ? false : undefined
    const mode =
      typeof query.sessionMode === 'string' && query.sessionMode ? query.sessionMode : undefined
    const where = {
      ...(paid !== undefined ? { paid } : {}),
      ...(mode ? { sessionMode: mode } : {}),
    }

    const [items, total] = await Promise.all([
      prisma.strip.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
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
          createdAt: true,
          user: { select: userSummarySelect },
        },
      }),
      prisma.strip.count({ where }),
    ])

    res.json({ items: items.map(serializeAdminStrip), total, page, limit })
  }),
)
