/*
  Warnings:

  - You are about to drop the column `stripId` on the `Payment` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_stripId_fkey";

-- DropIndex
DROP INDEX "Payment_stripId_idx";

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "stripId";

-- CreateTable
CREATE TABLE "_PaymentToStrip" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PaymentToStrip_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_PaymentToStrip_B_index" ON "_PaymentToStrip"("B");

-- AddForeignKey
ALTER TABLE "_PaymentToStrip" ADD CONSTRAINT "_PaymentToStrip_A_fkey" FOREIGN KEY ("A") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PaymentToStrip" ADD CONSTRAINT "_PaymentToStrip_B_fkey" FOREIGN KEY ("B") REFERENCES "Strip"("id") ON DELETE CASCADE ON UPDATE CASCADE;
