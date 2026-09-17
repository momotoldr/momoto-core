/**
 * One-off operator CLI to seed the closed-beta tester accounts.
 *
 *   npm run seed:testers -- --count 50            # 50 numbered accounts
 *   npm run seed:testers -- testers.txt            # named accounts, one per line
 *
 * Two ways to say who gets an account. `--count N` invents them — "Tester 01" through
 * "Tester 50", usernames `tester01`… — which is what you want when the accounts are
 * handed out first and matched to people later. `--prefix` renames them.
 *
 * Otherwise pass a file of people and get exactly those. Two formats are accepted,
 * detected automatically.
 *
 * **A CSV** — the beta signup form's export, used as-is. Column names are matched
 * case-insensitively and ignore spaces/underscores, so `Email Address` and `email`
 * are the same column:
 *
 *   name        required — also accepts displayName / fullName / nama
 *   email       optional (but the point of using a CSV) — also accepts emailAddress
 *   username    optional — derived from the name when absent
 *
 * Any other column (a timestamp, a password from an earlier run) is ignored.
 *
 * **A plain list** — one display name per line, optionally with an address:
 *
 *   # One name per line
 *   Andi <andi@example.com>
 *   Sinta
 *
 * Accounts are independent. Nothing here pairs them: partner linking is done by the
 * testers themselves through the invite code in Profile, which is part of what the
 * beta is meant to exercise.
 *
 * ## Emails (optional, but do it)
 *
 * A line may carry an address in the usual mail form:
 *
 *   Andi <andi@example.com>
 *
 * The address is stored **unverified** — an operator typed it, which is precisely the
 * mistake verification exists to catch, so it grants nothing on its own. The tester
 * confirms it from Profile (or by opening the link a later `npm run backfill:emails
 * --send` mails them), and only then can they reset a forgotten password. If the
 * address turns out to be wrong, nothing is stuck: whoever actually owns the mailbox
 * can still prove it and takes the address from this account.
 *
 * Seeding an address is also what lets a second run *recognise* someone: without one
 * there is no key to match a person on, so re-running a names file mints a duplicate
 * set (`andi`, then `andi1`). With one, the account is skipped.
 *
 * An address also lets Google sign-in find the account — `POST /auth/google` matches on
 * googleId or email — so a tester who clicks the Google button lands on the account
 * seeded here rather than a fresh, empty one.
 *
 * Passwords are generated here and written to `<input>.credentials.csv` (mode 0600)
 * rather than printed, so they don't end up in shell scrollback or CI logs. Hand
 * them out, then delete it — this script cannot recover them later. Note testers sign
 * in with the generated *username*, not their email.
 *
 * Pair this with INVITE_ONLY=true, which shuts `POST /auth/register` so these are the
 * only accounts that can exist.
 */
import { randomInt } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

import { hashPassword } from '../src/auth/passwords.js'
import { prisma } from '../src/db/client.js'
import { isValidEmail, normalizeEmail } from '../src/lib/email.js'

import { columnIndex, looksLikeCsv, readCsvTable, toCsvRow } from './csv.js'

/** Mirrors the signup rules in `http/routes/auth.ts` — usernames are `^[a-z0-9]{3,20}$`. */
const USERNAME_RE = /^[a-z0-9]{3,20}$/
const MAX_DISPLAY_NAME = 60

/** No 0/O/1/l/I — these get read aloud and typed by hand off a phone screen. */
const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
const PASSWORD_LENGTH = 14

interface Person {
  line: number
  displayName: string
  /** Optional; stored unverified. See the header. */
  email: string | null
  /** From a CSV `username` column. Null means "derive one from the display name". */
  username: string | null
}

interface Seeded {
  username: string
  password: string
  displayName: string
  email: string | null
}

function generatePassword(): string {
  let out = ''
  for (let i = 0; i < PASSWORD_LENGTH; i++) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]
  }
  return out
}

/** Same shape as the server's generator, minus the export — see `auth.ts`. */
async function uniqueUsername(base: string, taken: Set<string>): Promise<string> {
  const root = (base.toLowerCase().replace(/[^a-z0-9]/g, '') || 'tester').slice(0, 16) || 'tester'
  const padded = root.length >= 3 ? root : `${root}user`.slice(0, 20)
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const candidate = attempt === 0 ? padded : `${padded}${attempt}`.slice(0, 20)
    if (!USERNAME_RE.test(candidate)) continue
    if (taken.has(candidate)) continue
    if (await prisma.user.findUnique({ where: { username: candidate } })) continue
    return candidate
  }
  throw new Error(`Could not derive a free username from "${base}".`)
}

