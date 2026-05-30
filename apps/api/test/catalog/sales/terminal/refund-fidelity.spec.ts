/**
 * refund-fidelity.spec.ts — 008 US4 T056.
 *
 * The POS-reported refund amount is preserved VERBATIM — the SaaS stores it
 * as-is and NEVER rewrites it to the sale total or anything else (FR-012/030/031).
 * A partial refund (amount < sale total) round-trips exactly.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  type HarnessHandle,
} from "../capture/__capture-harness";

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
      "DELETE FROM sale_refunds WHERE source_system = 'pos-1'",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

describe("T056 — recordRefund preserves the POS amount verbatim", () => {
  it("a partial refund amount is stored exactly, never rewritten to the sale total", async () => {
    if (h.dockerSkipped || !h.harness) return;
    // Sale total is 12.5000 (captureBody default); refund a different, partial amount.
    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("rfcap"))
      .send(captureBody({ externalId: "ext-refund-fidelity" }));
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef;

    const res = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("rf1"))
      .send({
        sourceSystem: "pos-1",
        externalId: "refund-evt-partial",
        posRefundAmount: "7.3300",
        currencyCode: "USD",
      });

    expect(res.status).toBe(201);
    // Verbatim — NOT rewritten to the 12.5000 sale total.
    expect(res.body.posRefundAmount).toBe("7.3300");

    // And persisted exactly as reported.
    const row = await h.harness.env.admin.query<{ pos_refund_amount: string }>(
      `SELECT pos_refund_amount FROM sale_refunds WHERE external_id = 'refund-evt-partial'`,
    );
    expect(row.rows[0]?.pos_refund_amount).toBe("7.3300");
  });
});
