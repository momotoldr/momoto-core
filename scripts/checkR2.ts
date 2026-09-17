/**
 * Verify the R2 configuration end to end, before trusting it with real strips.
 *
 *   npm run check:r2
 *
 * Reads the same `env.r2` the server does, then actually exercises it: writes a probe
 * object to each bucket, reads it back, fetches it over the public URL, and cleans up.
 * Misconfigured storage otherwise fails at the worst moment — a user's strip save —
 * and a bucket that isn't public fails *silently*, as broken images in someone's cart.
 *
 * Read-only with respect to your data: the only objects it touches are the probes it
 * creates under `_healthcheck/`, and it deletes them on the way out.
 */
import { env } from '../src/config/env.js'
import {
  type Bucket,
  deleteImages,
  getImageStream,
  publicUrl,
  putImage,
  storageEnabled,
} from '../src/storage/objectStore.js'
import { makeThumbnail } from '../src/storage/thumbnail.js'

const GREEN = '[32m'
const RED = '[31m'
const YELLOW = '[33m'
const RESET = '[0m'

let failures = 0

function pass(label: string, detail = ''): void {
  console.log(`  ${GREEN}PASS${RESET}  ${label}${detail ? ` — ${detail}` : ''}`)
}

function fail(label: string, detail: string, fix?: string): void {
  failures += 1
  console.log(`  ${RED}FAIL${RESET}  ${label} — ${detail}`)
  if (fix) console.log(`        ${YELLOW}fix: ${fix}${RESET}`)
}

function warn(label: string): void {
  console.log(`  ${YELLOW}WARN${RESET}  ${label}`)
}

/**
 * A 1x1 PNG — small, and enough to prove a round trip.
 *
 * Fully valid, chunk CRCs included: the thumbnail check below actually decodes it, and
 * a subtly-corrupt PNG would fail that step and read as "sharp is broken" rather than
 * "the probe is bad".
 */
const PROBE = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de' +
    '0000000970485973000003e8000003e801b57b526b0000000c4944415408d763a8' +
    'e8590000032401a57b56470a0000000049454e44ae426082',
  'hex',
)

/** Write a probe, read it back, and report. Returns the key so it can be cleaned up. */
async function roundTrip(bucket: Bucket, label: string): Promise<string | null> {
  const key = `_healthcheck/${crypto.randomUUID()}.png`
  try {
    await putImage(bucket, key, PROBE, 'image/png')
  } catch (error) {
    const message = (error as Error).message
    // Map the common R2 rejections onto the setting that actually causes them —
    // "AccessDenied" on its own tells you nothing about which of five vars is wrong.
    // R2 spells it "Access Denied" (with a space) in the message even though the
    // error *name* is AccessDenied, so match both — the un-spaced pattern alone fell
    // through to the endpoint hint and sent you looking at the wrong variable.
    const fix = /NoSuchBucket|not exist/i.test(message)
      ? 'The bucket name is wrong, or that bucket does not exist in this account.'
      : /SignatureDoesNotMatch|InvalidAccessKeyId|Unauthorized|Access ?Denied|Forbidden/i.test(
            message,
          )
        ? 'The credentials reached R2 but were refused for THIS bucket. Most often the ' +
          'API token is scoped to specific buckets and this one is not among them — ' +
          're-scope it under R2 → Manage API tokens, or check R2_ACCESS_KEY_ID / ' +
          'R2_SECRET_ACCESS_KEY.'
        : 'Check R2_ACCOUNT_ID, and that this machine can reach the R2 endpoint.'
    fail(`${label}: write`, message, fix)
    return null
  }
  pass(`${label}: write`)

  const stream = await getImageStream(bucket, key)
  if (!stream) {
    fail(`${label}: read back`, 'the object we just wrote could not be read')
    return key
  }
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  if (Buffer.concat(chunks).equals(PROBE)) pass(`${label}: read back`, 'bytes match')
  else fail(`${label}: read back`, 'bytes came back different')
  return key
}

