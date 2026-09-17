import type { NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * Adapts an `async` handler to Express 4's callback contract.
 *
 * **This is not optional.** Express 4 ignores the promise a handler returns, so an
 * `async` route that rejects produces an *unhandled rejection* — which Node ≥15
 * escalates to an uncaught exception and the process exits. A single failed DB call
 * would take the server down and drop every in-memory room with it. Wrapping routes
 * here funnels rejections into `next(err)` so `errorHandler` answers the request.
 *
 * (Express 5 does this natively; drop this wrapper if/when we upgrade.)
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next)
  }
}
