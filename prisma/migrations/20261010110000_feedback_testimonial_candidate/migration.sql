-- Feedback.testimonialCandidate: a signed-in author, a written comment, 4+ stars — so
-- the admin inbox's Eligible filter reads candidates only instead of walking every
-- rating in the range. Kept by a trigger; see the field in schema.prisma.

-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "testimonialCandidate" BOOLEAN NOT NULL DEFAULT false;

-- The rule, as `isEligibleFeedback` in lib/testimonials.ts minus "not featured yet":
-- keep the 4 in step with MIN_TESTIMONIAL_RATING. Messages are stored trimmed, so a
-- written comment is simply a non-empty one. Recomputed whenever an input changes —
-- including userId going null when the author deletes their account.
CREATE FUNCTION feedback_testimonial_candidate() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW."testimonialCandidate" :=
    NEW."userId" IS NOT NULL AND NEW."message" <> '' AND COALESCE(NEW."rating", 0) >= 4;
  RETURN NEW;
END;
$$;
CREATE TRIGGER feedback_testimonial_candidate
BEFORE INSERT OR UPDATE OF "userId", "message", "rating" ON "Feedback"
FOR EACH ROW EXECUTE FUNCTION feedback_testimonial_candidate();

-- Backfill the rows already there.
UPDATE "Feedback" SET "testimonialCandidate" = true
WHERE "userId" IS NOT NULL AND "message" <> '' AND COALESCE("rating", 0) >= 4;

-- CreateIndex
CREATE INDEX "Feedback_testimonialCandidate_createdAt_id_idx" ON "Feedback"("testimonialCandidate", "createdAt", "id");

ANALYZE "Feedback";
