-- Move uploaded avatars out of Postgres and into object storage (Cloudflare R2),
-- the same place strip images already live.
--
-- Additive and reversible on its own: the column starts null, `AvatarImage` is left
-- untouched, and every existing upload keeps serving from the database until
-- `scripts/backfillAvatarStorage.ts` copies it up. Dropping the legacy table is a
-- separate, later migration — run it once the backfill reports 0 left.
--
-- The key lives on `User`, not on `AvatarImage`, so `serializeUser` can build the CDN
-- URL from a row it already has instead of joining on every login and refresh.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "avatarKey" TEXT;
