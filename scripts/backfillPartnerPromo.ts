/**
 * One-off operator CLI: give the partner buy 1 get 1 (docs/PLAN-promos.md §1c) to every
 * account that is linked to a partner right now.
 *
 *   npm run promos:backfill-beta -- --dry-run   # count who would get it
 *   npm run promos:backfill-beta                # grant it
 *
 * ## Why this exists
 *
 * Links made from the soft launch on earn the reward in `POST /partner/accept`, and only
 * when one of the two accounts is new. The closed-beta testers linked long before that,
 * and the user decided their links count (2026-10-27) — so this grants it to them once,
 * with no new-account rule, as `reason: 'beta_backfill'`.
 *
 * Run it once per environment on launch day: in prod every link that exists before the
 * public opening is a beta link. It doesn't look at `PARTNER_PROMO_ENABLED` — the flag
 * decides whether the reward can be *spent*, and turning it on later finds these waiting.
 *
 * Safe to re-run: the unique (userId, kind) index skips anyone who already has the
 * reward, earned or spent.
 */
import '../src/config/loadEnv.js'

import { prisma } from '../src/db/client.js'
import { PARTNER_BOGO } from '../src/promos/promos.js'

const dryRun = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const linked = await prisma.user.findMany({
    where: { partnerId: { not: null } },
    select: { id: true, partnerId: true },
  })
  const already = await prisma.promoGrant.findMany({
    where: { kind: PARTNER_BOGO, userId: { in: linked.map((user) => user.id) } },
    select: { userId: true },
  })
  const has = new Set(already.map((grant) => grant.userId))
  const todo = linked.filter((user) => !has.has(user.id))

  console.log(`${linked.length} linked accounts, ${has.size} already have the reward.`)
  if (dryRun) {
    console.log(`Dry run: would grant it to ${todo.length}.`)
    return
  }

  const { count } = await prisma.promoGrant.createMany({
    data: todo.map((user) => ({
      userId: user.id,
      kind: PARTNER_BOGO,
      reason: 'beta_backfill',
      sourceUserId: user.partnerId,
    })),
    skipDuplicates: true,
  })
  console.log(`Granted to ${count}.`)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
