import { isIPv4, isIPv6 } from 'node:net'

/**
 * The network a request came from, not the address: `/24` for IPv4, `/48` for IPv6.
 * Enough to spot one network flooding the endpoint; not enough to point at a person.
 * The full address is never stored or logged.
 */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip) return null
  // An IPv4 client seen through a dual-stack socket arrives as `::ffff:1.2.3.4`.
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  if (isIPv4(v4)) {
    const [a, b, c] = v4.split('.')
    return `${a}.${b}.${c}.0/24`
  }
  if (isIPv6(ip)) {
    const groups = expandIPv6(ip)
    return `${groups.slice(0, 3).join(':')}::/48`
  }
  return null
}

/** `2001:db8::1` → eight full groups, so the first three are the /48. */
function expandIPv6(ip: string): string[] {
  const [head = '', tail = ''] = ip.split('::')
  const left = head ? head.split(':') : []
  const right = ip.includes('::') && tail ? tail.split(':') : []
  const missing = 8 - left.length - right.length
  return [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right].map(
    (g) => g.replace(/^0+(?=.)/, '') || '0',
  )
}