/** `Andi <andi@example.com>` → name + address. A bare name yields a null address. */
function parsePerson(line: string, lineNo: number): Person {
  const match = /^(.*?)\s*<([^>]+)>$/.exec(line)
  if (!match) {
    return {
      line: lineNo,
      displayName: line.slice(0, MAX_DISPLAY_NAME),
      email: null,
      username: null,
    }
  }

  const displayName = (match[1] ?? '').trim()
  const email = normalizeEmail(match[2])
  if (!displayName) {
    throw new Error(`Line ${lineNo}: an address needs a name in front of it — got "${line}".`)
  }
  if (!isValidEmail(email)) {
    throw new Error(`Line ${lineNo}: "${match[2]}" doesn't look like an email address.`)
  }
  return {
    line: lineNo,
    displayName: displayName.slice(0, MAX_DISPLAY_NAME),
    email,
    username: null,
  }
}

/** Reads the signup form's export. See the header for the columns. */
function parseCsvPeople(text: string): Person[] {
  const { header, rows } = readCsvTable(text)
  const nameAt = columnIndex(header, 'displayname', 'name', 'fullname', 'nama')
  const emailAt = columnIndex(header, 'email', 'emailaddress', 'mail')
  const usernameAt = columnIndex(header, 'username', 'handle')

  if (nameAt === -1) {
    throw new Error(
      `The CSV needs a name column (name / displayName / fullName / nama).\nFound: ${header.join(', ')}`,
    )
  }

  const people: Person[] = []
  for (const { line, cells } of rows) {
    const displayName = (cells[nameAt] ?? '').trim()
    if (!displayName) continue // a trailing blank row from the spreadsheet

    const rawEmail = emailAt >= 0 ? normalizeEmail(cells[emailAt]) : ''
    if (rawEmail && !isValidEmail(rawEmail)) {
      throw new Error(`Line ${line}: "${rawEmail}" doesn't look like an email address.`)
    }

    // A supplied username is honoured when it fits the rules; otherwise stop rather
    // than silently seeding someone under a handle they didn't ask for.
    const rawUsername = usernameAt >= 0 ? (cells[usernameAt] ?? '').trim().toLowerCase() : ''
    if (rawUsername && !USERNAME_RE.test(rawUsername)) {
      throw new Error(
        `Line ${line}: username "${rawUsername}" must be 3–20 lowercase letters/digits.`,
      )
    }

    people.push({
      line,
      displayName: displayName.slice(0, MAX_DISPLAY_NAME),
      email: rawEmail || null,
      username: rawUsername || null,
    })
  }
  return people
}

function parseNames(input: string): Person[] {
  const people: Person[] = []

  input.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return

    // One person per line. A comma here means the file is in some columnar shape the
    // CSV detector didn't recognise — worth stopping for rather than seeding
    // "Andi,andi@example.com" as somebody's display name.
    if (line.includes(',')) {
      throw new Error(
        `Line ${i + 1}: one person per line, no commas — got "${line}".\n` +
          'If this is a CSV, give it a header row (name,email) so it is read as one.',
      )
    }
    people.push(parsePerson(line, i + 1))
  })
  return people
}

/**
 * Refuses a batch that would fail partway through. Two accounts can't share an
 * address or a username (both columns are uniquely indexed), and finding that out on
 * row 30 leaves half a batch seeded with a credentials file to reconcile by hand.
 */
function assertNoDuplicates(people: Person[]): void {
  const emails = new Map<string, number>()
  const usernames = new Map<string, number>()

  for (const person of people) {
    if (person.email) {
      const earlier = emails.get(person.email)
      if (earlier) {
        throw new Error(`Line ${person.line}: ${person.email} is already used on line ${earlier}.`)
      }
      emails.set(person.email, person.line)
    }
    if (person.username) {
      const earlier = usernames.get(person.username)
      if (earlier) {
        throw new Error(
          `Line ${person.line}: username "${person.username}" is already used on line ${earlier}.`,
        )
      }
      usernames.set(person.username, person.line)
    }
  }
}

