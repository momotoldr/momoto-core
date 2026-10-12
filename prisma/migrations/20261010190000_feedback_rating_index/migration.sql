-- Feedback filtered by star rating reads only that rating, newest first.

-- CreateIndex
CREATE INDEX "Feedback_rating_createdAt_id_idx" ON "Feedback"("rating", "createdAt", "id");
