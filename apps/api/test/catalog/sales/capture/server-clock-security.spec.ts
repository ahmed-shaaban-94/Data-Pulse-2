/**
 * server-clock-security.spec.ts — 008 US2 T042.
 *
 * A skewed client `sourceClockAt` is NEVER consulted for any security/timing
 * decision (FR-022): `received_at` is the SERVER clock (not the skewed value),
 * and idempotency replay is decided server-side regardless of the skew. The
 * skewed value is preserved as provenance only.
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

describe("T042 — sourceClockAt is provenance only, never a security clock", () => {
  it("a far-future sourceClockAt does not move received_at; idempotency still holds server-side", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const skewed = "2099-01-01T00:00:00.000Z"; // decades in the future
    const body = captureBody({ externalId: "ext-clock-skew", sourceClockAt: skewed });

    const first = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("clk1"))
      .send(body);
    expect(first.status).toBe(201);

    // The skew is preserved as provenance...
    expect(first.body.sourceClockAt).toBe(skewed);
    // ...but received_at is the SERVER clock — NOT driven by the 2099 skew.
    expect(new Date(first.body.receivedAt).getUTCFullYear()).toBeLessThan(2099);

    // Idempotency is decided on server state, unaffected by the skewed clock: a
    // same-provenance re-delivery deterministically replays, one row only.
    const replay = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("clk2"))
      .send(body);
    expect(replay.status).toBe(200);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.body.saleRef).toBe(first.body.saleRef);

    const count = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sales WHERE external_id = 'ext-clock-skew'`,
    );
    expect(count.rows[0]?.n).toBe("1");
  });
});
