/**
 * read-scope.spec.ts — 008 US1 read-path object-safety + provenance fidelity.
 *
 * Covers the post-review hardening of `readSale` / `captureSale`:
 *   - Reads are tenant AND store scoped (spec §120/§449, FR-063): a same-tenant
 *     cross-store read of a known saleRef is a non-disclosing 404, not a leak.
 *   - A read with no resolved store context is rejected (store_context_required),
 *     mirroring captureSale.
 *   - A malformed saleRef is a safe-404 at the boundary — it never reaches the
 *     DB to surface as a 500.
 *   - `sourceClockAt` is PERSISTED at capture and round-trips on read (it was
 *     accepted by the DTO but previously dropped from the INSERT).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  STORE_A_X,
  STORE_A_Y,
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

/** Capture one sale at STORE_A_X and return its saleRef. */
async function captureAtStoreA(
  body: Record<string, unknown>,
): Promise<{ saleRef: string; status: number; sourceClockAt: string | null }> {
  if (!h.harness) throw new Error("harness not initialized");
  const res = await h.harness
    .http()
    .post("/api/pos/v1/sales")
    .set("Idempotency-Key", idempKey("rdscope"))
    .send(body);
  return {
    saleRef: res.body.saleRef,
    status: res.status,
    sourceClockAt: res.body.sourceClockAt ?? null,
  };
}

describe("read-scope — readSale object safety (FR-063, SI-004)", () => {
  it("a same-tenant cross-store read of a known saleRef is a non-disclosing 404", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const { saleRef, status } = await captureAtStoreA(
      captureBody({ externalId: "ext-rdscope-xstore" }),
    );
    expect(status).toBe(201);

    // Same tenant, a DIFFERENT store binding than the sale's store → the sale
    // is filtered out by the store predicate and reads as absent.
    h.harness.contextGuard.storeId = STORE_A_Y;
    const res = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(res.status).toBe(404);

    // Sanity: the SAME ref IS visible from its own store (anchors the negative).
    h.harness.contextGuard.storeId = STORE_A_X;
    const ok = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(ok.status).toBe(200);
    expect(ok.body.saleRef).toBe(saleRef);
  });

  it("a read with no resolved store context is rejected (401)", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const { saleRef } = await captureAtStoreA(
      captureBody({ externalId: "ext-rdscope-nostore" }),
    );

    h.harness.contextGuard.storeId = null;
    const res = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(res.status).toBe(401);
  });

  it("a malformed saleRef is a safe-404 at the boundary (never a 500)", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const res = await h.harness
      .http()
      .get("/api/pos/v1/sales/not-a-valid-uuid");
    expect(res.status).toBe(404);
  });
});

describe("read-scope — sourceClockAt provenance fidelity (FR-050, gate C)", () => {
  it("sourceClockAt is persisted at capture and round-trips on read", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const sourceClockAt = "2026-05-01T09:59:30.000Z";
    const { saleRef, status, sourceClockAt: captured } = await captureAtStoreA(
      captureBody({ externalId: "ext-rdscope-clock", sourceClockAt }),
    );
    expect(status).toBe(201);
    // Was previously dropped from the INSERT → would read back as null.
    expect(captured).toBe(sourceClockAt);

    const res = await h.harness.http().get(`/api/pos/v1/sales/${saleRef}`);
    expect(res.status).toBe(200);
    expect(res.body.sourceClockAt).toBe(sourceClockAt);
  });
});
