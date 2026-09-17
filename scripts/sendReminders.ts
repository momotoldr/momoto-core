/**
 * Operator CLI to nudge people who have an account but have never made a strip.
 *
 *   npm run send:reminders -- --dry-run            # list them, render one, send nothing
 *   npm run send:reminders -- --limit 10           # first wave
 *   npm run send:reminders -- --lang id            # Indonesian copy
 *   npm run send:reminders -- --min-age-days 14    # only accounts older than that
 *
 * Unlike `send:invites`, the audience comes from the **database**, not a CSV: there is
 * no spreadsheet of who has and hasn't shot, and one that existed would be stale by the
 * time a wave went out.
 *
 * ## Who gets one
 *
 * An account with all four of:
 *
 *   - an email address on the row      — no address, nowhere to send. This silently
 *                                        excludes every seeded *partner* account: the
 *                                        beta only ever collected the registrant's
 *                                        address, so the second login has none.
 *   - no Strip rows at all             — the actual definition of "hasn't tried it"
 *   - role USER                        — never the operator's own admin accounts
 *   - created more than N days ago     — 7 by default. Somebody who signed up
 *                                        yesterday hasn't ignored anything yet.
 *
 * Addresses are mailed **whether or not they are verified**. Nearly every beta address
 * was typed in by an operator from the signup form and is unverified by definition, so
 * requiring proof here would cut the list to almost nobody. It is the same set of
 * addresses the invitation already reached.
 *
 * ## What it deliberately doesn't carry
 *
 * No password, no login token, no per-user link — just the booth URL. This is the one
 * message that goes to an unproven address, so a copy that lands in the wrong inbox
 * has to be worth nothing.
 *
 * ## Re-running is safe
 *
 * Every success is appended to a log file (`reminders.sent.log` by default, `--log` to
 * change it) and skipped next time, so a run that dies halfway can be resumed without
 * mailing the first half twice. Someone who takes a strip after being mailed drops out
 * of the query on their own. Delete the log to deliberately send a second wave.
 *
 * Credentials: none here. The mail goes out through momoto-notify, so this needs
 * NOTIFY_URL (and NOTIFY_API_KEY) — the same variables the app itself uses.
 *
 * ## Running it against the deployed database
 *
 * `loadEnv` reads `.env.local` before `.env` and dotenv never overrides, so on a
 * developer machine this reads **localhost** and reports a confident zero. Every other
 * operator script takes its audience from a CSV and never noticed. A real environment
 * variable beats both files, so pass one — note the `tr -d '"'`, because the value in
 * `.env` is quoted and Prisma rejects the quotes as part of the URL:
 *
 *   DATABASE_URL=$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"') \
 *     npm run send:reminders -- --dry-run --lang id --min-age-days 5
 *
 * Every run prints the host it read, so a zero is never ambiguous. Sending happens from
 * a laptop rather than Railway: `NOTIFY_URL` points at a local momoto-notify, which is
 * where the SMTP credentials live.
 */
import '../src/config/loadEnv.js'

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

import { prisma } from '../src/db/client.js'
import { normalizeLang } from '../src/notifications/lang.js'
import { previewBoothReminder, sendBoothReminder } from '../src/notifications/client.js'

/** Between sends. Shared mailboxes throttle per hour; trickling stays well clear. */
const DEFAULT_DELAY_MS = 1_500

/** How settled an account has to be before silence means anything. */
const DEFAULT_MIN_AGE_DAYS = 7

const DEFAULT_LOG = 'reminders.sent.log'

interface Recipient {
  email: string
  displayName: string
  createdAt: Date
}

/**
 * Which database this is about to read. Printed, because the answer is not obvious.
 *
 * `loadEnv` reads `.env.local` before `.env` and dotenv never overrides, so a developer
 * machine with a local database silently wins over the deployed one. Every other
 * operator script takes its audience from a CSV and doesn't care; this one *is* a
 * query, and against the wrong database it reports a confident, wrong zero.
 *
 * Host and database name only — a connection string carries the password.
 */
