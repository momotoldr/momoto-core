// The 6-digit check on the operator surface, through the real routes.
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

import jwt from 'jsonwebtoken'

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl || !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('TEST_DATABASE_URL must point at a local, disposable database.')
}

const SECRET = 'test-only-jwt-secret-0123456789abcdef'
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  JWT_SECRET: SECRET,
  JWT_PRIVATE_KEY: '',
  CORS_ORIGINS: 'http://localhost:5173',
  CLIENT_IP_HEADER: '',
  NOTIFY_URL: '',
})

const { prisma } = await import('../../src/db/client.js')
const { createApp } = await import('../../src/http/app.js')
const { signAccessToken } = await import('../../src/auth/tokens.js')
const { totpCode, totpStep } = await import('../../src/auth/totp.js')

let server: Server
let base: string
let seq = 0

before(async () => {
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
})

function makeUser(role: 'ADMIN' | 'USER' = 'ADMIN') {
  seq += 1
  return prisma.user.create({
    data: { username: `mfa${Date.now() % 1e8}${seq}`, displayName: 'Mfa', role },
  })
}

async function call(
  method: string,
  path: string,
  token: string,
  options: { body?: unknown; session?: string } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.session ? { 'x-admin-session': options.session } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const parsed = (await res.json()) as { result: Record<string, unknown> }
  return { status: res.status, body: parsed.result }
}

const codeNow = (secret: string, offset = 0): string =>
  totpCode(secret, totpStep(Date.now()) + offset)

/** Walks an admin through setup, returning what a later test needs. */
async function enroll() {
  const user = await makeUser()
  const token = signAccessToken(user.id)
  const { body } = await call('POST', '/admin/mfa/enroll', token, { body: {} })
  const secret = body.secret as string
  const confirmed = await call('POST', '/admin/mfa/enroll/confirm', token, {
    body: { code: codeNow(secret) },
  })
  assert.equal(confirmed.status, 200)
  return {
    user,
    token,
    secret,
    session: confirmed.body.token as string,
    recoveryCodes: confirmed.body.recoveryCodes as string[],
  }
}

describe('the admin surface without a 6-digit check', () => {
  it('refuses an admin who has not set it up, and says so', async () => {
    const user = await makeUser()
    const reply = await call('GET', '/admin/users', signAccessToken(user.id))
    assert.equal(reply.status, 403)
    assert.deepEqual(reply.body, { error: 'admin_session_required', enrolled: false })
  })

  it('refuses an enrolled admin without a session, and says so', async () => {
    const { token } = await enroll()
    const reply = await call('GET', '/admin/stats', token)
    assert.equal(reply.status, 403)
    assert.deepEqual(reply.body, { error: 'admin_session_required', enrolled: true })
  })

  it('keeps non-admins out of the setup routes too', async () => {
    const user = await makeUser('USER')
    const reply = await call('POST', '/admin/mfa/enroll', signAccessToken(user.id), { body: {} })
    assert.equal(reply.status, 403)
    assert.equal(reply.body.error, 'forbidden')
  })
})

