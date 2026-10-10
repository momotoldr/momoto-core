import { prisma } from '../db/client.js'

/**
 * Reads of the `DailyStat` counters and their `MetricTotal` all-time totals (see the
 * models in schema.prisma — both kept by database triggers, never written from here).
 * Days are UTC calendar days: "last 7 days" is today plus the 6 days before it.
 */

/** Midnight UTC `days` whole days before today. */
export function utcDaysAgo(days: number, now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days))
}

export interface MetricSums {
  total: number
  last7: number
  last30: number
}

const NONE: MetricSums = { total: 0, last7: 0, last30: 0 }

/**
 * The all-time, last-7-day and last-30-day sums of `metrics`. Totals are one
 * `MetricTotal` row each, read by primary key — not a scan: every counter bump rewrites
 * those few rows, so after a burst of writes the table holds pages of dead space that
 * a scan would walk until vacuum reuses them. The windows read only the last 30 days of
 * counters (the `day` index), so nothing here grows with history or traffic.
 */
export async function metricSums(
  metrics: readonly string[],
  now: Date = new Date(),
): Promise<(metric: string) => MetricSums> {
  // Plain `yyyy-mm-dd` strings, not Dates: a Date travels as a timestamp, and its ::date
  // cast would go through the database's TimeZone setting — a day off west of UTC.
  const since7 = utcDaysAgo(6, now).toISOString().slice(0, 10)
  const since30 = utcDaysAgo(29, now).toISOString().slice(0, 10)
  const [totals, windows] = await Promise.all([
    prisma.metricTotal.findMany({ where: { metric: { in: [...metrics] } } }),
    prisma.$queryRaw<{ metric: string; last7: bigint; last30: bigint }[]>`
      SELECT "metric",
        coalesce(sum("value") FILTER (WHERE "day" >= ${since7}::date), 0)::bigint AS last7,
        sum("value")::bigint AS last30
      FROM "DailyStat" WHERE "day" >= ${since30}::date GROUP BY "metric"`,
  ])
  const recent = new Map(windows.map((w) => [w.metric, w]))
  const sums = new Map(
    totals.map((t) => {
      const w = recent.get(t.metric)
      return [
        t.metric,
        { total: Number(t.value), last7: Number(w?.last7 ?? 0), last30: Number(w?.last30 ?? 0) },
      ]
    }),
  )
  return (metric) => sums.get(metric) ?? NONE
}

/** All-time totals for a few metrics — one `MetricTotal` row each, by primary key. */
export async function metricTotals(metrics: string[]): Promise<(metric: string) => number> {
  const rows = await prisma.metricTotal.findMany({ where: { metric: { in: metrics } } })
  const totals = new Map(rows.map((r) => [r.metric, Number(r.value)]))
  return (metric) => totals.get(metric) ?? 0
}

/** A metric's daily values from `since` (a UTC midnight) on, oldest first; gaps are absent. */
export async function metricDays(
  metric: string,
  since: Date,
): Promise<{ day: string; value: number }[]> {
  const rows = await prisma.dailyStat.findMany({
    where: { metric, day: { gte: since }, value: { not: 0 } },
    orderBy: { day: 'asc' },
    select: { day: true, value: true },
  })
  return rows.map((r) => ({ day: r.day.toISOString().slice(0, 10), value: Number(r.value) }))
}

/** A metric's sum over whole UTC days `fromDay` ≤ day < `toDay` (no `toDay`: up to today). */
export async function metricSumBetween(
  metric: string,
  fromDay: Date,
  toDay?: Date,
): Promise<number> {
  const { _sum } = await prisma.dailyStat.aggregate({
    where: { metric, day: { gte: fromDay, ...(toDay ? { lt: toDay } : {}) } },
    _sum: { value: true },
  })
  return Number(_sum.value ?? 0)
}
