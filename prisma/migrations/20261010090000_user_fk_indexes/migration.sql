-- Index every foreign key to User that lacked one. Deleting a user (admin delete or a
-- self-deleted account) has Postgres find and null/cascade the referencing rows; with
-- no index that's a full scan of the table per deletion.

-- CreateIndex
CREATE INDEX "Feedback_partnerUserId_idx" ON "Feedback"("partnerUserId");

-- CreateIndex
CREATE INDEX "Feedback_enteredById_idx" ON "Feedback"("enteredById");

-- CreateIndex
CREATE INDEX "Testimonial_userId_idx" ON "Testimonial"("userId");

-- CreateIndex
CREATE INDEX "Testimonial_partnerUserId_idx" ON "Testimonial"("partnerUserId");

