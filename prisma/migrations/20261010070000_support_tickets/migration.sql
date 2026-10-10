-- Support requests move out of "Feedback" into their own "SupportTicket" table. See the
-- `SupportTicket` model in schema.prisma.
--
-- One transaction (a multi-statement script). The lock holds off new feedback and
-- support rows until every support row has moved, so none is left behind or doubled.
LOCK TABLE "Feedback" IN SHARE ROW EXCLUSIVE MODE;

-- A support row can't have been featured (testimonials come from ratings), but moving
-- one that somehow was would silently unlink its testimonial — stop instead.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Testimonial" t JOIN "Feedback" f ON f."id" = t."feedbackId"
    WHERE f."category" = 'support'
  ) THEN
    RAISE EXCEPTION 'a support row has a testimonial; resolve it before migrating';
  END IF;
END;
$$;

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "ticketNumber" SERIAL NOT NULL,
    "userId" TEXT,
    "topic" TEXT,
    "message" TEXT NOT NULL,
    "email" TEXT,
    "context" TEXT,
    "analyticsSessionId" TEXT,
    "userAgent" TEXT,
    "lang" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_ticketNumber_key" ON "SupportTicket"("ticketNumber");

-- CreateIndex
CREATE INDEX "SupportTicket_createdAt_id_idx" ON "SupportTicket"("createdAt", "id");

-- CreateIndex
CREATE INDEX "SupportTicket_resolvedAt_createdAt_id_idx" ON "SupportTicket"("resolvedAt", "createdAt", "id");

-- CreateIndex
CREATE INDEX "SupportTicket_userId_idx" ON "SupportTicket"("userId");

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DailyStat counters for tickets (see the DailyStat model): `support` — tickets, by
-- creation day; `support:open` — the still-open ones, by creation day, so resolving
-- takes one out and reopening puts it back.
CREATE FUNCTION support_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM daily_stat_bump('support', OLD."createdAt", -1);
    IF OLD."resolvedAt" IS NULL THEN
      PERFORM daily_stat_bump('support:open', OLD."createdAt", -1);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM daily_stat_bump('support', NEW."createdAt", 1);
    IF NEW."resolvedAt" IS NULL THEN
      PERFORM daily_stat_bump('support:open', NEW."createdAt", 1);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER support_daily_stat
AFTER INSERT OR DELETE OR UPDATE OF "resolvedAt", "createdAt" ON "SupportTicket"
FOR EACH ROW EXECUTE FUNCTION support_daily_stat();

-- Move the support rows, ticket numbers and ids included (the trigger counts them in).
INSERT INTO "SupportTicket" (
  "id", "ticketNumber", "userId", "topic", "message", "email", "context",
  "analyticsSessionId", "userAgent", "lang", "createdAt", "resolvedAt"
)
SELECT
  "id", "ticketNumber", "userId", "topic", "message", "email", "context",
  "analyticsSessionId", "userAgent", "lang", "createdAt", "resolvedAt"
FROM "Feedback"
WHERE "category" = 'support';

-- New tickets continue after the highest moved one.
SELECT setval(
  pg_get_serial_sequence('"SupportTicket"', 'ticketNumber'),
  COALESCE((SELECT max("ticketNumber") FROM "SupportTicket"), 0) + 1,
  false
);

-- Out of Feedback (its counter trigger takes them back out of the feedback counters).
DELETE FROM "Feedback" WHERE "category" = 'support';

-- Feedback is only ratings/comments now: drop the support-only columns, and the
-- open/resolved status (that's a support-ticket idea; feedback has none). The counter
-- trigger names "category" in its column list, so it's rebuilt without it.
DROP TRIGGER feedback_daily_stat ON "Feedback";

-- DropIndex
DROP INDEX "Feedback_ticketNumber_key";

-- AlterTable
ALTER TABLE "Feedback" DROP COLUMN "category",
DROP COLUMN "resolvedAt",
DROP COLUMN "ticketNumber",
DROP COLUMN "topic";

CREATE OR REPLACE FUNCTION feedback_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM daily_stat_bump('feedback', OLD."createdAt", -1);
    IF OLD."rating" IS NOT NULL THEN
      PERFORM daily_stat_bump('rating:' || OLD."rating", OLD."createdAt", -1);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM daily_stat_bump('feedback', NEW."createdAt", 1);
    IF NEW."rating" IS NOT NULL THEN
      PERFORM daily_stat_bump('rating:' || NEW."rating", NEW."createdAt", 1);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER feedback_daily_stat
AFTER INSERT OR DELETE OR UPDATE OF "rating", "createdAt" ON "Feedback"
FOR EACH ROW EXECUTE FUNCTION feedback_daily_stat();

-- The per-category feedback counters have nothing left to count.
DELETE FROM "DailyStat" WHERE "metric" LIKE 'feedback:%';

-- Fresh statistics for the planner: a brand-new table has none until autovacuum gets to
-- it, and without them the support inbox's filters plan as full-table scans.
ANALYZE "SupportTicket";
ANALYZE "Feedback";
