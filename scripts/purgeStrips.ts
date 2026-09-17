/**
 * One-off operator CLI to delete strips — rows and stored objects together.
 *
 *   npm run purge:strips                        # dry run: show what would go
 *   npm run purge:strips -- --user ilham        # scope to one account
 *   npm run purge:strips -- --confirm           # actually delete
 *   npm run purge:strips -- --orphans-only      # sweep unreferenced objects only
 *
 * ## Why this exists rather than "empty the bucket"
 *
 * A strip is a row plus three objects: the PNG and its thumbnail in the public
 * bucket, the print rendition in the private one. Deleting the objects alone leaves
 * rows pointing at nothing, and the owner opens their cart to broken images.
 * Deleting the rows alone strands the objects forever — nothing names them once the
 * row is gone, so no later pass can find them by walking the database. This does
 * both, in the order that survives a failure in between: objects first, then the row
 * only for the strips whose objects actually went.
 *
 * That ordering is the opposite of `DELETE /strips/:id`, and deliberately so. The
 * route optimises for the user (their cart must be right even if R2 is down, and a
 * stranded object is a chore); a bulk purge optimises for leaving nothing behind, so
 * it would rather keep a row it can retry than lose the only reference to an object.
 *
 * ## Orphans
 *
 * `--orphans-only` reconciles the buckets against the database and removes objects no
 * row references. Those accumulate when the delete route's best-effort cleanup fails
 * (look for `storage.delete.failed` in the logs). Safe to run any time; it never
 * touches an object a row still points at.
 *
 * Nothing here is recoverable. The default is a dry run for that reason — `--confirm`
 * is the only thing that deletes.
 */
import '../src/config/loadEnv.js'

import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'

import { prisma } from '../src/db/client.js'

interface Options {
  confirm: boolean
  username: string | null
  orphansOnly: boolean
}

const USAGE = `Usage:
  npm run purge:strips                     # dry run — show what would be deleted
  npm run purge:strips -- --confirm        # delete every strip, rows and objects
  npm run purge:strips -- --user <name>    # scope to one account
  npm run purge:strips -- --orphans-only   # only sweep objects no row references`

function parseArgs(argv: string[]): Options | null {
  const opts: Options = { confirm: false, username: null, orphansOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--confirm') opts.confirm = true
    else if (arg === '--orphans-only') opts.orphansOnly = true
    else if (arg === '--user') opts.username = String(argv[++i] ?? '').trim()
    else if (arg.startsWith('--user=')) opts.username = arg.slice('--user='.length).trim()
    else if (arg === '--dry-run') opts.confirm = false
    else {
      console.error(`Unknown option: ${arg}\n\n${USAGE}`)
      return null
    }
  }
  return opts
}

function makeClient(): S3Client {
  const missing = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter(
    (k) => !process.env[k]?.trim(),
  )
  if (missing.length > 0) {
    throw new Error(
      `Object storage is not configured here: ${missing.join(', ')} unset.\n` +
        'Run this against the deployed environment, e.g.\n' +
        '  railway run --service momoto-core npm run purge:strips',
    )
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
    },
  })
}

async function listKeys(client: S3Client, bucket: string): Promise<Map<string, number>> {
  const keys = new Map<string, number>()
  let token: string | undefined
  do {
    const out = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    )
    for (const o of out.Contents ?? []) if (o.Key) keys.set(o.Key, o.Size ?? 0)
    token = out.IsTruncated ? out.NextContinuationToken : undefined
  } while (token)
  return keys
}

/** Deletes in batches of 1000 — the S3 API's ceiling for one DeleteObjects call. */
async function deleteKeys(client: S3Client, bucket: string, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    const out = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
      }),
    )
    // Unlike the request path this must not swallow failures: the caller is about to
    // delete the rows that name these objects, and a silent miss strands them forever.
    if (out.Errors?.length) {
      throw new Error(
        `${bucket}: ${out.Errors.length} object(s) would not delete — ` +
          `first: ${out.Errors[0]?.Key} (${out.Errors[0]?.Message}). No rows were removed.`,
      )
    }
  }
}

