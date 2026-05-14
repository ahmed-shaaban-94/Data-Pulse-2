-- 0004_audit_retention_marker.down.sql
--
-- Reverses 0004_audit_retention_marker.sql.
-- Drops both retention indexes and the retention_marked_at column.

BEGIN;

DROP INDEX IF EXISTS audit_events_retention_unmarked_idx;
DROP INDEX IF EXISTS audit_events_retention_marked_at_idx;

ALTER TABLE audit_events
  DROP COLUMN IF EXISTS retention_marked_at;

COMMIT;
