/**
 * One-off operator CLI to send the closed-beta invitations, one personalised email per
 * row, over your own SMTP (Hostinger, Gmail, anything).
 *
 *   npm run send:invites -- invites.csv --dry-run       # render + list, send nothing
 *   npm run send:invites -- invites.csv --limit 10      # first wave
 *   npm run send:invites -- invites.csv                 # the rest
 *
 * This is a mail *merge*, not a blast: every message carries that person's own password,
 * so each is addressed to exactly one recipient. Nothing is ever BCC'd.
 *
 * ## Input
 *
 * A CSV with a header row. Column names are matched case-insensitively, and quoted
 * fields are handled, so a spreadsheet export can be used as-is:
 *
 *   email           required
 *   username        required
 *   password        required
 *   displayName     optional — also accepts `name`; falls back to the username
 *   lang            optional — `en` or `id`; falls back to --lang (default en)
 *   partnerUsername optional — a second login, printed in the same email
 *   partnerPassword optional — required with partnerUsername, refused without it
 *
 * The layout produced by joining your signup form to `testers.txt.credentials.csv`
 * already fits.
 *
 * The partner columns exist because the beta seeds two accounts per registrant but
 * only ever collected one address: there is nobody to mail the second set to, so it
 * rides along in the same message and the registrant passes it on. Leave both
 * columns out and the mail renders exactly as it did before, partner section and
 * all, dropped.
 *
 * ## Credentials
 *
 * Read from the environment, never from the CSV or the command line:
 *
 *   SMTP_HOST   e.g. smtp.hostinger.com
 *   SMTP_PORT   465 (implicit TLS) or 587 (STARTTLS)
 *   SMTP_USER   e.g. contact@momotoldr.com
 *   SMTP_PASS   the mailbox password
 *   SMTP_FROM     optional display form, e.g. "Momoto <noreply@momotoldr.com>"
 *   SMTP_REPLY_TO optional, e.g. contact@momotoldr.com — lets From be a no-reply
 *                 while replies still reach a mailbox someone reads
 *
 * Put them in `momoto-core/.env`, which is gitignored.
 *
 * ## Confirming the address
 *
 * This mail carries **no confirmation link** — it only tells people they can confirm
 * their address and change their password in Profile once they're in. Keeping the
 * link out means this script needs nothing but the CSV and SMTP; the confirmation is
 * its own email, sent by the app when the user asks for it (or in bulk by
 * `npm run backfill:emails -- --send`).
 *
 * Confirming is what switches on `/forgot-password` for an account: an address an
 * operator attached from a spreadsheet is unproven until the person opens a link.
 *
 * ## Re-running is safe
 *
 * Every success is appended to `<input>.sent.log` and skipped next time, so a run that
 * dies at row 30 can be resumed without mailing the first 29 twice. Delete that file to
 * deliberately send again.
 */
import '../src/config/loadEnv.js'

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'

import { notify, previewNotification } from '../src/notifications/client.js'
import { normalizeLang } from '../src/notifications/lang.js'

import { columnIndex, readCsvTable } from './csv.js'

/** Between sends. Shared mailboxes throttle per hour; trickling stays well clear. */
const DEFAULT_DELAY_MS = 1_500

interface Invite {
  line: number
  email: string
  username: string
  password: string
  displayName: string
  lang: string
  /** The partner's login, when the batch seeded a second account. Both or neither. */
  partnerUsername: string | null
  partnerPassword: string | null
}

/**
 * Reads the invite CSV. Column names are matched case-insensitively and ignore
 * spaces/underscores, so a spreadsheet export works unedited.
 *
 *   email       required
 *   username    required
 *   password    required
 *   displayName optional — also accepts `name`; falls back to the username
 *   lang        optional — `en` or `id`; falls back to --lang
 */
