// What a sign-in rush looks like through the real routes.
import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, it } from 'node:test'

import argon2 from 'argon2'

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
  PASSWORD_HASH_MAX_CONCURRENT: '1',
  PASSWORD_HASH_MAX_WAIT_MS: '40',
})

const { prisma } = await import('../../src/db/client.js')
const { createApp } = await import('../../src/http/app.js')
const { signAccessToken } = await import('../../src/auth/tokens.js')

const stub = argon2 as unknown as { verify: () => Promise<boolean> }
const realVerify = stub.verify

let server: Server
let base: string

before(async () => {
  server = createApp().listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  stub.verify = realVerify
  await new Promise((resolve) => server.close(resolve))
  await prisma.$disconnect()
})

let seq = 0
function makeUser() {
  seq += 1
  return prisma.user.create({
    data: {
      username: `busy${Date.now() % 1e8}${seq}`,
      displayName: 'Busy',
      passwordHash: 'stubbed-hash',
    },
  })
}

function post(path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST') {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** Keeps the only hashing slot occupied until the returned function is called. */
async function occupyTheSlot(username: string) {
  let release: (value: boolean) => void = () => undefined
  stub.verify = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const inFlight = post('/auth/login', { username, password: 'irrelevant' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  return async () => {
    release(true)
    return inFlight
  }
}

describe('a sign-in rush', () => {
  it('tells people to retry, without counting against their account', async () => {
    const [holder, person] = await Promise.all([makeUser(), makeUser()])
    const release = await occupyTheSlot(holder.username)

    // More than the 10-per-account budget. Each would be a 429 if these were counted.
    for (let i = 0; i < 12; i += 1) {
      const res = await post('/auth/login', { username: person.username, password: 'pw' })
      assert.equal(res.status, 503)
      assert.equal(res.headers.get('retry-after'), '5')
      const body = (await res.json()) as { result: { error: string } }
      assert.equal(body.result.error, 'server_busy')
    }

    assert.equal((await release()).status, 200)
    stub.verify = () => Promise.resolve(true)
    const after = await post('/auth/login', { username: person.username, password: 'pw' })
    assert.equal(after.status, 200)
  })

  it('leaves the rest of the API answering', async () => {
    const holder = await makeUser()
    const release = await occupyTheSlot(holder.username)
    const started = performance.now()
    const stats = await fetch(`${base}/stats`)
    assert.equal(stats.status, 200)
    assert.ok(performance.now() - started < 1000)
    await release()
  })

  it('does not treat a busy server as a wrong password on account deletion', async () => {
    const [holder, person] = await Promise.all([makeUser(), makeUser()])
    const release = await occupyTheSlot(holder.username)
    const token = signAccessToken(person.id)
    for (let i = 0; i < 12; i += 1) {
      const res = await post(
        '/auth/me',
        { password: 'pw' },
        { authorization: `Bearer ${token}` },
        'DELETE',
      )
      assert.equal(res.status, 503)
    }
    await release()
    assert.notEqual(await prisma.user.findUnique({ where: { id: person.id } }), null)
  })
})