const mb = (bytes: number): string => `${(bytes / 2 ** 20).toFixed(1)} MB`

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts) {
    process.exitCode = 1
    return
  }

  const client = makeClient()
  const publicBucket = process.env.R2_BUCKET as string
  const privateBucket = process.env.R2_PRINT_BUCKET as string

  let userId: string | null = null
  if (opts.username) {
    const user = await prisma.user.findUnique({ where: { username: opts.username } })
    if (!user) {
      console.error(`No account with username "${opts.username}".`)
      process.exitCode = 1
      return
    }
    userId = user.id
  }

  const strips = await prisma.strip.findMany({
    where: userId ? { userId } : {},
    select: {
      id: true,
      storageKey: true,
      thumbnailKey: true,
      user: { select: { username: true } },
      printImage: { select: { storageKey: true } },
    },
  })

  const publicKeys: string[] = []
  const privateKeys: string[] = []
  for (const s of strips) {
    if (s.storageKey) publicKeys.push(s.storageKey)
    if (s.thumbnailKey) publicKeys.push(s.thumbnailKey)
    if (s.printImage?.storageKey) privateKeys.push(s.printImage.storageKey)
  }

  // Listed regardless of mode: the byte totals come from here, and in --orphans-only
  // this is the whole job.
  const pub = await listKeys(client, publicBucket)
  const priv = await listKeys(client, privateBucket)

  const allReferenced = await prisma.strip.findMany({
    select: { storageKey: true, thumbnailKey: true, printImage: { select: { storageKey: true } } },
  })
  const keepPublic = new Set<string>()
  const keepPrivate = new Set<string>()
  for (const s of allReferenced) {
    if (s.storageKey) keepPublic.add(s.storageKey)
    if (s.thumbnailKey) keepPublic.add(s.thumbnailKey)
    if (s.printImage?.storageKey) keepPrivate.add(s.printImage.storageKey)
  }
  const orphanPublic = [...pub.keys()].filter((k) => !keepPublic.has(k))
  const orphanPrivate = [...priv.keys()].filter((k) => !keepPrivate.has(k))

  const sizeOf = (keys: string[], from: Map<string, number>): number =>
    keys.reduce((sum, k) => sum + (from.get(k) ?? 0), 0)

  if (opts.orphansOnly) {
    const bytes = sizeOf(orphanPublic, pub) + sizeOf(orphanPrivate, priv)
    console.log(
      `Orphaned objects (no row references them): ` +
        `${orphanPublic.length} public + ${orphanPrivate.length} private, ${mb(bytes)}.`,
    )
    if (orphanPublic.length + orphanPrivate.length === 0) {
      console.log('Nothing to sweep.')
      return
    }
    if (!opts.confirm) {
      console.log(`\nDry run — nothing deleted. Re-run with --confirm to sweep them.`)
      return
    }
    await deleteKeys(client, publicBucket, orphanPublic)
    await deleteKeys(client, privateBucket, orphanPrivate)
    console.log(`Swept ${orphanPublic.length + orphanPrivate.length} objects, ${mb(bytes)} freed.`)
    return
  }

  const byOwner = new Map<string, number>()
  for (const s of strips) {
    const name = s.user?.username ?? '<no user>'
    byOwner.set(name, (byOwner.get(name) ?? 0) + 1)
  }
  const bytes = sizeOf(publicKeys, pub) + sizeOf(privateKeys, priv)

  console.log(
    `${strips.length} strip(s)${opts.username ? ` owned by ${opts.username}` : ''} — ` +
      `${publicKeys.length} public + ${privateKeys.length} private objects, ${mb(bytes)}.`,
  )
  for (const [name, count] of [...byOwner].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name.padEnd(16)} ${String(count).padStart(3)}`)
  }
  if (orphanPublic.length + orphanPrivate.length > 0) {
    console.log(
      `\nAlso ${orphanPublic.length + orphanPrivate.length} orphaned object(s) that no row ` +
        `references — run with --orphans-only to sweep those.`,
    )
  }

  if (strips.length === 0) {
    console.log('Nothing to delete.')
    return
  }
  if (!opts.confirm) {
    console.log(`\nDry run — nothing deleted. This cannot be undone; re-run with --confirm.`)
    return
  }

  // Objects first: a failure here leaves rows that still name them, so the run can
  // simply be repeated. The reverse order would lose the only reference and strand them.
  await deleteKeys(client, publicBucket, publicKeys)
  await deleteKeys(client, privateBucket, privateKeys)
  const { count } = await prisma.strip.deleteMany({
    where: { id: { in: strips.map((s) => s.id) } },
  })
  console.log(`\nDeleted ${count} row(s) and ${publicKeys.length + privateKeys.length} object(s).`)
  console.log(`${mb(bytes)} freed.`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
