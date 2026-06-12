-- 0025_sale_sync_status.sql
--
-- Spec 032 — POS Sale Capture / Sync-Status / Idempotency Contract.
-- Authors the server-authoritative sale-status (§7) + the dead-letter /
-- NEEDS_REPAIR quarantine (§8) the later Console read/repair surface (§9)
-- consumes. SLICE-AUTHORED under Principle VIII; G3 (apply/rollback on a
-- non-prod DB) is a HUMAN review gate.
--
-- DESIGN DECISIONS (data-model.md deferred these to the slice):
--
--  1. STATUS IS A COLUMN ON `sales`, NOT a pg enum and NOT a separate status
--     table. Precedent: 0012_sales already carries SaaS-owned MUTABLE columns
--     (`processed_at`, `mismatch_flag`) on the otherwise-immutable `sales` fact
--     and grants `sales` a SELECT+INSERT+UPDATE tenant policy (the void/refund
--     children are append-only, sales is not). `sync_status` is the same kind
--     of SaaS-owned mutable column — it rides the EXISTING `sales` tenant
--     UPDATE policy and needs NO new RLS policy. TEXT + CHECK (the 0024 pattern)
--     rather than CREATE TYPE, so adding a future state is a CHECK swap, not an
--     enum-migration dance.
--
--  2. VOCABULARY (spec §7): captured | synced | failed-retryable |
--     failed-needs-repair. Set `captured` at capture (in the INSERT); advanced
--     to `synced` by the SAME sale-processing drain UPDATE that sets
--     `processed_at` (spec clarify 2026-06-12 Q1: the drain that advances status
--     is the DP-2 sale-processing drain — NOT the ERPNext posting path; crossing
--     that wire would violate POS→DP-2→Connector→ERPNext). `failed-retryable` /
--     `failed-needs-repair` are set by the dead-letter classifier (§8).
--
--  3. DEAD-LETTER = a SEPARATE quarantine table `sale_sync_deadletters` (its OWN
--     RLS, ENABLE+FORCE, empty-GUC CASE guard — the 0017–0021 / 0024 precedent),
--     carrying the failure classification + provenance intact (028), feeding the
--     §9 NEEDS_REPAIR list + audit timeline. NEVER a silent drop (Principle
--     V/XIII). It does NOT rewrite any sale fact.
--
-- BACKFILL: `sales` is a POPULATED table. ADD COLUMN ... NOT NULL needs a
-- DEFAULT to succeed on existing rows; a bare default would mislabel
-- already-processed rows as `captured`. So: add with DEFAULT 'captured', then
-- backfill rows that already have `processed_at` to 'synced' so the existing
-- live loop's prior work is reflected truthfully.
--
-- HARD INVARIANTS PRESERVED:
--   - F-2: no payments.confirm / settled_at / tender column is added.
--   - F-3: the live provenance-conflict 409 is untouched (no schema change to
--          sale_voids / sale_refunds dedup).
--   - F-4: the L2 ON CONFLICT dedup on sales is untouched (only a new column +
--          a new table are added).
--   - F-5: no sale.captured outbox-event registration change.
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): BUSINESS-class. `sync_status` is a SaaS
-- state label. `sale_sync_deadletters` carries provenance identifiers + a
-- failure classification + a redacted reason; NO money, NO line amounts, NO PII,
-- NO plaintext secret. Retention inherits the 0012 long-horizon fact posture.
--
-- Reversibility: 0025_sale_sync_status.down.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Server-authoritative sale-status column on `sales` (§7).
-- ---------------------------------------------------------------------------

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'captured';

-- Backfill: any row already processed by the live drain is `synced`. New
-- captures land 'captured' (the column default + the capture INSERT both set
-- it). This UPDATE only touches the already-processed historical rows.
UPDATE sales SET sync_status = 'synced' WHERE processed_at IS NOT NULL;

ALTER TABLE sales
  ADD CONSTRAINT sales_sync_status_valid
    CHECK (sync_status IN (
      'captured',
      'synced',
      'failed-retryable',
      'failed-needs-repair'
    ));

-- NEEDS_REPAIR list acceleration (§9): the Console queue is tenant+store scoped
-- and filtered to the needs-repair state. Partial index mirrors the existing
-- `idx_sales_unprocessed` partial-index pattern. Newest-first keyset uses the
-- UUIDv7 (time-ordered) `id` (ORDER BY id DESC), so no extra timestamp column
-- is needed for the cursor.
CREATE INDEX IF NOT EXISTS idx_sales_needs_repair
  ON sales (tenant_id, store_id, id DESC)
  WHERE sync_status = 'failed-needs-repair';

