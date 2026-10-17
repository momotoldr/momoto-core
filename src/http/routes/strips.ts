import { Prisma } from '@prisma/client'
import express, { Router, type Request, type Response } from 'express'

import { env } from '../../config/env.js'
import { prisma } from '../../db/client.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import {
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
  stripKey,
  type Bucket,
  UPLOAD_BUCKET,
} from '../../storage/objectStore.js'
import { makeThumbnail, THUMBNAIL_BOUNDS, THUMBNAIL_MIME } from '../../storage/thumbnail.js'
import { signUploadGrant, verifyUploadGrant } from '../../storage/uploadGrant.js'
import { asyncRoute } from '../asyncRoute.js'
import { readImageSize, sniffImageType } from '../imageType.js'
import { requireAuth } from '../middleware/requireAuth.js'

export const stripsRouter = Router()

/**
 * Ceiling on an uploaded strip. A composed 4-cut PNG runs ~1–3 MB; this is the
 * backstop for a client that sends something larger, not the expected size.
 */
const STRIP_MAX_BYTES = 8 * 1024 * 1024

/** Uploads store real bytes — keep the rate modest (per user). */
const stripLimiter = new RateLimiter(30, 10 * 60_000)

/** Reclaim expired strip-upload rate windows (wired into the periodic sweep). */
export function sweepStripLimits(now: number = Date.now()): number {
  return stripLimiter.sweep(now)
}

/**
 * The image formats a strip may arrive in.
 *
 * WebP is what the client sends now — lossy q90 for the watermarked copy nobody
 * downloads, and *lossless* for the clean one, which is the paid deliverable and is
 * re-encoded back to PNG in the browser at download time. PNG stays accepted because
 * a client build cached before that change still sends it, and because a browser
 * without canvas WebP encoding falls back to it.
 */
const STRIP_MIME_TYPES = ['image/webp', 'image/png'] as const
type StripMimeType = (typeof STRIP_MIME_TYPES)[number]

function isStripMimeType(value: string | null): value is StripMimeType {
  return value !== null && (STRIP_MIME_TYPES as readonly string[]).includes(value)
}

/**
 * Accept the strip as a raw body rather than multipart, in either accepted format;
 * `express.json` ignores both, so the body parsers don't collide.
 *
 * `POST /strips` sends *two* images in this one body (see `splitStripUpload`), so the
 * ceiling has to cover both. The per-image check still applies after the split.
 */
const stripBody = express.raw({
  type: [...STRIP_MIME_TYPES],
  limit: 2 * STRIP_MAX_BYTES,
})

/**
 * The two images a strip is made of, as one raw body:
 *
 *     [4-byte big-endian length of the watermarked PNG][watermarked PNG][clean PNG]
 *
 * One request rather than two because a strip is only worth anything if *both* copies
 * arrive. The clean copy used to be a follow-up `POST /strips/:id/print-image` (since removed) fired
 * after the result screen had already said "saved" — so a user who navigated away, or
 * whose second request tripped the shared rate limit, ended up with a row that both
 * unlock paths refuse forever and nothing could repair (rebuilding the clean copy needs
 * frames the session no longer holds). Carrying both here makes the save atomic: the
 * strip and its print copy are written in one transaction, or neither is.
 *
 * A third form now carries the **client-rendered thumbnail** as well:
 *
 *     "MOMO"[u32 len watermarked][watermarked][u32 len clean][clean][thumbnail]
 *
 * The browser already holds the composed strip in a canvas, so scaling it down there
 * costs a `drawImage` and deletes the server's only expensive operation — a decode,
 * resize and re-encode that measured 99% of the CPU a save spends. See `storeThumbnail`.
 *
 * Not multipart: every upload in this codebase is a raw single-image body, and a length
 * prefix keeps that shape without pulling in a parser. All three forms stay unambiguous:
 * a PNG starts with 0x89 and a WebP with ASCII "RIFF" (0x52...), a length prefix bounded
 * by `STRIP_MAX_BYTES` always starts with 0x00, and the magic below starts with 0x4D.
 * Read as a big-endian length "MOMO" is 1.29 billion and "RIFF" 1.38 billion, both far
 * past that ceiling — so a server running the older parser rejects a three-part body as
 * malformed rather than silently mis-splitting it.
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const RIFF_MAGIC = Buffer.from('RIFF', 'ascii')
const STRIP_BUNDLE_MAGIC = Buffer.from('MOMO', 'ascii')

/** Does the body begin with a whole image, rather than a length prefix? */
function startsWithImage(body: Buffer): boolean {
  return (
    body.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ||
    (body.length > 12 &&
      body.subarray(0, 4).equals(RIFF_MAGIC) &&
      body.toString('ascii', 8, 12) === 'WEBP')
  )
}

interface StripUpload {
  watermarked: Buffer
  /**
   * The preview the client rendered, when it sent one. Null means this build predates
   * the three-part body (or failed to encode one), and the server renders it instead.
   */
  thumbnail: Buffer | null
  /**
   * Null only for the legacy single-image body — an older client mid-deploy, or a guest
   * strip cached before the clean copy was kept alongside it. Those still save (refusing
   * would cost someone a strip they already made); the row is simply marked unprintable,
   * which the cart now shows.
   */
  clean: Buffer | null
}

function splitStripUpload(body: Buffer): StripUpload | null {
  // Three parts, with the client's own thumbnail.
  if (body.subarray(0, 4).equals(STRIP_BUNDLE_MAGIC)) {
    const parts = readLengthPrefixed(body.subarray(4), 2)
    if (!parts) return null
    const [watermarked, clean] = parts.images
    if (!watermarked || !clean || parts.rest.length === 0) return null
    return { watermarked, clean, thumbnail: parts.rest }
  }

  // Legacy: the whole body is one image, and there is no clean copy to go with it.
  if (startsWithImage(body)) {
    return { watermarked: body, clean: null, thumbnail: null }
  }
  if (body.length < 4) return null
  const watermarkedLength = body.readUInt32BE(0)
  // Both halves must be non-empty and inside the per-image ceiling; a length that runs
  // past the body is a malformed (or hand-crafted) upload, not something to salvage.
  if (watermarkedLength === 0 || watermarkedLength > STRIP_MAX_BYTES) return null
  const end = 4 + watermarkedLength
  if (end >= body.length) return null
  const clean = body.subarray(end)
  if (clean.length > STRIP_MAX_BYTES) return null
  return { watermarked: body.subarray(4, end), clean, thumbnail: null }
}

/**
 * Peel `count` length-prefixed images off the front of a buffer, returning them and
 * whatever follows. Every length is bounded by `STRIP_MAX_BYTES`, so a malformed or
 * hand-crafted body is refused rather than producing a slice that runs off the end.
 */
function readLengthPrefixed(
  body: Buffer,
  count: number,
): { images: Buffer[]; rest: Buffer } | null {
  const images: Buffer[] = []
  let offset = 0
  for (let i = 0; i < count; i++) {
    if (offset + 4 > body.length) return null
    const length = body.readUInt32BE(offset)
    if (length === 0 || length > STRIP_MAX_BYTES) return null
    const start = offset + 4
    const end = start + length
    if (end > body.length) return null
    images.push(body.subarray(start, end))
    offset = end
  }
  return { images, rest: body.subarray(offset) }
}

