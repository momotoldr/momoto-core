-- A Session table summarising each room code's strips, kept by a trigger on "Strip".
-- See the `Session` model in schema.prisma.
--
-- The whole file runs as one transaction (a multi-statement script). Locking "Strip"
-- first holds off strip saves and deletes until the trigger exists *and* the backfill
-- is done, so no strip is counted twice or missed. The lock also fails loudly if this
-- ever runs outside a transaction ("LOCK TABLE can only be used in transaction blocks").
LOCK TABLE "Strip" IN SHARE ROW EXCLUSIVE MODE;

-- DropIndex
DROP INDEX "Strip_sessionId_idx";

-- CreateIndex
CREATE INDEX "Strip_sessionId_createdAt_idx" ON "Strip"("sessionId", "createdAt");

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "mode" TEXT,
    "stripCount" INTEGER NOT NULL,
    "firstAt" TIMESTAMP(3) NOT NULL,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_lastAt_id_idx" ON "Session"("lastAt", "id");

-- CreateIndex
CREATE INDEX "Session_mode_lastAt_id_idx" ON "Session"("mode", "lastAt", "id");

-- A strip joined a session: count it in, widen the first/last window.
CREATE FUNCTION session_strip_added(sid TEXT, smode TEXT, at TIMESTAMP(3)) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  -- "solo" is the FE's placeholder for a strip saved outside any room, not a session.
  IF sid IS NULL OR sid = 'solo' THEN
    RETURN;
  END IF;
  INSERT INTO "Session" ("id", "mode", "stripCount", "firstAt", "lastAt")
  VALUES (sid, smode, 1, at, at)
  ON CONFLICT ("id") DO UPDATE SET
    "stripCount" = "Session"."stripCount" + 1,
    "firstAt" = LEAST("Session"."firstAt", EXCLUDED."firstAt"),
    "lastAt" = GREATEST("Session"."lastAt", EXCLUDED."lastAt"),
    "mode" = COALESCE("Session"."mode", EXCLUDED."mode");
END;
$$;

-- A strip left a session: count it out; the last one out drops the session. The
-- first/last window is only recomputed when the strip sat on its edge — a lookup on
-- the (sessionId, createdAt) index.
--
-- Row triggers run once the whole statement is done, so a delete of several strips of
-- one session (an account deletion's cascade) finds *all* of them gone at the first
-- recompute, while the count is still mid-way down. No strips left means no session.
CREATE FUNCTION session_strip_removed(sid TEXT, at TIMESTAMP(3)) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  s "Session"%ROWTYPE;
  first_at TIMESTAMP(3);
  last_at TIMESTAMP(3);
BEGIN
  IF sid IS NULL OR sid = 'solo' THEN
    RETURN;
  END IF;
  UPDATE "Session" SET "stripCount" = "stripCount" - 1 WHERE "id" = sid RETURNING * INTO s;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF s."stripCount" <= 0 THEN
    DELETE FROM "Session" WHERE "id" = sid;
  ELSIF at <= s."firstAt" OR at >= s."lastAt" THEN
    SELECT min("createdAt"), max("createdAt") INTO first_at, last_at
    FROM "Strip" WHERE "sessionId" = sid;
    IF first_at IS NULL THEN
      DELETE FROM "Session" WHERE "id" = sid;
    ELSE
      UPDATE "Session" SET "firstAt" = first_at, "lastAt" = last_at WHERE "id" = sid;
    END IF;
  END IF;
END;
$$;

CREATE FUNCTION strip_session_sync() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM session_strip_removed(OLD."sessionId", OLD."createdAt");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM session_strip_added(NEW."sessionId", NEW."sessionMode", NEW."createdAt");
  END IF;
  RETURN NULL;
END;
$$;

-- Only the columns a session is built from: a paid/unlock/removed update doesn't fire it.
CREATE TRIGGER strip_session_sync
AFTER INSERT OR DELETE OR UPDATE OF "sessionId", "sessionMode", "createdAt" ON "Strip"
FOR EACH ROW EXECUTE FUNCTION strip_session_sync();

-- Backfill every existing session from its strips.
INSERT INTO "Session" ("id", "mode", "stripCount", "firstAt", "lastAt")
SELECT
  "sessionId",
  (array_agg("sessionMode" ORDER BY "createdAt") FILTER (WHERE "sessionMode" IS NOT NULL))[1],
  count(*),
  min("createdAt"),
  max("createdAt")
FROM "Strip"
WHERE "sessionId" IS NOT NULL AND "sessionId" <> 'solo'
GROUP BY "sessionId";
