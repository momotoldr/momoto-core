// The limit on concurrent password hashing. Argon2 is replaced with something the test can
// hold open, because what's under test is the queueing around it.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import argon2 from 'argon2'

process.env.JWT_SECRET = 'test-only-jwt-secret-0123456789abcdef'
process.env.JWT_PRIVATE_KEY = ''
process.env.PASSWORD_HASH_MAX_CONCURRENT = '2'
process.env.PASSWORD_HASH_MAX_WAIT_MS = '120'

const { PasswordHashBusyError, verifyDecoyPassword, verifyPassword } =
  await import('../src/auth/passwords.js')

const stub = argon2 as unknown as { verify: () => Promise<boolean> }
const realVerify = stub.verify

let active = 0
let peak = 0
let held: Array<() => void> = []

function holdEveryVerify(): void {
  stub.verify = () =>
    new Promise((resolve) => {
      active += 1
      peak = Math.max(peak, active)
      held.push(() => {
        active -= 1
        resolve(true)
      })
    })
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

async function releaseAll(): Promise<void> {
  while (held.length > 0) {
    held.shift()?.()
    await tick()
  }
}

afterEach(async () => {
  await releaseAll()
  stub.verify = realVerify
  active = 0
  peak = 0
  held = []
})

describe('the password hashing cap', { timeout: 5_000 }, () => {
  it('never runs more than the limit, and everyone still gets an answer', async () => {
    holdEveryVerify()
    const calls = Array.from({ length: 10 }, () => verifyPassword('hash', 'pw'))
    await tick()
    assert.equal(held.length, 2)
    await releaseAll()
    assert.deepEqual(await Promise.all(calls), Array<boolean>(10).fill(true))
    assert.equal(peak, 2)
  })

  it('turns people away at once when the line is full', async () => {
    holdEveryVerify()
    const queued = Array.from({ length: 2 + 64 }, () =>
      verifyPassword('hash', 'pw').catch(() => 'settled'),
    )
    await tick()
    const started = performance.now()
    await assert.rejects(verifyPassword('hash', 'pw'), PasswordHashBusyError)
    assert.ok(performance.now() - started < 50, 'should not have waited')
    await releaseAll()
    await Promise.all(queued)
  })

  it('stops waiting after the limit, and hands no slot to someone who left', async () => {
    holdEveryVerify()
    const first = verifyPassword('hash', 'pw')
    const second = verifyPassword('hash', 'pw')
    await tick()
    await assert.rejects(verifyPassword('hash', 'pw'), PasswordHashBusyError)

    await releaseAll()
    assert.deepEqual(await Promise.all([first, second]), [true, true])

    // Both slots are free again, so the next call runs immediately.
    const next = verifyPassword('hash', 'pw')
    await tick()
    assert.equal(held.length, 1)
    await releaseAll()
    assert.equal(await next, true)
  })

  it('still answers false for a malformed hash, and gives the slot back', async () => {
    stub.verify = () => Promise.reject(new Error('pchstr must contain a $'))
    for (let i = 0; i < 5; i += 1) assert.equal(await verifyPassword('garbage', 'pw'), false)
  })

  it('does not get stuck on a decoy refused during a rush', async () => {
    holdEveryVerify()
    const first = verifyPassword('hash', 'pw')
    const second = verifyPassword('hash', 'pw')
    await tick()
    await assert.rejects(verifyDecoyPassword('pw'), PasswordHashBusyError)
    await releaseAll()
    await Promise.all([first, second])

    stub.verify = () => Promise.resolve(false)
    assert.equal(await verifyDecoyPassword('pw'), false)
  })
})
