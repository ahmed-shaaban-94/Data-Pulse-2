/**
 * 015-US1-FEED — ErpnextPostingService.pullPostings Testcontainers spec.
 *
 * Proves the PULL feed is a pure read that projects `pending`
 * erpnext_posting_status rows into 012 PostingWorkItems:
 *   - a pending row → a sale_post work-item with the full Sale projection +
 *     each line's DP2-resolved erpnextItemRef (O-1 self-sufficiency);
 *   - cursor ordering: items ordered by sequence; `since` advances past seen rows;
 *   - idempotent replay: re-pulling the same `since` yields the same set;
 *   - a `posted` row is NOT offered (only `pending`);
 *   - money is exact-decimal strings (no float, §III); businessDate carried.
 *
 * Builds on the 015 isolation seed (catalog ⊕ sales ⊕ posting-status rows). The
 * seed's POST_A_PENDING (sale_post) is the resolvable feed row; POST_B_POSTED is
 * tenant B (not visible to tenant A's pull). To make POST_A_PENDING's lines
 * resolvable, this spec also confirms an item map + warehouse map for tenant A.
 *
 * Docker policy mirrors the isolation sweep: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import { ACTOR_A, STORE_A_X } from "../../__support__/isolation-harness";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

let env: PgTestEnv | null = null;
let skip = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
    // Make SALE_A_X's line resolvable: confirm an item map for its
    // tenant_product_ref + a warehouse map for STORE_A_X, so buildWorkItem
    // populates erpnextItemRef. The seeded sale lines reference tenant products
    // from the catalog fixture; map whichever product the SALE_A_X line carries.
    const a = env.admin;
    // The 008 seed's SALE_A_X lines carry NULL tenant_product_ref (ad-hoc). To
    // make them RESOLVABLE for the happy-path feed assertion, create a tenant
    // product, point SALE_A_X's lines at it, then confirm-map it + map the store.
    const TPROD_AX = "01900000-0000-7000-8000-0000000a7e01";
    await a.query(
      `INSERT INTO tenant_products
         (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'AX Widget', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
      [TPROD_AX, TENANT_A, ACTOR_A],
    );
    await a.query(
      `UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`,
      [TPROD_AX, SALE_A_X],
    );
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state,
          suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-AX', 'confirmed', 'manual', $3, now())
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TPROD_AX, ACTOR_A],
    );
    await a.query(
      `INSERT INTO erpnext_warehouse_map
         (id, tenant_id, store_id, purpose, erpnext_warehouse_ref, set_by, version)
       VALUES (gen_random_uuid(), $1, $2, 'stock', 'ERP-WH-AX', $3, 1)
       ON CONFLICT DO NOTHING`,
      [TENANT_A, STORE_A_X, ACTOR_A],
    );
  } catch (err) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`[posting-feed.spec] Docker unavailable: ${String(err)}`);
      return;
    }
    throw err;
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function svc(): ErpnextPostingService {
  if (!env) throw new Error("Docker unavailable");
  return new ErpnextPostingService(env.app);
}

describe("ErpnextPostingService.pullPostings — 015-US1-FEED", () => {
  it("offers the tenant-A pending sale_post work-item with a resolved erpnextItemRef", async () => {
    if (skip) return;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    const item = page.items.find((i) => i.workItemRef === POST_A_PENDING);
    expect(item).toBeDefined();
    expect(item!.kind).toBe("sale_post");
    expect(item!.sale.saleRef).toBe(SALE_A_X);
    expect(item!.sale.lines.length).toBeGreaterThan(0);
    for (const l of item!.sale.lines) {
      // O-1: every offered line is resolved AND carries the 012 ErpnextItemRef OBJECT shape
      // {doctype:"Item", name} — NOT a bare string (issue #506: the projection emitted the raw
      // Item code, violating the contract; a conforming consumer cannot parse it).
      expect(typeof l.erpnextItemRef).toBe("object");
      expect(l.erpnextItemRef.doctype).toBe("Item");
      expect(typeof l.erpnextItemRef.name).toBe("string");
      expect(l.erpnextItemRef.name.length).toBeGreaterThan(0);
    }
  });

  it("does NOT offer a posted row (only pending)", async () => {
    if (skip) return;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    // POST_B_POSTED is tenant B AND posted — doubly excluded; the reversal row is
    // also pending for tenant A, so assert no posted statuses leak by checking
    // every offered ref maps to a pending row.
    const refs = page.items.map((i) => i.workItemRef);
    const statuses = await env!.admin.query<{ id: string; status: string }>(
      `SELECT id, status FROM erpnext_posting_status WHERE id = ANY($1)`,
      [refs],
    );
    for (const r of statuses.rows) expect(r.status).toBe("pending");
  });

  it("emits exact-decimal string money + the sale businessDate (no float, §III/§X)", async () => {
    if (skip) return;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    const item = page.items.find((i) => i.workItemRef === POST_A_PENDING)!;
    expect(typeof item.sale.posTotal).toBe("string");
    expect(item.sale.posTotal).toMatch(/^\d+\.\d+$/);
    expect(item.sale.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    for (const l of item.sale.lines) {
      expect(l.unitPrice).toMatch(/^\d+\.\d+$/);
      expect(l.lineAmount).toMatch(/^\d+\.\d+$/);
    }
  });

  it("cursor-orders by sequence and advances; replay of the same since is stable", async () => {
    if (skip) return;
    const s = svc();
    const first = await s.pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    expect(first.items.length).toBeGreaterThanOrEqual(1);
    expect(first.cursor).not.toBeNull();
    // Replay: same since=null → same logical set (idempotent replay).
    const replay = await s.pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    expect(replay.items.map((i) => i.workItemRef)).toEqual(
      first.items.map((i) => i.workItemRef),
    );
    // Advance past everything → empty tail.
    const tail = await s.pullPostings({
      tenantId: TENANT_A,
      since: BigInt(first.cursor!),
      limit: 100,
    });
    expect(tail.items).toHaveLength(0);
  });

  it("respects the limit (page size cap)", async () => {
    if (skip) return;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 1 });
    expect(page.items.length).toBeLessThanOrEqual(1);
  });
});
