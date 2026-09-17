import { Router } from 'express'

import { prisma } from '../../db/client.js'
import { avatarMimeType, getImageStream } from '../../storage/objectStore.js'
import { asyncRoute } from '../asyncRoute.js'

export const avatarsRouter = Router()

/**
 * Serve an uploaded avatar.
 *
 * **Deliberately unauthenticated.** This URL goes in an `<img src>`, and an image
 * element cannot carry an `Authorization` header — gating it would mean rendering
 * avatars through fetch + object URLs for no real gain. A user id is a cuid, so the
 * ids aren't guessable, and the only thing behind one is a picture its owner chose
 * to show their partner.
 *
 * This is the *fallback* path, not the usual one. When object storage has a public
 * base URL, `serializeUser` hands out the CDN URL and no avatar request reaches this
 * server at all. What still lands here is a stored avatar with no CDN origin
 * configured (proxied out of the bucket) and a legacy row whose bytes are still in
 * Postgres (served from the column) — see the `AvatarImage` model.
 *
 * Cached hard and forever: `serializeUser` stamps `?v=<upload time>` onto the URL, so
 * a new picture is a new URL rather than something a stale cache can hide.
 */
avatarsRouter.get(
  '/:userId',
  asyncRoute(async (req, res) => {
    const userId = req.params.userId
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { avatarKey: true },
    })

    /**
     * Headers every avatar response shares, whatever it was read from.
     *
     * The bytes are attacker-influenced (a user picked the file), so `nosniff` and a
     * sandbox CSP make sure a browser treats them as the image type we validated and
     * nothing else.
     */
    const sendHeaders = (mimeType: string, etag: string): void => {
      res.setHeader('Content-Type', mimeType)
      res.setHeader('ETag', etag)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    }

    if (user?.avatarKey) {
      // The key changes on every upload, so it identifies the bytes exactly — a
      // better ETag than the timestamp the legacy path has to use.
      const etag = `"${user.avatarKey}"`
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end()
        return
      }
      const stream = await getImageStream('avatar', user.avatarKey)
      if (!stream) {
        // The row points at an object that's gone. A 404 (not a 500) — the client
        // falls back to the initial-letter avatar, same as for a user with no picture.
        res.status(404).json({ error: 'not_found' })
        return
      }
      sendHeaders(avatarMimeType(user.avatarKey), etag)
      stream.pipe(res)
      return
    }

    const image = await prisma.avatarImage.findUnique({ where: { userId } })
    if (!image) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    const etag = `"${image.updatedAt.getTime().toString(36)}"`
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end()
      return
    }

    sendHeaders(image.mimeType, etag)
    res.send(Buffer.from(image.bytes))
  }),
)
