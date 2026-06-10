-- 0024_pairing_codes.sql
--
-- POS Terminal-Pairing CONSUME (027) — the `pairing_codes` store the
-- `posPairTerminal` consume reads (orchestrator dispatch Q-DP2-PAIRING-CONSUME).
--
-- Implements the CONSUME side of
--   packages/contracts/openapi/pos-terminal-pairing.openapi.yaml
-- ONLY. Issuance (admin minting a code) is OUT OF SCOPE and authors no contract;
-- a row is seeded directly for the pilot smoke through the authorized seed lane.
--
-- DATA-MODEL DECISION (see specs/027-.../data-model.md): INLINE SNAPSHOT COLUMNS,
-- not FK projection. The 200 TerminalPairResponse needs a source at consume time
-- for terminal_label, branch_name, branch_address, tenant_tax_registration_id and
-- the three printer fields. The live schema (0000_initial) has NO column for any
-- of these (tenants lacks tax_registration_id; stores lacks address; no printer
-- table; no terminal_label). FK-projecting them is impossible without adding
-- columns to tenants/stores + a printer table — a multi-table, multi-migration
-- expansion (a stop condition). The contract itself describes these as values the
-- terminal PINS at pair-time and never re-fetches, so the issuer snapshots them
-- onto the code row. tenant_id + store_id ARE real FKs (the RLS axis + the device
-- scope). The minted device_token is NEVER stored here — only its hash lands in
-- devices.token_hash (the existing PosDeviceAuthGuard credential path). The
-- pairing_code is stored HASHED (code_hash), never plaintext (FR-006).
--
-- RLS: ENABLE + FORCE; tenant policies keyed on current_setting('app.current_tenant',
-- true) with the empty-GUC CASE guard (the 0017–0021 precedent: a bare ::uuid cast
-- throws 22P02 on an unset GUC). SELECT + INSERT + UPDATE (pending -> used is an
-- UPDATE; attempt accounting is an UPDATE). NO DELETE policy — spent codes are
-- retained for audit, not deleted.
--
-- DATA-LIFECYCLE CLASSIFICATION (§XIV): BUSINESS-class. code_hash is a hash, not a
-- recoverable secret. No money/amount, no PII (branch/tenant display + tax-reg id
-- are operator-facing business detail, not personal data), no plaintext secret.
-- The device_token (SECRET) is never on this table.
--
-- Reversibility: 0024_pairing_codes.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS pairing_codes (
  id                          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID         NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  -- store_id is FK'd via the COMPOSITE (tenant_id, store_id) -> stores(tenant_id, id)
  -- (the stores_tenant_id_uk key), NOT bare stores(id): this REJECTS at insert any
  -- row whose store belongs to a different tenant than tenant_id, so consume can
  -- never mint a devices row with a cross-tenant (tenant_id, store_id) scope.
  store_id                    UUID         NOT NULL,
  -- The one-time pairing code, SHA-256 hashed (hashToken). UNIQUE = single index
  -- probe at consume; never plaintext.
  code_hash                   BYTEA        NOT NULL UNIQUE,
  -- The stable terminal identity returned + persisted. Survives re-pair under the
  -- same branch (re-pair returns ALREADY_PAIRED, not a fresh token). Also used as
  -- the devices.id on the success burn so the device principal's store scope
  -- equals the paired branch.
  terminal_id                 UUID         NOT NULL DEFAULT gen_random_uuid(),
  -- Inline snapshot fields the issuer pins (the contract's pinned-at-pair-time
  -- terminal-resident copies). All non-empty; printer ids match the contract hex
  -- pattern; com_port nullable (USB-only printers send NULL).
  terminal_label              TEXT         NOT NULL,
  branch_name                 TEXT         NOT NULL,
  branch_address              TEXT         NOT NULL,
  tenant_tax_registration_id  TEXT         NOT NULL,
  printer_vendor_id           TEXT         NOT NULL,
  printer_product_id          TEXT         NOT NULL,
  printer_com_port            TEXT,
  -- Lifecycle.
  status                      TEXT         NOT NULL DEFAULT 'pending',
  expires_at                  TIMESTAMPTZ  NOT NULL,
  -- Per-code attempt accounting -> 429 RATE_LIMITED (FR-008). Per-IP limiting is
  -- the edge proxy's job (contract narrative); not re-implemented in the app.
  attempt_count               INTEGER      NOT NULL DEFAULT 0,
  last_attempt_at             TIMESTAMPTZ,
  -- The device minted on the success that burned this code (audit trail; NULL
  -- while pending). Deliberately NOT a FK to devices(id): a later-migration table
  -- must not pin the droppability of devices (0001) — an FK here breaks 0001's
  -- isolated down-migration test (`cannot drop table devices`). The value equals
  -- the minted devices.id (== terminal_id); the audit link is preserved without
  -- the cross-migration dependency.
  device_id                   UUID,
  used_at                     TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT pairing_codes_terminal_label_non_empty
    CHECK (length(btrim(terminal_label)) > 0 AND length(terminal_label) <= 64),
  CONSTRAINT pairing_codes_branch_name_non_empty
    CHECK (length(btrim(branch_name)) > 0),
  CONSTRAINT pairing_codes_branch_address_non_empty
    CHECK (length(btrim(branch_address)) > 0),
  CONSTRAINT pairing_codes_tax_reg_non_empty
    CHECK (length(btrim(tenant_tax_registration_id)) > 0),
  CONSTRAINT pairing_codes_printer_vendor_id_hex
    CHECK (printer_vendor_id ~ '^0x[0-9A-Fa-f]{4}$'),
  CONSTRAINT pairing_codes_printer_product_id_hex
    CHECK (printer_product_id ~ '^0x[0-9A-Fa-f]{4}$'),
  CONSTRAINT pairing_codes_printer_com_port_non_empty
    CHECK (printer_com_port IS NULL OR length(btrim(printer_com_port)) > 0),
  CONSTRAINT pairing_codes_status_valid
    CHECK (status IN ('pending', 'used', 'cancelled')),
  CONSTRAINT pairing_codes_attempt_count_non_negative
    CHECK (attempt_count >= 0),
  -- Composite FK: the store MUST belong to tenant_id (rejects cross-tenant scope
  -- at insert). Targets the stores_tenant_id_uk (tenant_id, id) unique key.
  CONSTRAINT pairing_codes_store_tenant_fk FOREIGN KEY (tenant_id, store_id)
    REFERENCES stores (tenant_id, id) ON DELETE RESTRICT
);

