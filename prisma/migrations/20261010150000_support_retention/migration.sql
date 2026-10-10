-- Resolved support tickets are deleted 3 days after resolving (lib/supportRetention.ts).
-- That purge is housekeeping, so it must not shrink the Overview's all-time `support`
-- counter: the purge sets `momoto.support_retention` in its transaction, and the counter
-- trigger skips deletes made under it. A manual delete (spam) still counts out. Purged
-- tickets are resolved, so `support:open` is never involved.
CREATE OR REPLACE FUNCTION support_daily_stat() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('momoto.support_retention', true) = 'on' THEN
    RETURN NULL;
  END IF;
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
