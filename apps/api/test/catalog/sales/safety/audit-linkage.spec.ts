/**
 * audit-linkage.spec.ts — 008 US6 T072.
 *
 * Capture → void → refund each emit ONE canonical audit event through the
 * shipped AuditEmitterInterceptor (FR-090/092, SC-009): actor, tenant, store,
 * action, target (nullable), correlation id (request_id). The metadata field is
 * NULL — no raw payload / secret is ever carried in the audit record (FR-042 /
 * §XIV PII discipline). The audit path is insert-only (the enqueuer only ever
 * appends).
 */
import {
  startCaptureHarness,
  stopCaptureHarness,
  resetHarness,
  captureBody,
  idempKey,
  DEVICE_USER_ID,
  TENANT_A,
  STORE_A_X,
  type HarnessHandle,
} from "../capture/__capture-harness";
import type { AuditJobEnqueuer } from "../../../../src/audit/audit-job.enqueuer";
import type { AuditJobPayload } from "../../../../src/audit/audit-job.types";

class SpyAuditEnqueuer implements AuditJobEnqueuer {
  public calls: AuditJobPayload[] = [];
  async enqueue(payload: AuditJobPayload): Promise<void> {
    this.calls.push(payload);
  }
  reset(): void {
    this.calls = [];
  }
}

const spy = new SpyAuditEnqueuer();
const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startCaptureHarness({ auditEnqueuer: spy }));
}, 180_000);
afterAll(async () => {
  await stopCaptureHarness(h);
}, 60_000);
beforeEach(() => {
  resetHarness(h);
  spy.reset();
});
afterEach(async () => {
  if (h.harness) {
    await h.harness.env.admin.query(
      "DELETE FROM sale_refunds WHERE source_system = 'pos-1'",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sale_voids WHERE source_system = 'pos-1'",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sale_lines WHERE sale_id IN (SELECT id FROM sales WHERE source_system = 'pos-1')",
    );
    await h.harness.env.admin.query(
      "DELETE FROM sales WHERE source_system = 'pos-1'",
    );
  }
});

describe("T072 — audit linkage across capture / void / refund", () => {
  it("each transition emits one canonical audit event, no raw payload in metadata", async () => {
    if (h.dockerSkipped || !h.harness) return;

    const cap = await h.harness
      .http()
      .post("/api/pos/v1/sales")
      .set("Idempotency-Key", idempKey("aud-cap"))
      .send(captureBody({ externalId: "ext-audit" }));
    expect(cap.status).toBe(201);
    const saleRef = cap.body.saleRef;

    const voided = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/void`)
      .set("Idempotency-Key", idempKey("aud-void"))
      .send({ sourceSystem: "pos-1", externalId: "audit-void" });
    expect(voided.status).toBe(201);

    const refunded = await h.harness
      .http()
      .post(`/api/pos/v1/sales/${saleRef}/refund`)
      .set("Idempotency-Key", idempKey("aud-ref"))
      .send({
        sourceSystem: "pos-1",
        externalId: "audit-refund",
        posRefundAmount: "1.0000",
        currencyCode: "USD",
      });
    expect(refunded.status).toBe(201);

    // Exactly one event per successful transition, in order.
    expect(spy.calls.map((c) => c.action)).toEqual([
      "sale.captured",
      "sale.voided",
      "sale.refunded",
    ]);

    for (const evt of spy.calls) {
      // Actor + scope are resolved from the principal/context, never the body.
      expect(evt.actor_user_id).toBe(DEVICE_USER_ID);
      expect(evt.tenant_id).toBe(TENANT_A);
      expect(evt.store_id).toBe(STORE_A_X);
      // Correlation id present for traceability.
      expect(typeof evt.request_id).toBe("string");
      expect(evt.request_id).not.toBe("");
      // No raw payload / secret ever travels in audit metadata (FR-042/090/092).
      expect(evt.metadata).toBeNull();
      expect(JSON.stringify(evt)).not.toContain("payload_hash");
    }
  });
});
