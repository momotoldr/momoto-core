import type { RequestHandler } from 'express'

import { ADMIN_SESSION_HEADER, isValidAdminSession } from '../../auth/adminSession.js'
import { prisma } from '../../db/client.js'
import { recordAdminRequest } from '../../lib/adminAudit.js'
import { asyncRoute } from '../asyncRoute.js'

/**
 * Gate for the admin monitoring surface (`/admin/*`). **Runs after
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
    select: { role: true, totpEnabledAt: true },
  })
  if (!user || user.role !== 'ADMIN') {
    // A signed-in account reaching for the operator surface is worth a record.
    recordAdminRequest(req, userId, 403)
    res.status(403).json({ error: 'forbidden' })
    return
  }
  res.locals.totpEnabledAt = user.totpEnabledAt
  next()
})

/**
 * The second factor. **Runs after `requireAdmin`.** Everything under `/admin` needs a
 * session earned with a 6-digit code, except the routes that earn one (`adminMfa.ts`).
 *
 * `enrolled` tells the portal which screen to show: the QR code, or the code prompt.
 */
export const requireAdminSession: RequestHandler = (req, res, next) => {
  const enrolledAt = res.locals.totpEnabledAt as Date | null
  if (isValidAdminSession(req.get(ADMIN_SESSION_HEADER), req.userId as string, enrolledAt)) {
    next()
    return
  }
  recordAdminRequest(req, req.userId as string, 403)
  res.status(403).json({ error: 'admin_session_required', enrolled: enrolledAt !== null })
}
