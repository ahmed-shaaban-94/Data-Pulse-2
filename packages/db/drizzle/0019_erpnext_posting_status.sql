-- 0019_erpnext_posting_status.sql
--
-- POS Sale Posting to ERPNext (015) — [GATED] schema + migration (015-SCHEMA / T012).
--
-- Source-of-truth artifacts:
--   - specs/015-pos-sale-posting-to-erpnext/data-model.md  §5 (entity + lifecycle), §2 (the new-table decision), §4 (015-RESOLVE)
--   - specs/015-pos-sale-posting-to-erpnext/plan.md         (Constitution Check; the §IX posting split)
--   - packages/db/src/schema/catalog/erpnext-posting-status.ts
--   - packages/db/__tests__/migration/0019-erpnext-posting-status.spec.ts            (round-trip, Docker-gated)
--   - apps/api/test/catalog/erpnext-posting/schema/erpnext-posting-status-schema-shape.spec.ts (Docker-free shape test)
--
-- Creates ONE table: `erpnext_posting_status` — per DP2 sale (kind='sale_post')
-- or per void/refund terminal event (kind='reversal'), the state of its ERPNext
-- posting: pending -> posted / failed_transient / permanently_rejected, plus the
-- ERPNext document reference (document_ref) for O-3 idempotency. The 008 sale
-- fact is NEVER mutated by a posting outcome (012 contract, §IX) — only this
-- status row is. The posting WORK-ITEM the connector pulls (012 feed) is a
-- read-projection over (this table ⊕ the 008 sale fact ⊕ 013 erpnext_item_map ⊕
-- 014 erpnext_warehouse_map) — NOT a stored wire row (data-model §3).
--
-- WHY a new table (NOT derive-on-read; 015-SIGNOFF-STATE, owner-authorized):
--   an externally-assigned ERPNext document_ref + the posting status cannot be
--   derived from existing tables, so O-3 (exactly-one document per sale across
--   retries) is unenforceable without persisted state. 010's read-down feed set
--   the precedent (a [GATED] change-log table; the app/outbox-mirror was rejected)
--   for a WEAKER need. (data-model §2)
--
-- source_ref_id: the ORIGINATING row — sales.id (sale_post) OR sale_voids.id /
--   sale_refunds.id (reversal). DELIBERATELY NO FK: it is POLYMORPHIC across three
--   tables (a single-table FK would make every reversal row fail to insert).
--   Mirrors the 014 erpnext_warehouse_ref / 013 erpnext_item_ref / 003
--   source_global_product_id no-FK rationale (don't couple to a target a single FK
--   cannot express). sale_id (the parent sale, present for BOTH kinds) DOES FK,
--   composite (sale_id, tenant_id, store_id) -> sales' uq_sales_id_tenant_store
--   (the 008 child-table FK pattern).
--
-- O-3 idempotency UNIQUE (tenant_id, source_ref_id): keyed on the originating
--   row's COLLISION-PROOF UUIDv7 PK, NOT on (source_system, external_id). 008
--   capture takes the terminal event's external_id from the REQUEST BODY with no
--   cross-table guarantee it differs from the parent sale's external_id — so a
--   (source_system, external_id) key could collide a reversal with its sale_post
--   and permanently block the 2nd posting (the REVERSAL-CARDINALITY trap; data-model
--   §5). Keying on source_ref_id is kind-agnostic and collision-proof: every sale,
--   void, and refund is a distinct PK, so multiple partial refunds of one sale each
--   get their own posting row.
--
-- sequence: a single global IDENTITY (monotonic) — the feed CURSOR / ordering
--   source the 012 connectorPullPostings cursor advances over (mirrors the 010
--   read-down change-log sequence). The pull feed orders by sequence; re-pulling
--   the same `since` yields the same logical set.
--
-- Mutable tenant-owned resource: pending -> posted/failed_transient/
--   permanently_rejected, and document_ref/rejection_category/retry_count are set
--   by the connectorAckOutcome ack — so SELECT + INSERT + UPDATE RLS policies
--   (mirrors the 0017/0018 mutable-table pattern). NO DELETE policy — a dead-letter
--   is a status, not a row removal.
--
-- NO money/amount column: amounts live on the 008 sale fact (sales/sale_lines) +
--   are projected into the work-item at read time. This table tracks posting STATE
--   only (data-model §5).
--
-- RLS: ENABLE + FORCE; tenant policies keyed on
--   current_setting('app.current_tenant', true) with the empty-GUC CASE guard
--   (a bare ::uuid cast throws 22P02 on an unset GUC — repo-wide fix from 0009/0010,
--   also used by 0017/0018). NULL tenant => row filtered => fail-closed.
--
-- ---------------------------------------------------------------------------
-- DATA-LIFECYCLE CLASSIFICATION + RETENTION (§XIV)
-- ---------------------------------------------------------------------------
-- BUSINESS-CLASS data: sale/store/originating-row references, provenance
-- (source_system, external_id, payload_hash), posting status, ERPNext document
-- reference (document_ref), rejection_category, retry_count, correlation id. NO
-- PII, NO payment/tender data, NO money/amount. Retention inherits the 001
-- long-horizon posture; a dead-lettered row is retained (status, not deleted) for
-- the 017 reconciliation/repair surface. If a later slice admits a PII or tender
-- field, this RECLASSIFIES and re-triggers the §XIV review.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TABLE IF NOT EXISTS erpnext_posting_status (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  store_id           UUID         NOT NULL REFERENCES stores(id)  ON DELETE RESTRICT,
  -- The parent sale (present for BOTH sale_post and reversal). Composite FK to
  -- sales' (id, tenant_id, store_id) unique — the 008 child-table FK pattern.
  sale_id            UUID         NOT NULL,
  kind               TEXT         NOT NULL,
  -- The ORIGINATING row id — sales.id | sale_voids.id | sale_refunds.id.
  -- POLYMORPHIC: deliberately NO FK (see header). The O-3 idempotency anchor.
  source_ref_id      UUID         NOT NULL,
  -- Provenance (mirrors 008) — the originating row's OWN pair. Carried for
  -- correlation, NOT the O-3 key (see header / data-model §5).
  source_system      TEXT         NOT NULL,
  external_id        TEXT         NOT NULL,
  payload_hash       CHAR(64)     NOT NULL,
  -- Posting lifecycle. pending on projection; the ack moves it.
  status             TEXT         NOT NULL DEFAULT 'pending',
  -- The ERPNext document id — set on a `posted` ack (powers O-3 replay). NULL until then.
  document_ref       TEXT,
  -- Nearest 012 RejectionReason.category on a `permanently_rejected` ack. NULL otherwise.
  rejection_category TEXT,
  retry_count        INTEGER      NOT NULL DEFAULT 0,
  -- Feed cursor / ordering source (single global monotonic; 010 precedent).
  sequence           BIGINT       GENERATED ALWAYS AS IDENTITY,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id     UUID,
  CONSTRAINT erpnext_posting_status_kind_valid
    CHECK (kind IN ('sale_post', 'reversal')),
  CONSTRAINT erpnext_posting_status_status_valid
    CHECK (status IN ('pending', 'posted', 'failed_transient', 'permanently_rejected')),
  CONSTRAINT erpnext_posting_status_payload_hash_format
    CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT erpnext_posting_status_retry_count_non_negative
    CHECK (retry_count >= 0),
  -- A posted row MUST carry the ERPNext document_ref (O-3); a non-posted row leaves it NULL.
  CONSTRAINT erpnext_posting_status_document_ref_when_posted
    CHECK ((status = 'posted') = (document_ref IS NOT NULL)),
  -- Composite FK to the parent sale (the 008 child-table pattern).
  CONSTRAINT fk_erpnext_posting_status_sale_tenant_store
    FOREIGN KEY (sale_id, tenant_id, store_id)
    REFERENCES sales (id, tenant_id, store_id) ON DELETE RESTRICT
);

