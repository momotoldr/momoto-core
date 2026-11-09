// Access tokens once core signs them with its private key: what is accepted, and the
// forgeries that must not be.
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'

const SECRET = 'test-only-jwt-secret-0123456789abcdef'
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

process.env.JWT_SECRET = SECRET
process.env.JWT_PRIVATE_KEY = Buffer.from(
  privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
).toString('base64')

const { signAccessToken, verifyAccessToken } = await import('../src/auth/tokens.js')

/** A token built by hand, so no library can refuse to produce the forgery. */
function hs256Token(key: string): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: 'victim',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}`
  return `${unsigned}.${createHmac('sha256', key).update(unsigned).digest('base64url')}`
}

describe('access tokens signed with the key pair', () => {
  it('round-trips, as ES256', () => {
    const token = signAccessToken('user-1')
    const header = JSON.parse(Buffer.from(token.split('.')[0] as string, 'base64url').toString())
    assert.equal(header.alg, 'ES256')
    assert.equal(verifyAccessToken(token).sub, 'user-1')
  })

  it('refuses a token signed with the old shared secret', () => {
    assert.throws(() => verifyAccessToken(hs256Token(SECRET)))
  })

  it('refuses a token signed with the public key as an HMAC secret', () => {
    assert.throws(() => verifyAccessToken(hs256Token(publicPem)))
  })
})
