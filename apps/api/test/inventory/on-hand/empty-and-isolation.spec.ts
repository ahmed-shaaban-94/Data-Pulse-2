/**
 * empty-and-isolation.spec.ts — 009-US1-ONHAND (T031).
 *
 * FR-005: an empty (never-stocked) key returns a deterministic "0", never an
 * error. (COALESCE(SUM(quantity), 0) — zero rows → NULL → "0".)
 * US1 scenario 4: movements at one store do not affect another store's on-hand.
 *
 * Layer: service + DB against the RLS-active env.app pool. Docker-gated.
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
  STORE_A_Y,
  TENANT_A,
} from "../../catalog/__support__/isolation-harness";
import { seedInventoryFixture } from "../__support__/seed-inventory";
import { InventoryService } from "../../../src/inventory/inventory.service";

// A product UUID never seeded for any movement.
const NEVER_STOCKED_PRODUCT = "0a000000-0000-7000-8000-00005704dead";

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
      console.warn(`\n[empty-and-isolation] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  service = new InventoryService(env.app as unknown as Pool);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[empty-and-isolation] skipping — Docker unavailable");
    return true;
  }
  return false;
}

describe("getOnHand — empty key (FR-005)", () => {
  it("a never-stocked product returns a deterministic '0', not an error", async () => {
    if (maybeSkip()) return;
    const onHand = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: NEVER_STOCKED_PRODUCT,
    });
    expect(Number(onHand.quantity)).toBe(0);
    expect(onHand.negativeBalance).toBe(false);
    expect(onHand.stockingUnit).toBeNull();
  });
});

describe("getOnHand — store isolation (US1 scenario 4)", () => {
  it("STORE_A_Y on-hand for PRODUCT_A_ACTIVE is independent of STORE_A_X", async () => {
    if (maybeSkip()) return;
    // seed-inventory: A.Y has only an outbound −3 for PRODUCT_A_ACTIVE; A.X has
    // +10/−1/−2 = 7. The two stores' balances must not bleed into each other.
    const ax = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const ay = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_Y,
      productId: PRODUCT_A_ACTIVE,
    });
    expect(Number(ax.quantity)).toBe(7);
    expect(Number(ay.quantity)).toBe(-3);
    expect(ay.negativeBalance).toBe(true);
  });
});
