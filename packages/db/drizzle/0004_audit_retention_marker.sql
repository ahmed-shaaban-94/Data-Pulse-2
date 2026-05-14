-- 0004_audit_retention_marker.sql
--
-- T311 — audit retention marker sweep (Layer A schema slice).
--
-- Adds `retention_marked_at` to `audit_events`. The retention sweep worker
-- sets this column when a row passes the documented 365-day retention window
-- (occurred_at < now() - interval '365 days'). The column is nullable with
-- no default: NULL means "not yet evaluated by the sweep".
--
-- Two indexes:
--   audit_events_retention_unmarked_idx — partial index on occurred_at for
--     rows where retention_marked_at IS NULL. The sweep worker's predicate
--     (occurred_at < cutoff AND retention_marked_at IS NULL) hits this index
--     for efficient batch reads.
--   audit_events_retention_marked_at_idx — partial index on retention_marked_at
--     for rows already marked (IS NOT NULL). Covers legal-hold queries, export
--     jobs, and any future deletion-readiness sweep.
--
-- Scope of this migration:
--   This migration adds the retention lifecycle column and its supporting
--   indexes only. It DOES NOT create roles, grant privileges, or otherwise
--   alter the database security surface. A DB-layer column-scoped UPDATE
--   grant (so that only `retention_marked_at` is writable by the retention
--   worker role) is deferred to a follow-up PR that introduces a verified
--   production worker-role pattern. Until that PR lands, the
--   write-only-retention-lifecycle invariant is enforced by the processor
--   abstraction, not by the database.
--
-- No deletion: this migration does not grant DELETE on audit_events to any
--   role. Audit-row deletion remains out of scope (Constitution §XIII).
--
-- Reversibility: 0004_audit_retention_marker.down.sql drops the column
--   and both indexes.

BEGIN;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS retention_marked_at TIMESTAMPTZ NULL;

-- Partial index for the sweep worker: rows where retention_marked_at IS NULL,
-- ordered by occurred_at so the batch-scan reads the oldest eligible rows first.
CREATE INDEX IF NOT EXISTS audit_events_retention_unmarked_idx
  ON audit_events (occurred_at)
  WHERE retention_marked_at IS NULL;

-- Partial index for downstream consumers of already-marked rows
-- (legal-hold checks, export jobs, future deletion sweep).
CREATE INDEX IF NOT EXISTS audit_events_retention_marked_at_idx
  ON audit_events (retention_marked_at)
  WHERE retention_marked_at IS NOT NULL;

COMMIT;
