import { Readable } from 'node:stream'

import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'

/**
 * Cloudflare R2 (S3-compatible) storage for the images we hold: strips and avatars.
 *
 * Strips are 1–3 MB PNGs and a user accumulates several, so keeping the bytes in
 * Postgres made every `<img>` render a multi-megabyte de-TOAST + DB round trip that
 * the backend then buffered whole in its heap. Here the bytes leave the database
 * entirely: the row keeps only a key, and the public copy is served straight off
 * Cloudflare's CDN without touching this process at all.
 *
 * Avatars are far smaller, but they load on nearly every screen and for both halves
 * of a couple, so they benefit from the same thing the strips did: the CDN answers
 * them and this server is never in the path.
 *
 * Storage is **optional** — with no R2 credentials configured, avatars fall back to
 * the legacy `AvatarImage.bytes` column (strips, whose column is gone, refuse the
 * write instead), so a local dev checkout and any not-yet-backfilled row keep
 * working unchanged.
 */

/**
 * The buckets we address, by role rather than by name.
 *
 * `public` and `private` exist because the two strip copies have opposite access
 * rules; `avatar` is split out so profile pictures can be given their own bucket and
 * their own custom domain. It may resolve to the same bucket as `public` — that is
 * what it does until `R2_AVATAR_BUCKET` is set — so this names the *role*, and env.ts
 * decides which actual bucket each role lands on.
 */
export type Bucket = 'public' | 'private' | 'avatar'

const client: S3Client | null = env.r2
  ? new S3Client({
      region: 'auto',
      endpoint: env.r2.endpoint,
      // Address buckets as `<endpoint>/<bucket>/<key>` rather than as a subdomain.
      // R2 accepts both; MinIO and other local S3 stand-ins generally only accept
      // this one, so it keeps `R2_ENDPOINT` usable for testing the storage path.
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.r2.accessKeyId,
        secretAccessKey: env.r2.secretAccessKey,
      },
    })
  : null

/**
 * The client that signs URLs for the browser. Same endpoint and credentials, with one
 * difference: no default checksum. The SDK otherwise stamps every PutObject with a CRC32
 * of the body it was given — and a presigned PUT is signed with no body, so the URL
 * would carry the checksum of *zero bytes* (`AAAAAA==`) for an upload of megabytes. R2
 * ignores it today; a URL that asserts the wrong checksum is still not one to hand out.
 * Kept separate so the server's own writes (`putImage`) are unchanged.
 */
const signingClient: S3Client | null = env.r2
  ? new S3Client({
      region: 'auto',
      endpoint: env.r2.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: env.r2.accessKeyId,
        secretAccessKey: env.r2.secretAccessKey,
      },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  : null

/** True when R2 is configured and new uploads should go there. */
export const storageEnabled = client !== null

/** Resolve a role to the bucket it lives in and the origin it's served from. */
function bucketConfig(bucket: Bucket): { name: string; publicBaseUrl: string | null } {
  const r2 = env.r2
  if (!r2) throw new Error('Object storage is not configured')
  switch (bucket) {
    case 'public':
      return { name: r2.bucket, publicBaseUrl: r2.publicBaseUrl }
    case 'avatar':
      return { name: r2.avatarBucket, publicBaseUrl: r2.avatarPublicBaseUrl }
    case 'private':
      // Never has a public origin, whatever is configured — this is the paid copy,
      // and it is only ever handed out through the auth + payment gate.
      return { name: r2.printBucket, publicBaseUrl: null }
  }
}

function bucketName(bucket: Bucket): string {
  return bucketConfig(bucket).name
}

/**
 * The CDN URL for a key, or null when that bucket has no public origin (in which case
 * the caller falls back to proxying the object through this server).
 *
 * Takes the bucket explicitly rather than assuming one: `public` and `avatar` can be
 * two different buckets behind two different domains, and guessing wrong would hand
 * out a URL that 404s.
 */
export function publicUrl(bucket: Bucket, key: string): string | null {
  if (!env.r2) return null
  const { publicBaseUrl } = bucketConfig(bucket)
  return publicBaseUrl ? `${publicBaseUrl}/${key}` : null
}

/**
 * A storage key for one strip image. Random rather than derived from the strip id:
 * the object is written *before* the row exists (so a row never points at a missing
 * object), and an unguessable name keeps the public bucket's contents unenumerable.
 */
export function stripKey(
  kind: 'watermarked' | 'print' | 'thumbnail',
  contentType?: string,
): string {
  const prefix = { watermarked: 'strips', print: 'prints', thumbnail: 'thumbs' }[kind]
  // The extension follows the actual bytes. Thumbnails are always WebP; the other two
  // are whatever the client encoded, so a key never claims a format the object isn't.
  const extension = kind === 'thumbnail' ? 'webp' : (IMAGE_EXTENSIONS[contentType ?? ''] ?? 'png')
  return `${prefix}/${crypto.randomUUID()}.${extension}`
}

/**
 * A storage key for one scrapbook object: the finished PDF (private bucket) or its cover
 * preview (public bucket). Random for the same reasons as `stripKey`; a re-finish after a
 * reopen always gets new keys, so nothing cached under an old one can resurface.
 */
export function scrapbookKey(kind: 'pdf' | 'cover', coverType: string = 'image/webp'): string {
  return kind === 'pdf'
    ? `scrapbooks/${crypto.randomUUID()}.pdf`
    : `scrapbook-covers/${crypto.randomUUID()}.${IMAGE_EXTENSIONS[coverType] ?? 'webp'}`
}

/** Extension for each format `sniffImageType` accepts. Shared by strips and avatars. */
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
}