function parseInvites(text: string, fallbackLang: string): Invite[] {
  const { header, rows } = readCsvTable(text)
  const at = {
    email: columnIndex(header, 'email', 'emailaddress', 'mail'),
    username: columnIndex(header, 'username', 'handle'),
    password: columnIndex(header, 'password'),
    displayName: columnIndex(header, 'displayname', 'name', 'fullname', 'nama'),
    lang: columnIndex(header, 'lang', 'language'),
    partnerUsername: columnIndex(header, 'partnerusername'),
    partnerPassword: columnIndex(header, 'partnerpassword'),
  }

  const missing = (['email', 'username', 'password'] as const).filter((k) => at[k] === -1)
  if (missing.length > 0) {
    throw new Error(`Missing column(s): ${missing.join(', ')}.\nFound: ${header.join(', ')}`)
  }

  const invites: Invite[] = []
  for (const { line, cells } of rows) {
    const email = (cells[at.email] ?? '').trim().toLowerCase()
    const username = (cells[at.username] ?? '').trim()
    const password = cells[at.password] ?? ''
    if (!email && !username && !password) continue // trailing blank row

    // Every message carries one person's own password, so a row we can't fully
    // identify is never "close enough" to send — stop and let the operator fix it.
    if (!email.includes('@'))
      throw new Error(`Line ${line}: "${email}" is not a valid email address.`)
    if (!username) throw new Error(`Line ${line}: missing username.`)
    if (!password) throw new Error(`Line ${line}: missing password.`)

    const displayName =
      (at.displayName >= 0 ? (cells[at.displayName] ?? '').trim() : '') || username
    const langCell = at.lang >= 0 ? (cells[at.lang] ?? '').trim().toLowerCase() : ''

    // Both columns move together. Half a pair means the file was joined wrong, and the
    // result would be a credentials box in someone's inbox with no password in it —
    // worth stopping the wave for, the same as a missing password of their own.
    const partnerUsername = at.partnerUsername >= 0 ? (cells[at.partnerUsername] ?? '').trim() : ''
    const partnerPassword = at.partnerPassword >= 0 ? (cells[at.partnerPassword] ?? '') : ''
    if (Boolean(partnerUsername) !== Boolean(partnerPassword)) {
      throw new Error(`Line ${line}: needs both partnerUsername and partnerPassword, or neither.`)
    }

    invites.push({
      line,
      email,
      username,
      password,
      displayName,
      lang: langCell || fallbackLang,
      partnerUsername: partnerUsername || null,
      partnerPassword: partnerPassword || null,
    })
  }
  return invites
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let dryRun = false
  let input: string | undefined
  let limit = Infinity
  let lang = 'en'
  let delayMs = DEFAULT_DELAY_MS

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? ''
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--limit') limit = Number(args[++i])
    else if (arg.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length))
    else if (arg === '--lang') lang = String(args[++i] ?? lang)
    else if (arg.startsWith('--lang=')) lang = arg.slice('--lang='.length)
    else if (arg === '--delay') delayMs = Number(args[++i])
    else if (arg.startsWith('--delay=')) delayMs = Number(arg.slice('--delay='.length))
    else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`)
      process.exitCode = 1
      return
    } else input = arg.trim()
  }

  if (!input) {
    console.error(
      'Usage: npm run send:invites -- <invites.csv> [--dry-run] [--limit N] [--lang en|id] [--delay MS]',
    )
    process.exitCode = 1
    return
  }
  if (!existsSync(input)) {
    console.error(`No such file: ${input}`)
    process.exitCode = 1
    return
  }

  const invites = parseInvites(readFileSync(input, 'utf8'), lang)

  // Anyone already mailed by an earlier run. Keyed by address, so a resumed run after a
  // crash picks up exactly where it stopped.
  const sentPath = `${input}.sent.log`
  const alreadySent = new Set(
    existsSync(sentPath)
      ? readFileSync(sentPath, 'utf8')
          .split('\n')
          .map((l) => l.trim().split(' ')[0] ?? '')
          .filter(Boolean)
      : [],
  )

  const pending = invites.filter((i) => !alreadySent.has(i.email))
  const batch = pending.slice(0, Number.isFinite(limit) ? limit : undefined)

  console.log(
    `${invites.length} invites in ${input} — ${alreadySent.size} already sent, ` +
      `${pending.length} pending, sending ${batch.length} now.`,
  )
  if (batch.length === 0) {
    console.log('Nothing to do.')
    return
  }

  const payloadFor = (invite: Invite) => ({
    type: 'beta_invite' as const,
    data: {
      displayName: invite.displayName,
      username: invite.username,
      password: invite.password,
      // Omitted rather than sent empty: the template drops its whole partner section
      // when these are absent, so a single-account row still renders correctly.
      ...(invite.partnerUsername && invite.partnerPassword
        ? { partnerUsername: invite.partnerUsername, partnerPassword: invite.partnerPassword }
        : {}),
    },
  })

  if (dryRun) {
    for (const invite of batch) {
      console.log(
        `  ${invite.email.padEnd(34)} ${invite.username.padEnd(16)} ` +
          `${(invite.partnerUsername ?? '—').padEnd(16)} [${invite.lang}]`,
      )
    }
    const first = batch[0]
    if (first) {
      // The templates live in momoto-notify now, so the preview has to be rendered
      // there too — this check (eyeball the real thing before mailing 50 people) is
      // the whole point of --dry-run, and it would be worthless rendering a copy.
      const rendered = await previewNotification(
        first.email,
        normalizeLang(first.lang),
        payloadFor(first),
      )
      if (!rendered) {
        console.error(
          '\nCould not reach the notification service to render a preview.\n' +
            'Set NOTIFY_URL (and NOTIFY_API_KEY) and make sure momoto-notify is running.',
        )
        process.exitCode = 1
        return
      }
      const preview = `${input}.preview.html`
      writeFileSync(preview, rendered.html)
      console.log(`\nRendered the first email to ${preview} — open it to check.`)
      console.log(`Subject would be: "${rendered.subject}"`)
    }
    console.log('\nDry run — nothing sent.')
    return
  }

  if (!process.env.NOTIFY_URL?.trim()) {
    console.error(
      'NOTIFY_URL is not set, so nothing would actually be mailed.\n\n' +
        'Point it at momoto-notify (and set NOTIFY_API_KEY to match), or re-run with\n' +
        '--dry-run to render without sending.',
    )
    process.exitCode = 1
    return
  }

  let sent = 0

  for (const invite of batch) {
    // `notify` never throws — a mail service that is down must not take a request
    // handler with it. That contract is wrong for this script, which is a deliberate
    // operator action whose whole purpose is the send, so check acceptance here and
    // stop the wave rather than logging 50 silent failures.
    const accepted = await notify(invite.email, normalizeLang(invite.lang), payloadFor(invite))
    if (!accepted) {
      console.error(`  FAILED → ${invite.email}: the notification service did not accept it`)
      console.error(`\nStopped after ${sent} sent. Fix the problem and re-run — everyone`)
      console.error(`already mailed is recorded in ${sentPath} and will be skipped.`)
      process.exitCode = 1
      return
    }
    // Record before the next send, so a crash can't lose the fact that this one went.
    appendFileSync(sentPath, `${invite.email} ${new Date().toISOString()}\n`)
    sent++
    console.log(`  queued → ${invite.email}`)

    if (invite !== batch[batch.length - 1]) await sleep(delayMs)
  }

  console.log(`\nSent ${sent} invitations. Recorded in ${sentPath}.`)
  const remaining = pending.length - sent
  if (remaining > 0) {
    console.log(`${remaining} still pending — re-run to continue.`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
