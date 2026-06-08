/**
 * 021-US3 — `ProductReconciliationRunProcessor` integration (T030/T031/T032).
 * Docker-gated (WSL Testcontainers).
 *
 * Reuses the api-side 013 `seedItemMapFixture` (catalog ⊕ erpnext_item_map) so the
 * processor compares a real confirmed mapping set against a recorded/stub ERPNext
 * item view:
 *   - stub-tolerance (FR-007): an UNAVAILABLE view → run completes,
 *     erpnext_view_status='unavailable', DP2-side classes only, NO fabricated
 *     unmapped_erpnext_item;
 *   - a recorded AVAILABLE view with one extra + one disabled item →
 *     match / unmapped_erpnext_item / sellable_state_divergence persisted;
 *   - the 013 mapping is unchanged by the run (read + report only, FR-014);
 *   - idempotent re-run (the guarded terminal write → status:'skipped').
 */
import "reflect-metadata";

import { runWithTenantContext } from "@data-pulse-2/db";
import { newId } from "@data-pulse-2/shared";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../api/test/_helpers/postgres-container";
import {
  ITEM_MAP_FIXTURE_IDS,
  seedItemMapFixture,
} from "../../../api/test/catalog/erpnext-item-map/__support__/seed-item-map";
import { ProductReconciliationRunProcessor } from "../../src/erpnext-product-reconciliation/product-reconciliation-run.processor";
import { recordedItemView } from "../../src/erpnext-product-reconciliation/erpnext-item-view.port";

const TENANT_A = ITEM_MAP_FIXTURE_IDS.tenantA;
const ACTOR_A = ITEM_MAP_FIXTURE_IDS.actorA;
const PRODUCT_A_CONFIRMED = ITEM_MAP_FIXTURE_IDS.productAConfirmed;
// The confirmed mapping's ERPNext item ref (from seed-item-map).
const CONFIRMED_ITEM_REF = "ERP-ITEM-A-001";

