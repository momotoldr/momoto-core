-- Testimonials have no hand-set order any more (the admin reorder was removed): they're
-- listed newest first, so the position column and its index go.

-- DropIndex
DROP INDEX "Testimonial_publishedAt_position_idx";

-- AlterTable
ALTER TABLE "Testimonial" DROP COLUMN "position";

-- CreateIndex
CREATE INDEX "Testimonial_publishedAt_idx" ON "Testimonial"("publishedAt");