/** Session metadata is a hint for grouping in the cart, not a trusted key. */
const MAX_SESSION_ID = 64
const SESSION_MODES = new Set(['solo', 'date', 'group'])

/**
 * How far back a client-supplied creation time may reach.
 *
 * Strips made while signed out sit in the browser's IndexedDB until the user signs in,
 * and only then reach this route — so `now()` would date a strip to the day it was
 * *flushed*, not the day it was taken, and file it under the wrong month in the gallery.
 * The client sends the real time instead.
 *
 * That value is not trustworthy, so it is bounded rather than believed: anything outside
 * this window (or in the future) falls back to now. The window matches the frontend's
 * `GUEST_STRIP_TTL_MS` — the cache prunes past 30 days, so nothing older than that can be
 * an honest flush.
 */
const MAX_BACKDATE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * The strip's real creation time, when the client supplies a believable one.
 *
 * Clamped, never rejected: a bad timestamp is not a reason to refuse someone's strip, and
 * falling back to now is exactly the old behaviour. Future times are dropped too — left
 * alone, one would pin a strip to the top of the gallery permanently.
 */
function readCreatedAt(query: Record<string, unknown>, now: number): Date | undefined {
  const raw = typeof query.createdAt === 'string' ? query.createdAt : ''
  if (!raw) return undefined
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) return undefined
  if (parsed > now || parsed < now - MAX_BACKDATE_MS) return undefined
  return new Date(parsed)
}

/** Just the columns the public shape needs (never the bytes). */
interface SerializableStrip {
  id: string
  storageKey: string | null
  thumbnailKey: string | null
  width: number
  height: number
  sessionId: string | null
  sessionMode: string | null
  paid: boolean
  createdAt: Date
  /** Presence only — the row's own columns are never part of the public shape. */
  printImage: { stripId: string } | null
}

/** Metadata-only projection for listing and serializing — deliberately no `bytes`. */
export const stripSummarySelect = {
  id: true,
  storageKey: true,
  thumbnailKey: true,
  width: true,
  height: true,
  sessionId: true,
  sessionMode: true,
  paid: true,
  createdAt: true,
  // Presence of the clean copy, which is what decides whether a strip can be sold at
  // all. Selected as the id alone: the cart needs to know a print image *exists*, and
  // nothing about the private object behind it.
  printImage: { select: { stripId: true } },
} as const

/**
 * Public shape of a stored strip — metadata + an image URL, never bytes.
 *
 * When a CDN origin is configured the URL points straight at Cloudflare: the browser
 * fetches the strip from the edge and this server is never in the path. Without one it
 * stays the relative `/strips/:id`, which the client resolves against the API base and
 * this server proxies from the bucket — so the contract is "a URL" either way.
 */
export function serializeStrip(strip: SerializableStrip) {
  const cdn = strip.storageKey ? publicUrl('public', strip.storageKey) : null
  // Absolute when served from the CDN; otherwise relative to this API's origin,
  // and the client prefixes it with the API base URL.
  const url = cdn ?? `/strips/${strip.id}`
  const thumbCdn = strip.thumbnailKey ? publicUrl('public', strip.thumbnailKey) : null
  return {
    id: strip.id,
    url,
    width: strip.width,
    height: strip.height,
    // Small preview for grids. Falls back to the full image when there's no
    // thumbnail (one where the encode failed), so a client can always just use this
    // field and never has to branch.
    thumbnailUrl: thumbCdn ?? (strip.thumbnailKey ? `/strips/${strip.id}/thumb` : url),
    sessionId: strip.sessionId,
    sessionMode: strip.sessionMode,
    paid: strip.paid,
    /**
     * Whether this strip can be unlocked or checked out at all.
     *
     * False when its clean copy never landed — the upload is best-effort and runs after
     * the result screen says "saved", so a user who navigated away mid-upload ends up
     * with a strip that both unlock paths will always refuse. Without this flag the cart
     * had no way to know, and offered an Unlock button that could only ever fail.
     */
    printable: strip.printImage !== null,
    createdAt: strip.createdAt.toISOString(),
  }
}

/**
 * Both storage ceilings and how much of each the user has spent, derived from rows the
 * caller already has in hand.
 *
 * Counted in memory rather than with two `prisma.count` queries: the listing loads every
 * one of the user's strips anyway, so the meter is free here and a round trip there.
 *
 * The two buckets are independent on purpose. `cart` counts unpaid strips (what
 * `POST /strips` refuses at), `gallery` counts paid ones (what an unlock refuses at) —
 * a full gallery must never stop someone saving a new capture.
 */
function quotaFor(strips: { paid: boolean }[]) {
  const galleryUsed = strips.reduce((total, strip) => total + (strip.paid ? 1 : 0), 0)
  return {
    cart: { used: strips.length - galleryUsed, limit: env.stripMaxItems },
    gallery: { used: galleryUsed, limit: env.galleryMaxItems },
  }
}

/**
 * Persist one validated image and return the key it was stored under.
 *
 * Object storage is the only destination — the inline `bytes` fallback was dropped
 * with the column. Callers must have checked `storageEnabled` first (see
 * `requireStorage`), so reaching here unconfigured is a programming error, not a
 * runtime condition to handle.
 */
async function storeImage(
  bucket: Bucket,
  bytes: Buffer,
  contentType: StripMimeType,
): Promise<string> {
  const key = stripKey(bucket === 'public' ? 'watermarked' : 'print', contentType)
  await putImage(bucket, key, bytes, contentType)
  return key
}

/**
 * Guard the write routes when object storage isn't configured.
 *
 * Since the `bytes` columns were dropped there is nowhere else to put a strip, so
 * saving has to fail — but it fails *here*, with a named error, rather than as a
 * confusing crash deeper in. 503 rather than 500: the request was fine, the server
 * just isn't presently able to accept strips. The rest of the API (auth, rooms) still
 * works, which is why this isn't a refuse-to-boot check.
 */
export function requireStorage(res: Response): boolean {
  if (storageEnabled) return true
  logger.error('strips.storageUnavailable', {
    msg: 'Object storage is not configured; strips cannot be saved. Set R2_ACCOUNT_ID etc.',
  })
  res.status(503).json({ error: 'storage_unavailable' })
  return false
}

/**
 * Render and upload a preview for a strip, returning its key (or null).
 *
 * Best-effort throughout: no storage configured, an image libvips can't read, or a
 * failed upload all produce null, and the row simply has no thumbnail — the API then
 * serves the full image under `thumbnailUrl` and nothing downstream breaks. This runs
 * inline on the save (~100ms) so the cart is right the moment the strip appears.
 */
async function storeThumbnail(bytes: Buffer, supplied: Buffer | null): Promise<string | null> {
  if (!storageEnabled) return null
  // Rendering this was the single most expensive thing a save did. A client that sends
  // its own is taken at its word once the bytes check out — a wrong preview is cosmetic
  // and only ever affects the uploader's own cart, so it does not warrant re-encoding
  // every strip to guard against. Anything that fails the checks falls through to the
  // server-rendered path rather than being refused.
  const thumbnail = (await acceptableThumbnail(supplied)) ?? (await makeThumbnail(bytes))
  if (!thumbnail) return null
  const key = stripKey('thumbnail', THUMBNAIL_MIME)
  try {
    await putImage('public', key, thumbnail, THUMBNAIL_MIME)
    return key
  } catch (error) {
    logger.warn('thumbnail.upload.failed', { message: (error as Error).message })
    return null
  }
}