-- Pending-code lookup acceleration (the consume probes by code_hash, already
-- UNIQUE; this index supports tenant-scoped admin listing of live codes).
CREATE INDEX IF NOT EXISTS pairing_codes_tenant_pending_idx
  ON pairing_codes (tenant_id, store_id) WHERE status = 'pending';

-- updated_at trigger — same pattern as every other table carrying updated_at.
CREATE TRIGGER pairing_codes_set_updated_at BEFORE UPDATE ON pairing_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- RLS: tenant-scoped, ENABLE + FORCE (so the table-owner CI connection still goes
-- through policy). Empty-GUC CASE guard (0017–0021 precedent): an unset GUC maps
-- to NULL => row filtered => fail-closed, never a 22P02 cast error.
ALTER TABLE pairing_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pairing_codes FORCE  ROW LEVEL SECURITY;

CREATE POLICY pairing_codes_tenant_select ON pairing_codes
  FOR SELECT
  USING (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

CREATE POLICY pairing_codes_tenant_insert ON pairing_codes
  FOR INSERT
  WITH CHECK (tenant_id = CASE
      WHEN current_setting('app.current_tenant', true) = '' THEN NULL
      ELSE current_setting('app.current_tenant', true)::uuid
    END);

-- UPDATE supports the pending -> used burn + the attempt-count accounting. NO
-- DELETE policy — spent codes are retained.
CREATE POLICY pairing_codes_tenant_update ON pairing_codes
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
