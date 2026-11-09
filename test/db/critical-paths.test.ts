// The paths where a bug costs someone money or their session: checkout, settlement,
// reconciliation, refresh rotation. Real routes against a real Postgres, because what is
// being tested is mostly how concurrent requests interleave in the database.
//
// Only Midtrans is stubbed. Run with `TEST_DATABASE_URL=… npm run test:db` against a
// migrated, disposable local database: `beforeEach` empties the tables it uses.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, it } from 'node:test'

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl || !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('TEST_DATABASE_URL must point at a local, disposable database.')
}

const SERVER_KEY = 'test-only-server-key'

// Before anything reads the config. Every value that could reach a real service is set
// here, so nothing falls through to a developer's .env.
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  JWT_SECRET: 'test-only-jwt-secret-0123456789abcdef',
  CORS_ORIGINS: 'http://localhost:5173',
  CLIENT_IP_HEADER: 'cf-connecting-ip',
  API_RATE_LIMIT_PER_MINUTE: '100',
  FREE_UNLOCK_ENABLED: 'false',
  JWT_PRIVATE_KEY: '',
  INVITE_ONLY: 'false',
  NOTIFY_URL: '',
  PAYMENTS_ENABLED: 'true',
  MIDTRANS_SERVER_KEY: SERVER_KEY,
  MIDTRANS_CLIENT_KEY: 'test-only-client-key',
  MIDTRANS_IS_PRODUCTION: 'false',
  MIDTRANS_ENABLED_PAYMENTS: 'gopay,qris',
  STRIP_PRINT_PRICE_IDR: '12999',
  PARTNER_PROMO_ENABLED: 'true',
  BUNDLE_PROMO_ENABLED: 'false',
})

const { prisma } = await import('../../src/db/client.js')
const { createApp } = await import('../../src/http/app.js')
const { reconcilePendingPayments } = await import('../../src/http/routes/payments.js')
const { issueRefreshToken, signAccessToken } = await import('../../src/auth/tokens.js')
const { signAdminSession } = await import('../../src/auth/adminSession.js')

// ── The Midtrans stub ────────────────────────────────────────────────────────