/** Fetch the probe over a bucket's CDN origin — the only way to prove public access. */
async function checkPublicUrl(bucket: Bucket, key: string, variable: string): Promise<void> {
  const url = publicUrl(bucket, key)
  if (!url) return
  const label = `${variable} serves the object`
  try {
    const response = await fetch(url)
    if (!response.ok) {
      fail(
        variable,
        `HTTP ${response.status}`,
        response.status === 401 || response.status === 403
          ? `Public access is off for that bucket. Enable it under R2 → the bucket → Settings → Public access.`
          : `Check that ${variable} is exactly this bucket's public origin, with no trailing path.`,
      )
      return
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (!body.equals(PROBE)) {
      fail(variable, 'returned something other than the object we wrote')
      return
    }
    pass(label, url.replace(key, '...'))
    const type = response.headers.get('content-type')
    if (type === 'image/png') pass(`${variable}: content-type preserved`, type)
    else fail(`${variable}: content-type`, `got "${type}", expected image/png`)
  } catch (error) {
    fail(variable, (error as Error).message, `Is ${variable} a reachable https origin?`)
  }
}

async function main(): Promise<void> {
  console.log('\nR2 configuration check\n')

  if (!storageEnabled || !env.r2) {
    console.log('  Object storage is NOT configured — strips will be stored in Postgres.')
    console.log('  Set R2_ACCOUNT_ID (plus the keys and buckets) to enable it. See .env.example.\n')
    return
  }

  const r2 = env.r2
  console.log('  Settings')
  console.log(`    endpoint        ${r2.endpoint}`)
  console.log(`    bucket          ${r2.bucket}  (public)`)
  console.log(`    printBucket     ${r2.printBucket}  (private)`)
  console.log(`    avatarBucket    ${r2.avatarBucket}  (public)`)
  console.log(
    `    publicBaseUrl   ${r2.publicBaseUrl ?? '(not set — images proxy through the API)'}`,
  )
  console.log(
    `    avatarBaseUrl   ${r2.avatarPublicBaseUrl ?? '(not set — avatars proxy through the API)'}`,
  )
  console.log(`    accessKeyId     ${r2.accessKeyId.slice(0, 4)}...${r2.accessKeyId.slice(-2)}`)
  console.log('\n  Buckets')

  const publicKey = await roundTrip('public', `public bucket "${r2.bucket}"`)
  const privateKey = await roundTrip('private', `print bucket "${r2.printBucket}"`)
  const avatarKey = await roundTrip('avatar', `avatar bucket "${r2.avatarBucket}"`)

  console.log('\n  Public access')
  if (!r2.publicBaseUrl) {
    warn('R2_PUBLIC_BASE_URL is not set — every strip will be streamed through the API.')
    console.log('        Setting it is where the render-speed win comes from: the browser')
    console.log('        then loads strips from Cloudflare and never touches the backend.')
  } else if (publicKey) {
    await checkPublicUrl('public', publicKey, 'R2_PUBLIC_BASE_URL')
  }

  if (!r2.avatarPublicBaseUrl) {
    warn('R2_AVATAR_PUBLIC_BASE_URL is not set — avatars stream through the API.')
    console.log('        A custom domain maps to one bucket, so the avatar bucket needs')
    console.log('        its own origin; it cannot borrow R2_PUBLIC_BASE_URL.')
  } else if (avatarKey) {
    await checkPublicUrl('avatar', avatarKey, 'R2_AVATAR_PUBLIC_BASE_URL')
  }

  console.log('\n  Thumbnails')
  const thumbnail = await makeThumbnail(PROBE)
  if (thumbnail) pass('sharp can render a WebP preview', `${thumbnail.length} bytes`)
  else fail('sharp', 'could not render a thumbnail', 'Reinstall sharp for this platform.')

  // Clean up the probes regardless of what failed above.
  await Promise.all([
    publicKey ? deleteImages('public', [publicKey]) : Promise.resolve(),
    privateKey ? deleteImages('private', [privateKey]) : Promise.resolve(),
    avatarKey ? deleteImages('avatar', [avatarKey]) : Promise.resolve(),
  ])

  if (failures > 0) {
    console.log(`\n  ${failures} check(s) failed — fix these before backfilling.\n`)
    process.exitCode = 1
    return
  }

  console.log('\n  All checks passed.\n')
  // The one thing an S3 client genuinely cannot determine about its own buckets.
  console.log('  This script cannot verify one thing for you: that the PRINT bucket')
  console.log(`  ("${r2.printBucket}") is NOT publicly readable. Confirm by hand under`)
  console.log('  R2 -> that bucket -> Settings -> Public access = disabled. It holds the')
  console.log('  clean copies people pay for.\n')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
