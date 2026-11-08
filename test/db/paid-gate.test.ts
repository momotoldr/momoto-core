// The case that used to fail open: payments off because a flag or a Midtrans key went
// missing, with nobody having asked for free unlocks. Its own file because the config is
// read once per process.
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

const databaseUrl = process.env.TEST_DATABASE_URL
if (!databaseUrl || !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname)) {
  throw new Error('TEST_DATABASE_URL must point at a local, disposable database.')
}

Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  JWT_SECRET: 'test-only-jwt-secret-0123456789abcdef',
  JWT_PRIVATE_KEY: '',
  CORS_ORIGINS: 'http://localhost:5173',
  CLIENT_IP_HEADER: '',
  NOTIFY_URL: '',
  PAYMENTS_ENABLED: 'true',
  MIDTRANS_SERVER_KEY: '',
  MIDTRANS_CLIENT_KEY: '',
  FREE_UNLOCK_ENABLED: '',
})

const { prisma } = await import('../../src/db/client.js')
const { createApp } = await import('../../src/http/app.js')
const { signAccessToken } = await import('../../src/auth/tokens.js')

let server: Server
let base: string

before(async () => {
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
})

async function makeStrip() {
  const user = await prisma.user.create({
    data: { username: `gate${Date.now() % 1e9}`, displayName: 'Gate' },
  })
  const strip = await prisma.strip.create({
    data: {
      userId: user.id,
      mimeType: 'image/webp',
      width: 600,
      height: 1800,
      storageKey: `strips/${user.id}.webp`,
      printImage: {
        create: {
          storageKey: `prints/${user.id}.webp`,
          mimeType: 'image/webp',
          width: 600,
          height: 1800,
        },
      },
    },
  })
  return { user, strip, token: signAccessToken(user.id) }
}

describe('with a Midtrans key missing and free unlocks not switched on', () => {
  it('does not unlock for free', async () => {
    const { strip, token } = await makeStrip()
    const res = await fetch(`${base}/strips/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ stripIds: [strip.id] }),
    })
    assert.equal(res.status, 403)
    const row = await prisma.strip.findUniqueOrThrow({ where: { id: strip.id } })
    assert.equal(row.paid, false)
  })

  it('does not hand out the clean copy', async () => {
    const { strip, token } = await makeStrip()
    const res = await fetch(`${base}/strips/${strip.id}/print-url`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(res.status, 402)
  })
})
