import { config as loadEnvFile } from 'dotenv'

/**
 * Reads the env files, in precedence order. Import this **before anything else** — it
 * has no exports and exists only for that side effect.
 *
 * Order matters twice over:
 *
 * 1. `@prisma/client` calls dotenv on `.env` the moment it is imported, and dotenv skips
 *    keys that are already set. Anything that pulls in Prisma before this module runs
 *    would therefore pin `.env`'s values — which is why `src/index.ts` imports this
 *    first of all, ahead of `./db/client.js`.
 * 2. Nothing here overrides. A real environment variable — what a deploy platform
 *    injects — is already in `process.env` before any file is read, so it wins over both
 *    files. `.env.local` beats `.env` purely by being read first.
 *
 * `.env.local` is skipped outright in production. It describes one developer's machine,
 * and a copy of it reaching a server must never be able to redirect that server at a
 * laptop's database.
 */
if (process.env.NODE_ENV !== 'production') {
  loadEnvFile({ path: '.env.local' })
}
loadEnvFile({ path: '.env' })
