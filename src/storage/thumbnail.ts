import sharp from 'sharp'

import { logger } from '../lib/logger.js'

/**
 * Small preview renditions of a strip, for grids that show many at once.
 *
 * The cart and the admin strips table render a page of strips side by side, and both
 * were pulling the **full-resolution** PNG for every tile — 1–3 MB each to fill a
 * slot a couple of hundred pixels tall. Moving the bytes to a CDN made that cheap for
 * the server, but the browser still downloads and decodes every one of them.
 *
 * One rendition covers both callers: bounded to `MAX_EDGE`, which leaves the cart's
 * largest tile sharp on a 2–3× display while being enormous overkill (and still tiny)
 * for the admin table's 80px row. WebP because these are photographic and the size
 * difference over PNG is roughly an order of magnitude.
 */

/** Bounding box for a preview. A strip is tall and narrow (~1:3), so height binds. */
const MAX_WIDTH = 400
const MAX_HEIGHT = 1200

/** Quality/size tradeoff for the WebP encode — visually clean at preview scale. */
const WEBP_QUALITY = 80

export const THUMBNAIL_MIME = 'image/webp'

/**
 * Bounds a client-rendered thumbnail has to satisfy to be stored as-is.
 *
 * Exported because the client renders these now — the browser already holds the
 * composed strip in a canvas, so scaling it there costs a `drawImage` and removes the
 * decode/resize/encode that was 99% of the CPU a save spent on this server. These are
 * the same limits `makeThumbnail` produces, with a little slack on the box so a
 * client's rounding can't fail an otherwise fine preview.
 */
export const THUMBNAIL_BOUNDS = {
  maxWidth: MAX_WIDTH + 8,
  maxHeight: MAX_HEIGHT + 8,
  /** A preview of this box is tens of KB; anything larger isn't one. */
  maxBytes: 512 * 1024,
} as const

/**
 * Render a preview of a composed strip, or null if it can't be produced.
 *
 * **Never throws.** A thumbnail is an optimization: if libvips can't read the image,
 * the caller carries on and the UI falls back to the full-size original. Failing the
 * user's save because a preview didn't render would be the wrong trade.
 */
export async function makeThumbnail(bytes: Buffer): Promise<Buffer | null> {
  try {
    return await sharp(bytes)
      .resize({
        width: MAX_WIDTH,
        height: MAX_HEIGHT,
        fit: 'inside',
        // A strip that somehow arrives smaller than the box is left alone rather than
        // upscaled into a bigger file than the original.
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer()
  } catch (error) {
    logger.warn('thumbnail.failed', { message: (error as Error).message })
    return null
  }
}
