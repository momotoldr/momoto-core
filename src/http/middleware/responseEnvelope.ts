import type { RequestHandler } from 'express'

/**
 * Wraps every JSON body this API sends as `{ statusCode, result }`, where `statusCode`
 * mirrors the HTTP status and `result` is what the route passed to `res.json`. Errors
 * take the same shape: `{ statusCode: 409, result: { error: 'cart_full' } }`.
 *
 * Done by patching `res.json` per request, so routes keep calling `res.json(body)` and
 * never build the envelope themselves (`res.send(object)` goes through `res.json` too).
 * Bodies that aren't JSON — image streams, the QR proxy, redirects, empty 204s — are
 * left alone.
 *
 * Mounted before the body parser, so its failures (`invalid_json`, `payload_too_large`)
 * reach `errorHandler` with the patch already in place.
 */
export const responseEnvelope: RequestHandler = (_req, res, next) => {
  const json = res.json.bind(res)
  res.json = (body?: unknown) => {
    // Most of these answers are one person's data, so nothing should keep them. A route
    // that wants its response cached sets its own header first.
    if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-store')
    return json({ statusCode: res.statusCode, result: body ?? null })
  }
  next()
}
