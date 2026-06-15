-- 0027_settlement_receivables.sql
--
-- Spec 035 — Sale Settlement & Receivables Model. Authors the operational
-- settlement/receivables schema (G3, T020) behind the ratified G2 contract
-- `packages/contracts/openapi/settlement/settlement.yaml`. SLICE-AUTHORED under
-- Principle VIII; G3 (apply/rollback on a non-prod DB) is a HUMAN review gate.
--
-- AUTHORITY (035-DR-SETTLEMENT §OQ-7 = 7-C): DP-2 owns the OPERATIONAL receivable
-- + cash-application truth. ERPNext owns the accounting Payment Entry as a
-- VALUATION projection, referenced here only by a nullable external ref
-- (`receivable.erpnext_payment_entry_ref`). NO posting to ERPNext happens here
-- (connector-owned, gated by 011-DR-POSTING-R1).
--
-- CARVE (035-DR-SETTLEMENT §OQ-4): NON-REVERSAL surface only. `receivable.state`
-- CHECK = open|partially_applied|settled|claimed|flagged. NO `reversal_consumed`
-- state — reversal-compatibility lands in a later additive migration after
-- DP-026 closes. Void/refund/insurance-rejection REUSE DP-026 + Connector Arc A
-- + POS-014 (NG-1); nothing reversal-shaped is created here.
--
-- TAX-PENDING (035-DR-SETTLEMENT §OQ-2): tax carriers are placeholders only
-- (`tax_placeholder JSONB`); NO VAT allocation. G6 reopens later (ADR-0003).
--
-- DESIGN DECISIONS (the slice settles these DP-2-local forks; the G2 contract
-- left field/table shapes to G3):
--
--  1. MONEY = NUMERIC(19,4), exact-decimal (Principle III, no floats). The wire
--     carries money as a string; the column is exact NUMERIC.
--  2. STATE VOCAB = TEXT + CHECK (the 0024/0026 pattern), NOT a pg enum — a
--     future state (e.g. the deferred reversal_consumed) is a CHECK swap, not an
--     enum-migration dance.
--  3. RECEIVABLE ↔ SALE = many receivables per sale (one per payer; the contract
--     `SettlementIntentResult.receivables[]`). Composite FK to
--     sales(id, tenant_id, store_id) — a receivable can never attach to a sale in
--     another tenant/store (the 0012/0026 child-table defense beneath RLS). The
--     sale fact is NEVER mutated (FR-006).
--  4. PAYMENT_APPLICATION = child of `receivable` (contract apply-payment is
--     per-receivable, path receivableRef). FK receivable_id. Cross-receivable
--     payment is NOT in the v1 contract — deferred.
--  5. CLAIM ↔ RECEIVABLE = many-to-many via `claim_receivables` join (the
--     contract `ClaimCreate.receivableRefs[]`).
--  6. REMITTANCE + RECONCILIATION_RESULT = rows keyed to claim (FR-014 records
--     variance + audit), not folded into claim.
--  7. SETTLEMENT_INTENT = EPHEMERAL. The persisted outcome is receivables +
--     audit events; no `settlement_intent` table in v1 (the contract persists
--     receivables, not the raw intent).
--
-- ISOLATION (Principle II/XII): every table is tenant-scoped, RLS ENABLE+FORCE,
-- with the empty-GUC CASE guard (0017–0021 / 0024 / 0026 precedent): an unset
-- GUC maps to NULL => row filtered => fail-closed, never a 22P02 cast error.
-- Cross-tenant access is a safe-404 at the API (FR-022).
--
-- IDEMPOTENCY (Principle XI, FR-020): write idempotency is enforced by the
-- existing IdempotencyInterceptor (per-request key store); no per-table
-- idempotency column is added here. Optimistic concurrency uses a `version`
-- column on the mutable aggregates (receivable, payer_account) — the contract's
-- 409-on-stale-version (Principle III).
--
-- AUDIT (Principle XIII): every table carries created_at/updated_at; balance and
-- state transitions are auditable via the application audit trail (the audit
-- event surface, not a per-table history column in this slice).
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): BUSINESS-class. Payer identity is a
-- display name + opaque external ref (potential light PII — no national-id /
-- card / secret stored here). Money lives on receivable/payment/remittance. NO
-- plaintext secret, NO card data. Retention inherits the long-horizon fact
-- posture; PII discipline applies to payer_account.display_name.
--
-- GUARDS UPDATED IN LOCKSTEP (verified this slice):
--   - migrate.spec.ts EXPECTED_MIGRATIONS appended + down-test retargeted.
--   - No new outbox event type (event-types-registry.spec unchanged).
--   - No new metric/signal (cardinality.spec unchanged).
--   - TS schema mirrors added under packages/db/src/schema/settlement/.
--
-- Reversibility: 0027_settlement_receivables.down.sql.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. payer_account — who is responsible for settling a sale balance (FR-001/2/4)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payer_account (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- NULL store_id = tenant-wide payer; non-NULL = store-scoped.
  store_id      UUID         REFERENCES stores(id) ON DELETE RESTRICT,
  -- FR-002: credit_customer | corporate | insurer (extensible via CHECK swap).
  category      TEXT         NOT NULL,
  display_name  TEXT         NOT NULL,
  -- Provider-neutral external identity ref (e.g. insurer code). Opaque, no FK.
  external_ref  TEXT,
  status        TEXT         NOT NULL DEFAULT 'active',
  -- Tax-/terms placeholder (FR-004); shape deferred. Never tax math here.
  credit_terms  JSONB,
  -- Optimistic concurrency (Principle III): stale version on update => 409.
  version       INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT payer_account_category_valid
    CHECK (category IN ('credit_customer', 'corporate', 'insurer')),
  CONSTRAINT payer_account_status_valid
    CHECK (status IN ('active', 'suspended')),
  CONSTRAINT payer_account_display_name_non_empty
    CHECK (length(btrim(display_name)) > 0),
  CONSTRAINT payer_account_version_non_negative CHECK (version >= 0)
);

