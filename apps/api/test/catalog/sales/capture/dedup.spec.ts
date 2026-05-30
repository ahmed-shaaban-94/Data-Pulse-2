/**
 * dedup.spec.ts — 008 US1 T033 (RED).
 *
 * Same `(tenant, sourceSystem, externalId)` submitted N times → exactly ONE
 * `sales` row, identical / deterministic response (FR-100), no double-apply
 * (FR-050, SC-003). The `(sourceSystem, externalId)` pair is recorded
 * provenance, never body-assignable authority (FR-041). A cross-tenant
 * `externalId` collision is isolated (SI-001).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  TENANT_A,
  TENANT_B,
  STORE_B_X,
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

describe("T033 — dedup on (tenant, sourceSystem, externalId)", () => {
  it("submitting the same provenance 3x yields exactly one row + identical response", async () => {
    if (h.dockerSkipped || !h.harness) return;
    const body = captureBody({ externalId: "ext-dedup-001" });

    const responses: Array<{ saleRef: string }> = [];
    for (let i = 0; i < 3; i++) {
      const res = await h.harness
        .http()
        .post("/api/pos/v1/sales")
        // Distinct idempotency keys per attempt — dedup must hold on PROVENANCE,
        // independent of the Idempotency-Key (a re-delivery, not a retry).
        .set("Idempotency-Key", idempKey(`dd${i}`))
        .send(body);
      if (i === 0) {
        // First delivery creates the fact.
        expect(res.status).toBe(201);
      } else {
        // Every subsequent identical-provenance delivery is a deterministic
        // replay (FR-100): 200 + the replay marker, never a second 201.
        expect(res.status).toBe(200);
        expect(res.headers["idempotent-replayed"]).toBe("true");
      }
      responses.push({ saleRef: res.body.saleRef });
    }

    // Deterministic: every response resolves to the SAME sale reference.
    expect(new Set(responses.map((r) => r.saleRef)).size).toBe(1);

    // Exactly one persisted row.
    const count = await h.harness.env.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM sales
       WHERE source_system = 'pos-1' AND external_id = 'ext-dedup-001'`,
    );
    expect(count.rows[0]?.n).toBe("1");
  });

  it("cross-tenant externalId collision is isolated (two rows, one per tenant)", async () => {
    if (h.dockerSkipped || !h.harness) return;
    // Tenant A submits ext-collide.
    await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("cta"))
      .send(captureBody({ externalId: "ext-collide" }));

    // Switch the POS principal to tenant B and submit the SAME externalId.
    h.harness.contextGuard.tenantId = TENANT_B;
    h.harness.contextGuard.storeId = STORE_B_X;
    await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("ctb"))
      .send(captureBody({ externalId: "ext-collide" }));

    // Two distinct rows — the dedup key is scoped by tenant_id (SI-001).
    const rows = await h.harness.env.admin.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM sales
       WHERE source_system = 'pos-1' AND external_id = 'ext-collide' ORDER BY tenant_id`,
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows.map((r) => r.tenant_id).sort()).toEqual(
      [TENANT_A, TENANT_B].sort(),
    );
  });
});
