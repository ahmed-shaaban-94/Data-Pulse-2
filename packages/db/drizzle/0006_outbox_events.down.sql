-- 0006_outbox_events.down.sql
--
-- Reverses 0006_outbox_events.sql.
-- Drops policies first, then indexes, then the table.
-- Reverse-order teardown ensures there are no dependency conflicts.

BEGIN;

-- Drop RLS policy first (must precede the table drop, but Postgres would
-- also drop it implicitly -- we make it explicit for clarity and to mirror
-- the forward migration's structure).
DROP POLICY IF EXISTS outbox_events_tenant_isolation ON outbox_events;

-- Drop indexes (also implicit on table drop, but explicit for clarity).
DROP INDEX IF EXISTS outbox_events_drainer_claim_idx;
DROP INDEX IF EXISTS outbox_events_dead_letter_idx;
DROP INDEX IF EXISTS outbox_events_tenant_occurred_at_idx;

-- Drop the table. CASCADE is intentionally omitted -- there should be no
-- dependent objects on a brand-new table. If a dependency exists, the error
-- is the right signal to stop rather than silently cascade.
DROP TABLE IF EXISTS outbox_events;

COMMIT;
