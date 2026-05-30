/**
 * business-date.spec.ts — 008 US2 T041.
 *
 * `business_date` is derived from the STORE's timezone (FR-023), not the client
 * clock or UTC. Near a day boundary, a sale's business_date is the store-local
 * calendar date — which can differ from the UTC date of the same instant.
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
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
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
    // Restore the store's default zone so sibling specs see UTC.
    await h.harness.env.admin.query(
      "UPDATE stores SET timezone = 'UTC' WHERE id = $1",
      [STORE_A_X],
    );
  }
});

describe("T041 — business_date is derived from the store timezone", () => {
  it("near a day boundary, business_date is the store-LOCAL date, not the UTC date", async () => {
    if (h.dockerSkipped || !h.harness) return;
    // STORE_A_X keeps shop on Honolulu time (UTC-10, no DST).
    await h.harness.env.admin.query(
      "UPDATE stores SET timezone = 'Pacific/Honolulu' WHERE id = $1",
      [STORE_A_X],
    );

    // 02:00Z on the 1st is still 16:00 on Apr 30 in Honolulu.
    const occurredAt = "2026-05-01T02:00:00.000Z";
    const res = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("bizdate"))
      .send(captureBody({ externalId: "ext-bizdate", occurredAt }));

    expect(res.status).toBe(201);
    expect(res.body.businessDate).toBe("2026-04-30"); // store-local
    expect(res.body.businessDate).not.toBe("2026-05-01"); // NOT the UTC date
  });

  it("with the default UTC store, business_date equals the UTC date (backward-compatible)", async () => {
    if (h.dockerSkipped || !h.harness) return;
    // STORE_A_X left at the 'UTC' default (resetHarness/afterEach).
    const occurredAt = "2026-05-01T02:00:00.000Z";
    const res = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("bizutc"))
      .send(captureBody({ externalId: "ext-bizutc", occurredAt }));

    expect(res.status).toBe(201);
    expect(res.body.businessDate).toBe("2026-05-01");
  });
});