/**
 * A storage key for one avatar, in the avatar bucket.
 *
 * Random for the same reasons as `stripKey`, plus one specific to avatars: the key is
 * the whole cache-buster. A replaced picture gets a brand-new URL, which is what lets
 * the object be served `immutable` off the CDN with no `?v=` and no revalidation.
 *
 * Keyed off the sniffed type, never a client-supplied filename or `Content-Type`.
 */
export function avatarKey(mimeType: string): string {
  const extension = IMAGE_EXTENSIONS[mimeType]
  if (!extension) throw new Error(`Unsupported avatar type: ${mimeType}`)
  return `avatars/${crypto.randomUUID()}.${extension}`
}

/** The MIME type an avatar key was written with, recovered from its extension. */
export function avatarMimeType(key: string): string {
  const extension = key.slice(key.lastIndexOf('.') + 1)
  const entry = Object.entries(IMAGE_EXTENSIONS).find(([, ext]) => ext === extension)
  return entry?.[0] ?? 'application/octet-stream'
}

/** Upload one image. Cached `immutable` — keys are unique per upload, never reused. */
export async function putImage(
  bucket: Bucket,
  key: string,
  bytes: Buffer,
  mimeType: string,
): Promise<void> {
  if (!client) throw new Error('Object storage is not configured')
  await client.send(
    new PutObjectCommand({
      Bucket: bucketName(bucket),
      Key: key,
      Body: bytes,
      ContentType: mimeType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  )
}

/**
 * Open an object for streaming to a response. Returns null if the object is gone —
 * a row whose key no longer resolves is a 404, not a 500.
 */
export async function getImageStream(bucket: Bucket, key: string): Promise<Readable | null> {
  if (!client) throw new Error('Object storage is not configured')
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }))
    return result.Body instanceof Readable ? result.Body : null
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'NoSuchKey' || name === 'NotFound') return null
    throw error
  }
}

/**
 * How long a presigned download URL stays usable. R2 checks expiry when the request
 * *starts*, so this only has to cover the round trip from our response to the browser's
 * fetch — a slow download that began in time still finishes.
 */
export const PRESIGNED_GET_TTL_SECONDS = 60

/**
 * A short-lived URL that lets the browser fetch one object straight from R2.
 *
 * This is how the paid clean copy reaches its owner without the bytes crossing this
 * server: the caller runs every auth and payment check first, then hands out a URL that
 * works for one object, for one minute, and for GET only. Bytes R2 serves itself are
 * free egress; the same bytes streamed through Railway are not.
 *
 * The headers this server used to set on the stream are baked into the signature as
 * `response-*` overrides, because it is no longer in the path to set them — and a
 * signed override can't be changed by whoever holds the URL. Signing is a local HMAC,
 * no network call, so this works the same against R2 and against a MinIO `R2_ENDPOINT`.
 *
 * Never call this for an object that has a public URL anyway; it is for `private`.
 */
export async function presignedGetUrl(
  bucket: Bucket,
  key: string,
  response: { filename: string; contentType: string },
): Promise<{ url: string; expiresAt: Date }> {
  if (!signingClient) throw new Error('Object storage is not configured')
  const expiresAt = new Date(Date.now() + PRESIGNED_GET_TTL_SECONDS * 1000)
  const url = await getSignedUrl(
    signingClient,
    new GetObjectCommand({
      Bucket: bucketName(bucket),
      Key: key,
      ResponseContentType: response.contentType,
      ResponseContentDisposition: `attachment; filename="${response.filename}"`,
      // The stored object says `public, immutable` (see `putImage`); the paid copy must
      // not be kept by anything between R2 and the browser.
      ResponseCacheControl: 'private, no-store',
    }),
    { expiresIn: PRESIGNED_GET_TTL_SECONDS },
  )
  return { url, expiresAt }
}

