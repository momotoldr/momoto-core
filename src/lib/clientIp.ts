import { isIP, isIPv4, isIPv6 } from 'node:net'

import type { Request } from 'express'

import { expandIPv6 } from './ipPrefix.js'
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

/**
 * The bucket a per-address rate limit counts against: the address itself for IPv4, but
 * the /64 prefix for IPv6.
 *
 * One IPv6 subscriber is routinely handed a whole /64 — 2^64 addresses — so keying on the
 * full address would let a single machine step to a fresh address per request and never
 * meet a limit. A /64 is what one home or one server gets, so it is the smallest unit
 * that is still one party. Same rule as momoto-realtime's copy.
 */
export function rateLimitKey(ip: string | undefined): string {
  if (!ip) return 'unknown'
  // An IPv4 client seen through a dual-stack socket arrives as `::ffff:1.2.3.4`.
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (isIPv4(v4)) return v4
  if (isIPv6(ip)) return `${expandIPv6(ip).slice(0, 4).join(':')}::/64`
  return ip
}
