import { randomBytes } from 'node:crypto'

import argon2 from 'argon2'

import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'

/** Thrown instead of joining a line too long to be worth waiting in. Answered as a 503. */
export class PasswordHashBusyError extends Error {
  constructor() {
    super('password_hash_busy')
  }
}

/** How many may wait for a slot. Past this, the answer is "try again", immediately. */
const MAX_QUEUED = 64
const BUSY_LOG_INTERVAL_MS = 60_000

interface Waiter {
  resolve: () => void
  timer: NodeJS.Timeout
}

let active = 0
const waiting: Waiter[] = []
let lastBusyLog = 0

function refuse(): PasswordHashBusyError {
  const now = Date.now()
  if (now - lastBusyLog >= BUSY_LOG_INTERVAL_MS) {
    lastBusyLog = now
    logger.warn('auth.password_hash.busy', { active, queued: waiting.length })
  }
  return new PasswordHashBusyError()
}

function acquireSlot(): Promise<void> {
  if (active < env.passwordHashMaxConcurrent) {
    active += 1
    return Promise.resolve()
  }
  if (waiting.length >= MAX_QUEUED) return Promise.reject(refuse())
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      timer: setTimeout(() => {
        waiting.splice(waiting.indexOf(waiter), 1)
        reject(refuse())
      }, env.passwordHashMaxWaitMs),
    }
    waiter.timer.unref()
    waiting.push(waiter)
  })
}

function releaseSlot(): void {
  const next = waiting.shift()
  if (next) {
    // The slot passes straight to the next in line, so `active` doesn't change.
    clearTimeout(next.timer)
    next.resolve()
    return
  }
  active -= 1
}

/**
 * A few hashes at a time, the rest in a short line.
 *
 * Each hash is deliberately expensive, and they run on the same small thread pool as DNS
 * lookups. Left alone, a sign-in rush takes the CPU and that pool from every other request
 * and queues without limit, finishing hashes for clients that gave up long ago. This
 * keeps a rush to the people in it, who get told to try again.
 */
async function withHashSlot<T>(work: () => Promise<T>): Promise<T> {
  await acquireSlot()
  try {
    return await work()
  } finally {
    releaseSlot()
  }
}

/**
 * Password hashing with argon2id (memory-hard, the current OWASP-recommended KDF).
 * Defaults are used — argon2 encodes the salt + parameters into the returned hash,
 * so `verify` needs nothing but the stored string.
 */
export function hashPassword(plain: string): Promise<string> {
  return withHashSlot(() => argon2.hash(plain, { type: argon2.argon2id }))
}

/**
 * Returns true iff `plain` matches the stored hash. Never throws on mismatch, but does
 * throw `PasswordHashBusyError`: being too busy to check isn't a wrong password.
 */
export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return withHashSlot(async () => {
    try {
      return await argon2.verify(hash, plain)
    } catch {
      return false
    }
  })
}

/** Hash of a value nobody knows — the comparison always fails. Computed once. */
let decoyHash: Promise<string> | null = null

/**
 * Burn the same argon2 work a real verification costs, and always fail.
 *
 * Login must not answer faster for an unknown username than for a known one: argon2
 * takes ~100ms, so skipping it on the miss path turns response time into a username
 * oracle an attacker can use to enumerate accounts. Call this whenever there's no
 * stored hash to check against.
 */
export function verifyDecoyPassword(plain: string): Promise<boolean> {
  // Outside the slots: it runs once, and a refusal here would be cached forever.
  decoyHash ??= argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id })
  return decoyHash.then((hash) => verifyPassword(hash, plain))
}
