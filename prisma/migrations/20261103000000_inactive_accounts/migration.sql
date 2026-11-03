-- Inactive-account deletion, phase 1 (docs/PLAN-inactive-accounts.md).
--
-- `lastActiveAt` is NOT NULL with a default, so this ALTER backfills every existing row
-- with the migration's time (CURRENT_TIMESTAMP is fixed for the transaction): nobody's
-- 90 days are guessed from the past, everyone's clock starts at this deploy.
-- `lang` lets a mail sent with no request behind it (the inactivity warning) match the
-- person's language; older rows simply get English, as with "Payment"."lang".

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "inactiveFinalAt" TIMESTAMP(3),
ADD COLUMN     "inactiveWarnedAt" TIMESTAMP(3),
ADD COLUMN     "lang" TEXT,
ADD COLUMN     "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "User_lastActiveAt_id_idx" ON "User"("lastActiveAt", "id");

-- Deleting an inactive account is housekeeping, so it must not shrink the all-time
-- counters the Overview and the public /stats read: the deletion sets
-- `momoto.inactive_purge` in its transaction (lib/deleteAccount.ts), and these triggers
-- skip deletes made under it. `SET LOCAL` covers the whole transaction, so the cascaded
-- Strip deletes and the Session rows the Strip trigger then drops are covered too. A
-- self-delete or an admin delete still counts out, as before. Same pattern as
-- `momoto.support_retention` (20261010150000).
--
-- The Session/SessionMember tables themselves are left alone: they still follow the
-- strips that exist. Only the counters keep the history.
CREATE OR REPLACE FUNCTION user_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('momoto.inactive_purge', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM daily_stat_bump('users', OLD."createdAt", -1);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM daily_stat_bump('users', NEW."createdAt", 1);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION strip_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('momoto.inactive_purge', true) = 'on' THEN
    RETURN NULL;
  END IF;
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

-- A purge can also *update* a Session (its first/last window narrows when an edge strip
-- goes). That moves the session's count from one day to another, net zero, so only the
-- delete is skipped.
CREATE OR REPLACE FUNCTION session_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('momoto.inactive_purge', true) = 'on' THEN
    RETURN NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM daily_stat_bump('sessions:' || COALESCE(OLD."mode", 'unknown'), OLD."firstAt", -1);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM daily_stat_bump('sessions:' || COALESCE(NEW."mode", 'unknown'), NEW."firstAt", 1);
  END IF;
  RETURN NULL;
END;
$$;
