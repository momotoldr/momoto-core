import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto'

import { env } from '../config/env.js'

/**
 * Time-based one-time passwords (RFC 6238) for admin accounts, and what goes with them.
 * Built on `node:crypto` because the algorithm is a few lines and this is the code that
 * guards the operator console.
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const PERIOD_SECONDS = 30
const DIGITS = 6
/** One step either side, for a phone whose clock is a little off. */
const DRIFT_STEPS = 1
const ISSUER = 'Momoto Admin'
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const RECOVERY_CODE_COUNT = 10

function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

function base32Decode(text: string): Buffer {
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

/** A new shared secret, base32 as authenticator apps expect. 160 bits, per the RFC. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The code for one 30-second step. */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = (digest[digest.length - 1] as number) & 0xf
  const value = digest.readUInt32BE(offset) & 0x7fffffff
  return String(value % 10 ** DIGITS).padStart(DIGITS, '0')
}

/** Which 30-second step a moment falls in. */
export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / PERIOD_SECONDS)
}

/**
 * The step `code` is valid for around `nowMs`, or null. The step is what the caller
 * records to refuse the same code twice.
 */
export function matchTotp(secret: string, code: string, nowMs: number = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null
  const current = totpStep(nowMs)
  const presented = Buffer.from(code)
  let matched: number | null = null
  // Every candidate is compared, so timing doesn't say which step hit.
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step += 1) {
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), presented)) matched = step
  }
  return matched
}

/** The address a QR code carries. */
export function otpauthUri(secret: string, username: string): string {
  const label = encodeURIComponent(`${ISSUER}:${username}`)
  const params = new URLSearchParams({
    secret,
    issuer: ISSUER,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/**
 * The secret has to be readable again to check codes, so unlike a password it can't be
 * hashed. Encrypted with a key derived from `JWT_SECRET`, so a database leak alone doesn't
 * yield it. Rotating `JWT_SECRET` means admins enrol again (`npm run admin:reset-mfa`).
 */
const encryptionKey = createHmac('sha256', env.jwtSecret).update('momoto:admin-totp:v1').digest()

export function encryptTotpSecret(secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.')
}

export function decryptTotpSecret(stored: string): string {
  const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64url'))
  if (!iv || !tag || !data) throw new Error('malformed TOTP secret')
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/** One-time codes for a lost phone, as shown to the admin. About 49 bits each. */
export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    let code = ''
    for (let i = 0; i < 10; i += 1) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]
    return `${code.slice(0, 5)}-${code.slice(5)}`
  })
}

/** The stored form. Forgiving about case and the dash, since these get typed from paper. */
export function hashRecoveryCode(code: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return createHash('sha256').update(normalized).digest('hex')
}
