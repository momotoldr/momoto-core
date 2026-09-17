-- Move strip images out of Postgres and into object storage (Cloudflare R2).
--
-- Additive and reversible on its own: the new key columns start null and the legacy
-- `bytes` columns are only relaxed to nullable, so every existing row keeps serving
-- from the database until `scripts/backfillStripStorage.ts` copies it up. Dropping
-- `bytes` is a separate, later migration — run it once the backfill reports 0 left.

-- AlterTable
ALTER TABLE "Strip" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "Strip" ALTER COLUMN "bytes" DROP NOT NULL;

-- AlterTable
ALTER TABLE "StripPrintImage" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "StripPrintImage" ALTER COLUMN "bytes" DROP NOT NULL;
