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
  incomingKey,
  presignedGetUrl,
  presignedPutUrl,
  promoteObject,
  publicUrl,
  putImage,
  readObject,
  storageEnabled,
  UPLOAD_BUCKET,
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

/**
 * Fetch the private probe through a presigned URL, the way the gallery's download does.
 *
 * Proves two things an S3 round trip can't: that this endpoint accepts our signatures
 * over plain HTTPS (a MinIO `R2_ENDPOINT` included), and that the bucket's CORS policy
 * lets the frontend read the response. The second is what fails silently in production
 * — the app falls back to streaming through the API, so downloads still work and only
 * the Railway bill says anything is wrong.
 */
async function checkPresignedGet(bucket: Bucket, key: string, printBucket: string): Promise<void> {
  const origin = env.appBaseUrl
  let url: string
  try {
    const presigned = await presignedGetUrl(bucket, key, {
      filename: 'momoto-probe.png',
      contentType: 'image/png',
    })
    url = presigned.url
  } catch (error) {
    fail('presign', (error as Error).message)
    return
  }
  try {
    // Node's fetch lets us set `Origin`, which a browser would set by itself.
    const response = await fetch(url, { headers: { Origin: origin } })
    if (!response.ok) {
      fail(
        'presigned GET',
        `HTTP ${response.status}`,
        response.status === 403
          ? 'The signature was refused. Check the server clock and that R2_ENDPOINT is the ' +
              'host the browser will reach (a presigned URL is signed for one host).'
          : undefined,
      )
      return
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (!body.equals(PROBE)) {
      fail('presigned GET', 'returned something other than the object we wrote')
      return
    }
    pass('presigned GET serves the private object', new URL(url).host)

    const disposition = response.headers.get('content-disposition') ?? ''
    if (disposition.startsWith('attachment')) pass('signed Content-Disposition applied')
    else fail('signed Content-Disposition', `got "${disposition}", expected attachment; ...`)

    const allowed = response.headers.get('access-control-allow-origin')
    if (allowed === origin || allowed === '*') {
      pass(`CORS allows ${origin}`)
    } else {
      fail(
        `CORS for ${origin}`,
        allowed ? `bucket allows "${allowed}" instead` : 'no Access-Control-Allow-Origin header',
        `Add ${origin} to the CORS policy of "${printBucket}" (R2 → the bucket → Settings → ` +
          'CORS policy; the exact rule is in docs/ARCHITECTURE.md §5). Until then every ' +
          'gallery download falls back to streaming through the API.',
      )
    }
  } catch (error) {
    fail('presigned GET', (error as Error).message, 'Is R2_ENDPOINT reachable from here?')
  }
}

/**
 * Run one direct upload the way the browser does: presign a PUT under `incoming/` in the
 * private upload bucket, prove R2 refuses a body of the wrong size, PUT the real one, and
 * promote it into every bucket a direct upload can end up in — across buckets for the
 * public ones, which is what keeps unvalidated bytes off any public origin. Then ask the
 * upload bucket whether a browser on the app's origin may send that PUT at all — the CORS
 * preflight — which is the part that fails silently: the app falls back to uploading
 * through the API, and only the Railway bill notices.
 *
 * Returns the keys it created, per bucket, so the caller can clean them up.
 */
async function checkDirectUpload(
  uploadBucket: Bucket,
  uploadBucketName: string,
  targets: [Bucket, string][],
): Promise<[Bucket, string[]][]> {
  const label = `direct upload into "${uploadBucketName}"`
  const incoming = incomingKey()
  const created: [Bucket, string[]][] = [[uploadBucket, [incoming]]]
  let url: string
  try {
    url = await presignedPutUrl(uploadBucket, incoming, {
      contentType: 'image/png',
      contentLength: PROBE.length,
    })
  } catch (error) {
    fail(`${label}: presign`, (error as Error).message)
    return created
  }
  try {
    const oversized = await fetch(url, {
      method: 'PUT',
      body: Buffer.concat([PROBE, Buffer.from([0])]),
      headers: { 'Content-Type': 'image/png' },
    })
    if (oversized.ok) {
      fail(
        `${label}: size bound`,
        'R2 accepted a body larger than the signed Content-Length',
        'The declared size is what the server bounds — without this, a client could upload anything.',
      )
    } else {
      pass(`${label}: refuses a body of the wrong size`, `HTTP ${oversized.status}`)
    }

    const put = await fetch(url, {
      method: 'PUT',
      body: PROBE,
      headers: { 'Content-Type': 'image/png' },
    })
    if (!put.ok) {
      fail(`${label}: PUT`, `HTTP ${put.status}`)
      return created
    }
    pass(`${label}: PUT`)
  } catch (error) {
    fail(label, (error as Error).message, 'Is R2_ENDPOINT reachable from here?')
    return created
  }

  for (const [bucket, name] of targets) {
    const promoted = `_healthcheck/${crypto.randomUUID()}.png`
    created.push([bucket, [promoted]])
    try {
      await promoteObject(incoming, bucket, promoted, 'image/png', uploadBucket)
      const back = await readObject(bucket, promoted, PROBE.length)
      if (back?.equals(PROBE)) pass(`promote from incoming/ into "${name}"`)
      else fail(`promote into "${name}"`, 'the promoted object does not match what was uploaded')
    } catch (error) {
      fail(
        `promote into "${name}"`,
        (error as Error).message,
        `The R2 token needs read on "${uploadBucketName}" and write on "${name}" for the ` +
          'server-side copy.',
      )
    }
  }

  const origin = env.appBaseUrl
  try {
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type',
      },
    })
    const allowed = preflight.headers.get('access-control-allow-origin')
    const methods = preflight.headers.get('access-control-allow-methods') ?? ''
    if ((allowed === origin || allowed === '*') && /\bPUT\b/i.test(methods)) {
      pass(`${label}: CORS allows PUT from ${origin}`)
    } else {
      fail(
        `${label}: CORS for ${origin}`,
        allowed
          ? `allows origin "${allowed}" with methods "${methods}"`
          : `no Access-Control-Allow-Origin on the preflight (HTTP ${preflight.status})`,
        `Add ${origin} with methods GET and PUT and header content-type to the CORS policy ` +
          `of "${uploadBucketName}" (exact rule in docs/ARCHITECTURE.md §5). Until then every ` +
          'upload falls back to going through the API.',
      )
    }
  } catch (error) {
    fail(`${label}: CORS preflight`, (error as Error).message)
  }
  return created
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
  console.log(`    scrapbookBucket ${r2.scrapbookBucket ?? '(not set)'}  (private)`)
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
  const scrapbookKey = r2.scrapbookBucket
    ? await roundTrip('scrapbook', `scrapbook bucket "${r2.scrapbookBucket}"`)
    : null

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

  console.log('\n  Direct downloads (print bucket)')
  if (privateKey) await checkPresignedGet('private', privateKey, r2.printBucket)

  console.log('\n  Direct uploads')
  // The avatar role may resolve to the strips bucket; promoting into it twice would say
  // nothing new.
  const uploadProbes = await checkDirectUpload(UPLOAD_BUCKET, r2.printBucket, [
    ['public', r2.bucket],
    ['private', r2.printBucket],
    ...(r2.avatarBucket !== r2.bucket ? [['avatar', r2.avatarBucket] as [Bucket, string]] : []),
  ])
  warn(
    `Lifecycle rules cannot be checked with this token. Confirm by hand that "${r2.printBucket}"`,
  )
  console.log('        has a rule deleting `incoming/` after 1 day — abandoned direct uploads')
  console.log('        are collected by nothing else.')

  // Scrapbooks keep everything in their own bucket — PDFs, covers and their own
  // `incoming/` — so its downloads, uploads and promotion are checked on their own.
  console.log('\n  Scrapbook bucket')
  if (!r2.scrapbookBucket) {
    warn('R2_SCRAPBOOK_BUCKET is not set — scrapbooks cannot be finished, downloaded or shown.')
  } else {
    if (scrapbookKey) await checkPresignedGet('scrapbook', scrapbookKey, r2.scrapbookBucket)
    uploadProbes.push(
      ...(await checkDirectUpload('scrapbook', r2.scrapbookBucket, [
        ['scrapbook', r2.scrapbookBucket],
      ])),
    )
    warn(
      `Lifecycle rules cannot be checked with this token. Confirm by hand that "${r2.scrapbookBucket}"`,
    )
    console.log('        has its own rule deleting `incoming/` after 1 day.')
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
    scrapbookKey ? deleteImages('scrapbook', [scrapbookKey]) : Promise.resolve(),
    ...uploadProbes.map(([bucket, keys]) => deleteImages(bucket, keys)),
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
  console.log('  clean copies people pay for.')
  if (r2.scrapbookBucket) {
    console.log(`  The same goes for the scrapbook bucket ("${r2.scrapbookBucket}"): it holds`)
    console.log('  paid PDFs and must have public access disabled too.')
  }
  console.log('')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
