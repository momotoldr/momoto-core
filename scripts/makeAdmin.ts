/**
 * One-off operator CLI to promote (or demote) an account's privilege level.
 *
 *   npm run make-admin -- <username>            # grant ADMIN
 *   npm run make-admin -- <username> --revoke   # back to USER
 *
 * Admin access is deliberately not self-service — there's no signup path that can
 * mint an admin. This script is the only way in, run by whoever holds the DB. It
 * touches nothing but the `role` column and never prints or accepts a password.
 */
import { prisma } from '../src/db/client.js'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const revoke = args.includes('--revoke')
  const username = args.find((a) => !a.startsWith('--'))?.trim()

  if (!username) {
    console.error('Usage: npm run make-admin -- <username> [--revoke]')
    process.exitCode = 1
    return
  }

  const role = revoke ? 'USER' : 'ADMIN'
  const user = await prisma.user.findUnique({ where: { username } })
  if (!user) {
    console.error(`No user with username "${username}".`)
    process.exitCode = 1
    return
  }

  if (user.role === role) {
    console.log(`"${username}" is already ${role}. Nothing to do.`)
    return
  }

  await prisma.user.update({ where: { id: user.id }, data: { role } })
  console.log(`"${username}" is now ${role}.`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