describe('setting it up', () => {
  it('shows the same secret until confirmed, and stores it encrypted', async () => {
    const user = await makeUser()
    const token = signAccessToken(user.id)
    const first = await call('POST', '/admin/mfa/enroll', token, { body: {} })
    const again = await call('POST', '/admin/mfa/enroll', token, { body: {} })
    assert.equal(first.body.secret, again.body.secret)
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.ok(row.totpSecret && !row.totpSecret.includes(first.body.secret as string))
    assert.equal(row.totpEnabledAt, null)
  })

  it('stays off after a wrong first code', async () => {
    const user = await makeUser()
    const token = signAccessToken(user.id)
    await call('POST', '/admin/mfa/enroll', token, { body: {} })
    const reply = await call('POST', '/admin/mfa/enroll/confirm', token, {
      body: { code: '000000' },
    })
    assert.equal(reply.status, 400)
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    assert.equal(row.totpEnabledAt, null)
  })

  it('gives a working session and recovery codes, stored hashed', async () => {
    const { user, token, session, recoveryCodes } = await enroll()
    assert.equal(recoveryCodes.length, 10)
    const reply = await call('GET', '/admin/users', token, { session })
    assert.equal(reply.status, 200)
    const stored = await prisma.totpRecoveryCode.findMany({ where: { userId: user.id } })
    assert.equal(stored.length, 10)
    assert.ok(stored.every((row) => !recoveryCodes.includes(row.codeHash)))
  })

  it('cannot be repeated once on, which would replace the secret', async () => {
    const { token } = await enroll()
    const reply = await call('POST', '/admin/mfa/enroll', token, { body: {} })
    assert.equal(reply.status, 409)
    assert.equal(reply.body.error, 'mfa_already_enrolled')
  })
})

describe('passing the check', () => {
  it('accepts the current code once, and refuses it replayed', async () => {
    const { token, secret } = await enroll()
    // Setup spent the current step, so the next one is what's fresh.
    const code = codeNow(secret, 1)
    const first = await call('POST', '/admin/mfa/verify', token, { body: { code } })
    assert.equal(first.status, 200)
    assert.equal(
      (await call('GET', '/admin/stats', token, { session: first.body.token as string })).status,
      200,
    )
    const replay = await call('POST', '/admin/mfa/verify', token, { body: { code } })
    assert.equal(replay.status, 400)
    assert.equal(replay.body.error, 'invalid_code')
  })

  it('stops guessing after ten attempts, even if the next one is right', async () => {
    const { token, secret } = await enroll()
    for (let i = 0; i < 10; i += 1) {
      const reply = await call('POST', '/admin/mfa/verify', token, { body: { code: '000000' } })
      assert.equal(reply.status, 400)
    }
    const locked = await call('POST', '/admin/mfa/verify', token, {
      body: { code: codeNow(secret, 1) },
    })
    assert.equal(locked.status, 429)
  })

  it('takes a recovery code once', async () => {
    const { token, recoveryCodes } = await enroll()
    const recoveryCode = recoveryCodes[0] as string
    const first = await call('POST', '/admin/mfa/verify', token, { body: { recoveryCode } })
    assert.equal(first.status, 200)
    const again = await call('POST', '/admin/mfa/verify', token, { body: { recoveryCode } })
    assert.equal(again.status, 400)
  })
})

describe('sessions that must not work', () => {
  it('refuses one signed with the shared secret instead of the derived key', async () => {
    const { user, token } = await enroll()
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })
    const forged = jwt.sign({ v: row.totpEnabledAt?.getTime() }, SECRET, {
      subject: user.id,
      audience: 'momoto-admin-session',
      expiresIn: 600,
    })
    assert.equal((await call('GET', '/admin/users', token, { session: forged })).status, 403)
  })

  it('refuses an ordinary access token used as a session', async () => {
    const { token } = await enroll()
    assert.equal((await call('GET', '/admin/users', token, { session: token })).status, 403)
  })

  it('refuses another admin’s session', async () => {
    const one = await enroll()
    const two = await enroll()
    const reply = await call('GET', '/admin/users', two.token, { session: one.session })
    assert.equal(reply.status, 403)
  })

  it('stops working once the setup is reset', async () => {
    const { user, token, session } = await enroll()
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
    })
    const reply = await call('GET', '/admin/users', token, { session })
    assert.equal(reply.status, 403)
    assert.equal(reply.body.enrolled, false)
  })

  it('stops working when the account is no longer an admin', async () => {
    const { user, token, session } = await enroll()
    await prisma.user.update({ where: { id: user.id }, data: { role: 'USER' } })
    const reply = await call('GET', '/admin/users', token, { session })
    assert.equal(reply.status, 403)
    assert.equal(reply.body.error, 'forbidden')
  })
})
