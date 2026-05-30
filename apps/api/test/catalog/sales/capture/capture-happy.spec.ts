/**
 * capture-happy.spec.ts — 008 US1 T030 (RED).
 *
 * captureSale → an immutable `sales` row scoped to (tenant, store), POS total
 * preserved verbatim, currency recorded, stable reference; two frozen
 * `sale_lines` with snapshot price/name/tax/unit (FR-001/002/005, SC-001).
 *
 * RED until 008-US1-CAPTURE authors SalesController/SalesService (the harness
 * import of those modules is the failing signal).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  TENANT_A,
  STORE_A_X,
  type HarnessHandle,
} from "./__capture-harness";

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness());
}, 180_000);
afterAll(async () => {
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));
afterEach(async () => {
  if (h.harness) {
    // sale_lines carries no source_system column — delete children via the
    // parent's provenance (matches the sibling capture specs' cleanup idiom).
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

describe("T030 — captureSale creates an immutable sale + frozen lines", () => {
  it("returns 201 with a stable sale reference, POS total verbatim, currency recorded", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const res = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("cap1"))
      .send(captureBody());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      saleRef: expect.any(String),
      storeId: STORE_A_X,
      currencyCode: "USD",
      posTotal: "12.5000",
    });
    expect(res.body.lines).toHaveLength(2);
  });

  it("persists exactly one sales row scoped to (tenant, store) with two sale_lines", async () => {
    if (h.dockerSkipped || !h.harness) return;
    await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("cap2"))
      .send(captureBody({ externalId: "ext-cap-002" }));

    const sale = await h.harness.env.admin.query<{
      tenant_id: string;
      store_id: string;
      pos_total: string;
    }>(
      `SELECT tenant_id, store_id, pos_total FROM sales
       WHERE source_system = 'pos-1' AND external_id = 'ext-cap-002'`,
    );
    expect(sale.rowCount).toBe(1);
    expect(sale.rows[0]?.tenant_id).toBe(TENANT_A);
    expect(sale.rows[0]?.store_id).toBe(STORE_A_X);
    expect(sale.rows[0]?.pos_total).toBe("12.5000");

    const lines = await h.harness.env.admin.query<{ line_name: string }>(
      `SELECT line_name FROM sale_lines WHERE sale_id = (
         SELECT id FROM sales WHERE external_id = 'ext-cap-002'
       ) ORDER BY line_name`,
    );
    expect(lines.rows.map((r) => r.line_name)).toEqual(["Gadget", "Widget"]);
  });
});
