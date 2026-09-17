import type { RequestHandler } from 'express'

import { prisma } from '../../db/client.js'
import { asyncRoute } from '../asyncRoute.js'

/**
 * Gate for the read-only admin monitoring surface (`/admin/*`). **Runs after
 * `requireAuth`**, which has already verified the access token and attached
 * `req.userId`. This checks the account's live `role` in the database rather than
 * trusting a token claim — the JWT only carries `sub`, and a DB lookup means a
 * revoked admin loses access immediately (no waiting for the token to expire).
 *
 * Responds 401 if `requireAuth` didn't run (no `req.userId`), 403 if the account
 * exists but isn't an admin. Wrapped in `asyncRoute` so a failed DB call funnels
 * into `errorHandler` instead of crashing the process (Express 4 ignores the
 * promise a middleware returns).
 */
export const requireAdmin: RequestHandler = asyncRoute(async (req, res, next) => {
  const userId = req.userId
  if (!userId) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  })
  if (!user || user.role !== 'ADMIN') {
    res.status(403).json({ error: 'forbidden' })
    return
  }
  next()
})
