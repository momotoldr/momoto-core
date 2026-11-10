/**
 * Clears an admin's 6-digit setup, for a lost phone with no recovery codes left.
 *
 *   npm run admin:reset-mfa -- <username>
 *
 * Their next sign-in goes through the QR step again, and any admin session they hold
 * stops working. Run by whoever holds the database, the same trust as `make-admin`.
 */
import { prisma } from '../src/db/client.js'

async function main(): Promise<void> {
  const username = process.argv
    .slice(2)
    .find((a) => !a.startsWith('--'))
    ?.trim()
  if (!username) {
    console.error('Usage: npm run admin:reset-mfa -- <username>')
    process.exitCode = 1
    return
  }

  const user = await prisma.user.findUnique({ where: { username } })
  if (!user) {
    console.error(`No user with username "${username}".`)
    process.exitCode = 1
    return
  }

  await prisma.$transaction([
    prisma.totpRecoveryCode.deleteMany({ where: { userId: user.id } }),
    prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null },
    }),
  ])
  console.log(`Cleared the 6-digit setup for "${username}".`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
