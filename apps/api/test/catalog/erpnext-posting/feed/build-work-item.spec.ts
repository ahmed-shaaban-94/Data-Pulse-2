/**
 * build-work-item.unit.spec — issue #506 regression guard (Docker-free unit test).
 *
 * `buildWorkItem` must project each line's `erpnextItemRef` as the 012 contract OBJECT shape
 * `{ doctype: "Item", name }` — NOT the bare Item-code string the DB column holds. The contract
 * (`posting-feed.yaml` ErpnextItemRef: type object, required [doctype,name]) is the source of
 * truth; the projection previously emitted `l.erpnext_item_ref` (a string), which a conforming
 * consumer cannot parse. This unit test fakes the PoolClient so it exercises the projection logic
 * directly, no Postgres/Docker.
 */
import "reflect-metadata";

import type { PoolClient } from "pg";

import { buildWorkItem } from "../../../../src/catalog/erpnext-posting/posting-work-item.projection";

/** A PoolClient stub that returns canned rows per query call, in order. */
function fakeClient(resultsInOrder: Array<{ rows: unknown[] }>): PoolClient {
  let call = 0;
  return {
    query: async () => {
      const r = resultsInOrder[call] ?? { rows: [] };
      call += 1;
      return r;
    },
  } as unknown as PoolClient;
}

const SALE_ROW = {
  id: "00000000-0000-7000-8000-00000000a5e1",
  store_id: "00000000-0000-7000-8000-00000000570e",
  currency_code: "USD",
  pos_total: "19.9900",
  occurred_at: new Date("2026-06-06T03:58:10.122Z"),
  business_date: "2026-06-06",
  source_system: "retail_tower_pos",
  external_id: "UNIT-SALE-0001",
};

const LINE_ROW = {
  line_name: "Line 1",
  unit_price: "19.9900",
  currency_code: "USD",
  quantity: "1.000000",
  line_amount: "19.9900",
  tax_amount: null,
  unit: "each",
  erpnext_item_ref: "ERP-ITEM-AX", // the bare Item code stored in the DB column
  tenant_product_ref: "00000000-0000-7000-8000-0000000a7e01",
};

const STATUS_ROW = {
  id: "00000000-0000-7000-8000-0000000057a7",
  kind: "sale_post" as const,
  saleId: SALE_ROW.id,
  sourceRefId: SALE_ROW.id,
  sourceSystem: "retail_tower_pos",
  externalId: "UNIT-SALE-0001",
  payloadHash: "a".repeat(64),
  sequence: "1",
};

describe("buildWorkItem — issue #506 erpnextItemRef object shape", () => {
  it("projects erpnextItemRef as the 012 object {doctype:'Item', name}, not a bare string", async () => {
    const client = fakeClient([{ rows: [SALE_ROW] }, { rows: [LINE_ROW] }]);

    const item = await buildWorkItem(client, STATUS_ROW);

    expect(item).not.toBeNull();
    expect(item!.sale.lines).toHaveLength(1);
    const ref = item!.sale.lines[0]!.erpnextItemRef;
    expect(typeof ref).toBe("object");
    expect(ref).toEqual({ doctype: "Item", name: "ERP-ITEM-AX" });
  });

  it("still omits the work-item (returns null) when a line's item ref is unresolved", async () => {
    // O-1 self-sufficiency: a stale/retired map leaves erpnext_item_ref NULL → omit, never ship "".
    const client = fakeClient([
      { rows: [SALE_ROW] },
      { rows: [{ ...LINE_ROW, erpnext_item_ref: null }] },
    ]);

    const item = await buildWorkItem(client, STATUS_ROW);

    expect(item).toBeNull();
  });
});