interface Stubbable {
  prototype: Record<string, unknown>
}
const load = createRequire(import.meta.url)
const { CoreApi } = load('midtrans-client') as { CoreApi: Stubbable }
const Transaction = load('midtrans-client/lib/transaction.js') as Stubbable

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Midtrans writes expiry as WIB wall-clock time with no offset. */
function wibWallClock(at: Date): string {
  return new Date(at.getTime() + 7 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')
}

let chargeDelayMs = 0
let cancelled: string[] = []
let statusOf: (orderId: string) => Record<string, unknown> = () => ({
  transaction_status: 'pending',
})

CoreApi.prototype.charge = async () => {
  await sleep(chargeDelayMs)
  return {
    transaction_status: 'pending',
    expiry_time: wibWallClock(new Date(Date.now() + 15 * 60_000)),
    actions: [{ name: 'generate-qr-code', url: 'https://example.test/qr.png' }],
  }
}
Transaction.prototype.cancel = async (orderId: string) => {
  cancelled.push(orderId)
  return {}
}
Transaction.prototype.status = async (orderId: string) => statusOf(orderId)

function unknownToMidtrans(): never {
  throw Object.assign(new Error('not found'), { httpStatusCode: 404 })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let server: Server
let base: string
let userSeq = 0

before(async () => {
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
})

beforeEach(async () => {
  chargeDelayMs = 0
  cancelled = []
  statusOf = () => ({ transaction_status: 'pending' })
  await prisma.payment.deleteMany()
  await prisma.user.deleteMany()
})

async function makeUser() {
  userSeq += 1
  return prisma.user.create({ data: { username: `t${userSeq}`, displayName: 'Test' } })
}

function makeStrip(userId: string) {
  return prisma.strip.create({
    data: {
      userId,
      mimeType: 'image/webp',
      width: 600,
      height: 1800,
      storageKey: `strips/${userId}-${Math.random()}.webp`,
      printImage: {
        create: {
          storageKey: `prints/${userId}-${Math.random()}.webp`,
          mimeType: 'image/webp',
          width: 600,
          height: 1800,
        },
      },
    },
  })
}

function makePayment(input: {
  userId: string
  stripIds: string[]
  status?: string
  expiresAt?: Date | null
  bogo?: boolean
}) {
  return prisma.payment.create({
    data: {
      orderId: `pay_${Math.random().toString(36).slice(2)}`,
      userId: input.userId,
      grossAmount: 12_999,
      paymentType: 'qris',
      status: input.status ?? 'pending',
      expiresAt:
        input.expiresAt === undefined ? new Date(Date.now() + 15 * 60_000) : input.expiresAt,
      bogo: input.bogo ?? false,
      strips: { connect: input.stripIds.map((id) => ({ id })) },
    },
  })
}

interface Reply {
  status: number
  body: Record<string, unknown>
  setCookie: string[]
  cacheControl: string | null
}

async function request(
  method: string,
  path: string,
  options: { token?: string; cookie?: string; body?: unknown; ip?: string; session?: string } = {},
): Promise<Reply> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.ip ? { 'cf-connecting-ip': options.ip } : {}),
      ...(options.session ? { 'x-admin-session': options.session } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const parsed = (await res.json()) as { result?: Record<string, unknown> }
  return {
    status: res.status,
    body: parsed.result ?? {},
    setCookie: res.headers.getSetCookie(),
    cacheControl: res.headers.get('cache-control'),
  }
}

/** Deliver a correctly signed notification, as Midtrans would. */
function notify(
  orderId: string,
  transactionStatus: string,
  grossAmount = '12999.00',
): Promise<Reply> {
  const statusCode = '200'
  return request('POST', '/payments/midtrans/notification', {
    body: {
      order_id: orderId,
      status_code: statusCode,
      gross_amount: grossAmount,
      transaction_status: transactionStatus,
      signature_key: createHash('sha512')
        .update(orderId + statusCode + grossAmount + SERVER_KEY)
        .digest('hex'),
    },
  })
}

function statusOfOrder(orderId: string): Promise<string> {
  return prisma.payment.findUniqueOrThrow({ where: { orderId } }).then((row) => row.status)
}

// ── Checkout ─────────────────────────────────────────────────────────────────

describe('POST /payments/charge', () => {
  it('records one order when two charges overlap, and cancels the loser', async () => {
    const user = await makeUser()
    const token = signAccessToken(user.id)
    await prisma.promoGrant.create({
      data: { userId: user.id, kind: 'partner_bogo', reason: 'link' },
    })
    const [a1, a2, b1, b2] = await Promise.all([
      makeStrip(user.id),
      makeStrip(user.id),
      makeStrip(user.id),
      makeStrip(user.id),
    ])
    // Long enough that both requests pass the early live-payment check first.
    chargeDelayMs = 200

    const replies = await Promise.all(
      [
        [a1.id, a2.id],
        [b1.id, b2.id],
      ].map((stripIds) =>
        request('POST', '/payments/charge', { token, body: { stripIds, method: 'qris' } }),
      ),
    )

    assert.deepEqual(replies.map((reply) => reply.status).sort(), [201, 409])
    const rows = await prisma.payment.findMany({ where: { userId: user.id } })
    assert.equal(rows.length, 1, 'only one payable order exists')
    assert.equal(rows[0]?.bogo, true)
    assert.equal(cancelled.length, 1, 'the losing Midtrans transaction is cancelled')
    assert.notEqual(cancelled[0], rows[0]?.orderId)

    // The loser is told about the winner in the shape the client resumes from.
    const loser = replies.find((reply) => reply.status === 409)
    assert.equal(loser?.body.error, 'payment_in_progress')
    assert.equal((loser?.body.payment as { orderId: string }).orderId, rows[0]?.orderId)
  })

  it('answers 502 when Midtrans fails, leaving no order behind', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    const original = CoreApi.prototype.charge
    CoreApi.prototype.charge = async () => {
      throw new Error('timeout of 8000ms exceeded')
    }
    try {
      const reply = await request('POST', '/payments/charge', {
        token: signAccessToken(user.id),
        body: { stripIds: [strip.id], method: 'qris' },
      })
      assert.equal(reply.status, 502)
      assert.equal(reply.body.error, 'midtrans_unavailable')
    } finally {
      CoreApi.prototype.charge = original
    }
    assert.equal(await prisma.payment.count({ where: { userId: user.id } }), 0)
  })
})

// ── Settlement ───────────────────────────────────────────────────────────────