let env: PgTestEnv | null = null;
let skip = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[021 run.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
  await applyAllUpAndCreateAppRole(env);
  await seedItemMapFixture(env);
  // run.actor_user_id FKs to users(id); the catalog fixture's ACTOR_A is a plain
  // uuid created_by, not a users row — seed it (the seed-reconciliation precedent).
  await env.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'recon021-run@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR_A],
  );
  // An ACTIVE product with NO confirmed mapping → a DP2-side backlog class the run
  // reports even when the connector view is unavailable (the 013 fixture's only
  // active product is confirmed-mapped; PRODUCT_A_RETIRED is retired/excluded).
  await env.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
     VALUES ($1, $2, '021 Run Unmapped', 'standard', $3, $3) ON CONFLICT DO NOTHING`,
    ["0a000000-0000-7000-8000-00000d021e01", TENANT_A, ACTOR_A],
  );
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

async function newRunningRun(): Promise<string> {
  const runId = newId();
  await runWithTenantContext(
    env!.app,
    { tenantId: TENANT_A, isPlatformAdmin: false },
    async (client) => {
      await client.query(
        `INSERT INTO erpnext_product_reconciliation_run
           (id, tenant_id, trigger, status, erpnext_view_status, actor_user_id)
         VALUES ($1, $2, 'on_demand', 'running', 'unavailable', $3)`,
        [runId, TENANT_A, ACTOR_A],
      );
    },
  );
  return runId;
}

async function runStatus(runId: string): Promise<{ status: string; view: string }> {
  const r = await env!.admin.query<{ status: string; erpnext_view_status: string }>(
    `SELECT status, erpnext_view_status FROM erpnext_product_reconciliation_run WHERE id=$1`,
    [runId],
  );
  return { status: r.rows[0]!.status, view: r.rows[0]!.erpnext_view_status };
}

async function resultClasses(runId: string): Promise<Record<string, number>> {
  const r = await env!.admin.query<{ mismatch_class: string; n: string }>(
    `SELECT mismatch_class, count(*)::text AS n
       FROM erpnext_product_reconciliation_result WHERE run_id=$1
      GROUP BY mismatch_class`,
    [runId],
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.mismatch_class] = Number(row.n);
  return out;
}

describe("021-US3 — run processor stub-tolerance (FR-007)", () => {
  it("an UNAVAILABLE view completes the run with DP2-side classes only, NO fabricated unmapped_erpnext_item", async () => {
    if (skip) return;
    const runId = await newRunningRun();
    const proc = new ProductReconciliationRunProcessor(env!.app); // EMPTY stub
    const res = await proc.process({ runId, tenantId: TENANT_A });
    expect(res.status).toBe("completed");
    expect(res.erpnextViewStatus).toBe("unavailable");

    const st = await runStatus(runId);
    expect(st.status).toBe("completed");
    expect(st.view).toBe("unavailable");

    const classes = await resultClasses(runId);
    // DP2-side backlog classes present; NO ERPNext-side fabrication.
    expect(classes["unmapped_erpnext_item"]).toBeUndefined();
    expect(classes["match"]).toBeUndefined();
    expect(
      (classes["unmapped_dp2_product"] ?? 0) + (classes["suggestion_unconfirmed"] ?? 0),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe("021-US3 — run processor against a recorded AVAILABLE view", () => {
  it("classifies match / unmapped_erpnext_item / sellable_state_divergence; 013 unchanged", async () => {
    if (skip) return;
    const before = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_item_map WHERE tenant_id=$1`,
      [TENANT_A],
    );

    const runId = await newRunningRun();
    const view = recordedItemView({
      status: "available",
      items: [
        { erpnextItemRef: CONFIRMED_ITEM_REF, sellable: true }, // → match
        { erpnextItemRef: "ERP-EXTRA-ONLY", sellable: true }, // → unmapped_erpnext_item
      ],
    });
    const proc = new ProductReconciliationRunProcessor(env!.app, view);
    const res = await proc.process({ runId, tenantId: TENANT_A });
    expect(res.status).toBe("completed");
    expect(res.erpnextViewStatus).toBe("available");

    const classes = await resultClasses(runId);
    expect(classes["match"]).toBeGreaterThanOrEqual(1);
    expect(classes["unmapped_erpnext_item"]).toBeGreaterThanOrEqual(1);

    // 013 mapping unchanged by the run (read + report only).
    const after = await env!.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM erpnext_item_map WHERE tenant_id=$1`,
      [TENANT_A],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it("a disabled ERPNext item is sellable_state_divergence — NOT silently flipped (OQ-5)", async () => {
    if (skip) return;
    const runId = await newRunningRun();
    const view = recordedItemView({
      status: "available",
      items: [{ erpnextItemRef: CONFIRMED_ITEM_REF, sellable: false }],
    });
    const proc = new ProductReconciliationRunProcessor(env!.app, view);
    await proc.process({ runId, tenantId: TENANT_A });
    const classes = await resultClasses(runId);
    expect(classes["sellable_state_divergence"]).toBeGreaterThanOrEqual(1);
    // The DP2 mapping for PRODUCT_A_CONFIRMED is untouched (still confirmed-active).
    const m = await env!.admin.query<{ state: string }>(
      `SELECT state FROM erpnext_item_map
        WHERE tenant_id=$1 AND tenant_product_id=$2 AND retired_at IS NULL`,
      [TENANT_A, PRODUCT_A_CONFIRMED],
    );
    expect(m.rows[0]?.state).toBe("confirmed");
  });

  it("a re-run is an idempotent no-op (guarded terminal write → skipped)", async () => {
    if (skip) return;
    const runId = await newRunningRun();
    const proc = new ProductReconciliationRunProcessor(env!.app); // EMPTY
    const first = await proc.process({ runId, tenantId: TENANT_A });
    expect(first.status).toBe("completed");
    const second = await proc.process({ runId, tenantId: TENANT_A });
    expect(second.status).toBe("skipped");
  });
});
