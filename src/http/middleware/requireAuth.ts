import type { NextFunction, Request, Response } from 'express'

import { verifyAccessToken } from '../../auth/tokens.js'

const BEARER = 'Bearer '

/**
 * Gate for authenticated HTTP routes. Reads the `Authorization: Bearer <jwt>`
 * header, verifies the access token, and attaches `req.userId`. Responds 401 if
 * the header is missing or the token is invalid/expired (the client then refreshes).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header || !header.startsWith(BEARER)) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  try {
    const { sub } = verifyAccessToken(header.slice(BEARER.length).trim())
    req.userId = sub
    next()
  } catch {
    res.status(401).json({ error: 'unauthorized' })
  }
}