/**
 * Vet a client-rendered thumbnail, or null if it can't be used as one.
 *
 * WebP only, inside the bounds `makeThumbnail` would have produced, and small enough
 * that it is plainly a preview rather than a second copy of the strip. Dimensions come
 * from the header, so this stays cheap — the whole point is not to decode anything.
 */
async function acceptableThumbnail(bytes: Buffer | null): Promise<Buffer | null> {
  if (!bytes || bytes.length === 0 || bytes.length > THUMBNAIL_BOUNDS.maxBytes) return null
  if (sniffImageType(bytes) !== THUMBNAIL_MIME) return null
  const size = await readImageSize(bytes)
  if (!size) return null
  if (size.width > THUMBNAIL_BOUNDS.maxWidth || size.height > THUMBNAIL_BOUNDS.maxHeight) {
    return null
  }
  return bytes
}

/**
 * Stream a stored object to the response.
 *
 * Returns false when the object can't be found, so the caller answers 404 — a row
 * whose object has been removed shouldn't surface as a 500. Streaming (rather than
 * buffering) matters here: these are multi-megabyte PNGs, and holding each one whole
 * in the heap is what made concurrent loads slow on a small instance.
 */
export async function serveImage(res: Response, bucket: Bucket, key: string): Promise<boolean> {
  const stream = await getImageStream(bucket, key)
  if (!stream) return false
  stream.pipe(res)
  return true
}

/**
 * Ceiling on the client's idempotency key. It is a UUID in practice; the bound just
 * keeps an arbitrary string out of an indexed column.
 */
const MAX_CLIENT_KEY = 64

/**
 * The client's idempotency key for this save, or null.
 *
 * The client mints one id per composed strip and resends it unchanged on every retry,
 * so it names *the strip*, not the attempt — which is exactly what makes a replay
 * detectable. Absent or over-long is null, which simply opts that upload out (see
 * `Strip.clientKey`): a missing key is never a reason to refuse someone's strip.
 *
 * It is a grouping hint like `sessionId`, not a trusted key — every lookup that uses
 * it is scoped to the authenticated user, so one client cannot reach another's strip
 * by guessing a key.
 */
function readClientKey(query: Record<string, unknown>): string | null {
  const raw = typeof query.clientKey === 'string' ? query.clientKey.trim() : ''
  return raw && raw.length <= MAX_CLIENT_KEY ? raw : null
}

/**
 * The strip this user already saved under `clientKey`, if any.
 *
 * Scoped to `userId` because that is half of the unique index — and because a key is
 * client-supplied, so an unscoped lookup would hand back someone else's strip to
 * whoever guessed it.
 */
async function findReplayedStrip(userId: string, clientKey: string | null) {
  if (!clientKey) return null
  return prisma.strip.findFirst({
    where: { userId, clientKey },
    select: { ...stripSummarySelect, removedAt: true },
  })
}

/** True for a P2002 raised by the `(userId, clientKey)` idempotency index. */
function isDuplicateClientKey(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    String(error.meta?.target ?? '').includes('clientKey')
  )
}

function readSessionMeta(query: Record<string, unknown>): {
  sessionId: string | null
  sessionMode: string | null
} {
  const rawId = typeof query.sessionId === 'string' ? query.sessionId.trim() : ''
  const rawMode = typeof query.mode === 'string' ? query.mode.trim() : ''
  return {
    sessionId: rawId && rawId.length <= MAX_SESSION_ID ? rawId : null,
    sessionMode: SESSION_MODES.has(rawMode) ? rawMode : null,
  }
}

/**
 * Remove the stored objects a set of deleted strips referenced.
 *
 * Rows cascade; objects don't. Anything that deletes strips (a user removing one, an
 * admin deleting an account) has to call this or the bucket accumulates images no
 * row can reach. Always best-effort — see `deleteImages`.
 */
export async function deleteStripObjects(
  strips: ({
    storageKey: string | null
    thumbnailKey: string | null
    printImage: { storageKey: string | null } | null
  } | null)[],
): Promise<void> {
  const publicKeys: string[] = []
  const privateKeys: string[] = []
  for (const strip of strips) {
    if (!strip) continue
    if (strip.storageKey) publicKeys.push(strip.storageKey)
    // The thumbnail is a second object in the public bucket — easy to forget, and
    // nothing else names it once the row is gone.
    if (strip.thumbnailKey) publicKeys.push(strip.thumbnailKey)
    if (strip.printImage?.storageKey) privateKeys.push(strip.printImage.storageKey)
  }
  await Promise.all([deleteImages('public', publicKeys), deleteImages('private', privateKeys)])
}

// ── Saving a strip: the checks both upload paths share ───────────────────────
//
// A strip arrives one of two ways: as one raw body through `POST /strips` (the original
// path, still used by older clients and as the fallback), or uploaded by the browser
// straight to R2 and then completed through `POST /strips/uploads/complete`. Everything
// that decides *whether* a strip is saved lives below, so the two can't disagree.

/** A request refused, with the status and code to answer it with. */
interface Refusal {
  status: number
  error: string
}

function isRefusal(value: object): value is Refusal {
  return 'error' in value
}

interface ValidatedStrip {
  watermarkedType: StripMimeType
  dimensions: { width: number; height: number }
  clean: { type: StripMimeType; dimensions: { width: number; height: number } } | null
}

/**
 * Check a strip's two images, trusting the bytes rather than any header sent with them.
 * The sniffed type is what gets stored and served, so the two copies are free to be
 * different formats: the client sends lossy WebP for one and lossless for the other.
 */
async function validateStripImages(
  watermarked: Buffer,
  clean: Buffer | null,
): Promise<ValidatedStrip | Refusal> {
  const watermarkedType = sniffImageType(watermarked)
  if (!isStripMimeType(watermarkedType)) return { status: 400, error: 'unsupported_image' }
  // Checked in its own block rather than folded into the condition above, so the
  // narrowed type survives to the write instead of needing a cast there.
  let cleanType: StripMimeType | null = null
  if (clean) {
    const sniffed = sniffImageType(clean)
    if (!isStripMimeType(sniffed)) return { status: 400, error: 'unsupported_image' }
    cleanType = sniffed
  }
  if (watermarked.length > STRIP_MAX_BYTES) return { status: 413, error: 'image_too_large' }
  // Header-only, so this stays cheap and can't be turned into a decompression bomb.
  const dimensions = await readImageSize(watermarked)
  const cleanDimensions = clean ? await readImageSize(clean) : null
  if (!dimensions || (clean && !cleanDimensions)) return { status: 400, error: 'invalid_input' }
  return {
    watermarkedType,
    dimensions,
    clean: cleanType && cleanDimensions ? { type: cleanType, dimensions: cleanDimensions } : null,
  }
}

/**
 * Answer a save that was already made under `clientKey`, if it was. True when it
 * responded.
 *
 * This is the retry after a save the *client* gave up on — a timeout on a multi-megabyte
 * upload, a dropped connection, a closed tab — none of which can stop the write already
 * running here, so the row landed anyway and the user was shown a failure. Retrying then
 * duplicated the strip in their cart.
 *
 * Always ahead of both the cart cap and any bucket write: a replay must not be refused as
 * `cart_full` by the very strip it is replaying, and re-storing bytes we already have
 * would only orphan them.
 */
