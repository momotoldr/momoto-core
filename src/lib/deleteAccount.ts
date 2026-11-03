import type { Prisma } from '@prisma/client'

import { prisma } from '../db/client.js'
import { deleteScrapbookObjects, scrapbookObjectsOf } from '../http/routes/scrapbooks.js'
import { deleteStripObjects } from '../http/routes/strips.js'
import { deleteImages } from '../storage/objectStore.js'
import { markTestimonialsChanged } from './testimonials.js'

/**
 * Who asked for the deletion. Only `inactive` changes what happens: it is housekeeping,
 * so the stat triggers leave the all-time counters alone (see below).
 */
export type DeleteAccountReason = 'self' | 'admin' | 'inactive'

/**
 * Permanently delete an account and everything stored for it. Shared by
 * `DELETE /auth/me`, `DELETE /admin/users/:id` and the inactive-account job
 * (docs/PLAN-inactive-accounts.md). Each caller does its own checks first: the
 * password, the admin's guardrails. This function only deletes.
 *
 * The delete cascades the user's strip rows, scrapbooks, refresh tokens and partner
 * invites. It unlinks any partner, and detaches feedback (kept for triage) and payments
 * (the record of money received; a paid order is never refunded). The strips' images,
 * the scrapbooks' PDFs and covers and the avatar live in object storage, which doesn't
 * cascade. Their keys are read while the rows still exist, and the objects are deleted
 * after, best-effort: a failure is logged, and the account is deleted either way.
 *
 * `inactive` runs the delete under `momoto.inactive_purge`, which the `users`, `strips`
 * and `sessions:*` counter triggers read to skip their decrement (migration
 * 20261103000000). A self or admin delete still counts out.
 *
 * `onlyIf` is checked by the `DELETE` itself, so a condition that stopped holding after
 * the caller read it is honoured. The inactive-account job passes its own `where`, so
 * someone who signs in mid-run is kept.
 *
 * Returns false when nothing was deleted: no such account, already deleted, or `onlyIf`
 * no longer holds.
 */
export async function deleteAccount(
  userId: string,
  reason: DeleteAccountReason,
  onlyIf: Prisma.UserWhereInput = {},
): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { avatarKey: true } })
  if (!user) return false

  const strips = await prisma.strip.findMany({
    where: { userId },
    select: {
      storageKey: true,
      thumbnailKey: true,
      printImage: { select: { storageKey: true } },
    },
  })
  // Scrapbooks likewise: a PDF in the private bucket and a cover in the public one each.
  const scrapbooks = await scrapbookObjectsOf(userId)

  // `deleteMany` so an account deleted between the read above and here is a no-op
  // rather than a P2025.
  const { count } =
    reason === 'inactive'
      ? (
          await prisma.$transaction([
            prisma.$executeRawUnsafe(`SET LOCAL momoto.inactive_purge = 'on'`),
            prisma.user.deleteMany({ where: { ...onlyIf, id: userId } }),
          ])
        )[1]
      : await prisma.user.deleteMany({ where: { ...onlyIf, id: userId } })
  if (count === 0) return false

  // Their testimonials cascaded away (or dropped them as a partner) — refresh the landing cache.
  markTestimonialsChanged()
  await deleteStripObjects(strips)
  await deleteScrapbookObjects(scrapbooks)
  if (user.avatarKey) await deleteImages('avatar', [user.avatarKey])
  return true
}
