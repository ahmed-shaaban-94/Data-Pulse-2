/**
 * token-mismatch.spec.ts — 008 US5 T061.
 *
 * The SAME Idempotency-Key with a DIFFERENT payload is a deterministic conflict
 * — 409 `idempotency_key_conflict` from the shipped interceptor (FR-051, 005
 * FR-021c) — with NO side effect (no second sale row).
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
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

describe("T061 — captureSale Idempotency-Key payload mismatch → 409, no side effect", () => {
  it("same key + different payload → 409 idempotency_key_conflict; only one row", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const key = idempKey("mmkey");

    const first = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", key)
      .send(captureBody({ externalId: "ext-mm-a", posTotal: "10.0000" }));
    expect(first.status).toBe(201);

    // Same key, materially different body → mismatch.
    const second = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", key)
      .send(captureBody({ externalId: "ext-mm-b", posTotal: "99.0000" }));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({
      error: { code: "idempotency_key_conflict", message: expect.any(String) },
    });

    // No second row was written (the mismatch fired before the handler). Scope
    // to the two known external IDs so the assertion is independent of cleanup
    // ordering: only the first (ext-mm-a) exists; ext-mm-b was never persisted.
    const count = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sales WHERE external_id IN ('ext-mm-a', 'ext-mm-b')`,
    );
    expect(count.rows[0]?.n).toBe("1");
    const b = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sales WHERE external_id = 'ext-mm-b'`,
    );
    expect(b.rows[0]?.n).toBe("0");
  });
});
