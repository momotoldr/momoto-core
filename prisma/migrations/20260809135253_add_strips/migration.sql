-- CreateTable
CREATE TABLE "Strip" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "mimeType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sessionId" TEXT,
    "sessionMode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Strip_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Strip_userId_createdAt_idx" ON "Strip"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Strip" ADD CONSTRAINT "Strip_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
