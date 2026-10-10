-- Strips filtered by session mode read only that mode, newest first.

-- CreateIndex
CREATE INDEX "Strip_sessionMode_createdAt_id_idx" ON "Strip"("sessionMode", "createdAt", "id");