describe('POST /payments/midtrans/notification', () => {
  it('refuses a bad signature and changes nothing', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    const payment = await makePayment({ userId: user.id, stripIds: [strip.id] })

    const reply = await request('POST', '/payments/midtrans/notification', {
      body: {
        order_id: payment.orderId,
        status_code: '200',
        gross_amount: '12999.00',
        transaction_status: 'settlement',
        signature_key: 'not-the-signature',
      },
    })

    assert.equal(reply.status, 403)
    assert.equal(await statusOfOrder(payment.orderId), 'pending')
    const row = await prisma.strip.findUniqueOrThrow({ where: { id: strip.id } })
    assert.equal(row.paid, false)
  })

  it('unlocks once when the same settlement arrives many times at once', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    await prisma.promoGrant.create({
      data: { userId: user.id, kind: 'partner_bogo', reason: 'link' },
    })
    const payment = await makePayment({ userId: user.id, stripIds: [strip.id], bogo: true })

    const replies = await Promise.all(
      Array.from({ length: 5 }, () => notify(payment.orderId, 'settlement')),
    )

    assert.ok(replies.every((reply) => reply.status === 200))
    const settled = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })
    assert.equal(settled.status, 'paid')
    const unlocked = await prisma.strip.findUniqueOrThrow({ where: { id: strip.id } })
    assert.equal(unlocked.paid, true)
    const grant = await prisma.promoGrant.findFirstOrThrow({ where: { userId: user.id } })
    assert.equal(grant.usedByPaymentId, payment.id)

    // A later replay doesn't move the settlement time.
    await notify(payment.orderId, 'settlement')
    const replayed = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })
    assert.deepEqual(replayed.paidAt, settled.paidAt)
  })

  for (const status of ['cancelled', 'expired', 'failed']) {
    it(`keeps a late "pending" from reviving a ${status} order`, async () => {
      const user = await makeUser()
      const strip = await makeStrip(user.id)
      const payment = await makePayment({ userId: user.id, stripIds: [strip.id], status })

      assert.equal((await notify(payment.orderId, 'pending')).status, 200)
      assert.equal(await statusOfOrder(payment.orderId), status)
    })
  }

  it('still settles an order that had expired, because the money arrived', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    const payment = await makePayment({
      userId: user.id,
      stripIds: [strip.id],
      status: 'expired',
    })

    await notify(payment.orderId, 'settlement')

    assert.equal(await statusOfOrder(payment.orderId), 'paid')
    const unlocked = await prisma.strip.findUniqueOrThrow({ where: { id: strip.id } })
    assert.equal(unlocked.paid, true)
  })

  it('refuses to settle when the amount differs from the order', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    const payment = await makePayment({ userId: user.id, stripIds: [strip.id] })

    assert.equal((await notify(payment.orderId, 'settlement', '1.00')).status, 200)

    assert.equal(await statusOfOrder(payment.orderId), 'pending')
    const row = await prisma.strip.findUniqueOrThrow({ where: { id: strip.id } })
    assert.equal(row.paid, false)
  })

  it('treats paid and refunded as final', async () => {
    const user = await makeUser()
    const paidStrip = await makeStrip(user.id)
    const refundedStrip = await makeStrip(user.id)
    const paid = await makePayment({ userId: user.id, stripIds: [paidStrip.id], status: 'paid' })
    const refunded = await makePayment({
      userId: user.id,
      stripIds: [refundedStrip.id],
      status: 'refunded',
    })

    await notify(paid.orderId, 'expire')
    await notify(refunded.orderId, 'settlement')

    assert.equal(await statusOfOrder(paid.orderId), 'paid')
    assert.equal(await statusOfOrder(refunded.orderId), 'refunded')
    const strip = await prisma.strip.findUniqueOrThrow({ where: { id: refundedStrip.id } })
    assert.equal(strip.paid, false)
  })
})

// ── Reconciliation ───────────────────────────────────────────────────────────

describe('reconcilePendingPayments', () => {
  // The job gates itself to once per five minutes, so each run claims a later "now".
  let runs = 0
  const nextRun = (): Date => {
    runs += 1
    return new Date(Date.now() + runs * 6 * 60_000)
  }
  const longAgo = (): Date => new Date(Date.now() - 60 * 60_000)

  it('unlocks a paid order whose notification never arrived', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    const payment = await makePayment({
      userId: user.id,
      stripIds: [strip.id],
      expiresAt: longAgo(),
    })
    statusOf = () => ({ transaction_status: 'settlement' })

    await reconcilePendingPayments(nextRun())

    assert.equal(await statusOfOrder(payment.orderId), 'paid')
    const unlocked = await prisma.strip.findUniqueOrThrow({ where: { id: strip.id } })
    assert.equal(unlocked.paid, true)
  })

  it('expires an order Midtrans has never heard of', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    const payment = await makePayment({
      userId: user.id,
      stripIds: [strip.id],
      expiresAt: longAgo(),
    })
    statusOf = unknownToMidtrans

    await reconcilePendingPayments(nextRun())

    assert.equal(await statusOfOrder(payment.orderId), 'expired')
  })

  it('leaves an order alone while its QR can still be paid', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    const payment = await makePayment({
      userId: user.id,
      stripIds: [strip.id],
      expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    })
    statusOf = () => {
      throw new Error('should not have asked Midtrans')
    }

    assert.equal(await reconcilePendingPayments(nextRun()), 0)
    assert.equal(await statusOfOrder(payment.orderId), 'pending')
  })

  it('carries on past one order Midtrans fails on', async () => {
    const user = await makeUser()
    const [one, two] = await Promise.all([makeStrip(user.id), makeStrip(user.id)])
    const failing = await makePayment({
      userId: user.id,
      stripIds: [one.id],
      expiresAt: longAgo(),
    })
    const fine = await makePayment({ userId: user.id, stripIds: [two.id], expiresAt: longAgo() })
    statusOf = (orderId) => {
      if (orderId === failing.orderId) throw new Error('midtrans is unwell')
      return { transaction_status: 'settlement' }
    }

    assert.equal(await reconcilePendingPayments(nextRun()), 2)

    assert.equal(await statusOfOrder(failing.orderId), 'pending')
    assert.equal(await statusOfOrder(fine.orderId), 'paid')
  })
})

