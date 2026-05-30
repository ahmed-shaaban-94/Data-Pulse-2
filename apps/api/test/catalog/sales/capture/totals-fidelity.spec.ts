/**
 * totals-fidelity.spec.ts — 008 US1 T032 (RED).
 *
 * When the POS-reported total differs from the SaaS per-line / half-up
 * comparison total, the POS total is PRESERVED verbatim and an advisory
 * `mismatch_flag` is set — the POS total is NEVER rewritten
 * (FR-030/031/032, SC-002; gate A.3/A.4).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
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

describe("T032 — POS total preserved verbatim; mismatch advisory only", () => {
  it("POS total that disagrees with the per-line sum is preserved + mismatch_flag set", async () => {
    if (h.dockerSkipped || !h.harness) return;
    // Per-line sum = 5.00 + 7.50 = 12.50, but POS reports 13.0000 (a mismatch).
    const res = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("mism"))
      .send(captureBody({ externalId: "ext-mism-001", posTotal: "13.0000" }));

    expect(res.status).toBe(201);
    // POS total preserved verbatim on the wire — never rewritten to 12.5000.
    expect(res.body.posTotal).toBe("13.0000");
    expect(res.body.mismatchFlag).toBe(true);

    const row = await h.harness.env.admin.query<{
      pos_total: string;
      mismatch_flag: boolean | null;
    }>(
      `SELECT pos_total, mismatch_flag FROM sales
       WHERE source_system = 'pos-1' AND external_id = 'ext-mism-001'`,
    );
    expect(row.rows[0]?.pos_total).toBe("13.0000");
    expect(row.rows[0]?.mismatch_flag).toBe(true);
  });

  it("POS total that matches the per-line sum is preserved with no mismatch", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const res = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("match"))
      .send(captureBody({ externalId: "ext-match-001", posTotal: "12.5000" }));

    expect(res.status).toBe(201);
    expect(res.body.posTotal).toBe("12.5000");
    expect(res.body.mismatchFlag).toBe(false);
  });
});