-- O-3 idempotency: exactly one posting target per ORIGINATING row (collision-proof
-- UUIDv7 PK). Permits multiple reversals per sale (each terminal event a distinct
-- source_ref_id) while rejecting a duplicate post of the same row. (data-model §5)
CREATE UNIQUE INDEX IF NOT EXISTS "UQ_idx_erpnext_posting_status_source_ref"
  ON erpnext_posting_status (tenant_id, source_ref_id);

-- Pending-feed scan: the connector pulls pending rows ordered by the feed cursor.
CREATE INDEX IF NOT EXISTS idx_erpnext_posting_status_pending
  ON erpnext_posting_status (tenant_id, sequence)
  WHERE status = 'pending';

-- Provenance / reconciliation lookup (017): find a posting by its source pair.
CREATE INDEX IF NOT EXISTS idx_erpnext_posting_status_provenance
  ON erpnext_posting_status (tenant_id, source_system, external_id);

ALTER TABLE erpnext_posting_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE erpnext_posting_status FORCE ROW LEVEL SECURITY;

CREATE POLICY erpnext_posting_status_tenant_read ON erpnext_posting_status
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY erpnext_posting_status_tenant_insert ON erpnext_posting_status
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- Mutable (the ack updates status / document_ref / rejection_category /
-- retry_count). UPDATE is tenant-scoped; column-level immutability of the
-- provenance/identity fields is enforced at the service boundary. NO DELETE policy.
CREATE POLICY erpnext_posting_status_tenant_update ON erpnext_posting_status
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