// ── Sessions and signup ──────────────────────────────────────────────────────

describe('POST /auth/refresh', () => {
  const cookieOf = (raw: string): string => `momoto_rt=${raw}`

  it('leaves the cookie alone for the tab that lost a rotation race', async () => {
    const user = await makeUser()
    const { raw } = await issueRefreshToken(user.id)

    const winner = await request('POST', '/auth/refresh', { cookie: cookieOf(raw), body: {} })
    const loser = await request('POST', '/auth/refresh', { cookie: cookieOf(raw), body: {} })

    assert.equal(winner.status, 200)
    assert.equal(winner.setCookie.length, 1)
    assert.equal(loser.status, 409)
    assert.equal(loser.body.error, 'refresh_race')
    assert.deepEqual(loser.setCookie, [], 'a Set-Cookie here would wipe the winner’s session')
  })

  it('still evicts every session when an old token is replayed later', async () => {
    const user = await makeUser()
    const { raw } = await issueRefreshToken(user.id)
    await request('POST', '/auth/refresh', { cookie: cookieOf(raw), body: {} })
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: { not: null } },
      data: { revokedAt: new Date(Date.now() - 5 * 60_000) },
    })

    const replay = await request('POST', '/auth/refresh', { cookie: cookieOf(raw), body: {} })

    assert.equal(replay.status, 401)
    assert.match(replay.setCookie[0] ?? '', /momoto_rt=;/)
    const live = await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })
    assert.equal(live, 0)
  })
})

describe('POST /auth/register', () => {
  it('caps verification mail to one address across new accounts', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 6; i += 1) {
      const reply = await request('POST', '/auth/register', {
        body: {
          username: `victimcase${i}`,
          password: 'correct-horse',
          displayName: 'Someone',
          email: 'stranger@example.test',
        },
      })
      statuses.push(reply.status)
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 429])
  })
})

describe('GET /readyz', () => {
  it('reports a reachable database', async () => {
    const reply = await request('GET', '/readyz')
    assert.equal(reply.status, 200)
    assert.equal(reply.body.status, 'ok')
  })
})

describe('the paid gate', () => {
  it('refuses free unlocks unless they are switched on', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    const reply = await request('POST', '/strips/unlock', {
      token: signAccessToken(user.id),
      body: { stripIds: [strip.id] },
    })
    assert.equal(reply.status, 403)
    const row = await prisma.strip.findUniqueOrThrow({ where: { id: strip.id } })
    assert.equal(row.paid, false)
  })

  it('keeps an unpaid clean copy locked', async () => {
    const user = await makeUser()
    const strip = await makeStrip(user.id)
    const reply = await request('GET', `/strips/${strip.id}/print-url`, {
      token: signAccessToken(user.id),
    })
    assert.equal(reply.status, 402)
  })

  it('hides another user’s clean copy', async () => {
    const [owner, other] = await Promise.all([makeUser(), makeUser()])
    const strip = await makeStrip(owner.id)
    const reply = await request('GET', `/strips/${strip.id}/print-url`, {
      token: signAccessToken(other.id),
    })
    assert.equal(reply.status, 404)
  })
})

