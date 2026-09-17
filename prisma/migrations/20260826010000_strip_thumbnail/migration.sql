-- Small WebP previews for the cart and admin grids, alongside the full-size image.
--
-- Additive and nullable: a row without a thumbnail simply falls back to the full
-- image, so this is safe to apply before any thumbnails exist. Backfill existing
-- rows with `npm run backfill:strips`.

-- AlterTable
ALTER TABLE "Strip" ADD COLUMN "thumbnailKey" TEXT;
