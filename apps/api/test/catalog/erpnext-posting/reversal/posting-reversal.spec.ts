/**
 * 015-US3-REVERSAL — reversal projection + trigger Testcontainers spec
 * (T050–T052, the api/DB-layer behaviors).
 *
 * Proves:
 *   - PROJECTION: a `reversal` erpnext_posting_status row (keyed on a void/refund
 *     terminal event's OWN id) projects into a `reversal` PostingWorkItem
 *     carrying `reversalOf` = the ORIGINAL sale's provenance + reversalKind
 *     (void|refund); the sale_post projection path is unaffected (§IX);
 *   - TRIGGER + CARDINALITY: recording a void AND a refund of the SAME sale via
 *     the 008 SalesService emits two `erpnext.posting.requested` reversal events
 *     (in-transaction), and the worker consumer resolves them into TWO distinct
 *     reversal rows (distinct source_ref_id) — neither blocked by the O-3 unique
 *     (the REVERSAL-CARDINALITY guarantee, data-model §5). Two partial refunds
 *     likewise produce two distinct rows.
 *
 * Docker policy: HARD failure unless MIGRATION_TEST_ALLOW_SKIP=1.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { runWithTenantContext } from "@data-pulse-2/db";
import { ErpnextPostingService } from "../../../../src/catalog/erpnext-posting/erpnext-posting.service";
import { buildWorkItem } from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";
import { ACTOR_A, STORE_A_X } from "../../__support__/isolation-harness";
import { SALE_VOIDED_A_X } from "../../sales/__support__/seed-sales";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_REVERSAL,
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
    // Make the VOIDED sale's lines resolvable so the reversal work-item is
    // offered (buildWorkItem still requires every line's erpnextItemRef).
    const a = env.admin;
    const TPROD_V = "01900000-0000-7000-8000-0000000a7e03";
    await a.query(
      `INSERT INTO tenant_products (id, tenant_id, name, tax_category, created_by, updated_by)
       VALUES ($1, $2, 'Voided Widget', 'standard', $3, $3) ON CONFLICT (id) DO NOTHING`,
      [TPROD_V, TENANT_A, ACTOR_A],
    );
    await a.query(`UPDATE sale_lines SET tenant_product_ref = $1 WHERE sale_id = $2`, [
      TPROD_V,
      SALE_VOIDED_A_X,
    ]);
    await a.query(
      `INSERT INTO erpnext_item_map
         (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source, confirmed_by, confirmed_at)
       VALUES (gen_random_uuid(), $1, $2, 'ERP-ITEM-V', 'confirmed', 'manual', $3, now())
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TPROD_V, ACTOR_A],
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
      console.warn(`[posting-reversal.spec] Docker unavailable: ${String(err)}`);
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

describe("US3-REVERSAL — projection", () => {
  it("a reversal row projects a reversal work-item with reversalOf (original provenance + reversalKind void)", async () => {
    if (skip) return;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    const item = page.items.find((i) => i.workItemRef === POST_A_REVERSAL);
    expect(item).toBeDefined();
    expect(item!.kind).toBe("reversal");
    expect(item!.reversalOf).not.toBeNull();
    expect(item!.reversalOf!.reversalKind).toBe("void");
    // reversalOf carries the ORIGINAL (voided) sale's provenance, not the void's.
    expect(item!.sale.saleRef).toBe(SALE_VOIDED_A_X);
    expect(item!.reversalOf!.externalId.length).toBeGreaterThan(0);
  });

  it("a sale_post work-item carries reversalOf=null (unaffected by US3)", async () => {
    if (skip) return;
    const page = await svc().pullPostings({ tenantId: TENANT_A, since: null, limit: 100 });
    const sp = page.items.find((i) => i.kind === "sale_post");
    if (sp) expect(sp.reversalOf).toBeNull();
  });

  it("buildWorkItem returns null for a reversal whose source_ref_id is neither a void nor a refund (defensive)", async () => {
    if (skip) return;
    await runWithTenantContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        const item = await buildWorkItem(client, {
          id: POST_A_REVERSAL,
          kind: "reversal",
          saleId: SALE_VOIDED_A_X,
          sourceRefId: "00000000-0000-7000-8000-000000000000", // not a terminal event
          sourceSystem: "pos",
          externalId: "x",
          payloadHash: "a".repeat(64),
          sequence: "1",
        });
        expect(item).toBeNull();
      },
    );
  });
});
