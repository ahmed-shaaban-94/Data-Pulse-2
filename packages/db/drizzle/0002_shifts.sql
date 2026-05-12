-- Wave 4.1a: shifts table for POS terminal shift lifecycle tracking.
-- Populated by the audit-event ingestion path (B2) when action_category = 'shift.open'.
-- Wave 4.1b will add lifecycle_state transitions and the stuck-shift query endpoint.

BEGIN;

CREATE TABLE IF NOT EXISTS shifts (
  shift_id                  UUID        PRIMARY KEY,
  tenant_id                 UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id                  UUID        NOT NULL REFERENCES stores(id)  ON DELETE CASCADE,
  opening_cashier_user_id   UUID        NOT NULL REFERENCES users(id)   ON DELETE RESTRICT,
  opening_device_id         UUID        NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
  opened_at                 TIMESTAMPTZ NOT NULL,
  lifecycle_state           TEXT        NOT NULL DEFAULT 'open'
                              CHECK (lifecycle_state IN ('open', 'closed', 'closed_forced')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER shifts_set_updated_at
  BEFORE UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS shifts_tenant_store_state_idx
  ON shifts (tenant_id, store_id, lifecycle_state);

ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE shifts FORCE ROW LEVEL SECURITY;

CREATE POLICY shifts_tenant_isolation ON shifts
  USING (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  )
  WITH CHECK (
    tenant_id = current_setting('app.current_tenant', true)::uuid
    OR current_setting('app.is_platform_admin', true) = 'true'
  );

COMMIT;
