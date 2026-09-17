/**
 * Generate grid thumbnails for any strip that lacks one.
 *
 *   npm run backfill:strips -- --dry-run     # report what's missing, touch nothing
 *   npm run backfill:strips                  # generate and upload
 *   npm run backfill:strips -- --batch 25    # smaller batches on a small instance
 *
 * Thumbnails are normally produced at upload time, so this only matters for strips
 * saved before that existed, or ones where the encode failed. A strip without one is
 * degraded, not broken — the API serves the full-size image under `thumbnailUrl` —
 * which is why this is a repairable background chore rather than part of the request.
 *
 * The source image comes back out of object storage, so this makes one download per
 * strip. Safe to re-run and safe to interrupt: it only ever looks at rows with no
 * `thumbnailKey`, and commits one row at a time.
 *
 * > This script previously also migrated inline `bytes` out of Postgres into object
 * > storage. That migration is complete and the columns are gone (see
 * > `prisma/migrations/*_drop_strip_bytes`), so those passes were removed rather than
 * > left as code that can no longer compile against the schema. Restoring a
 * > pre-migration backup would mean rewriting them — read the bytes column, upload,
 * > set the key — which is a short job against `objectStore.putImage`.
 */
import { prisma } from '../src/db/client.js'
import { getImageStream, putImage, storageEnabled, stripKey } from '../src/storage/objectStore.js'
import { makeThumbnail, THUMBNAIL_MIME } from '../src/storage/thumbnail.js'

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

/** Pull an object back out of the public bucket, into a buffer. */
async function readObject(key: string): Promise<Buffer | null> {
  const stream = await getImageStream('public', key)
  if (!stream) return null
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function backfillThumbnails(options: Options): Promise<{ made: number; failed: number }> {
  let made = 0
  let failed = 0

  const pending = await prisma.strip.count({ where: { thumbnailKey: null } })
  if (options.dryRun) {
    console.log(`Thumbnails: ${pending} row(s) would be generated`)
    return { made: 0, failed: 0 }
  }
  if (pending === 0) {
    console.log('Thumbnails: 0 to generate')
    return { made: 0, failed: 0 }
  }
  console.log(`Thumbnails: ${pending} to generate`)

  for (;;) {
    const rows = await prisma.strip.findMany({
      where: { thumbnailKey: null },
      select: { id: true, storageKey: true },
      take: options.batchSize,
    })
    if (rows.length === 0) break

    let batchFailures = 0
    for (const row of rows) {
      try {
        const source = row.storageKey ? await readObject(row.storageKey) : null
        if (!source) {
          // No image to render from. Leave it: the API falls back to the full-size
          // URL, so the row is degraded rather than broken.
          console.error(`  Strip ${row.id}: source image not found, skipping`)
          batchFailures += 1
          failed += 1
          continue
        }

        const thumbnail = await makeThumbnail(source)
        if (!thumbnail) throw new Error('could not render a thumbnail')
        const key = stripKey('thumbnail')
        await putImage('public', key, thumbnail, THUMBNAIL_MIME)
        await prisma.strip.update({ where: { id: row.id }, data: { thumbnailKey: key } })
        made += 1
        if (made % 25 === 0) console.log(`  ${made} generated...`)
      } catch (error) {
        batchFailures += 1
        failed += 1
        console.error(`  Strip ${row.id} failed: ${(error as Error).message}`)
      }
    }

    // Failures stay in the `thumbnailKey: null` set, so a wholly-failed batch would
    // otherwise be re-selected forever.
    if (batchFailures >= rows.length) {
      console.error('  Whole batch failed — stopping.')
      break
    }
  }

  return { made, failed }
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

  console.log(options.dryRun ? 'Thumbnail backfill (dry run)' : 'Thumbnail backfill')

  const { made, failed } = await backfillThumbnails(options)
  if (!options.dryRun) console.log(`Done: ${made} generated, ${failed} failed`)

  const left = await prisma.strip.count({ where: { thumbnailKey: null } })
  console.log(`Strips without a thumbnail: ${left}`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => void prisma.$disconnect())
