-- Drop the legacy inline image columns, now that every strip lives in object storage.
--
-- **This is irreversible.** Rolling back the schema does not bring the pixels back —
-- the images are in R2, and these columns are empty. Before applying, confirm both
-- counts below are zero:
--
--   SELECT count(*) FROM "Strip" WHERE bytes IS NOT NULL;
--   SELECT count(*) FROM "StripPrintImage" WHERE bytes IS NOT NULL;
--
-- **Deploy the application code FIRST.** A build that still writes `bytes` (even as
-- NULL, which the pre-drop code did on every insert) will fail against a table
-- without the column. Code that never mentions it works fine while the column still
-- exists, so code-then-migration is the safe order; the reverse breaks saves.
--
-- Space is not returned to the OS by DROP COLUMN — Postgres only stops using it.
-- Run `VACUUM FULL "Strip", "StripPrintImage";` afterwards to reclaim it (this takes
-- an exclusive lock, so pick a quiet moment).

-- AlterTable
ALTER TABLE "Strip" DROP COLUMN "bytes";

-- AlterTable
ALTER TABLE "StripPrintImage" DROP COLUMN "bytes";
