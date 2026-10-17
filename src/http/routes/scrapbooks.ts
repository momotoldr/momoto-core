import { Prisma } from '@prisma/client'
import express, { Router, type Request, type Response } from 'express'

import { env } from '../../config/env.js'
import { prisma } from '../../db/client.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import {
  deleteImages,
  incomingKey,
  presignedGetUrl,
  presignedPutUrl,
  promoteObject,
  presignedImageUrl,
  putImage,
  readObject,
  scrapbookKey,
  scrapbookStorageEnabled,
  type Bucket,
} from '../../storage/objectStore.js'
import { signUploadGrant, verifyUploadGrant } from '../../storage/uploadGrant.js'
import { asyncRoute } from '../asyncRoute.js'
import { readImageSize, sniffImageType } from '../imageType.js'
import { requireAuth } from '../middleware/requireAuth.js'
import {
  cartIsFull,
  readDeclaredFile,
  serializeStrip,
  serveImage,
  stripSummarySelect,
} from './strips.js'

/**
 * Scrapbooks: a fixed template filled with the owner's unlocked strips and their own text,
 * finished into a PDF and sold as one. Plan: docs/PLAN-scrapbook.md.
 *
 * The browser does all the rendering. This server stores the layout (`content`), takes the
 * finished PDF and its cover preview, and gates the download — the same split as a strip,
 * whose clean copy the client composes and this server only keeps and hands out.
 */
export const scrapbooksRouter = Router()

/**
 * Where everything a scrapbook stores lives — PDFs, covers and its own `incoming/` uploads
 * — apart from the strip and avatar buckets (user decision, 2026-10-17). Private: PDFs go
 * out through the paid gate, covers through short-lived signed URLs.
 */
const BUCKET: Bucket = 'scrapbook'

/**
 * Guard the routes that touch scrapbook objects when `R2_SCRAPBOOK_BUCKET` isn't set.
 * 503 rather than 500, and the rest of the API — drafts included — keeps working; only
 * finishing, the PDF and covers need the bucket.
 */
function requireScrapbookStorage(res: Response): boolean {
  if (scrapbookStorageEnabled) return true
  logger.error('scrapbooks.storageUnavailable', {
    msg: 'R2_SCRAPBOOK_BUCKET is not configured; scrapbooks cannot be finished or served.',
  })
  res.status(503).json({ error: 'storage_unavailable' })
  return false
}

/** How long a cover's signed URL is good for, and how long the redirect to it is cached —
 * half as long, so a cached redirect never points at an expired URL. */
const COVER_URL_TTL_SECONDS = 10 * 60
const COVER_REDIRECT_MAX_AGE = COVER_URL_TTL_SECONDS / 2

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * Template ids and slot ids are checked for **shape only**. The template manifest lives in
 * one place, the frontend; a second copy here would be one more list to keep in step (the
 * support-topics trap). An id this server doesn't recognise costs nothing: the client
 * simply has no slot to draw it in.
 */
const ID_PATTERN = /^[a-z0-9-]{1,40}$/
const MAX_STRIP_SLOTS = 32
const MAX_TEXT_SLOTS = 32
/** Per text slot. The FE enforces each slot's own, smaller `maxLength`; this is the backstop. */
const MAX_TEXT_LENGTH = 500
const MAX_TITLE_LENGTH = 80
/** A strip id is a cuid; the bound just keeps arbitrary strings out of the document. */
const MAX_STRIP_ID_LENGTH = 64
/** The template has 8 pages; anything near this is not an honest render. */
const MAX_PAGE_COUNT = 64

const PDF_MIME = 'application/pdf'
/**
 * The cover preview: WebP where the browser can encode it, JPEG where it can't — Safari's
 * canvas silently hands back PNG for WebP, and a PNG of a photo page is too big to be a
 * preview. Both are small, both are sniffed, neither is ever decoded here.
 */
const COVER_MIMES = ['image/webp', 'image/jpeg'] as const
/** The cover preview is a ~600px-wide image of page one (plan §7). Generous bounds. */
const COVER_BOUNDS = { maxWidth: 800, maxHeight: 1200, maxBytes: 512 * 1024 }

/** Autosave is chatty (a debounced PUT per pause in typing), so this one is roomy. */
const saveLimiter = new RateLimiter(600, 10 * 60_000)
/** Finishing moves megabytes into R2 — the same posture as a strip save. */
const finishLimiter = new RateLimiter(20, 10 * 60_000)
/** Everything else that changes a row: create, duplicate, reopen, unlock, remove, delete. */
const changeLimiter = new RateLimiter(60, 10 * 60_000)

/** Reclaim expired scrapbook rate windows (wired into the periodic sweep). */
export function sweepScrapbookLimits(now: number = Date.now()): number {
  return saveLimiter.sweep(now) + finishLimiter.sweep(now) + changeLimiter.sweep(now)
}

// ── Shape ────────────────────────────────────────────────────────────────────

/** The layout: which strip sits in which slot, and the text typed into each text slot. */
interface ScrapbookContent {
  strips: Record<string, string>
  texts: Record<string, string>
}

const EMPTY_CONTENT: ScrapbookContent = { strips: {}, texts: {} }

