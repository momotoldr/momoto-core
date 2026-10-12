-- SessionMember: who took part in each session, one row per person, kept by the same
-- Strip trigger as "Session". See the model in schema.prisma.
--
-- One transaction. The lock holds off strip writes until the trigger maintains members
-- and the backfill is done, so nobody is counted twice or missed.
LOCK TABLE "Strip" IN SHARE ROW EXCLUSIVE MODE;

-- CreateTable
CREATE TABLE "SessionMember" (
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "stripCount" INTEGER NOT NULL,

    CONSTRAINT "SessionMember_pkey" PRIMARY KEY ("sessionId","userId")
);

-- A strip joined a session: count its owner in.
CREATE FUNCTION session_member_added(sid TEXT, uid TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  -- Same rule as session_strip_added: "solo" is the FE's no-room placeholder.
  IF sid IS NULL OR sid = 'solo' THEN
    RETURN;
  END IF;
  INSERT INTO "SessionMember" ("sessionId", "userId", "stripCount") VALUES (sid, uid, 1)
  ON CONFLICT ("sessionId", "userId") DO UPDATE
    SET "stripCount" = "SessionMember"."stripCount" + 1;
END;
$$;

-- A strip left a session: count its owner out; their last strip there drops them.
CREATE FUNCTION session_member_removed(sid TEXT, uid TEXT) RETURNS VOID
LANGUAGE plpgsql AS $$
DECLARE
  remaining INT;
BEGIN
  IF sid IS NULL OR sid = 'solo' THEN
    RETURN;
  END IF;
  UPDATE "SessionMember" SET "stripCount" = "stripCount" - 1
  WHERE "sessionId" = sid AND "userId" = uid
  RETURNING "stripCount" INTO remaining;
  IF FOUND AND remaining <= 0 THEN
    DELETE FROM "SessionMember" WHERE "sessionId" = sid AND "userId" = uid;
  END IF;
END;
$$;

-- The existing sync trigger now keeps members too. A strip's owner is part of what a
-- membership is built from, so "userId" joins the column list.
CREATE OR REPLACE FUNCTION strip_session_sync() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM session_strip_removed(OLD."sessionId", OLD."createdAt");
    PERFORM session_member_removed(OLD."sessionId", OLD."userId");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM session_strip_added(NEW."sessionId", NEW."sessionMode", NEW."createdAt");
    PERFORM session_member_added(NEW."sessionId", NEW."userId");
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER strip_session_sync ON "Strip";
CREATE TRIGGER strip_session_sync
AFTER INSERT OR DELETE OR UPDATE OF "sessionId", "sessionMode", "createdAt", "userId" ON "Strip"
FOR EACH ROW EXECUTE FUNCTION strip_session_sync();

-- Backfill from the strips already there.
INSERT INTO "SessionMember" ("sessionId", "userId", "stripCount")
SELECT "sessionId", "userId", count(*)::int
FROM "Strip"
WHERE "sessionId" IS NOT NULL AND "sessionId" <> 'solo'
GROUP BY "sessionId", "userId";

ANALYZE "SessionMember";
