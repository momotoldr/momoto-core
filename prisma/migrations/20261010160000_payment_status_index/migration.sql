-- Transactions filtered by status read only that status's payments, newest first.

-- CreateIndex
CREATE INDEX "Payment_status_createdAt_id_idx" ON "Payment"("status", "createdAt", "id");

