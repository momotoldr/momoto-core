import { randomBytes } from 'node:crypto'

import argon2 from 'argon2'

/**
 * Password hashing with argon2id (memory-hard, the current OWASP-recommended KDF).
 * Defaults are used — argon2 encodes the salt + parameters into the returned hash,
 * so `verify` needs nothing but the stored string.
 */
export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id })
}

/** Returns true iff `plain` matches the stored hash. Never throws on mismatch. */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain)
  } catch {
    return false
  }
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
  decoyHash ??= argon2.hash(randomBytes(32).toString('hex'), { type: argon2.argon2id })
  return decoyHash.then((hash) => verifyPassword(hash, plain))
}