function databaseLabel(): string {
  const raw = process.env.DATABASE_URL?.trim()
  if (!raw) return 'unknown (DATABASE_URL is not set)'
  try {
    const parsed = new URL(raw)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return 'unparseable DATABASE_URL'
  }
}

/**
 * Everyone with an address who has never made a strip.
 *
 * `strips: { none: {} }` is the whole definition — a left join Prisma compiles to a
 * NOT EXISTS, so it stays one query however many strips the table holds.
 *
 * The age cutoff is applied here rather than in the query so the caller can say how
 * many accounts it held back. A wave that mails three people out of forty-two is
 * usually a cutoff that doesn't match how long ago the invitations went out, and that
 * is invisible if the excluded rows never come back.
 */
async function findRecipients(
  minAgeDays: number,
): Promise<{ recipients: Recipient[]; tooYoung: number }> {
  const cutoff = new Date(Date.now() - minAgeDays * 24 * 60 * 60 * 1000)

  const users = await prisma.user.findMany({
    where: {
      email: { not: null },
      strips: { none: {} },
      role: 'USER',
    },
    select: { email: true, displayName: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  })

  // `email` is `String?` in the schema and narrowing it in the query doesn't narrow the
  // type, so the filter below is what makes the non-null assertion honest.
  const eligible = users
    .filter((u): u is typeof u & { email: string } => Boolean(u.email))
    .map((u) => ({ email: u.email, displayName: u.displayName, createdAt: u.createdAt }))

  return {
    recipients: eligible.filter((r) => r.createdAt < cutoff),
    tooYoung: eligible.filter((r) => r.createdAt >= cutoff).length,
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Is the notification service actually there? Asked once, before the wave starts.
 *
 * `/healthz` needs no API key, so this separates "the service is down" from "the key is
 * wrong" — two failures that otherwise arrive as the same unhelpful line.
 */
async function serviceIsUp(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/healthz`, {
      signal: AbortSignal.timeout(4_000),
    })
    return res.ok
  } catch {
    return false
  }
}

const days = (since: Date): number =>
  Math.floor((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000))

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let dryRun = false
  let limit = Infinity
  let lang = 'en'
  let delayMs = DEFAULT_DELAY_MS
  let minAgeDays = DEFAULT_MIN_AGE_DAYS
  let logPath = DEFAULT_LOG

  const value = (inline: string, prefix: string, next: string | undefined): string =>
    inline.startsWith(prefix) ? inline.slice(prefix.length) : String(next ?? '')

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--limit' || arg.startsWith('--limit='))
      limit = Number(value(arg, '--limit=', args[arg === '--limit' ? ++i : i]))
    else if (arg === '--lang' || arg.startsWith('--lang='))
      lang = value(arg, '--lang=', args[arg === '--lang' ? ++i : i]) || lang
    else if (arg === '--delay' || arg.startsWith('--delay='))
      delayMs = Number(value(arg, '--delay=', args[arg === '--delay' ? ++i : i]))
    else if (arg === '--min-age-days' || arg.startsWith('--min-age-days='))
      minAgeDays = Number(value(arg, '--min-age-days=', args[arg === '--min-age-days' ? ++i : i]))
    else if (arg === '--log' || arg.startsWith('--log='))
      logPath = value(arg, '--log=', args[arg === '--log' ? ++i : i]) || logPath
    else {
      console.error(`Unknown option: ${arg}`)
      console.error(
        'Usage: npm run send:reminders -- [--dry-run] [--limit N] [--lang en|id]\n' +
          '                                  [--min-age-days N] [--delay MS] [--log FILE]',
      )
      process.exitCode = 1
      return
    }
  }

  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
    console.error('--min-age-days must be a number of days, 0 or more.')
    process.exitCode = 1
    return
  }

  console.log(`Reading ${databaseLabel()}`)

  const { recipients, tooYoung } = await findRecipients(minAgeDays)

  // Anyone already mailed by an earlier run. Keyed by address, so a resumed run after a
  // crash picks up exactly where it stopped.
  const alreadySent = new Set(
    existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .split('\n')
          .map((l) => l.trim().split(' ')[0] ?? '')
          .filter(Boolean)
      : [],
  )

  const pending = recipients.filter((r) => !alreadySent.has(r.email))
  const batch = pending.slice(0, Number.isFinite(limit) ? limit : undefined)

  console.log(
    `${recipients.length} account(s) with an address, no strip, and older than ` +
      `${minAgeDays} day(s) — ${recipients.length - pending.length} already reminded, ` +
      `${pending.length} pending, sending ${batch.length} now in [${normalizeLang(lang)}].`,
  )
  if (tooYoung > 0) {
    console.log(
      `${tooYoung} more would qualify but are newer than ${minAgeDays} day(s) — ` +
        `pass --min-age-days to include them.`,
    )
  }
  if (batch.length === 0) {
    console.log('Nothing to do.')
    return
  }

  if (dryRun) {
    for (const r of batch) {
      console.log(`  ${r.email.padEnd(34)} ${r.displayName.padEnd(20)} ${days(r.createdAt)}d old`)
    }
    const first = batch[0]
    if (first) {
      // The templates live in momoto-notify, so the preview has to be rendered there
      // too — eyeballing the real thing before mailing everyone is the whole point of
      // --dry-run, and it would be worthless rendering a copy.
      const rendered = await previewBoothReminder(
        first.email,
        first.displayName,
        normalizeLang(lang),
      )
      if (!rendered) {
        console.error(
          '\nCould not reach the notification service to render a preview.\n' +
            'Set NOTIFY_URL (and NOTIFY_API_KEY) and make sure momoto-notify is running.',
        )
        process.exitCode = 1
        return
      }
      const preview = `${logPath}.preview.html`
      writeFileSync(preview, rendered.html)
      console.log(`\nRendered the first email to ${preview} — open it to check.`)
      console.log(`Subject would be: "${rendered.subject}"`)
    }
    console.log('\nDry run — nothing sent.')
    return
  }

  const notifyUrl = process.env.NOTIFY_URL?.trim()
  if (!notifyUrl) {
    console.error(
      'NOTIFY_URL is not set, so nothing would actually be mailed.\n\n' +
        'Point it at momoto-notify (and set NOTIFY_API_KEY to match), or re-run with\n' +
        '--dry-run to render without sending.',
    )
    process.exitCode = 1
    return
  }

  // Preflight, before anybody is mailed.
  //
  // Without it, a service that isn't running surfaces as a per-recipient "did not
  // accept it" on the first address in the wave — which reads like a problem with that
  // person, and buries the actual cause (ECONNREFUSED) in a log line above. Cheap to
  // ask once, and it turns the common local failure — forgot to start momoto-notify,
  // or its terminal was closed mid-wave — into a sentence that says what to do.
  if (!(await serviceIsUp(notifyUrl))) {
    console.error(
      `momoto-notify is not answering at ${notifyUrl}.\n\n` +
        'Start it in its own terminal and leave that terminal open for the whole wave:\n' +
        '  cd ../momoto-notify && npm run dev\n\n' +
        'Nothing has been sent.',
    )
    process.exitCode = 1
    return
  }

  let sent = 0

  for (const r of batch) {
    // `notify` never throws — a mail service that is down must not take a request
    // handler with it. That contract is wrong for this script, whose whole purpose is
    // the send, so check acceptance here and stop the wave rather than logging fifty
    // silent failures.
    const accepted = await sendBoothReminder(r.email, r.displayName, normalizeLang(lang))
    if (!accepted) {
      console.error(`  FAILED → ${r.email}: the notification service did not accept it`)
      console.error(`\nStopped after ${sent} sent. Fix the problem and re-run — everyone`)
      console.error(`already mailed is recorded in ${logPath} and will be skipped.`)
      process.exitCode = 1
      return
    }
    // Record before the next send, so a crash can't lose the fact that this one went.
    appendFileSync(logPath, `${r.email} ${new Date().toISOString()}\n`)
    sent++
    console.log(`  queued → ${r.email}`)

    if (r !== batch[batch.length - 1]) await sleep(delayMs)
  }

  console.log(`\nSent ${sent} reminder(s). Recorded in ${logPath}.`)
  const remaining = pending.length - sent
  if (remaining > 0) {
    console.log(`${remaining} still pending — re-run to continue.`)
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
