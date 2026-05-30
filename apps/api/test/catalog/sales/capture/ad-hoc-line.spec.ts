/**
 * ad-hoc-line.spec.ts — 008 US1 T034 (RED).
 *
 * A line with no resolvable tenant product still snapshots price/name/tax/unit
 * (tenant_product_ref stays NULL); the capture MUST NOT auto-create a tenant
 * product from a sale line (FR-004).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  TENANT_A,
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
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

describe("T034 — ad-hoc line (no resolvable tenant product)", () => {
  it("snapshots the line with tenant_product_ref NULL and creates no tenant product", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const admin = h.harness.env.admin;

    const productCountBefore = await admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tenant_products WHERE tenant_id = $1`,
      [TENANT_A],
    );

    const res = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("adhoc"))
      .send(
        captureBody({
          externalId: "ext-adhoc-001",
          posTotal: "3.0000",
          lines: [
            {
              lineName: "Hand-keyed misc item",
              unitPrice: "3.0000",
              currencyCode: "USD",
              quantity: "1",
              lineAmount: "3.0000",
              unit: "ea",
              // No tenantProductRef — ad-hoc.
            },
          ],
        }),
      );

    expect(res.status).toBe(201);

    // The line is snapshotted with a NULL product reference.
    const line = await admin.query<{
      line_name: string;
      unit_price: string;
      tenant_product_ref: string | null;
    }>(
      `SELECT line_name, unit_price, tenant_product_ref FROM sale_lines
       WHERE sale_id = (SELECT id FROM sales WHERE external_id = 'ext-adhoc-001')`,
    );
    expect(line.rows[0]?.line_name).toBe("Hand-keyed misc item");
    expect(line.rows[0]?.unit_price).toBe("3.0000");
    expect(line.rows[0]?.tenant_product_ref).toBeNull();

    // No tenant product was auto-created (FR-004).
    const productCountAfter = await admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM tenant_products WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(productCountAfter.rows[0]?.n).toBe(productCountBefore.rows[0]?.n);
  });
});