describe('POST /partner/accept', () => {
  const accept = (userId: string, code: string, ip: string): Promise<Reply> =>
    request('POST', '/partner/accept', { token: signAccessToken(userId), body: { code }, ip })

  it('stops an address that keeps guessing, even from other accounts', async () => {
    const [guesser, inviter, nextAccount, stranger] = await Promise.all([
      makeUser(),
      makeUser(),
      makeUser(),
      makeUser(),
    ])
    await prisma.partnerInvite.create({
      data: {
        code: 'REALCODE',
        inviterId: inviter.id,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      },
    })
    for (let i = 0; i < 30; i += 1) await accept(guesser.id, `WRONG${i}`, '198.51.100.7')

    const refused = await accept(nextAccount.id, 'REALCODE', '198.51.100.7')
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error, 'invite_invalid')
    const linked = await prisma.user.findUniqueOrThrow({ where: { id: nextAccount.id } })
    assert.equal(linked.partnerId, null)

    const elsewhere = await accept(stranger.id, 'REALCODE', '198.51.100.8')
    assert.equal(elsewhere.status, 200)
  })
})

describe('the admin audit log', () => {
  async function auditRows(actorId: string) {
    for (let i = 0; i < 40; i += 1) {
      const rows = await prisma.adminAuditLog.findMany({ where: { actorId } })
      if (rows.length > 0) return rows
      await sleep(25)
    }
    return []
  }

  beforeEach(() => prisma.adminAuditLog.deleteMany())

  it('records an admin reading personal data, without the search term', async () => {
    const enrolledAt = new Date()
    const admin = await prisma.user.create({
      data: {
        username: `admin${userSeq++}`,
        displayName: 'Admin',
        role: 'ADMIN',
        totpEnabledAt: enrolledAt,
      },
    })
    const reply = await request('GET', '/admin/users?q=someones-name', {
      token: signAccessToken(admin.id),
      session: signAdminSession(admin.id, enrolledAt).token,
    })
    assert.equal(reply.status, 200)

    const rows = await auditRows(admin.id)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.method, 'GET')
    assert.equal(rows[0]?.path, '/admin/users')
    assert.equal(rows[0]?.status, 200)
  })

  it('records a signed-in non-admin being turned away', async () => {
    const user = await makeUser()
    const reply = await request('GET', '/admin/users', { token: signAccessToken(user.id) })
    assert.equal(reply.status, 403)

    const rows = await auditRows(user.id)
    assert.equal(rows[0]?.status, 403)
  })

  it('keeps the record after the account is gone', async () => {
    const user = await makeUser()
    await request('GET', '/admin/stats', { token: signAccessToken(user.id) })
    await auditRows(user.id)
    await prisma.user.delete({ where: { id: user.id } })
    assert.equal(await prisma.adminAuditLog.count({ where: { actorId: user.id } }), 1)
  })
})

describe('rate limits and input bounds', () => {
  it('caps one address across the API, but not the health checks', async () => {
    const ip = '198.51.100.20'
    let last: Reply | undefined
    for (let i = 0; i < 101; i += 1) last = await request('GET', '/not-a-route', { ip })
    assert.equal(last?.status, 429)

    assert.equal((await request('GET', '/healthz', { ip })).status, 200)
    assert.equal((await request('GET', '/not-a-route', { ip: '198.51.100.21' })).status, 404)
  })

  it('answers a huge username without keeping it', async () => {
    const reply = await request('POST', '/auth/login', {
      ip: '198.51.100.30',
      body: { username: 'x'.repeat(5_000), password: 'whatever-it-is' },
    })
    assert.equal(reply.status, 401)
  })

  it('limits how often signup confirms an email is taken', async () => {
    await prisma.user.create({
      data: {
        username: `taken${userSeq++}`,
        displayName: 'Taken',
        email: 'taken@example.test',
        emailVerifiedAt: new Date(),
      },
    })
    const statuses: number[] = []
    for (let i = 0; i < 11; i += 1) {
      const reply = await request('POST', '/auth/register', {
        ip: '198.51.100.40',
        body: {
          username: `probe${i}`,
          password: 'correct-horse',
          displayName: 'Probe',
          email: 'taken@example.test',
        },
      })
      statuses.push(reply.status)
    }
    assert.deepEqual(statuses, [...Array<number>(10).fill(409), 429])
  })
})

describe('reset-link check and response caching', () => {
  it('takes the token in the body, and no longer in the URL', async () => {
    const check = await request('POST', '/auth/reset-password/check', {
      body: { token: 'not-a-real-token' },
    })
    assert.equal(check.status, 200)
    assert.equal(check.body.valid, false)
    assert.equal((await request('GET', '/auth/reset-password?token=abc')).status, 404)
  })

  it('tells caches not to keep personal JSON', async () => {
    const user = await makeUser()
    const reply = await request('GET', '/auth/me', { token: signAccessToken(user.id) })
    assert.equal(reply.cacheControl, 'no-store')
  })
})