async function answerReplay(res: Response, userId: string, clientKey: string | null) {
  const replayed = await findReplayedStrip(userId, clientKey)
  // A retry so late that the strip it replays was unlocked and then removed from the
  // gallery in between. Effectively unreachable (retries land within seconds), but
  // answering with a strip whose images are gone would put a broken tile in the cart.
  if (replayed?.removedAt) {
    logger.info('strips.saveReplayedRemoved', { userId, stripId: replayed.id })
    res.status(409).json({ error: 'strip_removed' })
    return true
  }
  if (replayed) {
    logger.info('strips.saveReplayed', { userId, stripId: replayed.id })
    // 200, not 201: nothing was created. The client treats both as success.
    res.status(200).json({ strip: serializeStrip(replayed) })
    return true
  }
  return false
}

/**
 * Whether the cart is already at its cap.
 *
 * Checked *before* anything is written to a bucket: rejecting after the upload would
 * leave objects in R2 that no row names. Only unpaid strips count — a strip someone paid
 * for is theirs to keep, and shouldn't stop them making another. Two tabs racing can land
 * at cap + 1; that's accepted rather than paying for a serializable transaction.
 */
async function cartIsFull(userId: string): Promise<boolean> {
  const unpaid = await prisma.strip.count({ where: { userId, paid: false } })
  if (unpaid < env.stripMaxItems) return false
  logger.info('strips.cartFull', { userId, unpaid, limit: env.stripMaxItems })
  return true
}

/** Where a strip's images ended up, once they are at their permanent keys. */
interface StoredStripKeys {
  storageKey: string
  thumbnailKey: string | null
  printKey: string | null
}

/**
 * Write the strip row (and its print copy's row) for images already at their permanent
 * keys, and answer the request.
 *
 * One write for both rows. This is the whole point of saving both images together: a
 * strip can't exist in the cart without the copy that makes it sellable, because there is
 * no moment between the two where a failure or a closed tab can land.
 */
async function createStripRow(
  res: Response,
  userId: string,
  strip: ValidatedStrip,
  keys: StoredStripKeys,
  meta: {
    sessionId: string | null
    sessionMode: string | null
    createdAt: Date | undefined
    clientKey: string | null
  },
  log: { bytes: number; direct: boolean },
): Promise<void> {
  const { storageKey, thumbnailKey, printKey } = keys
  let created
  try {
    created = await prisma.strip.create({
      data: {
        userId,
        storageKey,
        thumbnailKey,
        mimeType: strip.watermarkedType,
        width: strip.dimensions.width,
        height: strip.dimensions.height,
        sessionId: meta.sessionId,
        sessionMode: meta.sessionMode,
        createdAt: meta.createdAt,
        clientKey: meta.clientKey,
        ...(printKey && strip.clean
          ? {
              printImage: {
                create: {
                  storageKey: printKey,
                  mimeType: strip.clean.type,
                  width: strip.clean.dimensions.width,
                  height: strip.clean.dimensions.height,
                },
              },
            }
          : {}),
      },
      select: stripSummarySelect,
    })
  } catch (error) {
    // The other half of the idempotency guard: two saves of the same strip in flight
    // at once, so the replay check found nothing and the unique index caught it here.
    // Rarer than the sequential retry, but the same user-visible bug — and it is why
    // the index exists rather than the lookup alone.
    const existing = isDuplicateClientKey(error)
      ? await findReplayedStrip(userId, meta.clientKey)
      : null
    if (!existing) throw error
    // The winner's objects are the ones the row names; ours are already unreachable.
    // Drop them now — nothing else ever will, since no row will mention them.
    await Promise.all([
      deleteImages(
        'public',
        [storageKey, thumbnailKey].filter((key): key is string => !!key),
      ),
      deleteImages('private', printKey ? [printKey] : []),
    ])
    logger.info('strips.saveRaced', { userId, stripId: existing.id })
    res.status(200).json({ strip: serializeStrip(existing) })
    return
  }
  logger.info('strips.saved', {
    userId,
    stripId: created.id,
    bytes: log.bytes,
    // Which path the bytes took: straight to R2, or through this server. A `false` from
    // a current client means its direct upload failed and it fell back — usually the
    // bucket's CORS rule — and that save cost Railway egress.
    direct: log.direct,
    // False means this save has no replay protection — a legacy client, or one that
    // dropped the key. A rise here is a duplicate-strip report waiting to happen.
    idempotent: meta.clientKey !== null,
    thumbnail: thumbnailKey !== null,
    // Watch this: a `false` here is a strip that will never be sellable, and after the
    // atomic save it should only ever come from a legacy single-image body.
    printable: printKey !== null,
  })
  res.status(201).json({ strip: serializeStrip(created) })
}

// ── POST /strips ─── save a created strip to the cart ────────────────────────
/**
 * The strip's bytes in the request body (see `splitStripUpload`), stored by this server.
 *
 * Current clients upload straight to R2 instead (`/strips/uploads`, below) and come here
 * only when that fails; older clients still use this alone. Every byte this route pushes
 * to R2 is Railway egress, which is why it is no longer the first choice.
 */
stripsRouter.post(
  '/',
  requireAuth,
  stripBody,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!requireStorage(res)) return
    if (!stripLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    const body: unknown = req.body
    if (!Buffer.isBuffer(body) || body.length === 0) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    const upload = splitStripUpload(body)
    if (!upload) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    const { watermarked, clean, thumbnail } = upload
    const validated = await validateStripImages(watermarked, clean)
    if (isRefusal(validated)) {
      res.status(validated.status).json({ error: validated.error })
      return
    }

    const query = req.query as Record<string, unknown>
    const clientKey = readClientKey(query)
    if (await answerReplay(res, userId, clientKey)) return
    if (await cartIsFull(userId)) {
      res.status(409).json({ error: 'cart_full' })
      return
    }

    const { sessionId, sessionMode } = readSessionMeta(query)
    // Undefined when absent or implausible, which leaves Prisma's `@default(now())` to
    // stamp it — the behaviour every signed-in save already relies on.
    const createdAt = readCreatedAt(query, Date.now())

    // Upload before the row exists, so a row never points at a missing object. The
    // reverse order would leave a broken image on the user's cart if the upload
    // failed; this way a failed insert only leaves an orphan object in the bucket.
    // The clean copy goes to the *private* bucket — it is the paid deliverable and is
    // only ever handed out through the gate on `GET /strips/:id/print(-url)`.
    const [storageKey, thumbnailKey, printKey] = await Promise.all([
      storeImage('public', watermarked, validated.watermarkedType),
      storeThumbnail(watermarked, thumbnail),
      clean && validated.clean
        ? storeImage('private', clean, validated.clean.type)
        : Promise.resolve(null),
    ])

    await createStripRow(
      res,
      userId,
      validated,
      { storageKey, thumbnailKey, printKey },
      { sessionId, sessionMode, createdAt, clientKey },
      { bytes: watermarked.length, direct: false },
    )
  }),
)

