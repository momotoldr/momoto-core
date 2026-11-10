-- The scrapbook bundle became one finished scrapbook + 3 *unpaid* strips in one checkout
-- (user, 2026-10-27), replacing "a book that uses 3 gallery strips". Nothing is claimed
-- per strip any more, so the claim columns go and a payment records how many bundles
-- priced it. Both migrations ship together; neither has reached staging or prod.

/*
  Warnings:

  - You are about to drop the column `bundleClaims` on the `Payment` table. All the data in the column will be lost.
  - You are about to drop the column `bundledIntoId` on the `Strip` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Strip" DROP CONSTRAINT "Strip_bundledIntoId_fkey";

-- DropIndex
DROP INDEX "Strip_bundledIntoId_idx";

-- AlterTable
ALTER TABLE "Payment" DROP COLUMN "bundleClaims",
ADD COLUMN     "bundles" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Strip" DROP COLUMN "bundledIntoId";
