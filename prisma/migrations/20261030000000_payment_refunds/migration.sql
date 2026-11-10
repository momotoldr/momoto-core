-- Admin refunds for orders Midtrans settled but we never recorded as paid. Additive and
-- nullable: existing rows were never refunded. `status` is TEXT, so `refunded` needs no
-- change there.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "refundedAt" TIMESTAMP(3),
ADD COLUMN "refundReason" TEXT,
ADD COLUMN "refundedById" TEXT;

-- CreateIndex
CREATE INDEX "Payment_refundedById_idx" ON "Payment"("refundedById");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_refundedById_fkey" FOREIGN KEY ("refundedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
