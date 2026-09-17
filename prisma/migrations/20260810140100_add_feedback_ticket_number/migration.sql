-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "ticketNumber" SERIAL NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Feedback_ticketNumber_key" ON "Feedback"("ticketNumber");
