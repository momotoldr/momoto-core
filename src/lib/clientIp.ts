import { isIP } from 'node:net'

import type { Request } from 'express'

import { logger } from './logger.js'

/**
 * The visitor's address, for every per-IP rate limit.
 *
 * Behind Cloudflare, `req.ip` is the wrong answer whatever `TRUST_PROXY` says. Requests go
 * visitor → Cloudflare → Railway's edge → this process, and on 2026-10-01 a diagnostic in
 * momoto-analytics showed that the `X-Forwarded-For` reaching us holds two infrastructure
 * addresses and **not the visitor's at all** (forged values sent by a client were dropped,
 * too). So `trust proxy` 1 gave Railway's edge and 2 gave a Cloudflare server — either way
 * many visitors shared one rate-limit bucket.
 *
 * Cloudflare puts the visitor's address in `CF-Connecting-IP` on every request it forwards,
 * so with `CLIENT_IP_HEADER=cf-connecting-ip` that header wins. It is only as trustworthy
 * as the route in: a request that skips Cloudflare (a `*.up.railway.app` domain) could set
 * it to anything and mint itself a fresh bucket per request — so keep the service reachable
 * through the Cloudflare domain only. A missing or malformed header falls back to `req.ip`.
 *
 * Duplicated in momoto-core, momoto-realtime and momoto-analytics on purpose (no shared
 * package between services).
 */
export function clientIp(req: Request, header: string | null): string | undefined {
  const value = header ? req.get(header)?.split(',')[0]?.trim() : undefined
  const fromHeader = !!value && isIP(value) !== 0
  if (!reported) {
    reported = true
    // Once per process, names only — the one place a misconfigured header shows, since
    // the fallback is otherwise silent.
    logger.info('client_ip.source', {
      configuredHeader: header,
      used: fromHeader ? 'header' : 'req.ip',
      present: ['cf-connecting-ip', 'x-forwarded-for'].filter((n) => req.get(n) !== undefined),
    })
  }
  return fromHeader ? value : req.ip
}

let reported = false
