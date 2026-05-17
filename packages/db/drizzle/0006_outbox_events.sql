-- 0006_outbox_events.sql
--
-- T571 -- Outbox events table: schema, indexes, and RLS policies.
-- Slice 1A of P7 Track C (feature 004-platform-production-readiness).
--
-- This migration:
--   1. Creates the `outbox_events` table (new table, additive only).
--   2. Creates three supporting indexes.
--   3. Enables Row-Level Security and FORCE ROW LEVEL SECURITY.
--   4. Creates a single tenant-isolation policy (USING + WITH CHECK).
--
-- Zero-downtime characteristics:
--   - Pure additive: no change to any existing table.
--   - New table is empty at migration time: no backfill required.
--   - All indexes are created in the same transaction as the table (no
--     CONCURRENTLY needed on an empty table -- there is no live traffic
--     to lock out).
--   - No existing application code reads or writes `outbox_events` yet
--     (producer helper T580 is a future gated task), so old application
--     code running against the new schema sees no error.
--
-- Reversibility: 0006_outbox_events.down.sql drops policies, indexes,
--   and the table in reverse order.
--
-- Design references:
--   - docs/outbox/lifecycle.md    -- column set (section 2), state enum
--   - docs/outbox/drainer-design.md -- claim query shape, index rationale
--   - specs/004-platform-production-readiness/tasks.md T570, T571
--   - Constitution v3.0.0 section II (multi-tenant RLS), section V (workers),
--     section XIV (PII / data lifecycle)

BEGIN;

-- =============================================================================
-- 1. outbox_events table
-- =============================================================================
--
-- Column notes:
--
--   event_id     : UUIDv7 preferred; producer generates at insert time.
--                  Also the consumer dedup key (lifecycle.md section 5).
--   tenant_id    : NOT NULL; partitions the table for RLS. Drainer
--                  establishes tenant context from this column before
--                  any downstream DB access (lifecycle.md section 6).
--   store_id     : nullable; NULL for tenant-level events.
--   event_type   : registry-controlled; first allowed: 'audit.event.created'.
--   payload      : JSONB; never logged in full (Constitution XIV, FR-C-008).
--   delivery_state : enforced by CHECK; drives the claim and retry queries.
--                  Values: pending, claimed, delivered, failed, dead_lettered.
--                  NOTE: task wording listed 'in_flight' and 'processed';
--                  this migration uses 'claimed' and 'delivered' per the
--                  design contract in lifecycle.md section 2 and
--                  drainer-design.md section 2, which the future drainer
--                  code (T580/T581) will be written against.
--   attempts     : incremented at claim time (inside the claim CTE),
--                  not in the failure handler (spike T551 finding).
--   next_attempt_at : NULL means immediately eligible; set by drainer on
--                  failure transition per backoff schedule (lifecycle.md
--                  section 4.2). Schema does not bake in a backoff formula;
--                  that is a drainer runtime concern.
--   last_error   : redacted error class only (lifecycle.md section 4.3).
--   occurred_at  : business event timestamp (UTC); may differ from created_at.
--   created_at   : row insert time (producer transaction commit time).
--   updated_at   : last state-transition time; updated by drainer.
--   processed_at : set when row reaches 'delivered' or 'dead_lettered'.
--   correlation_id : UUID (matches existing conventions in audit_events and
--                  sessions); optional; carries the end-to-end trace id.
--                  NOTE: lifecycle.md section 2 shows UUID NOT NULL; task
--                  wording says TEXT NULL. This migration uses UUID NULL to
--                  match the repo UUID convention while remaining optional
--                  (correlation id is not always available at produce time).

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id         UUID         NOT NULL,
  tenant_id        UUID         NOT NULL,
  store_id         UUID,
  event_type       TEXT         NOT NULL,
  payload          JSONB        NOT NULL,
  delivery_state   TEXT         NOT NULL DEFAULT 'pending',
  attempts         INT          NOT NULL DEFAULT 0,
  next_attempt_at  TIMESTAMPTZ,
  last_error       TEXT,
  occurred_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at     TIMESTAMPTZ,
  correlation_id   UUID,

  PRIMARY KEY (event_id),

  CONSTRAINT outbox_events_delivery_state_valid
    CHECK (delivery_state IN ('pending','claimed','delivered','failed','dead_lettered')),

  CONSTRAINT outbox_events_attempts_non_negative
    CHECK (attempts >= 0)
);

-- =============================================================================
-- 2. Indexes
-- =============================================================================
--
-- Index 1 — drainer claim scan.
-- The claim query (drainer-design.md section 2) reads:
--
--   WHERE delivery_state IN ('pending', 'failed')
--     AND (next_attempt_at IS NULL OR next_attempt_at <= now())
--
-- A partial index on (delivery_state, next_attempt_at) restricted to the
-- claimable states covers both branches of the OR predicate. 'claimed',
-- 'delivered', and 'dead_lettered' rows are excluded from the partial index
-- so they do not bloat the structure the drainer scans on every poll tick.

CREATE INDEX IF NOT EXISTS outbox_events_drainer_claim_idx
  ON outbox_events (delivery_state, next_attempt_at)
  WHERE delivery_state IN ('pending', 'failed');

-- Index 2 — dead-letter triage.
-- Operator queries and the future admin endpoint (T591) filter exclusively
-- on dead_lettered rows. A small partial index isolates those rows cheaply.

CREATE INDEX IF NOT EXISTS outbox_events_dead_letter_idx
  ON outbox_events (delivery_state)
  WHERE delivery_state = 'dead_lettered';

-- Index 3 — tenant audit history.
-- Tenant-scoped audit queries walk events ordered by occurred_at. The
-- RLS policy will always add a tenant_id predicate, so the leading column
-- is tenant_id; occurred_at is the sort key.

CREATE INDEX IF NOT EXISTS outbox_events_tenant_occurred_at_idx
  ON outbox_events (tenant_id, occurred_at);

-- =============================================================================
-- 3. Row-Level Security
-- =============================================================================
--
-- Pattern mirrors every existing tenant-scoped table in 0000_initial.sql:
--   current_setting('app.current_tenant', true)::uuid
--     -- the `true` makes an unset GUC return NULL, so the predicate fails
--        closed (matches no rows) when tenant context is not established.
--   OR current_setting('app.is_platform_admin', true) = 'true'
--     -- platform admins can see all rows.
--
-- FORCE ROW LEVEL SECURITY: binds even the table owner connection
--   (Testcontainers superuser, CI, etc.) to the policy so tests using
--   env.admin to seed data must use SET LOCAL explicitly if they want
--   policy-filtered reads -- preventing false-positive test coverage.
--   Convention is consistent with every other tenant-scoped table.
--
-- Single policy covering all commands (SELECT, INSERT, UPDATE, DELETE).
-- USING = visibility predicate for SELECT / UPDATE / DELETE.
-- WITH CHECK = write predicate for INSERT / UPDATE.
-- Matching USING and WITH CHECK prevents a writer with the wrong tenant
-- context from reading or writing rows belonging to another tenant.

ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

CREATE POLICY outbox_events_tenant_isolation ON outbox_events
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

-- =============================================================================
-- NOTE: No explicit GRANT ... TO <role> in this migration.
-- =============================================================================
--
-- The existing test helper (postgres-container.ts `ensureAppRole`) issues a
-- broad GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
-- after every migration run, which covers `outbox_events` automatically.
-- Production environments manage grants externally via secrets/IAM tooling,
-- consistent with the pattern established in 0000_initial.sql.
-- No BYPASSRLS is granted to any role by this migration (T600 / Constitution II).

COMMIT;