// ── Direct uploads ───────────────────────────────────────────────────────────
//
// The browser PUTs straight to R2 under `incoming/`, and the server only promotes an
// object to its real key once it has read it back and validated it. Bytes moving
// browser → R2 and R2 → this server are both free; bytes leaving this server for R2 are
// billed Railway egress, and they were the larger half of what a save cost.
//
// Every upload lands in the **private** bucket, whatever bucket it ends up in. Unvalidated
// bytes in a bucket with a public origin would be served off our CDN domain to anyone
// holding the key until they were promoted or collected — free hosting under our name for
// whoever starts an upload and never finishes it. In the private bucket they are reachable
// only through a URL this server signs, and `promoteObject` copies across buckets.
//
// `incoming/` is the whole orphan story: an upload whose client never comes back to
// complete it leaves objects only there, never at a key a row could name, and a
// 1-day lifecycle rule on that prefix (print buckets — docs/ARCHITECTURE.md §5) collects
// them. Nothing in the app ever reads an `incoming/` key except to validate and copy it.

/** Where every direct upload lands until it is validated. Never has a public origin. */
export const UPLOAD_BUCKET: Bucket = 'private'

/** How long a presigned PUT stays usable. Checked when the upload *starts*. */
export const PRESIGNED_PUT_TTL_SECONDS = 10 * 60

/** A fresh key under the upload prefix. No extension: the type isn't known until sniffed. */
export function incomingKey(): string {
  return `incoming/${crypto.randomUUID()}`
}

/**
 * A short-lived URL the browser can PUT exactly one object to.
 *
 * `Content-Type` and `Content-Length` are both signed, so R2 refuses a body that isn't
 * the size and type the client declared to the server first — the declared size is
 * what the server bounds, so this is what makes the bound hold without the bytes ever
 * passing through here. The stored type and cache headers don't matter either way:
 * the object is re-described when it is promoted (`promoteObject`).
 */
export async function presignedPutUrl(
  bucket: Bucket,
  key: string,
  object: { contentType: string; contentLength: number },
): Promise<string> {
  if (!signingClient) throw new Error('Object storage is not configured')
  return getSignedUrl(
    signingClient,
    new PutObjectCommand({
      Bucket: bucketName(bucket),
      Key: key,
      ContentType: object.contentType,
      ContentLength: object.contentLength,
    }),
    {
      expiresIn: PRESIGNED_PUT_TTL_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length']),
    },
  )
}

/**
 * Read a whole object into memory, or null if it's missing or larger than `maxBytes`.
 *
 * For validating a direct upload: the same checks the raw-body routes run need the
 * bytes, and lossy WebP can't be sized from a truncated header. Reading from R2 is
 * ingress here, which Railway doesn't bill, so this costs latency, not money.
 */
export async function readObject(
  bucket: Bucket,
  key: string,
  maxBytes: number,
): Promise<Buffer | null> {
  if (!client) throw new Error('Object storage is not configured')
  try {
    const result = await client.send(new GetObjectCommand({ Bucket: bucketName(bucket), Key: key }))
    if (!result.Body || (result.ContentLength ?? 0) > maxBytes) {
      result.Body?.transformToWebStream()
        .cancel()
        .catch(() => undefined)
      return null
    }
    const bytes = Buffer.from(await result.Body.transformToByteArray())
    return bytes.length > maxBytes ? null : bytes
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'NoSuchKey' || name === 'NotFound') return null
    throw error
  }
}

/**
 * Copy a validated upload from `incoming/` in the upload bucket to its permanent key in
 * `to`, server-side.
 *
 * Usually across buckets — a strip's watermarked copy and every avatar move from the
 * private bucket to a public one here, and only here, after validation. The copy is
 * described afresh — the sniffed type, and `immutable` caching like `putImage` — rather
 * than inheriting whatever the browser's PUT carried. R2 copies within the account, so
 * no bytes cross this server; the API token needs read on the upload bucket and write on
 * `to`, which it already has for every bucket it writes.
 */
export async function promoteObject(
  fromKey: string,
  to: Bucket,
  toKey: string,
  mimeType: string,
): Promise<void> {
  if (!client) throw new Error('Object storage is not configured')
  const source = bucketName(UPLOAD_BUCKET)
  await client.send(
    new CopyObjectCommand({
      Bucket: bucketName(to),
      Key: toKey,
      CopySource: `${source}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
      MetadataDirective: 'REPLACE',
      ContentType: mimeType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  )
}

/**
 * Best-effort delete of objects that a deleted row referenced. Failures are logged,
 * never thrown: the row is already gone, and a leftover object is a cleanup problem
 * rather than something the user's delete should fail on.
 */
export async function deleteImages(bucket: Bucket, keys: string[]): Promise<void> {
  if (!client || keys.length === 0) return
  try {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucketName(bucket),
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    )
  } catch (error) {
    logger.error('storage.delete.failed', {
      bucket,
      count: keys.length,
      message: (error as Error).message,
    })
  }
}
