// Augments Express's Request with the authenticated user id, set by requireAuth.
import 'express'

declare global {
  namespace Express {
    interface Request {
      /** Present on routes behind `requireAuth` — the authenticated user's id. */
      userId?: string
    }
  }
}