// ── POST /strips/uploads ─── start a direct upload ───────────────────────────
/**
 * One file the client intends to upload, as it declared it. The declared size is signed
 * into the PUT URL, so R2 enforces the bound checked here.
 */
export function readDeclaredFile(
  value: unknown,
  types: readonly string[],
  maxBytes: number,
): { contentType: string; size: number } | null {
  if (!value || typeof value !== 'object') return null
  const { type, size } = value as { type?: unknown; size?: unknown }
  if (typeof type !== 'string' || !types.includes(type)) return null
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > maxBytes) {
    return null
  }
  return { contentType: type, size }
}

/**
 * Start saving a strip whose bytes go browser → R2 directly, so they never cross this
 * server and cost no Railway egress.
 *
 * Body (JSON): `{ watermarked: {type, size}, clean: {type, size}, thumbnail?: {type, size},
 * sessionId?, mode?, createdAt?, clientKey? }` — the same metadata `POST /strips` takes as
 * query params.
 *
 * Runs every check that can be run before the bytes exist — rate limit, replay, cart cap,
 * declared types and sizes — so a refused save never uploads anything. Answers either
 * `{ strip }` (a replay: already saved, nothing to upload) or
 * `{ upload: { token, files } }`, a presigned PUT per file under `incoming/` in the
 * private bucket — every file, including the ones that end up public — plus the
 * grant that completes them. The bytes themselves are checked at completion, after they
 * land; nothing here trusts the declared type beyond choosing what to sign.
 *
 * A thumbnail that doesn't fit the bounds is dropped rather than refused — the server
 * renders one at completion, the same as the raw route does.
 */
stripsRouter.post(
  '/uploads',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!requireStorage(res)) return
    if (!stripLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const watermarked = readDeclaredFile(body.watermarked, STRIP_MIME_TYPES, STRIP_MAX_BYTES)
    const clean = readDeclaredFile(body.clean, STRIP_MIME_TYPES, STRIP_MAX_BYTES)
    if (!watermarked || !clean) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    const thumbnail = readDeclaredFile(body.thumbnail, [THUMBNAIL_MIME], THUMBNAIL_BOUNDS.maxBytes)

    // A direct save always has a key: completion is a second request, and the key is
    // what makes repeating it — or falling back to `POST /strips` after it — harmless.
    // Minted here for a client that sent none; that client can't reuse it on its own
    // fallback, but completion stays idempotent.
    const clientKey = readClientKey(body) ?? crypto.randomUUID()
    if (await answerReplay(res, userId, clientKey)) return
    if (await cartIsFull(userId)) {
      res.status(409).json({ error: 'cart_full' })
      return
    }

    const { sessionId, sessionMode } = readSessionMeta(body)
    const createdAt = readCreatedAt(body, Date.now())
    const granted = {
      watermarked: { key: incomingKey(), ...watermarked },
      clean: { key: incomingKey(), ...clean },
      thumbnail: thumbnail ? { key: incomingKey(), ...thumbnail } : null,
    }
    // All three land in the private upload bucket, the watermarked copy and the preview
    // included: nothing unvalidated may sit where a public origin can serve it. They
    // only reach the public bucket by being promoted at completion.
    const presign = (file: { key: string; contentType: string; size: number }) =>
      presignedPutUrl(UPLOAD_BUCKET, file.key, {
        contentType: file.contentType,
        contentLength: file.size,
      }).then((url) => ({ url, contentType: file.contentType }))
    const [watermarkedPut, cleanPut, thumbnailPut] = await Promise.all([
      presign(granted.watermarked),
      presign(granted.clean),
      granted.thumbnail ? presign(granted.thumbnail) : Promise.resolve(null),
    ])

    const token = signUploadGrant({
      kind: 'strip',
      userId,
      ...granted,
      clientKey,
      sessionId,
      sessionMode,
      createdAt: createdAt?.toISOString() ?? null,
    })
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({
      upload: {
        token,
        files: { watermarked: watermarkedPut, clean: cleanPut, thumbnail: thumbnailPut },
      },
    })
  }),
)

// ── POST /strips/uploads/complete ─── validate, promote, save ────────────────
/**
 * Finish a direct upload: read what landed under `incoming/` in the private upload
 * bucket, run exactly the checks `POST /strips` runs on a body, copy each file to its
 * permanent key — the watermarked copy and the preview across to the public bucket, the
 * clean copy within the private one — and write the row. Nothing reaches the public
 * bucket without passing those checks first.
 *
 * Body (JSON): `{ token }` from `POST /strips/uploads`. The token, not the client, says
 * which objects to read and what metadata to save, so nothing here is client-chosen.
 *
 * Reading the objects back is ingress (free); the copies happen inside R2. The only bytes
 * this route pushes out are a server-rendered thumbnail, when the client's own was
 * missing or failed its checks.
 *
 * `409 upload_incomplete` means a granted file isn't in the bucket — the PUT never
 * finished. The client falls back to `POST /strips` on that, with the same `clientKey`.
 */
stripsRouter.post(
  '/uploads/complete',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!requireStorage(res)) return
    const grant = verifyUploadGrant(
      (req.body as { token?: unknown } | undefined)?.token,
      'strip',
      userId,
    )
    if (!grant) {
      res.status(400).json({ error: 'invalid_upload' })
      return
    }
    const incoming = [grant.watermarked.key, grant.clean.key, grant.thumbnail?.key].filter(
      (key): key is string => !!key,
    )
    // Best-effort, like every delete: the lifecycle rule on `incoming/` is the backstop.
    const dropIncoming = () => deleteImages(UPLOAD_BUCKET, incoming)

    // Completing twice (a retry whose first attempt actually landed) answers with the
    // strip that exists. Whatever this attempt uploaded is surplus.
    if (await answerReplay(res, userId, grant.clientKey)) {
      await dropIncoming()
      return
    }

    const [watermarked, clean, thumbnail] = await Promise.all([
      readObject(UPLOAD_BUCKET, grant.watermarked.key, STRIP_MAX_BYTES),
      readObject(UPLOAD_BUCKET, grant.clean.key, STRIP_MAX_BYTES),
      grant.thumbnail
        ? readObject(UPLOAD_BUCKET, grant.thumbnail.key, THUMBNAIL_BOUNDS.maxBytes)
        : Promise.resolve(null),
    ])
    if (!watermarked || !clean) {
      res.status(409).json({ error: 'upload_incomplete' })
      return
    }
    const validated = await validateStripImages(watermarked, clean)
    if (isRefusal(validated) || !validated.clean) {
      await dropIncoming()
      const refusal = isRefusal(validated) ? validated : { status: 400, error: 'invalid_input' }
      res.status(refusal.status).json({ error: refusal.error })
      return
    }
    // Again, now that the bytes are here: the cart may have filled while they uploaded.
    if (await cartIsFull(userId)) {
      await dropIncoming()
      res.status(409).json({ error: 'cart_full' })
      return
    }

    const storageKey = stripKey('watermarked', validated.watermarkedType)
    const printKey = stripKey('print', validated.clean.type)
    try {
      await Promise.all([
        promoteObject(grant.watermarked.key, 'public', storageKey, validated.watermarkedType),
        promoteObject(grant.clean.key, 'private', printKey, validated.clean.type),
      ])
    } catch (error) {
      // One copy may have landed; with no row naming it, it is an orphan unless dropped.
      await Promise.all([deleteImages('public', [storageKey]), deleteImages('private', [printKey])])
      throw error
    }
    const thumbnailKey = await promoteThumbnail(
      grant.thumbnail?.key ?? null,
      thumbnail,
      watermarked,
    )

    await createStripRow(
      res,
      userId,
      validated,
      { storageKey, thumbnailKey, printKey },
      {
        sessionId: grant.sessionId,
        sessionMode: grant.sessionMode,
        createdAt: grant.createdAt ? new Date(grant.createdAt) : undefined,
        clientKey: grant.clientKey,
      },
      { bytes: watermarked.length, direct: true },
    )
    // After the row, so a failure above leaves the uploads for a retry to complete.
    await dropIncoming()
  }),
)

