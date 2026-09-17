import sharp from 'sharp'

/** Image formats we accept for an avatar, in the order we test for them. */
const SIGNATURES = [
  {
    mimeType: 'image/webp',
    test: (b: Buffer) =>
      b.length > 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    mimeType: 'image/jpeg',
    test: (b: Buffer) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mimeType: 'image/png',
    test: (b: Buffer) =>
      b.length > 8 &&
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
] as const

/**
 * Identify an image by its leading bytes, or null if it isn't one we accept.
 *
 * The `Content-Type` a client sends is a claim, not evidence: anything can be
 * labelled `image/png`. Since we later serve these bytes back with a `Content-Type`
 * of our own, that claim has to be checked against the actual content — otherwise we
 * would happily store an HTML or SVG payload and hand it back to a browser as an
 * image. Sniffing here is what makes the stored `mimeType` trustworthy.
 */
export function sniffImageType(bytes: Buffer): string | null {
  return SIGNATURES.find((sig) => sig.test(bytes))?.mimeType ?? null
}

/**
 * Read an image's pixel dimensions, or null if the bytes can't be parsed as one.
 *
 * Header-only: `sharp.metadata()` reads the size out of the format's header without
 * decoding any pixels, so this stays cheap and can't be turned into a decompression
 * bomb by a small file that expands to gigabytes. That's the whole reason it's safe
 * to run on an upload before we've decided to keep it.
 *
 * The numbers are as *stored*, ignoring any EXIF orientation tag — a rotated JPEG
 * reports its pre-rotation width and height. That doesn't matter to the only caller,
 * which asks whether the two are equal, and a 90° rotation can't change that.
 */
export async function readImageSize(
  bytes: Buffer,
): Promise<{ width: number; height: number } | null> {
  try {
    const { width, height } = await sharp(bytes).metadata()
    if (!width || !height) return null
    return { width, height }
  } catch {
    return null
  }
}