const scrapbookSelect = {
  id: true,
  templateId: true,
  title: true,
  content: true,
  finishedAt: true,
  pdfKey: true,
  pageCount: true,
  coverKey: true,
  paid: true,
  paidAt: true,
  removedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

type ScrapbookRow = Prisma.ScrapbookGetPayload<{ select: typeof scrapbookSelect }>

type ScrapbookState = 'draft' | 'finished' | 'paid'

/** Derived, never stored: the columns already say it, and a stored copy could disagree. */
function stateOf(row: { paid: boolean; finishedAt: Date | null }): ScrapbookState {
  if (row.paid) return 'paid'
  return row.finishedAt ? 'finished' : 'draft'
}

/**
 * Read a stored `content` back into its shape. Every write goes through `readContent`, so
 * this only guards against a row edited by hand — anything off is dropped, not thrown.
 */
function storedContent(value: Prisma.JsonValue): ScrapbookContent {
  return readContent(value) ?? EMPTY_CONTENT
}

/** The distinct strips a layout uses, in no particular order. */
function stripIdsOf(content: ScrapbookContent): string[] {
  return [...new Set(Object.values(content.strips))]
}

/**
 * The cover's URL. Absolute off the CDN when the public bucket has an origin; otherwise
 * the relative proxy route, which the client resolves against the API base — the same
 * contract as a strip's `thumbnailUrl`. Null for a scrapbook that has no cover yet.
 */
export function coverUrlOf(row: { id: string; coverKey: string | null }): string | null {
  if (!row.coverKey) return null
  // Always the API route, which redirects to a signed URL — the bucket has no public
  // origin. `v` is the key's own UUID, so a re-finish (new key) is a new URL and no cached
  // redirect can show the old cover.
  const version = row.coverKey.slice(row.coverKey.lastIndexOf('/') + 1).split('.')[0]
  return `/scrapbooks/${row.id}/cover?v=${version}`
}

/** One scrapbook for the shelf: no content, just enough to draw a cover and a state tape. */
function serializeSummary(row: ScrapbookRow) {
  return {
    id: row.id,
    templateId: row.templateId,
    title: row.title,
    state: stateOf(row),
    coverUrl: coverUrlOf(row),
    // Lets the gallery's Remove dialog say "this strip is in a scrapbook" without loading
    // every layout (plan §2d).
    stripIds: stripIdsOf(storedContent(row.content)),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** One scrapbook in full, for the editor and the read-only viewer. */
function serializeScrapbook(row: ScrapbookRow) {
  return {
    ...serializeSummary(row),
    content: storedContent(row.content),
    pageCount: row.pageCount,
    createdAt: row.createdAt.toISOString(),
    // The version a finish must be rendered from (see `ScrapbookUploadGrant`). Same value
    // as `updatedAt`; named for what the client does with it.
    contentVersion: row.updatedAt.toISOString(),
  }
}

/**
 * Validate a layout from the client. Null when it isn't the right shape — any bad key,
 * value or count refuses the whole document rather than saving part of it.
 */
function readContent(value: unknown): ScrapbookContent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { strips, texts } = value as { strips?: unknown; texts?: unknown }
  const stripEntries = readMap(strips, MAX_STRIP_SLOTS, (id) =>
    typeof id === 'string' && id.length > 0 && id.length <= MAX_STRIP_ID_LENGTH ? id : null,
  )
  const textEntries = readMap(texts, MAX_TEXT_SLOTS, (text) =>
    typeof text === 'string' ? normaliseText(text, MAX_TEXT_LENGTH) : null,
  )
  if (!stripEntries || !textEntries) return null
  return { strips: stripEntries, texts: textEntries }
}

function readMap(
  value: unknown,
  maxEntries: number,
  readValue: (raw: unknown) => string | null,
): Record<string, string> | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > maxEntries) return null
  const out: Record<string, string> = {}
  for (const [key, raw] of entries) {
    if (!ID_PATTERN.test(key)) return null
    const read = readValue(raw)
    if (read === null) return null
    // An empty text slot is the same as no entry; keep the document small.
    if (read !== '') out[key] = read
  }
  return out
}

/**
 * Text is drawn onto a canvas, never put into HTML, so there is nothing to escape — only
 * normalise: one newline convention, no NULs, and the length bound. Over-long is refused
 * rather than cut, since a silent cut would change what the user typed.
 */
function normaliseText(text: string, max: number): string | null {
  const clean = text.replace(/\r\n?/g, '\n').replaceAll('\u0000', '')
  return clean.length <= max ? clean : null
}

