-- DropIndex
DROP INDEX "Feedback_createdAt_idx";

-- CreateIndex
CREATE INDEX "User_createdAt_id_idx" ON "User"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Feedback_createdAt_id_idx" ON "Feedback"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Strip_createdAt_id_idx" ON "Strip"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Payment_createdAt_id_idx" ON "Payment"("createdAt", "id");
