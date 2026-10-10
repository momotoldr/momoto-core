-- The admin testimonials list is now keyset-paged newest first, like the other lists.

-- CreateIndex
CREATE INDEX "Testimonial_createdAt_id_idx" ON "Testimonial"("createdAt", "id");

