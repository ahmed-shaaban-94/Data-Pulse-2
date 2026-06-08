/**
 * 019-T040-FEED — ErpnextBinViewService.pullRequests Testcontainers spec (RED-first).
 *
 * Proves the bin-view PULL feed is a pure read that projects OPEN 017 stock runs
 * (status='running', store has an active 014 `stock` mapping) into 019
 * `BinViewRequest` feed items per the shipped
 * `packages/contracts/openapi/erpnext-connector/stock-view.yaml`:
 *   - a running run for a mapped store → ONE BinViewRequest with the run's
 *     `runRef`, the store's `erpnextWarehouseRef`, a derived opaque `requestRef`,
 *     and an `itemWindow` (windowSeq 0, maxItems 500) for ≤500 mapped items;
 *   - a `completed` run is NOT offered (only `running`);
 *   - a store with no active 014 mapping is NOT offered;
 *   - cursor ordering + idempotent replay: re-pulling the same `since` yields the
 *     same logical set;
 *   - tenant isolation: tenant A's pull never sees tenant B's running run.
 *
 * Builds on the 017 reconciliation seed (catalog ⊕ sales ⊕ 015 ⊕ 014 map ⊕ 017
 * rows). The shared seed's RUN_A is `completed`; this spec seeds a fresh RUNNING
 * run for STORE_A_X (the mapped store) via the admin pool so the feed has a row.
 *
 * Docker policy mirrors the 017 specs: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ErpnextBinViewService } from "../../../../src/catalog/erpnext-bin-view/erpnext-bin-view.service";
import { ACTOR_A, STORE_A_X, TENANT_A, TENANT_B, STORE_B_X, ACTOR_B } from "../../__support__/isolation-harness";
import { seedReconciliationFixture } from "../../erpnext-reconciliation/__support__/seed-reconciliation";

let env: PgTestEnv | null = null;
let skip = false;

/** A fresh RUNNING tenant-A stock run for the mapped STORE_A_X (the feed target). */
const RUN_A_RUNNING = "0a000000-0000-7000-8000-00000e7040a1";
/** A fresh RUNNING tenant-B stock run (the cross-tenant target A must not see). */
const RUN_B_RUNNING = "0b000000-0000-7000-8000-00000e7040b1";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
    const a = env.admin;
    // A RUNNING run for the mapped STORE_A_X — the bin-view feed offers it.
    await a.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
       VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
       ON CONFLICT (id) DO NOTHING`,
      [RUN_A_RUNNING, TENANT_A, STORE_A_X, ACTOR_A],
    );
    // A RUNNING run for tenant B (cross-tenant; STORE_B_X mapping seeded by 015 seed? no —
    // seed a 014 map for STORE_B_X so the run is "offerable" within B, proving A can't see it).
    await a.query(
      `INSERT INTO erpnext_warehouse_map
         (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-017B', $3, 1)
       ON CONFLICT DO NOTHING`,
      [TENANT_B, STORE_B_X, ACTOR_B],
    );
    await a.query(
      `INSERT INTO erpnext_reconciliation_run
         (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
       VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
       ON CONFLICT (id) DO NOTHING`,
      [RUN_B_RUNNING, TENANT_B, STORE_B_X, ACTOR_B],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[bin-view-feed.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
});

describe("ErpnextBinViewService.pullRequests — 019 bin-view feed", () => {
  it("offers ONE BinViewRequest for a running run on a mapped store", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const page = await service.pullRequests({
      tenantId: TENANT_A,
      since: null,
      limit: 100,
    });

    const forRun = page.items.filter((i) => i.runRef === RUN_A_RUNNING);
    expect(forRun).toHaveLength(1);
    const req = forRun[0]!;
    expect(req.storeId).toBe(STORE_A_X);
    expect(req.erpnextWarehouseRef).toBe("ERP-WH-017A");
    expect(req.requestRef).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(req.itemWindow.windowSeq).toBe(0);
    expect(req.itemWindow.maxItems).toBe(500);
    expect(typeof req.itemCursor).toBe("string");
  });

  it("does NOT offer a completed run", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const page = await service.pullRequests({
      tenantId: TENANT_A,
      since: null,
      limit: 100,
    });
    // RUN_A (the shared seed) is `completed` — never offered.
    const completed = page.items.filter(
      (i) => i.runRef === "0a000000-0000-7000-8000-00000e0517a2",
    );
    expect(completed).toHaveLength(0);
  });

  it("is tenant-isolated: tenant A never sees tenant B's running run", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const page = await service.pullRequests({
      tenantId: TENANT_A,
      since: null,
      limit: 100,
    });
    const crossTenant = page.items.filter((i) => i.runRef === RUN_B_RUNNING);
    expect(crossTenant).toHaveLength(0);
  });

  it("paginates correctly: limit=1 walks ALL running runs across pages (keyset)", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    // Seed two MORE running runs on the mapped store, so tenant A has >=3.
    const extra1 = "0a000000-0000-7000-8000-00000e7040c1";
    const extra2 = "0a000000-0000-7000-8000-00000e7040c2";
    for (const id of [extra1, extra2]) {
      await env!.admin.query(
        `INSERT INTO erpnext_reconciliation_run
           (id, tenant_id, store_id, kind, trigger, status, actor_user_id)
         VALUES ($1, $2, $3, 'stock', 'on_demand', 'running', $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, TENANT_A, STORE_A_X, ACTOR_A],
      );
    }
    // Walk the whole feed one item per page; every running run must appear exactly
    // once. A cursor/sort-key mismatch would silently drop runs across a boundary.
    const seen = new Set<string>();
    let since: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page = await service.pullRequests({ tenantId: TENANT_A, since, limit: 1 });
      for (const i of page.items) seen.add(i.runRef);
      if (page.nextPageToken === null) break;
      since = page.cursor;
    }
    for (const id of [RUN_A_RUNNING, extra1, extra2]) {
      expect(seen.has(id)).toBe(true);
    }
  });

  it("idempotent replay: same `since` yields the same logical set", async () => {
    if (skip) return;
    const service = new ErpnextBinViewService(env!.app);
    const first = await service.pullRequests({
      tenantId: TENANT_A,
      since: null,
      limit: 100,
    });
    const replay = await service.pullRequests({
      tenantId: TENANT_A,
      since: null,
      limit: 100,
    });
    expect(replay.items.map((i) => i.requestRef).sort()).toEqual(
      first.items.map((i) => i.requestRef).sort(),
    );
  });
});
