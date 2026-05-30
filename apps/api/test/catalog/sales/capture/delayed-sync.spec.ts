/**
 * delayed-sync.spec.ts — 008 US2 T040.
 *
 * A sale that occurred long before it syncs is CAPTURED, not rejected (FR-020/024,
 * SC-007). `occurred_at` / `source_clock_at` are preserved verbatim; `received_at`
 * is the server clock at receipt (so it is far later than a weeks-old occurredAt).
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

describe("T040 — delayed offline sync is captured, time not rewritten", () => {
  it("a months-old occurredAt is accepted; occurredAt/sourceClockAt preserved, receivedAt is server clock", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const occurredAt = "2026-01-05T08:30:00.000Z"; // long before sync
    const sourceClockAt = "2026-01-05T08:30:05.000Z";

    const res = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("delayed"))
      .send(captureBody({ externalId: "ext-delayed", occurredAt, sourceClockAt }));

    // Accepted, NOT rejected for being stale.
    expect(res.status).toBe(201);
    // POS times preserved verbatim.
    expect(res.body.occurredAt).toBe(occurredAt);
    expect(res.body.sourceClockAt).toBe(sourceClockAt);
    // received_at is the server clock — far later than the weeks-old occurredAt.
    expect(new Date(res.body.receivedAt).getTime()).toBeGreaterThan(
      new Date(occurredAt).getTime(),
    );
  });
});
