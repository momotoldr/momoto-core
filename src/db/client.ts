import { PrismaClient } from '@prisma/client'

/**
 * Single shared Prisma client for the process — mirrors the `roomStore` singleton
 * convention. `tsx watch` reloads the module on change, so we cache the instance
 * on `globalThis` in dev to avoid exhausting connections with duplicate clients.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

export const prisma = globalForPrisma.prisma ?? new PrismaClient()

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}
