/**
 * One-off operator CLI to attach email addresses to accounts that were seeded without
 * one, and to mail those people a confirmation link.
 *
 *   npm run backfill:emails -- invites.csv --dry-run    # show what would change
 *   npm run backfill:emails -- invites.csv              # write the addresses
 *   npm run backfill:emails -- --send                   # mail confirmation links
 *   npm run backfill:emails -- invites.csv --send       # both, in one pass
 *
 * ## Why this exists
 *
 * The closed-beta accounts were created by `seedTesters.ts` before it stored emails,
 * so they have none — which means no password reset, because there is nowhere to send
 * the link. The addresses are not lost: they are sitting in the CSV that
 * `sendInvites.ts` already reads to mail those same people their credentials. This
 * script joins the two back together.
 *
 * ## Input
 *
 * The same CSV `send:invites` takes — a header row, case-insensitive column names:
 *
 *   username  required — the account to attach to
 *   email     required
 *
 * Extra columns (password, displayName, lang) are ignored, so an invite CSV works
 * unchanged.
 *
 * ## What it writes
 *
 * `User.email`, and nothing else. **`emailVerifiedAt` stays null**: an operator
 * matching rows in a spreadsheet is not proof that a person owns a mailbox, and a
 * wrong row here is exactly the mistake verification exists to catch. Until the tester
 * opens a link, the address grants nothing — no reset mail is ever sent to it.
 *
 * `--send` then issues a real verification claim for every account holding an
 * unverified address, which mails them the confirmation link. Once they click it they
 * can recover their own account.
 *
 * Safe to re-run: an account that already has an address is left alone unless
 * `--force` is passed, and `--send` skips anyone already verified.
 */
import '../src/config/loadEnv.js'

import { readFileSync } from 'node:fs'

import { claimEmail } from '../src/auth/emailVerification.js'
import { prisma } from '../src/db/client.js'
import { isValidEmail, normalizeEmail } from '../src/lib/email.js'

import { columnIndex, readCsvTable } from './csv.js'

interface Row {
  line: number
  username: string
  email: string
}

/** Reads the CSV, or exits with an explanation. */
function readRows(path: string): Row[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(`No such file: ${path}\n\nExpected a CSV with username and email columns.`)
      process.exit(1)
    }
    throw err
  }

  const { header, rows: dataRows } = readCsvTable(raw)
  const usernameAt = columnIndex(header, 'username', 'handle')
  const emailAt = columnIndex(header, 'email', 'emailaddress', 'mail')
  if (usernameAt === -1 || emailAt === -1) {
    console.error(
      `${path} needs both a "username" and an "email" column.\nFound: ${header.join(', ')}`,
    )
    process.exit(1)
  }

  const rows: Row[] = []
  const seen = new Map<string, number>()
  for (const { line, cells } of dataRows) {
    const username = (cells[usernameAt] ?? '').trim().toLowerCase()
    const email = normalizeEmail(cells[emailAt])

    if (!username || !email) continue
    if (!isValidEmail(email)) {
      console.error(`Line ${line}: "${email}" doesn't look like an email address — skipped.`)
      continue
    }
    // The column is uniquely indexed, so a duplicate address would fail partway
    // through. Catch it here, before anything is written.
    const earlier = seen.get(email)
    if (earlier) {
      console.error(`Line ${line}: ${email} already appears on line ${earlier} — skipped.`)
      continue
    }
    seen.set(email, line)
    rows.push({ line, username, email })
  }
  return rows
}

/** Attaches addresses from the CSV. Returns how many rows were written. */
async function attach(rows: Row[], force: boolean, dryRun: boolean): Promise<number> {
  let written = 0

  for (const row of rows) {
    const user = await prisma.user.findUnique({
      where: { username: row.username },
      select: { id: true, email: true, emailVerifiedAt: true },
    })
    if (!user) {
      console.error(`Line ${row.line}: no account named "${row.username}" — skipped.`)
      continue
    }
    if (user.email && !force) {
      const state = user.emailVerifiedAt ? 'verified' : 'unverified'
      console.log(
        `  ${row.username}: already has a ${state} address — skipped (--force to replace).`,
      )
      continue
    }
    // Never overwrite a *proven* address on an operator's say-so. The person on the
    // other end confirmed that one; a spreadsheet row did not.
    if (user.emailVerifiedAt) {
      console.log(`  ${row.username}: address is verified — refusing to replace it.`)
      continue
    }

    // Someone else may already hold this address. Unverified holders lose it to
    // whoever proves it (see `verifyEmailClaim`), but two rows can't share the column
    // in the meantime, so skip rather than fail the run.
    const holder = await prisma.user.findUnique({ where: { email: row.email } })
    if (holder && holder.id !== user.id) {
      console.error(`Line ${row.line}: ${row.email} is already on another account — skipped.`)
      continue
    }

    console.log(`  ${row.username} → ${row.email}${dryRun ? ' (dry run)' : ''}`)
    if (!dryRun) {
      await prisma.user.update({
        where: { id: user.id },
        // `emailVerifiedAt` stays null on purpose — see the header.
        data: { email: row.email },
      })
    }
    written += 1
  }
  return written
}

/** Mails a confirmation link to everyone holding an unverified address. */
async function sendConfirmations(dryRun: boolean): Promise<number> {
  const users = await prisma.user.findMany({
    where: { email: { not: null }, emailVerifiedAt: null },
    select: { id: true, username: true, email: true },
    orderBy: { createdAt: 'asc' },
  })

  console.log(`\n${users.length} accounts hold an unverified address.`)
  let sent = 0
  for (const user of users) {
    console.log(`  ${user.username} <${user.email}>${dryRun ? ' (dry run)' : ''}`)
    if (!dryRun) {
      // Reuse the app's own claim path rather than mailing something bespoke, so the
      // link, the TTL and the template are identical to the ones a user gets from
      // Profile — one mechanism, one thing to keep working.
      await claimEmail(user.id, user.email as string, 'en')
      // Trickle: shared mailboxes throttle per hour, and this is the same transport
      // `sendInvites.ts` deliberately paces itself on.
      await new Promise((resolve) => setTimeout(resolve, 1_500))
    }
    sent += 1
  }
  return sent
}

const USAGE = `Usage:
  npm run backfill:emails -- <invites.csv> [--force] [--dry-run]
  npm run backfill:emails -- --send [--dry-run]
  npm run backfill:emails -- <invites.csv> --send [--dry-run]`

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let dryRun = false
  let force = false
  let send = false
  let input: string | undefined

  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--force') force = true
    else if (arg === '--send') send = true
    else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}\n\n${USAGE}`)
      process.exitCode = 1
      return
    } else input = arg.trim()
  }

  if (!input && !send) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }

  if (input) {
    const rows = readRows(input)
    console.log(`${rows.length} usable rows in ${input}.\n`)
    const written = await attach(rows, force, dryRun)
    console.log(`\n${written} accounts ${dryRun ? 'would get' : 'got'} an address.`)
  }

  if (send) {
    const sent = await sendConfirmations(dryRun)
    console.log(`\n${sent} confirmation links ${dryRun ? 'would be' : 'were'} sent.`)
    if (!dryRun) {
      console.log('Addresses stay unverified until each person opens their link.')
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