async function createTester(person: Person, taken: Set<string>): Promise<Seeded> {
  // A username from the CSV is used as given — an operator who supplied one means it,
  // and quietly appending a digit would hand the tester different credentials from
  // the ones on the sheet they are reading. Collisions stop the run instead.
  if (person.username) {
    if (
      taken.has(person.username) ||
      (await prisma.user.findUnique({ where: { username: person.username } }))
    ) {
      throw new Error(`Line ${person.line}: username "${person.username}" is already taken.`)
    }
  }
  const username = person.username ?? (await uniqueUsername(person.displayName, taken))
  taken.add(username)
  const password = generatePassword()

  await prisma.user.create({
    data: {
      username,
      displayName: person.displayName,
      passwordHash: await hashPassword(password),
      // `emailVerifiedAt` is deliberately left null — see the header. The address is
      // a convenience for the operator and a head start for the tester, not proof.
      email: person.email,
    },
  })

  return { username, password, displayName: person.displayName, email: person.email }
}

/**
 * Loads the names file, or exits with an explanation. Both failures here are first-run
 * mistakes rather than bugs, so they get a message instead of a stack trace.
 */
function readNames(input: string): Person[] {
  let raw: string
  try {
    raw = readFileSync(input, 'utf8')
  } catch (err) {
    // The bare ENOENT reads like a bug in the script rather than a missing input file,
    // which is the actual (and very common) case on a first run.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error(
        `No such file: ${input}\n\n` +
          `Expected either the signup form's CSV export or a plain list, relative to ${process.cwd()}:\n` +
          '\n  name,email\n  Andi,andi@example.com\n\nor\n\n  Andi <andi@example.com>\n  Sinta Dewi\n\n' +
          'Or skip the file entirely and use --count 50 for numbered accounts.',
      )
      process.exit(1)
    }
    throw err
  }

  // One argument, two formats: the signup form's CSV export or a plain list. The
  // header row is what tells them apart — see `looksLikeCsv`.
  const isCsv = looksLikeCsv(raw, 'email', 'emailaddress', 'name', 'displayname', 'nama')
  const people = isCsv ? parseCsvPeople(raw) : parseNames(raw)
  console.log(`Reading ${input} as ${isCsv ? 'a CSV' : 'a plain name list'}.`)
  assertNoDuplicates(people)
  if (people.length === 0) {
    console.error(
      `${input} has no people in it.\n\n` +
        'Expected either a CSV with a header row (name,email) or one display name per\n' +
        'line; blank lines and #comments are ignored.\n' +
        'If you created it with `cat > file` and pressed Ctrl+D, it saved empty.',
    )
    process.exit(1)
  }
  return people
}

const USAGE = `Usage:
  npm run seed:testers -- --count 50 [--prefix Tester] [--out FILE] [--dry-run]
  npm run seed:testers -- <testers.txt> [--out FILE] [--dry-run]

testers.txt is one person per line; add an address to make the account recoverable:
  Andi <andi@example.com>
  Sinta Dewi`