CREATE INDEX IF NOT EXISTS idx_payer_account_tenant_list
  ON payer_account (tenant_id, id DESC);

CREATE TRIGGER payer_account_set_updated_at
  BEFORE UPDATE ON payer_account
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. receivable — money owed against a sale by a payer (FR-005/6/7)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS receivable (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id      UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  sale_id       UUID         NOT NULL,
  payer_id      UUID         NOT NULL REFERENCES payer_account(id) ON DELETE RESTRICT,
  -- Money owed still outstanding (exact-decimal). Changes only via audited
  -- transitions (FR-007).
  outstanding_balance NUMERIC(19,4) NOT NULL,
  -- CARVE: NO reversal_consumed (deferred to post-DP-026 additive migration).
  state         TEXT         NOT NULL DEFAULT 'open',
  -- 7-C: nullable external ref to the ERPNext accounting Payment Entry
  -- (valuation projection ERPNext owns). NULL until the connector posting gate
  -- (011-DR-POSTING-R1) clears. DP-2 owns the operational record; this is a
  -- non-authoritative pointer.
  erpnext_payment_entry_ref TEXT,
  -- Tax-pending placeholder; NO VAT allocation in v1 (§OQ-2, FR-023).
  tax_placeholder JSONB,
  version       INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT receivable_state_valid
    CHECK (state IN ('open', 'partially_applied', 'settled', 'claimed', 'flagged')),
  CONSTRAINT receivable_balance_non_negative
    CHECK (outstanding_balance >= 0),
  CONSTRAINT receivable_version_non_negative CHECK (version >= 0),
  -- Composite-FK target key: child tables (payment_application, claim_receivables)
  -- reference (id, tenant_id, store_id), so that triple must be UNIQUE — the
  -- uq_sales_id_tenant_store precedent on `sales`. (id is already the PK; this
  -- adds the composite key the FKs match against.)
  CONSTRAINT uq_receivable_id_tenant_store UNIQUE (id, tenant_id, store_id),
  -- Composite FK: a receivable can never reference a sale in a different
  -- tenant/store (the 0012/0026 child-table defense beneath RLS).
  CONSTRAINT fk_receivable_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_receivable_tenant_store_list
  ON receivable (tenant_id, store_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_receivable_payer
  ON receivable (tenant_id, payer_id);
-- Open-receivable acceleration (queue / aging): partial index on non-terminal.
CREATE INDEX IF NOT EXISTS idx_receivable_open
  ON receivable (tenant_id, store_id, id DESC)
  WHERE state IN ('open', 'partially_applied', 'claimed');

CREATE TRIGGER receivable_set_updated_at
  BEFORE UPDATE ON receivable
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. payment_application — DP-2-owned cash application (7-C) (FR-011/12)
-- ---------------------------------------------------------------------------
-- Child of receivable (the contract apply-payment is per-receivable). Append-
-- only ledger of applications; the receivable's outstanding_balance is the
-- running aggregate.
CREATE TABLE IF NOT EXISTS payment_application (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id      UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  receivable_id UUID         NOT NULL,
  applied_amount NUMERIC(19,4) NOT NULL,
  -- Optional human note; redacted in the audit trail (§XIII/XIV).
  note          TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT payment_application_amount_positive CHECK (applied_amount > 0),
  -- Composite FK to receivable within the same tenant/store.
  CONSTRAINT fk_payment_application_receivable
    FOREIGN KEY (receivable_id, tenant_id, store_id)
    REFERENCES receivable (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_payment_application_receivable
  ON payment_application (tenant_id, receivable_id, id DESC);

-- ---------------------------------------------------------------------------
-- 4. claim — receivable(s) submitted to a third-party payer (FR-014)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id      UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  payer_id      UUID         NOT NULL REFERENCES payer_account(id) ON DELETE RESTRICT,
  status        TEXT         NOT NULL DEFAULT 'submitted',
  version       INTEGER      NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT claim_status_valid
    CHECK (status IN ('submitted', 'acknowledged', 'reconciled')),
  CONSTRAINT claim_version_non_negative CHECK (version >= 0),
  -- Composite-FK target key: child tables (claim_receivables, remittance,
  -- reconciliation_result) reference (id, tenant_id, store_id), so that triple
  -- must be UNIQUE (the uq_sales_id_tenant_store precedent).
  CONSTRAINT uq_claim_id_tenant_store UNIQUE (id, tenant_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_claim_tenant_store_list
  ON claim (tenant_id, store_id, id DESC);

CREATE TRIGGER claim_set_updated_at
  BEFORE UPDATE ON claim
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. claim_receivables — claim ↔ receivable join (FR-014)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claim_receivables (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id      UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  claim_id      UUID         NOT NULL,
  receivable_id UUID         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  -- A receivable appears at most once per claim.
  CONSTRAINT uq_claim_receivables UNIQUE (claim_id, receivable_id),
  CONSTRAINT fk_claim_receivables_claim
    FOREIGN KEY (claim_id, tenant_id, store_id)
    REFERENCES claim (id, tenant_id, store_id) ON DELETE RESTRICT,
  CONSTRAINT fk_claim_receivables_receivable
    FOREIGN KEY (receivable_id, tenant_id, store_id)
    REFERENCES receivable (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_claim_receivables_claim
  ON claim_receivables (tenant_id, claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_receivables_receivable
  ON claim_receivables (tenant_id, receivable_id);

-- ---------------------------------------------------------------------------
-- 6. remittance — amounts paid by a third-party payer against a claim (FR-014)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS remittance (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id        UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  claim_id        UUID         NOT NULL,
  remitted_amount NUMERIC(19,4) NOT NULL,
  -- Optional payer-side remittance advice reference; opaque.
  remittance_ref  TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT remittance_amount_non_negative CHECK (remitted_amount >= 0),
  CONSTRAINT fk_remittance_claim
    FOREIGN KEY (claim_id, tenant_id, store_id)
    REFERENCES claim (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_remittance_claim
  ON remittance (tenant_id, claim_id, id DESC);

-- ---------------------------------------------------------------------------
-- 7. reconciliation_result — matched/variance outcome of remittance vs claim
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reconciliation_result (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id        UUID         NOT NULL REFERENCES stores(id) ON DELETE RESTRICT,
  claim_id        UUID         NOT NULL,
  claimed_amount  NUMERIC(19,4) NOT NULL,
  remitted_amount NUMERIC(19,4) NOT NULL,
  -- claimed − remitted; recorded, never hidden (FR-014). May be negative.
  variance        NUMERIC(19,4) NOT NULL,
  outcome         TEXT         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT reconciliation_result_outcome_valid
    CHECK (outcome IN ('settled', 'partial', 'flagged')),
  CONSTRAINT fk_reconciliation_result_claim
    FOREIGN KEY (claim_id, tenant_id, store_id)
    REFERENCES claim (id, tenant_id, store_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_result_claim
  ON reconciliation_result (tenant_id, claim_id, id DESC);

-- ---------------------------------------------------------------------------
-- RLS — every table tenant-scoped, ENABLE + FORCE, empty-GUC CASE guard.
-- (0017–0021 / 0024 / 0026 precedent: unset GUC => NULL => fail-closed.)
-- SELECT + INSERT + UPDATE policies; NO DELETE (settlement rows are retained for
-- audit — never a silent drop, Principle V/XIII). The append-only ledgers
-- (payment_application, remittance, reconciliation_result, claim_receivables)
-- get SELECT + INSERT only.
-- ---------------------------------------------------------------------------

-- helper note: the empty-GUC guard is inlined per policy (no shared SQL fn in
-- this schema), matching the 0026 precedent.

-- payer_account: SELECT/INSERT/UPDATE
ALTER TABLE payer_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE payer_account FORCE  ROW LEVEL SECURITY;
CREATE POLICY payer_account_tenant_select ON payer_account
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY payer_account_tenant_insert ON payer_account
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY payer_account_tenant_update ON payer_account
  FOR UPDATE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- receivable: SELECT/INSERT/UPDATE
ALTER TABLE receivable ENABLE ROW LEVEL SECURITY;
ALTER TABLE receivable FORCE  ROW LEVEL SECURITY;
CREATE POLICY receivable_tenant_select ON receivable
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY receivable_tenant_insert ON receivable
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY receivable_tenant_update ON receivable
  FOR UPDATE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- payment_application: SELECT/INSERT (append-only ledger)
ALTER TABLE payment_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_application FORCE  ROW LEVEL SECURITY;
CREATE POLICY payment_application_tenant_select ON payment_application
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY payment_application_tenant_insert ON payment_application
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- claim: SELECT/INSERT/UPDATE
ALTER TABLE claim ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim FORCE  ROW LEVEL SECURITY;
CREATE POLICY claim_tenant_select ON claim
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY claim_tenant_insert ON claim
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY claim_tenant_update ON claim
  FOR UPDATE USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END)
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- claim_receivables: SELECT/INSERT (join, append-only)
ALTER TABLE claim_receivables ENABLE ROW LEVEL SECURITY;
ALTER TABLE claim_receivables FORCE  ROW LEVEL SECURITY;
CREATE POLICY claim_receivables_tenant_select ON claim_receivables
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY claim_receivables_tenant_insert ON claim_receivables
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- remittance: SELECT/INSERT (append-only)
ALTER TABLE remittance ENABLE ROW LEVEL SECURITY;
ALTER TABLE remittance FORCE  ROW LEVEL SECURITY;
CREATE POLICY remittance_tenant_select ON remittance
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY remittance_tenant_insert ON remittance
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

-- reconciliation_result: SELECT/INSERT (append-only)
ALTER TABLE reconciliation_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_result FORCE  ROW LEVEL SECURITY;
CREATE POLICY reconciliation_result_tenant_select ON reconciliation_result
  FOR SELECT USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);
CREATE POLICY reconciliation_result_tenant_insert ON reconciliation_result
  FOR INSERT WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid END);

COMMIT;