-- ---------------------------------------------------------------------------
-- 2. Dead-letter / NEEDS_REPAIR quarantine (§8) — separate table, own RLS.
-- ---------------------------------------------------------------------------
--
-- One row per quarantined failed sync, keyed back to the sale via the composite
-- (sale_id, tenant_id, store_id) FK (the 0012 child-table precedent — a
-- deadletter row can never attach to a sale in a different tenant/store).
-- `classification` is the §8 RETRYABLE vs NEEDS_REPAIR routing; `reason_code` is
-- a redacted machine label (NEVER a raw upstream error body — Principle
-- XIII/XIV). Provenance (`source_system`, `external_id`) preserved (028).
CREATE TABLE IF NOT EXISTS sale_sync_deadletters (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id       UUID         NOT NULL,
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id      UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  -- §8 classification: 'retryable' (transient/auth, backoff) vs 'needs-repair'
  -- (non-retryable, operator-mediated). Mirrors the sync_status failure split.
  classification TEXT        NOT NULL,
  -- Redacted machine reason label (e.g. 'auth_revoked', 'validation_failure',
  -- 'transient_5xx'). NEVER a raw payload or upstream error body.
  reason_code    TEXT        NOT NULL,
  -- Provenance, preserved intact for reconciliation (028 / Principle XIII).
  source_system  TEXT        NOT NULL,
  external_id    TEXT        NOT NULL,
  -- Optional end-to-end correlation id (UUID-typed, matches outbox_events).
  correlation_id UUID,
  -- Retry accounting for the retryable class (backoff bookkeeping).
  retry_count    INTEGER     NOT NULL DEFAULT 0,
  -- Server clocks (Principle X) — never client-supplied.
  quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when a server-mediated repair (§9) resolves the item; NULL while open.
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sale_sync_deadletters_classification_valid
    CHECK (classification IN ('retryable', 'needs-repair')),
  CONSTRAINT sale_sync_deadletters_reason_code_non_empty
    CHECK (length(btrim(reason_code)) > 0),
  CONSTRAINT sale_sync_deadletters_retry_count_non_negative
    CHECK (retry_count >= 0),
  -- Composite FK: the deadletter can never reference a sale in a different
  -- tenant/store (the 0012 child-table defense-in-depth beneath RLS). Targets
  -- the uq_sales_id_tenant_store key.
  CONSTRAINT fk_sale_sync_deadletters_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT
);

-- One OPEN deadletter per sale: a sale may re-fail after a repair, so the
-- uniqueness is over the OPEN rows only (resolved rows are retained for audit,
-- not deleted — never a silent drop). A plain UNIQUE (sale_id, resolved_at)
-- would NOT enforce this — Postgres treats NULLs as distinct, so multiple
-- (sale_id, NULL) open rows would coexist. A PARTIAL unique index on the open
-- rows is the correct enforcement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_sync_deadletters_open
  ON sale_sync_deadletters (sale_id) WHERE resolved_at IS NULL;

-- NEEDS_REPAIR queue read (§9): tenant+store scoped, newest-first, open only.
-- Partial index on the open needs-repair rows; UUIDv7 id keyset (ORDER BY id
-- DESC), so the cursor needs no extra column.
CREATE INDEX IF NOT EXISTS idx_sale_sync_deadletters_needs_repair_open
  ON sale_sync_deadletters (tenant_id, store_id, id DESC)
  WHERE classification = 'needs-repair' AND resolved_at IS NULL;

-- updated_at trigger — same pattern as every other table carrying updated_at.
CREATE TRIGGER sale_sync_deadletters_set_updated_at
  BEFORE UPDATE ON sale_sync_deadletters
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: tenant-scoped, ENABLE + FORCE (table-owner CI connection still goes
-- through policy). Empty-GUC CASE guard (0017–0021 / 0024 precedent): an unset
-- GUC maps to NULL => row filtered => fail-closed, never a 22P02 cast error.
ALTER TABLE sale_sync_deadletters ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_sync_deadletters FORCE  ROW LEVEL SECURITY;

CREATE POLICY sale_sync_deadletters_tenant_select ON sale_sync_deadletters
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY sale_sync_deadletters_tenant_insert ON sale_sync_deadletters
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- UPDATE supports the server-mediated repair resolve (resolved_at) + retry
-- accounting. NO DELETE policy — resolved rows are retained for audit.
CREATE POLICY sale_sync_deadletters_tenant_update ON sale_sync_deadletters
  FOR UPDATE
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

COMMIT;