/**
 * The direct-upload twin of `storeThumbnail`: promote the client's preview in place when
 * it passes the same checks, and only otherwise render one here. Null on any failure —
 * a strip with no thumbnail still works.
 */
async function promoteThumbnail(
  incoming: string | null,
  supplied: Buffer | null,
  watermarked: Buffer,
): Promise<string | null> {
  if (incoming && (await acceptableThumbnail(supplied))) {
    const key = stripKey('thumbnail', THUMBNAIL_MIME)
    try {
      await promoteObject(incoming, 'public', key, THUMBNAIL_MIME)
      return key
    } catch (error) {
      logger.warn('thumbnail.promote.failed', { message: (error as Error).message })
    }
  }
  return storeThumbnail(watermarked, null)
}

/**
 * How many more strips the gallery can take, given what the user has unlocked already.
 *
 * Shared by both unlock paths — the free one below and the Snap checkout — so the two
 * refuse on exactly the same arithmetic. Always called **before** the strips are
 * flipped (and, on the paid path, before a Midtrans transaction exists): refusing after
 * money moved would leave the user charged with nothing to show.
 */
export async function galleryRoomFor(
  userId: string,
  adding: number,
): Promise<{ ok: true } | { ok: false; used: number; limit: number }> {
  // A removed strip was paid for but no longer holds a slot — freeing one is the point
  // of removing it.
  const used = await prisma.strip.count({ where: { userId, paid: true, removedAt: null } })
  const limit = env.galleryMaxItems
  return used + adding > limit ? { ok: false, used, limit } : { ok: true }
}

/**
 * What a purchase attempt resolved to: the strips, or the reason they can't be bought.
 *
 * The two codes that name ids do so deliberately, and `strip_not_found` deliberately
 * doesn't. A miss means "not yours, or gone" — echoing those ids back would turn this
 * into an oracle for probing other people's strips. The other two only ever describe
 * rows already confirmed to belong to the caller, so naming them is safe, and it's what
 * lets the cart mark the exact strip instead of failing the whole basket anonymously.
 */
export type PurchasableStrips =
  | { ok: true; strips: { id: string }[] }
  | { ok: false; error: 'strip_not_found' }
  | { ok: false; error: 'strips_already_paid' | 'strips_not_printable'; stripIds: string[] }

/**
 * Resolve the strips an unlock or checkout names, refusing with a code the client can act
 * on. Shared by both paths so the free unlock and the Snap checkout agree on what is
 * sellable — and so a strip refused by one is refused identically by the other.
 *
 * This replaced a single `strips_not_purchasable` covering all three conditions. That
 * told the client nothing it could use: a double-submit, a stale cart entry and a strip
 * whose clean copy never uploaded are three different problems with three different
 * fixes, and only the last of them is permanent.
 */
export async function findPurchasableStrips(
  userId: string,
  stripIds: string[],
): Promise<PurchasableStrips> {
  const strips = await prisma.strip.findMany({
    where: { id: { in: stripIds }, userId },
    select: { id: true, paid: true, printImage: { select: { stripId: true } } },
  })
  // Scoped to `userId`, so a short result is either someone else's strip or a deleted
  // one. The cart can't tell them apart either — both mean "reload and try again".
  if (strips.length !== stripIds.length) return { ok: false, error: 'strip_not_found' }

  // Already-unlocked before unprintable: a paid strip had a clean copy when it settled,
  // so "you already own this" is both true and the more useful of the two answers.
  const paid = strips.filter((strip) => strip.paid)
  if (paid.length > 0) {
    return { ok: false, error: 'strips_already_paid', stripIds: paid.map((strip) => strip.id) }
  }

  // No clean copy means nothing to deliver — unlocking would put an undownloadable tile
  // in the gallery, and charging for it would be worse.
  const unprintable = strips.filter((strip) => !strip.printImage)
  if (unprintable.length > 0) {
    return {
      ok: false,
      error: 'strips_not_printable',
      stripIds: unprintable.map((strip) => strip.id),
    }
  }

  return { ok: true, strips: strips.map((strip) => ({ id: strip.id })) }
}

/**
 * Answer a refused purchase, and log which of the three conditions fired.
 *
 * Both routes reply identically, and the log line is the point: the codes are new, and
 * how often each one fires is what says whether missing print copies are a rare accident
 * or a routine outcome of the upload being best-effort.
 */
export function refusePurchase(
  res: Response,
  route: string,
  userId: string,
  refusal: Extract<PurchasableStrips, { ok: false }>,
): void {
  logger.info('strips.notPurchasable', {
    route,
    userId,
    error: refusal.error,
    count: refusal.error === 'strip_not_found' ? undefined : refusal.stripIds.length,
  })
  res
    .status(409)
    .json(
      refusal.error === 'strip_not_found'
        ? { error: refusal.error }
        : { error: refusal.error, stripIds: refusal.stripIds },
    )
}

/** Unlocking stores nothing new, but it does flip paid rows — keep the rate modest. */
const unlockLimiter = new RateLimiter(30, 10 * 60_000)

/** Reclaim expired unlock rate windows (wired into the periodic sweep). */
export function sweepUnlockLimits(now: number = Date.now()): number {
  return unlockLimiter.sweep(now)
}

/** Bound one unlock request, mirroring the checkout route's own cap. */
const MAX_UNLOCK_STRIPS = 20

// ── POST /strips/unlock ─── move strips from the cart to the gallery, free ───
/**
 * The **free** unlock path, used only while checkout is dark.
 *
 * It flips exactly the column a settled Midtrans payment would (`paid` + `paidAt`), so
 * the gallery and the paid download gate behave identically whichever path put the strip
 * there — and turning payments on needs no migration or backfill.
 *
 * No `Payment` row is written: nothing was charged, and a zero-amount payment would
 * misreport revenue in the admin console.
 *
 * **This route is refused outright once payments are enabled.** That single check is what
 * keeps it from being a way to take the paid deliverable for nothing, so it runs before
 * anything else — before the rate limiter, before the body is even read.
 */
