/**
 * One-off operator CLI to reset an account's password by hand.
 *
 *   npm run reset:password -- andi                 # one account
 *   npm run reset:password -- andi sinta budi      # several
 *   npm run reset:password -- andi --dry-run       # show what would happen
 *
 * ## When to use this
 *
 * This is the support escape hatch, not the normal path. Self-service recovery lives
 * at `/forgot-password` and needs a **verified** address on the account; until a
 * tester has confirmed one, this script is the only way back in. It is also the right
 * tool when someone's password has leaked and they need it changed now.
 *
 * ## What it does
 *
 * Generates a new password, writes it to `<username>.credentials.csv` at mode 0600
 * rather than printing it — passwords in shell scrollback outlive the terminal, get
 * captured by CI logs, and end up in screen shares — and revokes every refresh token
 * on the account, so any device still signed in is signed out. That last part is the
 * point when the reason for the reset is "someone else may have it."
 *
 * The account's email, if any, is left completely alone: this script does not mail
 * anything, and it cannot make an unverified address verified.
 */
import '../src/config/loadEnv.js'

import { randomInt } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'

import { hashPassword } from '../src/auth/passwords.js'
import { revokeAllForUser } from '../src/auth/tokens.js'
import { prisma } from '../src/db/client.js'

import { toCsvRow } from './csv.js'

/** No 0/O/1/l/I — these get read aloud and typed by hand off a phone screen. */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
const PASSWORD_LENGTH = 14

function generatePassword(): string {
  let out = ''
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
  }
  return out
}

interface Reset {
  username: string
  password: string
  sessionsRevoked: number
}

const USAGE = `Usage:
  npm run reset:password -- <username> [<username>...] [--out FILE] [--dry-run]`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let dryRun = false
  let out: string | undefined
  const usernames: string[] = []

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--out') out = String(args[++i] ?? '')
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}\n\n${USAGE}`)
      process.exitCode = 1
      return
    } else usernames.push(arg.trim().toLowerCase())
  }

  if (usernames.length === 0) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  // Look everyone up before changing anything, so a typo'd username doesn't leave a
  // half-done batch where some passwords have already been replaced.
  const users = await prisma.user.findMany({
    where: { username: { in: usernames } },
    select: { id: true, username: true },
  })
  const found = new Map(users.map((u) => [u.username, u.id]))
  const missing = usernames.filter((u) => !found.has(u))
  if (missing.length > 0) {
    console.error(`No such account: ${missing.join(', ')}`)
    process.exitCode = 1
    return
  }

  const outPath = out || `${usernames[0]}.credentials.csv`
  // The generated password exists nowhere else — the database holds an argon2 hash and
  // nothing readable. Clobbering an earlier file would destroy the only copy.
  if (!dryRun && existsSync(outPath)) {
    console.error(
      `${outPath} already exists, and its passwords cannot be recovered from the database.\n\n` +
        `Write this batch elsewhere:\n  npm run reset:password -- ${usernames.join(' ')} --out other.csv`,
    )
    process.exitCode = 1
    return
  }

  if (dryRun) {
    for (const username of usernames) {
      console.log(`  ${username}: would get a new password and be signed out everywhere`)
    }
    console.log('\nDry run — nothing changed.')
    return
  }

  const done: Reset[] = []
  const writeCredentials = (): void => {
    const rows = ['username,password', ...done.map((r) => toCsvRow([r.username, r.password]))]
    writeFileSync(outPath, `${rows.join('\n')}\n`, { mode: 0o600 })
  }

  try {
    for (const username of usernames) {
      const id = found.get(username) as string
      const password = generatePassword()
      await prisma.user.update({
        where: { id },
        data: { passwordHash: await hashPassword(password) },
      })
      // Any device still holding a refresh cookie keeps working otherwise — which
      // would defeat the point when the reset is a response to a suspected theft.
      const sessionsRevoked = await revokeAllForUser(id)
      done.push({ username, password, sessionsRevoked })
      console.log(`  ${username}: reset, ${sessionsRevoked} session(s) revoked`)
    }
  } catch (err) {
    // A password is already changed by the time anything downstream can fail, and it
    // exists nowhere else — save what succeeded before letting the error surface.
    if (done.length > 0) {
      writeCredentials()
      console.error(`\nFailed partway through. ${done.length} reset and saved to ${outPath}.\n`)
    }
    throw err
  }

  writeCredentials()
  console.log(`\nCredentials written to ${outPath} (owner-read only).`)
  console.log('Hand them over, then delete that file — they are not recoverable from the DB.')
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
