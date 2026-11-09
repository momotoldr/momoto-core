// The TOTP arithmetic, against the published RFC 6238 vectors.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

process.env.JWT_SECRET = 'test-only-jwt-secret-0123456789abcdef'
process.env.JWT_PRIVATE_KEY = ''

const {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchTotp,
  otpauthUri,
  totpCode,
  totpStep,
} = await import('../src/auth/totp.js')

/** "12345678901234567890", the RFC's shared secret, in base32. */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

describe('totp', () => {
  // The RFC prints 8 digits; a 6-digit code is the last six of them.
  for (const [seconds, code] of [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ] as const) {
    it(`matches the RFC vector at ${seconds}`, () => {
      assert.equal(totpCode(RFC_SECRET, totpStep(seconds * 1000)), code)
    })
  }

  it('accepts one step of clock drift and no more', () => {
    const now = 1234567890 * 1000
    const step = totpStep(now)
    for (const offset of [-1, 0, 1]) {
      assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + offset), now), step + offset)
    }
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 2), now), null)
    assert.equal(matchTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now), null)
  })

  it('rejects anything that is not six digits', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12345a']) {
      assert.equal(matchTotp(RFC_SECRET, code), null)
    }
  })

  it('generates a secret that round-trips through its own codes', () => {
    const secret = generateTotpSecret()
    assert.match(secret, /^[A-Z2-7]{32}$/)
    assert.notEqual(matchTotp(secret, totpCode(secret, totpStep(Date.now()))), null)
  })

  it('encrypts the secret, differently each time', () => {
    const a = encryptTotpSecret(RFC_SECRET)
    const b = encryptTotpSecret(RFC_SECRET)
    assert.notEqual(a, b)
    assert.ok(!a.includes(RFC_SECRET))
    assert.equal(decryptTotpSecret(a), RFC_SECRET)
  })

  it('refuses a tampered secret', () => {
    const [iv, tag, data] = encryptTotpSecret(RFC_SECRET).split('.') as [string, string, string]
    const flipped = `${data[0] === 'A' ? 'B' : 'A'}${data.slice(1)}`
    assert.throws(() => decryptTotpSecret(`${iv}.${tag}.${flipped}`))
  })

  it('names the issuer and account in the QR address', () => {
    const uri = otpauthUri(RFC_SECRET, 'andi')
    assert.ok(uri.startsWith('otpauth://totp/Momoto%20Admin%3Aandi?'))
    assert.ok(uri.includes(`secret=${RFC_SECRET}`))
  })

  it('makes unique recovery codes, forgiving about case and the dash', () => {
    const codes = generateRecoveryCodes()
    assert.equal(new Set(codes).size, 10)
    const code = codes[0] as string
    assert.equal(hashRecoveryCode(code.toLowerCase().replace('-', '')), hashRecoveryCode(code))
  })
})
