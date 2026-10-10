-- All-time totals per metric, so the Overview and public /stats read one row per
-- metric instead of summing every day of history. See `MetricTotal` in schema.prisma.
--
-- One transaction. The lock holds off counter writes until the bump function updates
-- both tables and the totals are backfilled, so no bump is lost or counted twice.
LOCK TABLE "DailyStat" IN SHARE ROW EXCLUSIVE MODE;

-- CreateTable
CREATE TABLE "MetricTotal" (
    "metric" TEXT NOT NULL,
    "value" BIGINT NOT NULL,

    CONSTRAINT "MetricTotal_pkey" PRIMARY KEY ("metric")
);

-- CreateIndex
CREATE INDEX "DailyStat_day_idx" ON "DailyStat"("day");

-- Every counter change now lands on its day and on the all-time total.
CREATE OR REPLACE FUNCTION daily_stat_bump(m TEXT, at TIMESTAMP(3), delta BIGINT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF delta = 0 THEN
    RETURN;
  END IF;
  INSERT INTO "DailyStat" ("metric", "day", "value") VALUES (m, at::date, delta)
  ON CONFLICT ("metric", "day") DO UPDATE SET "value" = "DailyStat"."value" + EXCLUDED."value";
  INSERT INTO "MetricTotal" ("metric", "value") VALUES (m, delta)
  ON CONFLICT ("metric") DO UPDATE SET "value" = "MetricTotal"."value" + EXCLUDED."value";
END;
$$;

-- Backfill from the days counted so far.
INSERT INTO "MetricTotal" ("metric", "value")
SELECT "metric", sum("value")::bigint FROM "DailyStat" GROUP BY "metric";

ANALYZE "MetricTotal";
ANALYZE "DailyStat";
