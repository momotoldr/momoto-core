import { randomInt } from 'node:crypto'

// Unambiguous uppercase alphabet — no 0/O or 1/I/L — so a shared code is easy to read
// aloud and type. The same shape as momoto-realtime's room codes, so the two feel alike
// to a user, but deliberately a separate copy: they are different codes that only
// happened to start out identical, and neither should change because the other did.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const DEFAULT_LENGTH = 6

/** Crypto-strong, human-friendly partner invite code. */
export function generateInviteCode(length: number = DEFAULT_LENGTH): string {
  let code = ''
  for (let i = 0; i < length; i += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)]
  }
  return code
}
