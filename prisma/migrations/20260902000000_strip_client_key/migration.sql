-- Idempotency key for strip uploads.
--
-- `POST /strips` is the largest request the app makes (two full-size PNGs, three
-- object-store writes and a thumbnail render before it answers), and a client that
-- gives up on it cannot cancel the write already running server-side. The retry that
-- followed created a second row for the same strip: a save the user watched fail
-- appeared twice in their cart. The client now sends the id it minted when the strip
-- was composed, and this index makes the replay a no-op.
--
-- Additive and safe on a live table: the column starts null everywhere, and Postgres
-- treats NULLs as distinct in a unique index — so every existing row, and any client
-- that sends no key, keeps saving exactly as before.

-- AlterTable
ALTER TABLE "Strip" ADD COLUMN "clientKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Strip_userId_clientKey_key" ON "Strip"("userId", "clientKey");
