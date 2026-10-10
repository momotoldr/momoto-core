-- Strips filtered by Paid / Free read only that side, newest first.

-- CreateIndex
CREATE INDEX "Strip_paid_createdAt_id_idx" ON "Strip"("paid", "createdAt", "id");

