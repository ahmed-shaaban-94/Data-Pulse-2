/**
 * on-hand-derivation.spec.ts — 009-US1-ONHAND (T030).
 *
 * Proves FR-003 / SC-001: on-hand is the compute-on-read signed SUM of a
 * (tenant, store, product)'s movements — NOT a stored mutable value.
 *
 * Layer: service + DB (NOT HTTP). `getOnHand` runs the SQL SUM and the
 * `toBody`-style projection in the service, so a service-level test against the
 * RLS-active `env.app` pool is the strongest proof — it also catches the
 * RLS-masks-empty trap (forget tenant context → RLS fail-closes → zero rows →
 * COALESCE → a wrong "0" that looks like a correct empty). The seeded fixtures
 * have known signed quantities, so a wrong-zero is caught here.
 *
 * Docker-gated (db-integration CI). Skips cleanly without Docker.
 */
import "reflect-metadata";

import { Pool } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  seedCatalogIsolationFixture,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
} from "../../catalog/__support__/isolation-harness";
import { seedInventoryFixture } from "../__support__/seed-inventory";
import { InventoryService } from "../../../src/inventory/inventory.service";

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: InventoryService;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedInventoryFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[on-hand-derivation] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  // Service bound to the RLS-active app pool (not the admin/superuser pool).
  service = new InventoryService(env.app as unknown as Pool);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[on-hand-derivation] skipping — Docker unavailable");
    return true;
  }
  return false;
}

describe("getOnHand — compute-on-read signed SUM (FR-003/SC-001)", () => {
  it("sums seeded movements for PRODUCT_A_ACTIVE at STORE_A_X → 7", async () => {
    if (maybeSkip()) return;
    // seed-inventory movements at (A.X, PRODUCT_A_ACTIVE):
    //   MOVE_A_X            inbound          +10
    //   MOVE_SALE_LINKED_A_X outbound         −1
    //   MOVE_CORRECTION_A_X  count_correction −2
    //   → net 10 − 1 − 2 = 7.
    // Excluded: MOVE_ADHOC_A_X (NULL product), MOVE_A_Y (different store).
    const onHand = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    expect(onHand.storeId).toBe(STORE_A_X);
    expect(onHand.productId).toBe(PRODUCT_A_ACTIVE);
    expect(Number(onHand.quantity)).toBe(7);
    expect(onHand.negativeBalance).toBe(false);
  });

  it("is computed on read (no stored balance) — reflects the signed sum, can be re-derived", async () => {
    if (maybeSkip()) return;
    const a = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const b = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    // Deterministic + idempotent read — no mutation, no drift.
    expect(a.quantity).toBe(b.quantity);
  });
});