/** Names for `--count`: "Tester 01".."Tester 50", widened to fit three digits at 100+. */
function generateNames(count: number, prefix: string): Person[] {
  const width = String(count).length
  return Array.from({ length: count }, (_, i) => ({
    line: i + 1,
    displayName: `${prefix} ${String(i + 1).padStart(width, '0')}`.slice(0, MAX_DISPLAY_NAME),
    email: null,
    username: null,
  }))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let dryRun = false
  let input: string | undefined
  let count: number | undefined
  let prefix = 'Tester'
  let out: string | undefined

  // Hand-rolled rather than a parser dependency: three options, and both `--count 50`
  // and `--count=50` should work because both get typed.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--count') count = Number(args[++i])
    else if (arg.startsWith('--count=')) count = Number(arg.slice('--count='.length))
    else if (arg === '--prefix') prefix = String(args[++i] ?? prefix)
    else if (arg.startsWith('--prefix=')) prefix = arg.slice('--prefix='.length)
    else if (arg === '--out') out = String(args[++i] ?? '')
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}\n\n${USAGE}`)
      process.exitCode = 1
      return
    } else input = arg.trim()
  }

  if (input && count !== undefined) {
    console.error(`Pass a names file or --count, not both.\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  if (!input && count === undefined) {
    console.error(USAGE)
    process.exitCode = 1
    return
  }
  if (count !== undefined && (!Number.isInteger(count) || count < 1 || count > 500)) {
    console.error(
      `--count must be a whole number between 1 and 500 (got "${args[args.indexOf('--count') + 1] ?? count}").`,
    )
    process.exitCode = 1
    return
  }

  const people = count !== undefined ? generateNames(count, prefix) : readNames(input as string)
  const label = count !== undefined ? `--count ${count}` : (input as string)

  console.log(`${people.length} accounts to seed from ${label}.`)

  if (dryRun) {
    for (const person of people) {
      console.log(`  ${person.displayName}${person.email ? ` <${person.email}>` : ''}`)
    }
    console.log('\nDry run — nothing written.')
    return
  }

  // Usernames derived in this run aren't in the DB yet, so the uniqueness probe needs
  // its own memory of what it just handed out (two testers named "Andi", say).
  // An address is the only key we can match a person on, so it's also the only way to
  // make a re-run idempotent. Names alone can't be — two testers really can be called
  // Andi — so people without one are still seeded every time.
  const withEmail = people.filter((p): p is Person & { email: string } => p.email !== null)
  const existing = withEmail.length
    ? new Set(
        (
          await prisma.user.findMany({
            where: { email: { in: withEmail.map((p) => p.email) } },
            select: { email: true },
          })
        ).map((u) => u.email as string),
      )
    : new Set<string>()
  const toSeed = people.filter((p) => !(p.email && existing.has(p.email)))
  if (toSeed.length !== people.length) {
    console.log(`${people.length - toSeed.length} already seeded (matched by email) — skipping.`)
  }

  const taken = new Set<string>()
  const credentials: Seeded[] = []
  const outPath = out || (input ? `${input}.credentials.csv` : 'testers.credentials.csv')

  // These passwords exist nowhere else — the database has argon2 hashes and nothing that
  // can be read back. Overwriting an earlier batch's file would destroy the only copy of
  // its credentials, so refuse rather than clobber. Checked before any account is created.
  if (existsSync(outPath)) {
    console.error(
      `${outPath} already exists, and its passwords cannot be recovered from the database.\n\n` +
        'Seed this batch to its own file instead:\n' +
        `  npm run seed:testers -- ${input ?? `--count ${count}`} --out batch2.credentials.csv\n\n` +
        'Or move the existing file somewhere safe first.',
    )
    process.exitCode = 1
    return
  }

  // Column order and names match what `npm run send:invites` reads, so this file goes
  // straight to it with no spreadsheet join in between — provided every row has an
  // address, since that script requires one. Rows without an email have to be dropped
  // first; the closing summary says how many there are.
  const writeCredentials = (): void => {
    const rows = [
      'displayName,username,password,email',
      ...credentials.map((c) => toCsvRow([c.displayName, c.username, c.password, c.email])),
    ]
    writeFileSync(outPath, `${rows.join('\n')}\n`, { mode: 0o600 })
  }

  try {
    for (const person of toSeed) {
      credentials.push(await createTester(person, taken))
    }
  } catch (err) {
    // A row is already in the database by the time anything downstream can fail, and its
    // password exists nowhere else — losing it here would strand an account nobody can
    // sign into. Save what succeeded before letting the error surface.
    if (credentials.length > 0) {
      writeCredentials()
      console.error(
        `\nFailed partway through. ${credentials.length} accounts were created and their` +
          ` credentials saved to ${outPath} — the rest were not.\n`,
      )
    }
    throw err
  }

  writeCredentials()

  console.log(`\nCreated ${credentials.length} accounts.`)
  console.log(`Credentials written to ${outPath} (owner-read only).`)
  console.log(
    'Hand them out, then delete that file — the passwords are not recoverable from the DB.',
  )
  // Re-running is only safe for the rows that carry an address — that's the only key
  // there is to match a person on. Say which is which now, while the file is in hand.
  const nameless = credentials.filter((c) => !c.email).length
  if (nameless > 0) {
    console.log(
      `\n${nameless} of these have no email. Running this again would create a SECOND` +
        ' account for each of them rather than recognising them, and they cannot reset a' +
        ' forgotten password until they add an address in Profile.',
    )
  }
  if (credentials.length > nameless) {
    console.log(
      '\nSeeded addresses are stored UNVERIFIED — they prove nothing until the tester' +
        ' confirms one. Mail the confirmation links with:\n  npm run backfill:emails -- --send',
    )
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