stripsRouter.post(
  '/unlock',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (env.paymentsEnabled) {
      res.status(403).json({ error: 'payments_enabled' })
      return
    }
    const userId = req.userId as string
    if (!unlockLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    // De-dupe + validate the requested ids, exactly as the checkout route does.
    const body = req.body as { stripIds?: unknown }
    const stripIds = Array.isArray(body.stripIds)
      ? [...new Set(body.stripIds.filter((id): id is string => typeof id === 'string'))]
      : []
    if (stripIds.length === 0 || stripIds.length > MAX_UNLOCK_STRIPS) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    // Every strip must be the caller's, still unpaid, and have a clean copy to deliver.
    const purchasable = await findPurchasableStrips(userId, stripIds)
    if (!purchasable.ok) {
      refusePurchase(res, 'unlock', userId, purchasable)
      return
    }

    const room = await galleryRoomFor(userId, stripIds.length)
    if (!room.ok) {
      logger.info('gallery.full', { userId, used: room.used, limit: room.limit })
      res.status(409).json({ error: 'gallery_full', used: room.used, limit: room.limit })
      return
    }

    await prisma.strip.updateMany({
      where: { id: { in: stripIds }, userId, paid: false },
      data: { paid: true, paidAt: new Date() },
    })
    logger.info('strips.unlocked', { userId, count: stripIds.length, free: true })

    // Hand back the updated rows so the client can move them cart → gallery without
    // refetching the whole list.
    const strips = await prisma.strip.findMany({
      where: { id: { in: stripIds }, userId },
      select: stripSummarySelect,
    })
    res.json({ strips: strips.map(serializeStrip) })
  }),
)

/** Removing deletes objects in two buckets per call — keep the rate modest. */
const removeLimiter = new RateLimiter(30, 10 * 60_000)

/** Reclaim expired remove rate windows (wired into the periodic sweep). */
export function sweepRemoveLimits(now: number = Date.now()): number {
  return removeLimiter.sweep(now)
}

/** The user's live strips' quota, for a response that has just changed it. */
async function currentQuota(userId: string) {
  const strips = await prisma.strip.findMany({
    where: { userId, removedAt: null },
    select: { paid: true },
  })
  return quotaFor(strips)
}

// ── POST /strips/:id/remove ─── take an unlocked strip out of the gallery ────
/**
 * The gallery's Remove: a **soft** delete of an unlocked strip.
 *
 * The row stays and the files go. `Payment.strips` is a join, so hard-deleting the row
 * would leave the payment that bought it unable to say what it was for — the record a
 * refund or a support question needs. The files, on the other hand, are what the
 * gallery limit exists to bound, and nothing about a payment needs them: all three
 * objects (watermarked, thumbnail, clean copy) are deleted, so nothing of the photo is
 * kept once its owner has asked for it gone.
 *
 * Cart strips aren't removed here — nothing was paid for them, and `DELETE` stays
 * the right tool. Removing twice is a no-op success, so a double tap or a retry after a
 * dropped response never shows an error.
 */
stripsRouter.post(
  '/:id/remove',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!removeLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }

    // Read the keys before they are nulled: once the row stops naming the objects,
    // nothing else ever will.
    const strip = await prisma.strip.findFirst({
      where: { id: req.params.id, userId },
      select: {
        id: true,
        paid: true,
        removedAt: true,
        storageKey: true,
        thumbnailKey: true,
        printImage: { select: { storageKey: true } },
      },
    })
    if (!strip) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    if (!strip.paid) {
      res.status(409).json({ error: 'strip_not_paid' })
      return
    }
    if (strip.removedAt) {
      res.json({ quota: await currentQuota(userId) })
      return
    }

    // Guarded on `removedAt: null` so two racing removes can't both delete objects: the
    // loser updates nothing and answers like the already-removed case above.
    const [{ count }] = await prisma.$transaction([
      prisma.strip.updateMany({
        where: { id: strip.id, userId, paid: true, removedAt: null },
        data: { removedAt: new Date(), storageKey: null, thumbnailKey: null },
      }),
      prisma.stripPrintImage.deleteMany({ where: { stripId: strip.id } }),
    ])
    if (count > 0) {
      // Best-effort, after the row is settled — same posture as `DELETE`. A failure is
      // logged as `storage.delete.failed` and left for `purge:strips --orphans-only`.
      await deleteStripObjects([strip])
      const paidOrders = await prisma.payment.count({
        where: { status: 'paid', strips: { some: { id: strip.id } } },
      })
      // `bought` separates removals of strips someone paid for from free unlocks.
      logger.info('strips.removed', { userId, stripId: strip.id, bought: paidOrders > 0 })
    }

    res.json({ quota: await currentQuota(userId) })
  }),
)

// ── GET /strips ─── list the current user's strips (newest first) ────────────
stripsRouter.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const strips = await prisma.strip.findMany({
      // Removed strips have no images left to show, and the client never needs them:
      // the purchase history still names them through the payment, and draws a
      // placeholder for an id the cart doesn't hold.
      where: { userId, removedAt: null },
      orderBy: { createdAt: 'desc' },
      // Never load the bytes for a listing — the metadata + image URL is all the cart
      // needs, and the bytes are large.
      select: stripSummarySelect,
    })
    res.json({ strips: strips.map(serializeStrip), quota: quotaFor(strips) })
  }),
)

// ── GET /strips/:id ─── serve the strip image ───────────────────────────────
/**
 * **Deliberately unauthenticated**, mirroring avatars: the URL goes in an `<img src>`,
 * which can't carry an `Authorization` header. A cuid isn't guessable, and the only
 * thing behind one is the (watermarked) strip its owner made. Cached hard; the id is
 * immutable so the bytes never change under a URL.
 */
stripsRouter.get(
  '/:id',
  asyncRoute(async (req, res) => {
    // Answer a cache revalidation without touching the database at all. The ETag is
    // the id, which the URL already gave us, and the id is immutable — so a client
    // holding this ETag is holding the current bytes. (Previously this loaded the
    // whole multi-megabyte row *before* comparing, making a 0-byte 304 as expensive
    // as a full send.)
    const etag = `"${req.params.id}"`
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end()
      return
    }

    const strip = await prisma.strip.findUnique({
      where: { id: req.params.id },
      // Metadata first — `bytes` is only read below, and only for legacy rows.
      select: { id: true, mimeType: true, storageKey: true },
    })
    if (!strip) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    // Fast path: hand the browser the CDN URL and get out of the way. The public
    // bucket is exactly as reachable as this endpoint already was (unauthenticated,
    // guarded by an unguessable key), so redirecting gives up nothing.
    const cdn = strip.storageKey ? publicUrl('public', strip.storageKey) : null
    if (cdn) {
      // A temporary redirect, cached for an hour: long enough that a page of
      // thumbnails doesn't re-ask on every render, short enough that changing the
      // CDN origin isn't pinned in browsers forever (which a 308 would do).
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.redirect(302, cdn)
      return
    }

    res.setHeader('Content-Type', strip.mimeType)
    res.setHeader('ETag', etag)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    // Bytes are attacker-influenced (a user's upload), so pin the type we validated
    // and neuter anything a browser might otherwise sniff/execute.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")

    // In storage, but no public origin configured — proxy it through. A row with no
    // key at all predates the migration and has no image anywhere.
    if (!strip.storageKey || !(await serveImage(res, 'public', strip.storageKey))) {
      res.status(404).json({ error: 'not_found' })
    }
  }),
)

// ── GET /strips/:id/thumb ─── serve the small preview ───────────────────────
/**
 * The grid-sized rendition. Same unauthenticated-by-unguessable-id posture as the
 * full image above — it's a smaller copy of the same picture.
 *
 * Only reached when no public CDN origin is configured; with one, `thumbnailUrl`
 * already points at the bucket and this never gets called.
 */
