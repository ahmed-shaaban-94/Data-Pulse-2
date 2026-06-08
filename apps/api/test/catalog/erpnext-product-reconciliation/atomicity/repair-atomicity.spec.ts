/**
 * 021-US2 atomicity (T023) — a repair that fails to write `audit_events` rolls
 * back BOTH the `repair_attempt` AND the 013 mapping transition (FR-015).
 * Docker-gated (WSL Testcontainers).
 *
 * Induces the mid-transaction failure via a DB TRIGGER on `audit_events` (the
 * documented 018 gotcha: named-export jest spies aren't redefinable, so the
 * failure must come from the database, not a mock). The trigger raises on an
 * INSERT carrying the 021 repair action; because the 013 confirm + the
 * `repair_attempt` insert + the audit insert all run on ONE tenant-scoped client
 * inside `runWithTenantContext`, the audit failure aborts the whole transaction.
 *
 * Asserts (after the repair throws):
 *   - the 013 mapping is STILL `suggested` (the transition rolled back);
 *   - NO `repair_attempt` row was persisted;
 *   - NO `audit_events` row was persisted.
 */
import "reflect-metadata";

import { runWithTenantContext } from "@data-pulse-2/db";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ErpnextItemMapService } from "../../../../src/catalog/erpnext-item-map/erpnext-item-map.service";
import { ErpnextProductReconciliationService } from "../../../../src/catalog/erpnext-product-reconciliation/erpnext-product-reconciliation.service";
import {
  ITEM_MAP_FIXTURE_IDS,
  seedItemMapFixture,
} from "../../erpnext-item-map/__support__/seed-item-map";

const TENANT_A = ITEM_MAP_FIXTURE_IDS.tenantA;
const ACTOR_A = ITEM_MAP_FIXTURE_IDS.actorA;
// A dedicated ACTIVE product + suggested-only mapping (the 013 fixture's
// productASuggested is a RETIRED product, excluded from the active backlog).
const PRODUCT_A_SUGGESTED = "0a000000-0000-7000-8000-00000d021a41";
const MAP_A_SUGGESTED = "0a000000-0000-7000-8000-00000d021a42";

let env: PgTestEnv | null = null;
let skip = false;
let svc: ErpnextProductReconciliationService;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[021 atomicity.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  await seedItemMapFixture(env);
  await env.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'recon021-atom@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR_A],
  );
  await env.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, '021 Atom Suggested', 'standard', $3, $3) ON CONFLICT DO NOTHING`,
    [PRODUCT_A_SUGGESTED, TENANT_A, ACTOR_A],
  );
  await env.admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, suggested_by, version)
     VALUES ($1, $2, $3, 'ERP-021-ATOM', 'suggested', 'manual', $4, 1)
     ON CONFLICT DO NOTHING`,
    [MAP_A_SUGGESTED, TENANT_A, PRODUCT_A_SUGGESTED, ACTOR_A],
  );
  // A trigger that aborts any audit_events INSERT for the 021 repair action —
  // the mid-transaction failure the atomicity test needs (DB-side, not a mock).
  await env.admin.query(`
    CREATE OR REPLACE FUNCTION fail_021_audit() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = 'erpnext_product_reconciliation.repaired' THEN
        RAISE EXCEPTION 'induced audit failure (021 atomicity test)';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER trg_fail_021_audit
      BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION fail_021_audit();
  `);
  svc = new ErpnextProductReconciliationService(
    env.app,
    new ErpnextItemMapService(env.app),
  );
}, 180_000);

afterAll(async () => {
  if (env) {
    await env.admin.query(`DROP TRIGGER IF EXISTS trg_fail_021_audit ON audit_events`);
    await env.admin.query(`DROP FUNCTION IF EXISTS fail_021_audit()`);
    await stopPgEnv(env);
  }
}, 60_000);

describe("021-US2 atomicity (T023) — audit failure rolls back the whole repair", () => {
  it("a repair whose audit_events insert fails leaves the 013 mapping + repair_attempt unchanged", async () => {
    if (skip) return;

    const before = await runWithTenantContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        const r = await client.query<{ state: string; version: number }>(
          `SELECT state, version FROM erpnext_item_map WHERE id = $1`,
          [MAP_A_SUGGESTED],
        );
        return r.rows[0]!;
      },
    );
    expect(before.state).toBe("suggested");

    await expect(
      svc.repairBacklogItem({
        tenantId: TENANT_A,
        actorUserId: ACTOR_A,
        repairKind: "confirm",
        tenantProductId: PRODUCT_A_SUGGESTED,
        mappingId: MAP_A_SUGGESTED,
        version: before.version,
      }),
    ).rejects.toThrow(/induced audit failure/);

    // The 013 transition rolled back — still suggested at the same version.
    const after = await env!.admin.query<{ state: string; version: number }>(
      `SELECT state, version FROM erpnext_item_map WHERE id = $1`,
      [MAP_A_SUGGESTED],
    );
    expect(after.rows[0]!.state).toBe("suggested");
    expect(after.rows[0]!.version).toBe(before.version);

    // No repair_attempt + no audit row were persisted.
    const attempts = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_product_reconciliation_repair_attempt
        WHERE tenant_id=$1 AND target_ref_id=$2`,
      [TENANT_A, PRODUCT_A_SUGGESTED],
    );
    expect(attempts.rows[0]!.count).toBe("0");
    const audit = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE tenant_id=$1 AND action='erpnext_product_reconciliation.repaired'`,
      [TENANT_A],
    );
    expect(audit.rows[0]!.count).toBe("0");
  });
});
