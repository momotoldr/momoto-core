-- The payment method's admin fee (ADMIN_FEE_<METHOD>). Additive with a default: every
-- existing order was charged without one.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "adminFee" INTEGER NOT NULL DEFAULT 0;