function readTitle(value: unknown): string | null {
  if (value === undefined) return ''
  if (typeof value !== 'string') return null
  const title = normaliseText(value, MAX_TITLE_LENGTH)
  return title === null ? null : title.replace(/\n/g, ' ').trim()
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** The caller's scrapbook, unless it has been removed. Null is a 404 either way. */
function findOwn(userId: string, id: string) {
  return prisma.scrapbook.findFirst({
    where: { id, userId, removedAt: null },
    select: scrapbookSelect,
  })
}

function notFound(res: Response): void {
  res.status(404).json({ error: 'not_found' })
}

/** How many scrapbooks the user holds against the cap. Removed ones have given theirs up. */
async function quotaFor(userId: string) {
  const used = await prisma.scrapbook.count({ where: { userId, removedAt: null } })
  return { used, limit: env.scrapbookMaxItems }
}

/**
 * Refuse a create or duplicate at the cap. Checked before the insert; two tabs racing can
 * land at cap + 1, accepted rather than paying for a serializable transaction (the cart's
 * posture too).
 */
async function refuseIfFull(res: Response, userId: string): Promise<boolean> {
  const quota = await quotaFor(userId)
  if (quota.used < quota.limit) return false
  logger.info('scrapbooks.full', { userId, ...quota })
  res.status(409).json({ error: 'scrapbook_limit', ...quota })
  return true
}

/**
 * Whether a payment attempt that can still be paid names this scrapbook. Reopening or
 * deleting one under a live QR would let someone pay for a PDF that no longer exists.
 *
 * Takes the transaction it runs in: every caller holds the row lock (`lockScrapbook`), so
 * the answer can't change before their write.
 */
export async function hasLivePayment(
  scrapbookId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const live = await db.payment.findFirst({
    where: {
      status: 'pending',
      expiresAt: { gt: new Date() },
      scrapbooks: { some: { id: scrapbookId } },
    },
    select: { id: true },
  })
  return live !== null
}

/**
 * The strips a layout may newly place: the caller's own, unlocked, and not removed from
 * the gallery. Returns the ids that fail, so the editor can mark the exact slots.
 *
 * Only strips *new* to the layout are checked. One placed earlier and since removed from
 * the gallery stays where it was (it renders as an empty slot, plan §2d), so the rest of a
 * draft can still be saved around it.
 */
async function unusableStrips(userId: string, stripIds: string[]): Promise<string[]> {
  if (stripIds.length === 0) return []
  const usable = await prisma.strip.findMany({
    where: { id: { in: stripIds }, userId, paid: true, removedAt: null },
    select: { id: true },
  })
  const ok = new Set(usable.map((strip) => strip.id))
  return stripIds.filter((id) => !ok.has(id))
}

/**
 * Take the scrapbook's row lock for the rest of the transaction.
 *
 * Serialises the three writes that must not interleave: recording a payment for a
 * finished scrapbook (`/payments/charge`), reopening it, and deleting it. Each checks
 * the scrapbook's state and the live payments that name it *under this lock*, so a reopen
 * can't delete the PDF between checkout's check and its payment being saved — the race
 * that would otherwise settle a payment on a draft with nothing to download.
 *
 * Not held across the Midtrans call (an external request of seconds): checkout charges
 * first, then takes the lock only to re-check and record.
 */
export async function lockScrapbook(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT 1 FROM "Scrapbook" WHERE "id" = ${id} FOR UPDATE`
}

/**
 * Whether a scrapbook can be bought: the caller's, not removed, finished with a stored
 * PDF, and not already paid. Shared by the free unlock and `/payments/charge` so both
 * refuse on identical grounds, as `findPurchasableStrips` is for strips.
 */
export type PurchasableScrapbook =
  | { ok: true; scrapbook: { id: string; title: string } }
  | { ok: false; status: 404 | 409; error: 'not_found' | 'scrapbook_already_paid' | 'not_finished' }

export async function findPurchasableScrapbook(
  userId: string,
  scrapbookId: string,
  db: Prisma.TransactionClient = prisma,
): Promise<PurchasableScrapbook> {
  const row = await db.scrapbook.findFirst({
    where: { id: scrapbookId, userId, removedAt: null },
    select: { id: true, title: true, paid: true, finishedAt: true, pdfKey: true },
  })
  if (!row) return { ok: false, status: 404, error: 'not_found' }
  if (row.paid) return { ok: false, status: 409, error: 'scrapbook_already_paid' }
  if (!row.finishedAt || !row.pdfKey) return { ok: false, status: 409, error: 'not_finished' }
  return { ok: true, scrapbook: { id: row.id, title: row.title } }
}

/** Best-effort removal of a scrapbook's objects. A leftover is a cleanup job, not an error. */
export async function deleteScrapbookObjects(
  rows: { pdfKey: string | null; coverKey: string | null }[],
): Promise<void> {
  const pdfKeys = rows.map((row) => row.pdfKey).filter((key): key is string => !!key)
  const coverKeys = rows.map((row) => row.coverKey).filter((key): key is string => !!key)
  await deleteImages(BUCKET, [...pdfKeys, ...coverKeys])
}

/**
 * Every object a user's scrapbooks hold, for account deletion: the rows cascade with the
 * user, the objects don't (R2 never cascades), so the keys are read while the rows exist.
 */
export function scrapbookObjectsOf(userId: string) {
  return prisma.scrapbook.findMany({
    where: { userId },
    select: { pdfKey: true, coverKey: true },
  })
}

// ── Finishing: the checks both upload paths share ───────────────────────────
//
// A finished PDF arrives one of two ways: uploaded by the browser straight to R2 and then
// completed (`/finish/uploads` → `/finish/uploads/complete`), or as one raw body through
// `/finish`, the fallback. Everything that decides *whether* a finish is kept lives here,
// so the two can't disagree.

interface FinishFiles {
  pdf: Buffer
  cover: Buffer
}

/**
 * Check a finished scrapbook's bytes. A refusal code, or null when they are acceptable.
 *
 * The PDF is checked for being a whole PDF — the `%PDF-` header and an `%%EOF` near the
 * end, which a truncated upload lacks — not for matching `content`. The browser rendered
 * it, and someone determined enough could render anything; every photo it can hold is a
 * strip they already own (plan, *Trust model*). The cover is sniffed and sized from its
 * header, never decoded, like a strip's thumbnail.
 */
async function checkFinishFiles(
  files: FinishFiles,
): Promise<{ ok: false; error: string } | { ok: true; coverType: string }> {
  const { pdf, cover } = files
  const refuse = (error: string) => ({ ok: false as const, error })
  if (pdf.length === 0 || pdf.length > env.scrapbookPdfMaxBytes) return refuse('invalid_pdf')
  if (pdf.toString('latin1', 0, 5) !== '%PDF-') return refuse('invalid_pdf')
  if (!pdf.toString('latin1', Math.max(0, pdf.length - 1024)).includes('%%EOF')) {
    return refuse('invalid_pdf')
  }
  if (cover.length === 0 || cover.length > COVER_BOUNDS.maxBytes) return refuse('invalid_cover')
  const coverType = sniffImageType(cover)
  if (!coverType || !(COVER_MIMES as readonly string[]).includes(coverType)) {
    return refuse('invalid_cover')
  }
  const size = await readImageSize(cover)
  if (!size || size.width > COVER_BOUNDS.maxWidth || size.height > COVER_BOUNDS.maxHeight) {
    return refuse('invalid_cover')
  }
  return { ok: true, coverType }
}

function readPageCount(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_PAGE_COUNT ? n : null
}

/**
 * Mark a draft finished, but only if it is still the draft the PDF was rendered from.
 *
 * Guarded in the write itself (`finishedAt: null` and the exact `updatedAt`), so an
 * autosave or a second finish landing between our checks and this write can't be missed.
 * When the guard fails the objects just stored are named by nothing, so they are deleted
 * here, and the answer says why: someone else finished it, or the content moved.
 */
async function markFinished(
  res: Response,
  userId: string,
  scrapbookId: string,
  contentVersion: Date,
  stored: { pdfKey: string; coverKey: string; pdfBytes: number; pageCount: number },
  log: { direct: boolean },
): Promise<void> {
  const { count } = await prisma.scrapbook.updateMany({
    where: {
      id: scrapbookId,
      userId,
      removedAt: null,
      finishedAt: null,
      updatedAt: contentVersion,
    },
    data: { ...stored, finishedAt: new Date() },
  })
  if (count === 0) {
    await deleteScrapbookObjects([stored])
    const now = await findOwn(userId, scrapbookId)
    if (!now) return notFound(res)
    const error = now.finishedAt ? 'scrapbook_locked' : 'content_changed'
    logger.info('scrapbooks.finishRaced', { userId, scrapbookId, error })
    res.status(409).json({ error })
    return
  }
  const row = await findOwn(userId, scrapbookId)
  if (!row) return notFound(res)
  logger.info('scrapbooks.finished', {
    userId,
    scrapbookId,
    bytes: stored.pdfBytes,
    pageCount: stored.pageCount,
    // Which path the bytes took. `false` from a current client means its direct upload
    // failed and it fell back — usually the print bucket's CORS rule — and cost egress.
    direct: log.direct,
  })
  res.json({ scrapbook: serializeScrapbook(row) })
}

/** A draft the caller may finish, or the reason it can't be. Answers for the caller. */
async function findFinishable(
  res: Response,
  userId: string,
  scrapbookId: string,
): Promise<ScrapbookRow | null> {
  const row = await findOwn(userId, scrapbookId)
  if (!row) {
    notFound(res)
    return null
  }
  if (row.finishedAt) {
    // Also what a retry sees after a finish that landed but whose answer was lost — the
    // client reads the state on this and treats `finished` as its success (plan §2b).
    res.status(409).json({ error: 'scrapbook_locked' })
    return null
  }
  // Finishing puts it in the cart, where it takes a slot like a strip (2026-10-17). Checked
  // at every step of a finish, before anything is promoted, so a cart that filled up
  // between start and complete still refuses — the uploads left in `incoming/` expire.
  if (await cartIsFull(userId)) {
    res.status(409).json({ error: 'cart_full' })
    return null
  }
  return row
}

// ── GET /scrapbooks ─── the shelf ────────────────────────────────────────────
scrapbooksRouter.get(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const rows = await prisma.scrapbook.findMany({
      where: { userId, removedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: scrapbookSelect,
    })
    res.json({
      scrapbooks: rows.map(serializeSummary),
      // Counted from the rows in hand — the listing already loaded every one.
      quota: { used: rows.length, limit: env.scrapbookMaxItems },
    })
  }),
)

// ── POST /scrapbooks ─── start a new draft ───────────────────────────────────
scrapbooksRouter.post(
  '/',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!changeLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const { templateId } = (req.body ?? {}) as { templateId?: unknown }
    if (typeof templateId !== 'string' || !ID_PATTERN.test(templateId)) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }
    if (await refuseIfFull(res, userId)) return

    const row = await prisma.scrapbook.create({
      data: { userId, templateId, content: EMPTY_CONTENT as unknown as Prisma.InputJsonObject },
      select: scrapbookSelect,
    })
    logger.info('scrapbooks.created', { userId, scrapbookId: row.id, templateId })
    res.status(201).json({ scrapbook: serializeScrapbook(row) })
  }),
)

// ── GET /scrapbooks/:id ─── one scrapbook, with the strips it uses ───────────
/**
 * `strips` holds every strip the layout references that is still usable, serialized as
 * `GET /strips` does, so the editor can draw them without the cart store. `missing` names
 * the ones that aren't any more — removed from the gallery since — which the editor draws
 * as empty slots with a note (plan §2d).
 */
scrapbooksRouter.get(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const row = await findOwn(userId, req.params.id as string)
    if (!row) return notFound(res)

    const ids = stripIdsOf(storedContent(row.content))
    const strips =
      ids.length === 0
        ? []
        : await prisma.strip.findMany({
            where: { id: { in: ids }, userId, paid: true, removedAt: null },
            select: stripSummarySelect,
          })
    const found = new Set(strips.map((strip) => strip.id))
    res.json({
      scrapbook: serializeScrapbook(row),
      strips: strips.map(serializeStrip),
      missing: ids.filter((id) => !found.has(id)),
    })
  }),
)

// ── PUT /scrapbooks/:id ─── autosave the layout ──────────────────────────────
/**
 * Replace a draft's title and content wholesale. Last write wins: one person editing in
 * two tabs isn't worth locking for, and a finish already refuses content that moved under
 * it (`content_changed`).
 *
 * `422 strip_unavailable` names the newly placed strips that can't be used — not the
 * caller's, not unlocked, or removed — so the editor can clear those slots.
 */
scrapbooksRouter.put(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const scrapbookId = req.params.id as string
    if (!saveLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const body = (req.body ?? {}) as { title?: unknown; content?: unknown }
    const title = readTitle(body.title)
    const content = readContent(body.content)
    if (title === null || !content) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const row = await findOwn(userId, scrapbookId)
    if (!row) return notFound(res)
    if (row.finishedAt) {
      res.status(409).json({ error: 'scrapbook_locked' })
      return
    }

    const before = new Set(stripIdsOf(storedContent(row.content)))
    const added = stripIdsOf(content).filter((id) => !before.has(id))
    const unusable = await unusableStrips(userId, added)
    if (unusable.length > 0) {
      res.status(422).json({ error: 'strip_unavailable', stripIds: unusable })
      return
    }

    // Guarded on `finishedAt: null` in the write, so a finish that landed since the read
    // above can't have its content changed underneath its PDF.
    const { count } = await prisma.scrapbook.updateMany({
      where: { id: scrapbookId, userId, removedAt: null, finishedAt: null },
      data: { title, content: content as unknown as Prisma.InputJsonObject },
    })
    if (count === 0) {
      res.status(409).json({ error: 'scrapbook_locked' })
      return
    }
    const saved = await findOwn(userId, scrapbookId)
    if (!saved) return notFound(res)
    res.json({ scrapbook: serializeScrapbook(saved) })
  }),
)

// ── POST /scrapbooks/:id/finish/uploads ─── start a direct finish ────────────
/**
 * Start finishing a draft whose PDF and cover go browser → R2 directly, so the bytes never
 * cross this server. Body (JSON): `{ pdf: {type, size}, cover: {type, size}, pageCount,
 * contentVersion }` — `contentVersion` is the scrapbook's version the PDF was **rendered
 * from**, as the client last read it.
 *
 * Refused with `409 content_changed` right here if that is no longer the current version:
 * an edit that landed between the render and this request would otherwise be taken as the
 * version to finish, and its PDF stored for content it doesn't show. (The grant carries the
 * same version, so an edit between here and completion is caught there too.)
 *
 * Both files land under `incoming/` in the **private** upload bucket — the cover too,
 * since nothing unvalidated may sit where a public origin serves it — and the grant
 * carries the content version the PDF was rendered from. Answers
 * `{ upload: { token, files: { pdf, cover } } }`.
 */
scrapbooksRouter.post(
  '/:id/finish/uploads',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const scrapbookId = req.params.id as string
    if (!requireScrapbookStorage(res)) return
    if (!finishLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const pdf = readDeclaredFile(body.pdf, [PDF_MIME], env.scrapbookPdfMaxBytes)
    const cover = readDeclaredFile(body.cover, COVER_MIMES, COVER_BOUNDS.maxBytes)
    const pageCount = readPageCount(body.pageCount)
    const contentVersion = typeof body.contentVersion === 'string' ? body.contentVersion : null
    if (!pdf || !cover || pageCount === null || !contentVersion) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const row = await findFinishable(res, userId, scrapbookId)
    if (!row) return
    if (row.updatedAt.toISOString() !== contentVersion) {
      logger.info('scrapbooks.contentChanged', { userId, scrapbookId, direct: true, at: 'start' })
      res.status(409).json({ error: 'content_changed' })
      return
    }

    const granted = {
      pdf: { key: incomingKey(), ...pdf },
      cover: { key: incomingKey(), ...cover },
    }
    const presign = (file: { key: string; contentType: string; size: number }) =>
      presignedPutUrl(BUCKET, file.key, {
        contentType: file.contentType,
        contentLength: file.size,
      }).then((url) => ({ url, contentType: file.contentType }))
    const [pdfPut, coverPut] = await Promise.all([presign(granted.pdf), presign(granted.cover)])

    const token = signUploadGrant({
      kind: 'scrapbook',
      userId,
      scrapbookId,
      contentVersion,
      ...granted,
      pageCount,
    })
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ upload: { token, files: { pdf: pdfPut, cover: coverPut } } })
  }),
)

// ── POST /scrapbooks/:id/finish/uploads/complete ─── validate, promote, lock ─
/**
 * Finish a direct upload: read both files back from `incoming/` (free ingress), check
 * them, copy the PDF within the private bucket and the cover across to the public one,
 * and lock the draft. Body (JSON): `{ token }`.
 *
 * `409 content_changed` — the scrapbook was edited after the PDF was rendered; the client
 * re-renders. `409 upload_incomplete` — a granted file isn't there; the client falls back
 * to `/finish`. `409 scrapbook_locked` — already finished; the client reads the state.
 */
scrapbooksRouter.post(
  '/:id/finish/uploads/complete',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const scrapbookId = req.params.id as string
    if (!requireScrapbookStorage(res)) return
    const grant = verifyUploadGrant(
      (req.body as { token?: unknown } | undefined)?.token,
      'scrapbook',
      userId,
    )
    if (!grant || grant.scrapbookId !== scrapbookId) {
      res.status(400).json({ error: 'invalid_upload' })
      return
    }
    // Best-effort, like every delete: the lifecycle rule on `incoming/` is the backstop.
    const dropIncoming = () => deleteImages(BUCKET, [grant.pdf.key, grant.cover.key])

    const row = await findFinishable(res, userId, scrapbookId)
    if (!row) {
      await dropIncoming()
      return
    }
    // Checked before reading megabytes back: an edit since the render settles it.
    if (row.updatedAt.toISOString() !== grant.contentVersion) {
      await dropIncoming()
      // How often this fires says whether the browser's tab freeze (plan §7b) is enough.
      logger.info('scrapbooks.contentChanged', { userId, scrapbookId, direct: true })
      res.status(409).json({ error: 'content_changed' })
      return
    }

    const [pdf, cover] = await Promise.all([
      readObject(BUCKET, grant.pdf.key, env.scrapbookPdfMaxBytes),
      readObject(BUCKET, grant.cover.key, COVER_BOUNDS.maxBytes),
    ])
    if (!pdf || !cover) {
      res.status(409).json({ error: 'upload_incomplete' })
      return
    }
    const checked = await checkFinishFiles({ pdf, cover })
    if (!checked.ok) {
      await dropIncoming()
      res.status(400).json({ error: checked.error })
      return
    }

    const stored = {
      pdfKey: scrapbookKey('pdf'),
      coverKey: scrapbookKey('cover', checked.coverType),
      pdfBytes: pdf.length,
      pageCount: grant.pageCount,
    }
    try {
      await Promise.all([
        promoteObject(grant.pdf.key, BUCKET, stored.pdfKey, PDF_MIME, BUCKET),
        promoteObject(grant.cover.key, BUCKET, stored.coverKey, checked.coverType, BUCKET),
      ])
    } catch (error) {
      // One copy may have landed; with no row naming it, it is an orphan unless dropped.
      await deleteScrapbookObjects([stored])
      throw error
    }

    await markFinished(res, userId, scrapbookId, row.updatedAt, stored, { direct: true })
    // After the row, so a failure above leaves the uploads for a retry to complete.
    await dropIncoming()
  }),
)

// ── POST /scrapbooks/:id/finish ─── the fallback: bytes through the API ──────
/**
 * The finish with its bytes in the body, stored by this server. Only for when the direct
 * path fails (the client's `shouldFallBack`); every byte here is Railway egress on its way
 * to R2.
 *
 * Body: `"MOMS"[u32 len pdf][pdf][cover webp or jpeg]`, `Content-Type: application/octet-stream`.
 * Query: `pageCount`, and `contentVersion` — the `updatedAt` the client rendered from, so
 * this path refuses stale content exactly as completion does.
 */
const SCRAPBOOK_BUNDLE_MAGIC = Buffer.from('MOMS', 'ascii')

const finishBody = express.raw({
  type: 'application/octet-stream',
  limit: SCRAPBOOK_BUNDLE_MAGIC.length + 4 + env.scrapbookPdfMaxBytes + COVER_BOUNDS.maxBytes,
})

function splitFinishBundle(body: Buffer): FinishFiles | null {
  const head = SCRAPBOOK_BUNDLE_MAGIC.length
  if (body.length < head + 4 || !body.subarray(0, head).equals(SCRAPBOOK_BUNDLE_MAGIC)) {
    return null
  }
  const pdfLength = body.readUInt32BE(head)
  if (pdfLength === 0 || pdfLength > env.scrapbookPdfMaxBytes) return null
  const start = head + 4
  const end = start + pdfLength
  if (end >= body.length) return null
  return { pdf: body.subarray(start, end), cover: body.subarray(end) }
}

scrapbooksRouter.post(
  '/:id/finish',
  requireAuth,
  finishBody,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const scrapbookId = req.params.id as string
    if (!requireScrapbookStorage(res)) return
    if (!finishLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const query = req.query as Record<string, unknown>
    const pageCount = readPageCount(query.pageCount)
    const contentVersion =
      typeof query.contentVersion === 'string' ? new Date(query.contentVersion) : null
    const files = Buffer.isBuffer(req.body) ? splitFinishBundle(req.body) : null
    if (!files || pageCount === null || !contentVersion || Number.isNaN(contentVersion.getTime())) {
      res.status(400).json({ error: 'invalid_input' })
      return
    }

    const row = await findFinishable(res, userId, scrapbookId)
    if (!row) return
    if (row.updatedAt.getTime() !== contentVersion.getTime()) {
      logger.info('scrapbooks.contentChanged', { userId, scrapbookId, direct: false })
      res.status(409).json({ error: 'content_changed' })
      return
    }
    const checked = await checkFinishFiles(files)
    if (!checked.ok) {
      res.status(400).json({ error: checked.error })
      return
    }

    // Objects before the row, so a row never names a missing object.
    const stored = {
      pdfKey: scrapbookKey('pdf'),
      coverKey: scrapbookKey('cover', checked.coverType),
      pdfBytes: files.pdf.length,
      pageCount,
    }
    try {
      await Promise.all([
        putImage(BUCKET, stored.pdfKey, files.pdf, PDF_MIME),
        putImage(BUCKET, stored.coverKey, files.cover, checked.coverType),
      ])
    } catch (error) {
      await deleteScrapbookObjects([stored])
      throw error
    }
    await markFinished(res, userId, scrapbookId, row.updatedAt, stored, { direct: false })
  }),
)

// ── POST /scrapbooks/:id/reopen ─── back to a draft ──────────────────────────
/**
 * "Keep editing" on a finished, unpaid scrapbook: delete its PDF and cover and unlock the
 * content. Refused once paid (a paid scrapbook is final — Duplicate instead) and while a
 * payment attempt that can still be paid names it. Reopening a draft is a no-op success.
 */
scrapbooksRouter.post(
  '/:id/reopen',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const scrapbookId = req.params.id as string
    if (!changeLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const row = await findOwn(userId, scrapbookId)
    if (!row) return notFound(res)
    if (row.paid) {
      res.status(409).json({ error: 'scrapbook_paid' })
      return
    }
    if (!row.finishedAt) {
      res.json({ scrapbook: serializeScrapbook(row) })
      return
    }

    // Under the row lock, so checkout can't record a payment between this check and the
    // write (see `lockScrapbook`).
    const outcome = await prisma.$transaction(async (tx) => {
      await lockScrapbook(tx, scrapbookId)
      if (await hasLivePayment(scrapbookId, tx)) return 'payment_in_progress' as const
      const { count } = await tx.scrapbook.updateMany({
        where: { id: scrapbookId, userId, removedAt: null, paid: false, finishedAt: { not: null } },
        data: { finishedAt: null, pdfKey: null, coverKey: null, pdfBytes: null, pageCount: null },
      })
      return count > 0 ? ('reopened' as const) : ('unchanged' as const)
    })
    if (outcome === 'payment_in_progress') {
      res.status(409).json({ error: 'payment_in_progress' })
      return
    }
    // Only the request that actually unlocked it deletes the objects the row named — and
    // only after the transaction committed, so a rollback never leaves a row naming
    // deleted objects.
    if (outcome === 'reopened') await deleteScrapbookObjects([row])
    const now = await findOwn(userId, scrapbookId)
    if (!now) return notFound(res)
    logger.info('scrapbooks.reopened', { userId, scrapbookId })
    res.json({ scrapbook: serializeScrapbook(now) })
  }),
)

// ── POST /scrapbooks/:id/unlock ─── free unlock, while payments are dark ─────
/**
 * The scrapbook twin of `POST /strips/unlock`: flips `paid` the way a settled payment
 * would, so the download gate behaves identically whichever path got it there. No
 * `Payment` row — nothing was charged.
 *
 * **Refused outright once payments are enabled**, before anything else runs; that check
 * is what keeps this from being a way to take the paid PDF for nothing.
 */
scrapbooksRouter.post(
  '/:id/unlock',
  requireAuth,
  asyncRoute(async (req, res) => {
    if (env.paymentsEnabled) {
      res.status(403).json({ error: 'payments_enabled' })
      return
    }
    const userId = req.userId as string
    const scrapbookId = req.params.id as string
    if (!changeLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const purchasable = await findPurchasableScrapbook(userId, scrapbookId)
    // Already paid is the success this call is for — a double tap or a retry lands here.
    if (!purchasable.ok && purchasable.error !== 'scrapbook_already_paid') {
      res.status(purchasable.status).json({ error: purchasable.error })
      return
    }
    if (purchasable.ok) {
      await prisma.scrapbook.updateMany({
        where: { id: scrapbookId, userId, paid: false, finishedAt: { not: null } },
        data: { paid: true, paidAt: new Date() },
      })
      logger.info('scrapbooks.unlocked', { userId, scrapbookId, free: true })
    }
    const now = await findOwn(userId, scrapbookId)
    if (!now) return notFound(res)
    res.json({ scrapbook: serializeScrapbook(now) })
  }),
)

// ── POST /scrapbooks/:id/duplicate ─── a new draft from any scrapbook ────────
/**
 * How a user gets a different version of a paid (final) scrapbook — or a copy of any
 * other. Copies template, title and content; never the PDF, cover or paid state. Strips
 * that have left the gallery since come along and show as missing, like in any draft.
 */
scrapbooksRouter.post(
  '/:id/duplicate',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    if (!changeLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const source = await findOwn(userId, req.params.id as string)
    if (!source) return notFound(res)
    if (await refuseIfFull(res, userId)) return

    const row = await prisma.scrapbook.create({
      data: {
        userId,
        templateId: source.templateId,
        title: source.title,
        content: storedContent(source.content) as unknown as Prisma.InputJsonObject,
      },
      select: scrapbookSelect,
    })
    logger.info('scrapbooks.duplicated', { userId, scrapbookId: row.id, from: source.id })
    res.status(201).json({ scrapbook: serializeScrapbook(row) })
  }),
)

// ── POST /scrapbooks/:id/remove ─── soft remove of a paid scrapbook ──────────
/**
 * The gallery's soft remove, for scrapbooks: the row stays (its `Payment` names it — the
 * record a refund or support question needs) and both objects go. Only for paid ones;
 * an unpaid scrapbook is simply deleted. Removing twice is a no-op success.
 */
scrapbooksRouter.post(
  '/:id/remove',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const scrapbookId = req.params.id as string
    if (!changeLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    // Not `findOwn`: an already-removed scrapbook answers success, not 404.
    const row = await prisma.scrapbook.findFirst({
      where: { id: scrapbookId, userId },
      select: { paid: true, removedAt: true, pdfKey: true, coverKey: true },
    })
    if (!row) return notFound(res)
    if (!row.paid) {
      res.status(409).json({ error: 'scrapbook_not_paid' })
      return
    }
    if (!row.removedAt) {
      // Guarded on `removedAt: null` so two racing removes can't both delete objects.
      const { count } = await prisma.scrapbook.updateMany({
        where: { id: scrapbookId, userId, paid: true, removedAt: null },
        data: { removedAt: new Date(), pdfKey: null, coverKey: null },
      })
      if (count > 0) {
        await deleteScrapbookObjects([row])
        logger.info('scrapbooks.removed', { userId, scrapbookId })
      }
    }
    res.json({ quota: await quotaFor(userId) })
  }),
)

// ── DELETE /scrapbooks/:id ─── delete an unpaid scrapbook ────────────────────
scrapbooksRouter.delete(
  '/:id',
  requireAuth,
  asyncRoute(async (req, res) => {
    const userId = req.userId as string
    const scrapbookId = req.params.id as string
    if (!changeLimiter.allow(userId)) {
      res.status(429).json({ error: 'too_many_requests' })
      return
    }
    const row = await prisma.scrapbook.findFirst({
      where: { id: scrapbookId, userId },
      select: { paid: true, pdfKey: true, coverKey: true },
    })
    if (!row) return notFound(res)
    // A paid one is never hard-deleted: its payment would lose the record of what it
    // bought. `/remove` is the way out for those.
    if (row.paid) {
      res.status(409).json({ error: 'scrapbook_paid' })
      return
    }
    const outcome = await prisma.$transaction(async (tx) => {
      await lockScrapbook(tx, scrapbookId)
      if (await hasLivePayment(scrapbookId, tx)) return 'payment_in_progress' as const
      const { count } = await tx.scrapbook.deleteMany({
        where: { id: scrapbookId, userId, paid: false },
      })
      return count > 0 ? ('deleted' as const) : ('unchanged' as const)
    })
    if (outcome === 'payment_in_progress') {
      res.status(409).json({ error: 'payment_in_progress' })
      return
    }
    if (outcome === 'deleted') {
      await deleteScrapbookObjects([row])
      logger.info('scrapbooks.deleted', { userId, scrapbookId })
    }
    res.json({ quota: await quotaFor(userId) })
  }),
)

// ── The PDF's gate ───────────────────────────────────────────────────────────

/**
 * Decide whether the caller may have this scrapbook's PDF, and answer for them if not.
 *
 * Shared by both ways of handing it over (`/pdf` streams it, `/pdf-url` signs a URL), so
 * they can never drift apart on who gets the file — the `authorizeCleanCopy` pattern.
 *
 * Stricter than a strip's clean copy on one point: the PDF needs `paid` **whatever**
 * `env.paymentsEnabled` says. A scrapbook has its own free unlock while payments are dark,
 * so there is no state in which an unpaid PDF should leave the server.
 */
async function authorizePdf(
  req: Request,
  res: Response,
): Promise<{ key: string; filename: string } | null> {
  const userId = req.userId as string
  const row = await findOwn(userId, req.params.id as string)
  if (!row || !row.pdfKey) {
    notFound(res)
    return null
  }
  if (!row.paid) {
    res.status(402).json({ error: 'payment_required' })
    return null
  }
  return { key: row.pdfKey, filename: `momoto-scrapbook-${slugOf(row.title, row.id)}.pdf` }
}

/** A filename-safe slug of the title, or the id when the title has nothing usable. */
function slugOf(title: string, fallback: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || fallback
}

// ── GET /scrapbooks/:id/pdf-url ─── a 60-second R2 URL for the PDF ───────────
/**
 * `{ url, expiresAt }`: a presigned GET the browser fetches straight from the private
 * bucket, so the download costs no Railway egress. Minted only after the owner + paid
 * gate, for one object, for a minute. The print bucket's CORS rule and the CSP entry that
 * clean strips need already cover it (docs/ARCHITECTURE.md §5); without them the client
 * falls back to `/pdf`.
 */
scrapbooksRouter.get(
  '/:id/pdf-url',
  requireAuth,
  asyncRoute(async (req, res) => {
    const pdf = await authorizePdf(req, res)
    if (!pdf) return
    const { url, expiresAt } = await presignedGetUrl(BUCKET, pdf.key, {
      filename: pdf.filename,
      contentType: PDF_MIME,
    })
    // The URL is a bearer credential for a minute; nothing should keep it.
    res.setHeader('Cache-Control', 'private, no-store')
    res.json({ url, expiresAt: expiresAt.toISOString() })
  }),
)

// ── GET /scrapbooks/:id/pdf ─── the fallback: stream the PDF ─────────────────
scrapbooksRouter.get(
  '/:id/pdf',
  requireAuth,
  asyncRoute(async (req, res) => {
    const pdf = await authorizePdf(req, res)
    if (!pdf) return
    res.setHeader('Content-Type', PDF_MIME)
    res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`)
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (!(await serveImage(res, BUCKET, pdf.key))) notFound(res)
  }),
)

