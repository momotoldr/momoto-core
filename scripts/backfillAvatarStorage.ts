/**
 * Move uploaded avatars out of Postgres and into object storage.
 *
 *   npm run backfill:avatars -- --dry-run     # report what's left, touch nothing
 *   npm run backfill:avatars                  # upload and switch the rows over
 *   npm run backfill:avatars -- --batch 25    # smaller batches on a small instance
 *
 * Avatars used to live as bytes on `AvatarImage`; they now live in the public bucket
 * with the key on `User.avatarKey`. Both shapes are served, so this is a chore to run
 * once after deploying the change rather than something the app waits on.
 *
 * Safe to re-run and safe to interrupt: it only looks at users who still have an
 * `AvatarImage` row, and each user is committed on their own — upload first, then a
 * transaction that sets the key and drops the legacy row, so a crash between the two
 * leaves an orphaned object (cheap) rather than a user with no picture.
 */
import { prisma } from '../src/db/client.js'
import { avatarKey, putImage, storageEnabled } from '../src/storage/objectStore.js'

interface Options {
  dryRun: boolean
  batchSize: number
}

function parseArgs(): Options {
  const args = process.argv.slice(2)
  const batchIndex = args.indexOf('--batch')
  const batchRaw = batchIndex >= 0 ? Number(args[batchIndex + 1]) : NaN
  return {
    dryRun: args.includes('--dry-run'),
    batchSize: Number.isInteger(batchRaw) && batchRaw > 0 ? batchRaw : 50,
  }
}

async function backfillAvatars(options: Options): Promise<{ moved: number; failed: number }> {
  let moved = 0
  let failed = 0

  const pending = await prisma.avatarImage.count()
  if (options.dryRun) {
    console.log(`Avatars: ${pending} row(s) would be moved to object storage`)
    return { moved: 0, failed: 0 }
  }
  if (pending === 0) {
    console.log('Avatars: 0 to move')
    return { moved: 0, failed: 0 }
  }
  console.log(`Avatars: ${pending} to move`)

  for (;;) {
    const rows = await prisma.avatarImage.findMany({
      select: { userId: true, bytes: true, mimeType: true },
      take: options.batchSize,
    })
    if (rows.length === 0) break

    let batchFailures = 0
    for (const row of rows) {
      try {
        const key = avatarKey(row.mimeType)
        await putImage('avatar', key, Buffer.from(row.bytes), row.mimeType)
        // Point the user at the object and drop the legacy row together — a user
        // holding both would make the two paths in `GET /avatars/:userId` disagree.
        await prisma.$transaction([
          prisma.user.update({ where: { id: row.userId }, data: { avatarKey: key } }),
          prisma.avatarImage.delete({ where: { userId: row.userId } }),
        ])
        moved += 1
        if (moved % 25 === 0) console.log(`  ${moved} moved...`)
      } catch (error) {
        batchFailures += 1
        failed += 1
        console.error(`  User ${row.userId} failed: ${(error as Error).message}`)
      }
    }

    // Failures keep their `AvatarImage` row, so a wholly-failed batch would
    // otherwise be re-selected forever.
    if (batchFailures >= rows.length) {
      console.error('  Whole batch failed — stopping.')
      break
    }
  }

  return { moved, failed }
}

async function main(): Promise<void> {
  const options = parseArgs()

  if (!storageEnabled) {
    console.error(
      'Object storage is not configured — set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,\n' +
        'R2_SECRET_ACCESS_KEY and R2_BUCKET (see .env.example) first.',
    )
    process.exitCode = 1
    return
  }

  console.log(options.dryRun ? 'Avatar backfill (dry run)' : 'Avatar backfill')

  const { moved, failed } = await backfillAvatars(options)
  if (!options.dryRun) console.log(`Done: ${moved} moved, ${failed} failed`)

  const left = await prisma.avatarImage.count()
  console.log(`Avatars still in Postgres: ${left}`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
