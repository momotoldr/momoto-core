-- Soft-launch promos (docs/PLAN-promos.md): the partner buy 1 get 1 reward (PromoGrant,
-- Payment.bogo) and the scrapbook bundle (Payment.bundleClaims, Strip.bundledIntoId).
-- Additive only: new nullable/defaulted columns and a new table.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "bogo" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "bundleClaims" JSONB;

-- AlterTable
ALTER TABLE "Strip" ADD COLUMN     "bundledIntoId" TEXT;

-- CreateTable
CREATE TABLE "PromoGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceUserId" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "usedByPaymentId" TEXT,

    CONSTRAINT "PromoGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoGrant_usedByPaymentId_key" ON "PromoGrant"("usedByPaymentId");

-- CreateIndex
CREATE INDEX "PromoGrant_sourceUserId_idx" ON "PromoGrant"("sourceUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PromoGrant_userId_kind_key" ON "PromoGrant"("userId", "kind");

-- CreateIndex
CREATE INDEX "Strip_bundledIntoId_idx" ON "Strip"("bundledIntoId");

-- AddForeignKey
ALTER TABLE "Strip" ADD CONSTRAINT "Strip_bundledIntoId_fkey" FOREIGN KEY ("bundledIntoId") REFERENCES "Scrapbook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoGrant" ADD CONSTRAINT "PromoGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoGrant" ADD CONSTRAINT "PromoGrant_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoGrant" ADD CONSTRAINT "PromoGrant_usedByPaymentId_fkey" FOREIGN KEY ("usedByPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