stripsRouter.get(
  '/:id/thumb',
  asyncRoute(async (req, res) => {
    const etag = `"${req.params.id}-thumb"`
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end()
      return
    }

    const strip = await prisma.strip.findUnique({
      where: { id: req.params.id },
      select: { thumbnailKey: true },
    })
    // No thumbnail means fall back to the full image rather than 404 — the client
    // may be holding a `thumbnailUrl` from before the backfill reached this row.
    if (!strip?.thumbnailKey) {
      res.redirect(302, `/strips/${req.params.id}`)
      return
    }

    const cdn = publicUrl('public', strip.thumbnailKey)
    if (cdn) {
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.redirect(302, cdn)
      return
    }

    res.setHeader('Content-Type', THUMBNAIL_MIME)
    res.setHeader('ETag', etag)
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")

    if (!(await serveImage(res, 'public', strip.thumbnailKey))) {
      res.status(404).json({ error: 'not_found' })
    }
  }),
)

// ── The clean copy's gate ───────────────────────────────────────────────────
/** What the paid download needs once the gate has passed. */
interface CleanCopy {
  key: string
  mimeType: string
  filename: string
}

/**
 * Decide whether the caller may have this strip's clean copy, and answer for them if not.
 *
 * Shared by both ways of handing it over (`/print` streams it, `/print-url` signs a URL
 * for it), so they can never drift apart on who gets the file: owner only, paid when
 * `env.paymentsEnabled`, and a 404 for anything that doesn't resolve. Returns null once
 * it has responded.
 */
async function authorizeCleanCopy(req: Request, res: Response): Promise<CleanCopy | null> {
  const userId = req.userId as string
  const id = req.params.id as string
  const strip = await prisma.strip.findUnique({
    where: { id },
    // Ownership and the paid gate are decided on metadata alone — the image is
    // only reached for once both have passed, so a 402 costs nothing.
    select: {
      userId: true,
      paid: true,
      printImage: { select: { mimeType: true, storageKey: true } },
    },
  })
  if (!strip || strip.userId !== userId) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  if (env.paymentsEnabled && !strip.paid) {
    res.status(402).json({ error: 'payment_required' })
    return null
  }
  const key = strip.printImage?.storageKey
  if (!strip.printImage || !key) {
    res.status(404).json({ error: 'not_found' })
    return null
  }
  const { mimeType } = strip.printImage
  // The extension has to follow the stored bytes. The gallery re-encodes to PNG in
  // the browser and names the file itself, so this is what a direct hit on the URL
  // gets — and a `.png` full of WebP is worse than an honest `.webp`.
  const extension = mimeType === 'image/webp' ? 'webp' : 'png'
  return { key, mimeType, filename: `momoto-strip-${id}.${extension}` }
}

// ── GET /strips/:id/print ─── serve the clean copy (owner only) ──────────────
/**
 * The clean deliverable — the single file used for both "download" and "print".
 * Auth-gated (unlike the free watermarked image, which is unauth-by-cuid).
 * When `env.paymentsEnabled`, the strip must also be paid.
 *
 * Streams through this server, which bills Railway egress on every download. The app
 * now asks `/print-url` first and only lands here as a fallback; this stays because a
 * FE from before that route existed still calls it, and because it is the fallback.
 */
stripsRouter.get(
  '/:id/print',
  requireAuth,
  asyncRoute(async (req, res) => {
    const copy = await authorizeCleanCopy(req, res)
    if (!copy) return

    // Streamed from the private bucket, through this gate — the file the user paid
    // for never gets a public URL.
    res.setHeader('Content-Type', copy.mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="${copy.filename}"`)
    // Private paid content — don't let shared caches keep it.
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')

    if (!(await serveImage(res, 'private', copy.key))) {
      res.status(404).json({ error: 'not_found' })
    }
  }),
)

// ── GET /strips/:id/print-url ─── a 60-second R2 URL for the clean copy ──────
/**
 * Same gate as `/print`, but instead of the bytes it returns `{ url, expiresAt }`: a
 * presigned GET the browser fetches straight from the private bucket, so the download
 * costs no Railway egress. Still never a public or long-lived URL — it names one
 * object, expires in a minute, and is only minted after the owner + paid checks.
 *
 * The browser fetches it cross-origin, so the private bucket needs a CORS rule for the
 * app's origins (docs/ARCHITECTURE.md §5) and the R2 host must be in the FE's
 * `connect-src`. If either is missing the FE falls back to `/print`.
 *
 * Doesn't check the object exists — that would be an R2 round trip on every download
 * to catch a case that is already a 404 from R2 itself, which the FE treats as failed.
 */
stripsRouter.get(
  '/:id/print-url',
  requireAuth,
  asyncRoute(async (req, res) => {
    const copy = await authorizeCleanCopy(req, res)
    if (!copy) return

    const { url, expiresAt } = await presignedGetUrl('private', copy.key, {
      filename: copy.filename,
      contentType: copy.mimeType,
    })
    // The URL is a bearer credential for a minute; nothing should keep it.
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ url, expiresAt: expiresAt.toISOString() })
  }),
)

// ── DELETE /strips/:id ─── remove a strip from the cart ──────────────────────
stripsRouter.delete(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    // Read the storage keys before the row goes: the objects aren't reachable once
    // the only thing naming them is deleted, and `StripPrintImage` cascades away too.
    const strip = await prisma.strip.findFirst({
      where: { id: req.params.id, userId },
      select: {
        id: true,
        paid: true,
        storageKey: true,
        thumbnailKey: true,
        printImage: { select: { storageKey: true } },
      },
    })
    // An unlocked strip is never hard-deleted: dropping the row drops its join to the
    // payment that bought it, and the order would no longer say what it was for. The
    // gallery removes one with `POST /strips/:id/remove`, which keeps the row.
    if (strip?.paid) {
      res.status(409).json({ error: 'strip_paid' })
      return
    }
    // Refuse while a still-payable payment covers this strip. Deleting it would drop the
    // join row, and the webhook that settles minutes later would then flip *nothing* —
    // the user charged for a strip that no longer exists. The client hides the control,
    // but the money is the reason the rule lives here rather than only in the UI.
    //
    // Queried inline rather than through payments.ts, which already imports from this
    // module; the expiry check mirrors `findLivePayment` there.
    const livePayment = await prisma.payment.findFirst({
      where: {
        userId,
        status: 'pending',
        expiresAt: { gt: new Date() },
        strips: { some: { id: req.params.id } },
      },
      select: { orderId: true },
    })
    if (livePayment) {
      logger.info('strips.delete.paymentInProgress', {
        userId,
        stripId: req.params.id,
        orderId: livePayment.orderId,
      })
      res.status(409).json({ error: 'payment_in_progress' })
      return
    }

    // Scope the delete to the owner: deleting by id alone would let any signed-in user
    // remove someone else's strip. `deleteMany` makes "not found / not yours" a no-op
    // rather than a P2025 throw.
    const { count } = await prisma.strip.deleteMany({ where: { id: req.params.id, userId } })
    if (count === 0) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    // Best-effort, after the row is gone — a stranded object is a cleanup chore, but
    // a delete that fails because of one would leave the user's cart wrong.
    await deleteStripObjects([strip])
    res.status(204).end()
  }),
)
