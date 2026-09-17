-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN     "enteredById" TEXT,
ADD COLUMN     "sourceNote" TEXT;

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

