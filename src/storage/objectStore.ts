import { Readable } from 'node:stream'

import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

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
