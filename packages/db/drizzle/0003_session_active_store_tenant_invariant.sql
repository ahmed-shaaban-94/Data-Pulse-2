-- SESSION-ACTIVE-STORE-1: Enforce Invariant I-4 at the database layer.
--
-- I-4: If active_store_id IS NOT NULL AND active_tenant_id IS NOT NULL
--      then the store's tenant_id MUST equal active_tenant_id.
--
-- Why a trigger, not a composite FK
-- ----------------------------------
-- A composite FK (active_tenant_id, active_store_id) → stores(tenant_id, id)
-- with ON DELETE SET NULL would null BOTH columns when a store is deleted,
-- destroying the active_tenant_id alongside it. The independent single-column
-- FKs (active_tenant_id → tenants SET NULL, active_store_id → stores SET NULL)
-- preserve each field's lifetime separately. A BEFORE trigger enforces the
-- cross-column invariant without interfering with those cascades.

-- ── 1. Repair existing invalid pairs ────────────────────────────────────────
-- Clear only active_store_id when it points to a store owned by a different
-- tenant. active_tenant_id is preserved so the user stays in their tenant.
UPDATE sessions
SET    active_store_id = NULL
WHERE  active_store_id IS NOT NULL
  AND  active_tenant_id IS NOT NULL
  AND  NOT EXISTS (
         SELECT 1
         FROM   stores
         WHERE  stores.id        = sessions.active_store_id
           AND  stores.tenant_id = sessions.active_tenant_id
       );

-- ── 2. Trigger function ──────────────────────────────────────────────────────
-- Short-circuits (returns NEW immediately) when either column is NULL:
--   • active_store_id IS NULL  → no store set, invariant trivially holds
--   • active_tenant_id IS NULL → no tenant set; the existing CHECK constraint
--     `sessions_active_store_implies_tenant` already rejects that combination
-- Only performs the cross-table look-up when both are non-null.
CREATE OR REPLACE FUNCTION sessions_check_active_store_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.active_store_id IS NULL OR NEW.active_tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM   stores
    WHERE  stores.id        = NEW.active_store_id
      AND  stores.tenant_id = NEW.active_tenant_id
  ) THEN
    RAISE EXCEPTION
      'active_store_id % does not belong to active_tenant_id %',
      NEW.active_store_id, NEW.active_tenant_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- ── 3. Attach the trigger (idempotent) ──────────────────────────────────────
DROP TRIGGER IF EXISTS sessions_active_store_tenant_check ON sessions;

CREATE TRIGGER sessions_active_store_tenant_check
  BEFORE INSERT OR UPDATE ON sessions
  FOR EACH ROW
  EXECUTE FUNCTION sessions_check_active_store_tenant();
