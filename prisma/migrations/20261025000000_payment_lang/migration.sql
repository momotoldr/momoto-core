-- The payer's UI language at checkout, so the receipt mailed on settlement matches it.
-- Additive and nullable: older rows simply get English.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "lang" TEXT;