// ── GET /scrapbooks/:id/cover ─── the cover preview, via a signed URL ────────
/**
 * Every cover URL points here: the scrapbook bucket is private, so this answers with a
 * redirect to a short-lived signed URL rather than streaming the bytes — R2 serves them,
 * and they cost no Railway egress. The redirect is cached for half the URL's life, so a
 * cached redirect never lands on an expired URL; the `v` the cover URL carries changes
 * with every finish, so a new cover is never hidden behind an old redirect.
 *
 * **Unauthenticated**, like a strip's thumbnail — it goes in an `<img>`, which can't carry
 * a token, and the id is an unguessable cuid. A cover is a preview of the owner's own
 * page, not the paid file.
 */
scrapbooksRouter.get(
  '/:id/cover',
  asyncRoute(async (req, res) => {
    if (!scrapbookStorageEnabled) return notFound(res)
    const row = await prisma.scrapbook.findFirst({
      where: { id: req.params.id as string, removedAt: null },
      select: { coverKey: true },
    })
    if (!row?.coverKey) return notFound(res)
    const { url } = await presignedImageUrl(
      BUCKET,
      row.coverKey,
      row.coverKey.endsWith('.jpg') ? 'image/jpeg' : 'image/webp',
      COVER_URL_TTL_SECONDS,
    )
    res.setHeader('Cache-Control', `private, max-age=${COVER_REDIRECT_MAX_AGE}`)
    res.redirect(302, url)
  }),
)
