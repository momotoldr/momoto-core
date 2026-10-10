-- Daily counters for the admin Overview and public /stats, kept by triggers. See the
-- `DailyStat` model in schema.prisma for the metric list.
--
-- One transaction (a multi-statement script): the locks hold off writes to every
-- counted table until the triggers exist *and* the backfill is done, so nothing is
-- counted twice or missed. LOCK also fails loudly outside a transaction.
LOCK TABLE "User", "Strip", "Feedback", "Payment", "Session" IN SHARE ROW EXCLUSIVE MODE;

-- CreateTable
CREATE TABLE "DailyStat" (
    "metric" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "value" BIGINT NOT NULL,

    CONSTRAINT "DailyStat_pkey" PRIMARY KEY ("metric","day")
);

-- Add `delta` to one (metric, day). Timestamps are stored as UTC, so ::date is the UTC day.
CREATE FUNCTION daily_stat_bump(m TEXT, at TIMESTAMP(3), delta BIGINT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  IF delta = 0 THEN
    RETURN;
  END IF;
  INSERT INTO "DailyStat" ("metric", "day", "value") VALUES (m, at::date, delta)
  ON CONFLICT ("metric", "day") DO UPDATE SET "value" = "DailyStat"."value" + EXCLUDED."value";
END;
$$;

-- Each trigger takes back the old row's contribution (UPDATE, DELETE) and adds the new
-- row's (INSERT, UPDATE). Column lists keep unrelated updates from firing them.

CREATE FUNCTION user_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM daily_stat_bump('users', OLD."createdAt", -1);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM daily_stat_bump('users', NEW."createdAt", 1);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER user_daily_stat
AFTER INSERT OR DELETE OR UPDATE OF "createdAt" ON "User"
FOR EACH ROW EXECUTE FUNCTION user_daily_stat();

CREATE FUNCTION strip_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM daily_stat_bump('strips', OLD."createdAt", -1);
    PERFORM daily_stat_bump('strips:' || COALESCE(OLD."sessionMode", 'unknown'), OLD."createdAt", -1);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM daily_stat_bump('strips', NEW."createdAt", 1);
    PERFORM daily_stat_bump('strips:' || COALESCE(NEW."sessionMode", 'unknown'), NEW."createdAt", 1);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER strip_daily_stat
AFTER INSERT OR DELETE OR UPDATE OF "sessionMode", "createdAt" ON "Strip"
FOR EACH ROW EXECUTE FUNCTION strip_daily_stat();

CREATE FUNCTION feedback_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM daily_stat_bump('feedback', OLD."createdAt", -1);
    PERFORM daily_stat_bump('feedback:' || OLD."category", OLD."createdAt", -1);
    IF OLD."rating" IS NOT NULL THEN
      PERFORM daily_stat_bump('rating:' || OLD."rating", OLD."createdAt", -1);
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM daily_stat_bump('feedback', NEW."createdAt", 1);
    PERFORM daily_stat_bump('feedback:' || NEW."category", NEW."createdAt", 1);
    IF NEW."rating" IS NOT NULL THEN
      PERFORM daily_stat_bump('rating:' || NEW."rating", NEW."createdAt", 1);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER feedback_daily_stat
AFTER INSERT OR DELETE OR UPDATE OF "category", "rating", "createdAt" ON "Feedback"
FOR EACH ROW EXECUTE FUNCTION feedback_daily_stat();

CREATE FUNCTION payment_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."status" = 'paid' THEN
    PERFORM daily_stat_bump('revenue', COALESCE(OLD."paidAt", OLD."createdAt"), -OLD."grossAmount");
    PERFORM daily_stat_bump('paid_orders', COALESCE(OLD."paidAt", OLD."createdAt"), -1);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."status" = 'paid' THEN
    PERFORM daily_stat_bump('revenue', COALESCE(NEW."paidAt", NEW."createdAt"), NEW."grossAmount");
    PERFORM daily_stat_bump('paid_orders', COALESCE(NEW."paidAt", NEW."createdAt"), 1);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER payment_daily_stat
AFTER INSERT OR DELETE OR UPDATE OF "status", "grossAmount", "paidAt", "createdAt" ON "Payment"
FOR EACH ROW EXECUTE FUNCTION payment_daily_stat();

-- Session rows are themselves written by the strip_session_sync trigger; this fires on
-- those writes too. stripCount/lastAt churn isn't in the column list.
CREATE FUNCTION session_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM daily_stat_bump('sessions:' || COALESCE(OLD."mode", 'unknown'), OLD."firstAt", -1);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM daily_stat_bump('sessions:' || COALESCE(NEW."mode", 'unknown'), NEW."firstAt", 1);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER session_daily_stat
AFTER INSERT OR DELETE OR UPDATE OF "mode", "firstAt" ON "Session"
FOR EACH ROW EXECUTE FUNCTION session_daily_stat();

-- Backfill from the existing rows — the same contributions the triggers would have made.
INSERT INTO "DailyStat" ("metric", "day", "value")
SELECT metric, day, sum(value)::bigint FROM (
  SELECT 'users' AS metric, "createdAt"::date AS day, 1::bigint AS value FROM "User"
  UNION ALL SELECT 'strips', "createdAt"::date, 1 FROM "Strip"
  UNION ALL SELECT 'strips:' || COALESCE("sessionMode", 'unknown'), "createdAt"::date, 1 FROM "Strip"
  UNION ALL SELECT 'feedback', "createdAt"::date, 1 FROM "Feedback"
  UNION ALL SELECT 'feedback:' || "category", "createdAt"::date, 1 FROM "Feedback"
  UNION ALL SELECT 'rating:' || "rating", "createdAt"::date, 1 FROM "Feedback" WHERE "rating" IS NOT NULL
  UNION ALL SELECT 'revenue', COALESCE("paidAt", "createdAt")::date, "grossAmount" FROM "Payment" WHERE "status" = 'paid'
  UNION ALL SELECT 'paid_orders', COALESCE("paidAt", "createdAt")::date, 1 FROM "Payment" WHERE "status" = 'paid'
  UNION ALL SELECT 'sessions:' || COALESCE("mode", 'unknown'), "firstAt"::date, 1 FROM "Session"
) contributions
GROUP BY metric, day;
