/**
 * Verify this app can actually reach `momoto-notify`, and say precisely what's wrong
 * when it can't.
 *
 *   npm run check:notify                       # config + connectivity
 *   npm run check:notify -- you@example.com    # also send a real test email
 *
 * **Run it from the backend's own environment** — a Railway/Render shell attached to
 * `momoto-core`, or `railway run npm run check:notify`. The notification service is
 * deliberately private, so it cannot be curled from a laptop; the only vantage point
 * that proves anything is the one place allowed to talk to it.
 *
 * This exists because the failure it diagnoses is silent by design. Sends are
 * fire-and-forget so a dead mail service can never fail a signup, which means
 * `POST /auth/me/email` answers `202 {"ok":true}` whether the message flew or fell on
 * the floor. Something has to be able to ask the question directly.
 */
import { env } from '../src/config/env.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const ok = (msg: string): void => console.log(`${GREEN}✓${RESET} ${msg}`)
const bad = (msg: string): void => console.log(`${RED}✗${RESET} ${msg}`)
const warn = (msg: string): void => console.log(`${YELLOW}!${RESET} ${msg}`)
const hint = (msg: string): void => console.log(`  ${DIM}${msg}${RESET}`)

/** Turns a fetch failure into the one line that names the actual problem. */
function explain(err: unknown): void {
  if (err instanceof Error && err.name === 'AbortError') {
    bad('Timed out waiting for the service.')
    hint('It resolved and accepted a connection but did not answer in time.')
    hint('Right after a deploy this can be the private network still initialising —')
    hint('wait ~15s and re-run before looking further.')
    return
  }

  const cause = err instanceof Error ? (err.cause as NodeJS.ErrnoException | undefined) : undefined
  const code = cause?.code

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    bad(`Hostname does not resolve (${code}).`)
    hint('On Railway the internal name is <service-name>.railway.internal — it must be')
    hint('the service name exactly, and both services must be in the SAME project and')
    hint('environment. Private DNS resolves nowhere else, including your laptop.')
    return
  }
  if (code === 'ECONNREFUSED') {
    bad('Connection refused — the host resolved, but nothing is listening on that port.')
    hint('Two usual causes:')
    hint('  1. NOTIFY_URL is missing the port. Railway does not proxy private traffic,')
    hint('     so it must be http://<service>.railway.internal:<PORT>, not just the host.')
    hint('  2. The service is crash-looping. Check its deploy logs — a half-filled SMTP')
    hint('     config throws at boot on purpose rather than silently never sending.')
    return
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    bad(`Connection dropped (${code}). The service accepted then closed it.`)
    hint('Usually a container restarting mid-request.')
    return
  }

  bad(`Could not reach the service: ${err instanceof Error ? err.message : String(err)}`)
  if (code) hint(`Underlying error code: ${code}`)
}

async function main(): Promise<void> {
  const to = process.argv.slice(2).find((a) => !a.startsWith('-'))

  console.log('\nNotification service check\n')

  // ── 1. Is it configured at all? ──
  if (!env.notify) {
    bad('NOTIFY_URL is not set in this environment.')
    hint('Every send is currently a no-op that still reports success to the caller —')
    hint('this is the failure that looks exactly like everything working.')
    hint('')
    hint('Set NOTIFY_URL (and NOTIFY_API_KEY) on this service and REDEPLOY. The')
    hint('environment is read once at boot, so setting a variable without a restart')
    hint('changes nothing.')
    process.exitCode = 1
    return
  }
  ok(`NOTIFY_URL = ${env.notify.url}`)

  if (!/:\d+/.test(new URL(env.notify.url).host) && env.notify.url.includes('.internal')) {
    warn('That internal URL has no port.')
    hint('Railway does not proxy private traffic — add the port the service listens on,')
    hint('e.g. http://momoto-notify.railway.internal:3002')
  }
  if (!env.notify.apiKey) {
    warn('NOTIFY_API_KEY is not set — the service will only accept this if it also has none.')
  } else {
    ok('NOTIFY_API_KEY is set')
  }
  ok(`APP_BASE_URL = ${env.appBaseUrl}`)
  hint('Every emailed link is built from that. If it is wrong, the mail sends and the')
  hint('links go nowhere useful.')

  // ── 2. Can we reach it? ──
  console.log('')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  let health: Response
  try {
    health = await fetch(`${env.notify.url}/healthz`, { signal: controller.signal })
  } catch (err) {
    explain(err)
    process.exitCode = 1
    return
  } finally {
    clearTimeout(timer)
  }

  if (!health.ok) {
    bad(`/healthz answered ${health.status}.`)
    process.exitCode = 1
    return
  }
  const body = (await health.json()) as { status?: string; pending?: number }
  ok(`Reachable — /healthz says "${body.status}", ${body.pending ?? 0} message(s) queued`)

  // ── 3. Does it accept our key? ──
  const auth = await fetch(`${env.notify.url}/notifications`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.notify.apiKey ? { authorization: `Bearer ${env.notify.apiKey}` } : {}),
    },
    // Deliberately invalid: a 400 proves the key was accepted and validation ran,
    // without putting anything in anyone's inbox.
    body: JSON.stringify({ type: 'verify_email', to: 'probe@example.com', data: {} }),
  })

  if (auth.status === 401) {
    bad('Authentication rejected (401) — NOTIFY_API_KEY differs between the two services.')
    hint('Compare them character for character; a trailing newline counts.')
    process.exitCode = 1
    return
  }
  if (auth.status !== 400) {
    warn(`Expected 400 from the deliberately-invalid probe, got ${auth.status}.`)
  } else {
    ok('Authenticated — the service accepted the key and validated the payload')
  }

  // ── 4. Optionally, a real send. ──
  if (!to) {
    console.log('')
    ok('Configuration and connectivity are good.')
    hint('To prove delivery end to end (including spam placement):')
    hint('  npm run check:notify -- you@example.com')
    return
  }

  console.log('')
  const sent = await fetch(`${env.notify.url}/notifications`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(env.notify.apiKey ? { authorization: `Bearer ${env.notify.apiKey}` } : {}),
    },
    body: JSON.stringify({
      type: 'verify_email',
      to,
      lang: 'en',
      data: { url: `${env.appBaseUrl}/verify-email?token=check-notify-probe`, expiresInHours: 24 },
    }),
  })

  if (!sent.ok) {
    bad(`The service refused the message (${sent.status}): ${await sent.text()}`)
    process.exitCode = 1
    return
  }
  ok(`Queued for ${to}.`)
  hint('Queued is not delivered. Watch the service log for mail.sent (success) or')
  hint('notify.failed (SMTP refused it after every retry), then check the inbox AND')
  hint('the spam folder — spam placement is the thing this test is really for.')
  hint('')
  hint('The link in that message is a dummy token and will say the link is invalid.')
  hint('That is expected: this proves delivery, not verification.')
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
