-- Scrapbooks: a fixed template filled with the owner's unlocked strips and text, finished
-- into a PDF (private bucket) and sold as one. Additive only. docs/PLAN-scrapbook.md §1.

-- CreateTable
CREATE TABLE "Scrapbook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" JSONB NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "pdfKey" TEXT,
    "pdfBytes" INTEGER,
    "pageCount" INTEGER,
    "coverKey" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scrapbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PaymentToScrapbook" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PaymentToScrapbook_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Scrapbook_userId_updatedAt_idx" ON "Scrapbook"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "_PaymentToScrapbook_B_index" ON "_PaymentToScrapbook"("B");

-- AddForeignKey
ALTER TABLE "Scrapbook" ADD CONSTRAINT "Scrapbook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PaymentToScrapbook" ADD CONSTRAINT "_PaymentToScrapbook_A_fkey" FOREIGN KEY ("A") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PaymentToScrapbook" ADD CONSTRAINT "_PaymentToScrapbook_B_fkey" FOREIGN KEY ("B") REFERENCES "Scrapbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
