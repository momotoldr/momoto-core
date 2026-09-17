/*
  Warnings:

  - You are about to drop the column `snapToken` on the `Payment` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "snapToken",
ADD COLUMN     "deeplinkUrl" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "paymentType" TEXT,
ADD COLUMN     "qrImageUrl" TEXT;
