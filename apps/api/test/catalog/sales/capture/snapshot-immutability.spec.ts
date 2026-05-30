/**
 * snapshot-immutability.spec.ts — 008 US1 T031 (RED).
 *
 * After capture, editing the referenced tenant-product's price/name MUST NOT
 * mutate any existing `sale_line` — the line is a frozen snapshot (FR-003,
 * SC-001).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  TENANT_A,
  PRODUCT_A_ACTIVE,
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
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE tenant_id = $1 AND line_name IN ('Snapshot Widget')",
      [TENANT_A],
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1' AND external_id = 'ext-snap-001'",
    );
  }
});

describe("T031 — sale_line snapshot is frozen against later catalog edits", () => {
  it("editing the tenant product's price/name leaves the captured sale_line unchanged", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const admin = h.harness.env.admin;

    // Capture a sale whose line references PRODUCT_A_ACTIVE (lineage only).
    await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("snap"))
      .send(
        captureBody({
          externalId: "ext-snap-001",
          posTotal: "9.0000",
          lines: [
            {
              lineName: "Snapshot Widget",
              unitPrice: "9.0000",
              currencyCode: "USD",
              quantity: "1",
              lineAmount: "9.0000",
              unit: "ea",
              tenantProductRef: PRODUCT_A_ACTIVE,
            },
          ],
        }),
      );

    const before = await admin.query<{ line_name: string; unit_price: string }>(
      `SELECT line_name, unit_price FROM sale_lines
       WHERE sale_id = (SELECT id FROM sales WHERE external_id = 'ext-snap-001')`,
    );
    expect(before.rows[0]?.line_name).toBe("Snapshot Widget");
    expect(before.rows[0]?.unit_price).toBe("9.0000");

    // Mutate the referenced tenant product (name + price) directly. The
    // paired-currency CHECK (0007 `tenant_products_currency_paired`) requires
    // default_price and default_currency_code to be set together, so set both.
    await admin.query(
      `UPDATE tenant_products
         SET name = 'RENAMED', default_price = 999.0000, default_currency_code = 'USD'
       WHERE id = $1`,
      [PRODUCT_A_ACTIVE],
    );

    // The captured line is unaffected — snapshot, not a live read.
    const after = await admin.query<{ line_name: string; unit_price: string }>(
      `SELECT line_name, unit_price FROM sale_lines
       WHERE sale_id = (SELECT id FROM sales WHERE external_id = 'ext-snap-001')`,
    );
    expect(after.rows[0]?.line_name).toBe("Snapshot Widget");
    expect(after.rows[0]?.unit_price).toBe("9.0000");
  });
});
