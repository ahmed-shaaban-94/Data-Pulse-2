/**
 * T584 — AuditEventCreatedConsumer unit test.
 *
 * No Docker, no Postgres, no Redis — pure unit test. The consumer's
 * responsibility is: validate the outbox event payload, then enqueue a
 * BullMQ "audit-fanout" job. Both responsibilities are exercised here.
 *
 * Coverage:
 *   AC-1  Happy path: valid payload → exactly one queue.add call with the
 *         expected job name and data shape.
 *   AC-2  Validation: malformed payload → throw an Error whose name is a
 *         redacted error class (NOT containing PII / payload content).
 *   AC-3  Job-name contract: AUDIT_QUEUE_NAME = "audit", AUDIT_JOB_NAME =
 *         "audit-fanout" — locked literals matching the existing producer.
 *   AC-4  Correlation propagation: when payload.request_id is null but
 *         the envelope carries a correlation_id, the queue job receives
 *         the correlation_id as request_id.
 *   AC-5  No jobId: opts MUST NOT contain a `jobId` — every audit emission
 *         is a distinct row (FR-AUDIT-1).
 *   AC-6  Consumer surface: consumerId + eventType constants match the
 *         contract used by the drainer registry.
 */
import {
  AuditEventCreatedConsumer,
  AUDIT_EVENT_CREATED_CONSUMER_ID,
  OUTBOX_AUDIT_QUEUE_NAME,
  OUTBOX_AUDIT_JOB_NAME,
  type AuditQueueLike,
  type AuditEventCreatedPayload,
} from "../../src/outbox/consumers/audit-event-created.consumer";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";

// ---------------------------------------------------------------------------
// Fake queue
// ---------------------------------------------------------------------------

class FakeQueue implements AuditQueueLike {
  calls: Array<{ name: string; data: unknown; opts: Record<string, unknown> | undefined }> = [];
  async add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ name, data, opts });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const validPayload: AuditEventCreatedPayload = {
  actor_user_id: "00000000-0000-7000-8000-000000000001",
  actor_label:   null,
  tenant_id:     "00000000-0000-7000-8000-000000000002",
  store_id:      null,
  action:        "context.switch.tenant",
  target_type:   null,
  target_id:     null,
  request_id:    "00000000-0000-7000-8000-000000000003",
  metadata:      null,
};

function envelope(
  payload: unknown,
  overrides: Partial<OutboxEventEnvelope<unknown>> = {},
): OutboxEventEnvelope<unknown> {
  return {
    event_id:       "0e000000-0000-4000-8000-000000000001",
    event_type:     "audit.event.created",
    tenant_id:      "00000000-0000-7000-8000-000000000002",
    store_id:       null,
    payload,
    correlation_id: "corr-0001",
    attempts:       1,
    occurred_at:    new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1 / AC-3 / AC-5: happy path and contract literals
// ---------------------------------------------------------------------------

describe("AuditEventCreatedConsumer — happy path (AC-1, AC-3, AC-5)", () => {
  it("AC-3: queue name literals are pinned", () => {
    expect(OUTBOX_AUDIT_QUEUE_NAME).toBe("audit");
    expect(OUTBOX_AUDIT_JOB_NAME).toBe("audit-fanout");
  });

  it("AC-1: valid payload triggers exactly one queue.add with the expected job name", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    await consumer.handle(envelope(validPayload) as OutboxEventEnvelope<AuditEventCreatedPayload>);

    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0]!.name).toBe(OUTBOX_AUDIT_JOB_NAME);

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data).toMatchObject({
      action: "context.switch.tenant",
      tenant_id: validPayload.tenant_id,
      actor_user_id: validPayload.actor_user_id,
    });
  });

  it("AC-5: queue.add opts MUST NOT include a jobId", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);
    await consumer.handle(envelope(validPayload) as OutboxEventEnvelope<AuditEventCreatedPayload>);

    const opts = queue.calls[0]!.opts;
    // opts may be undefined or an object — if an object, it MUST NOT have jobId.
    if (opts !== undefined) {
      expect(opts["jobId"]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// AC-2: validation failure → redacted error
// ---------------------------------------------------------------------------

describe("AuditEventCreatedConsumer — payload validation (AC-2)", () => {
  it("rejects payload missing required `action` with an Error whose message does NOT leak field values", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const malformed = {
      ...validPayload,
      action: undefined as unknown as string,
    };

    let caught: Error | null = null;
    try {
      await consumer.handle(envelope(malformed) as OutboxEventEnvelope<AuditEventCreatedPayload>);
    } catch (err) {
      caught = err instanceof Error ? err : new Error(String(err));
    }

    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/malformed payload/);
    // The error must NOT include any UUID from the payload — only the
    // field name + Zod's structural diagnosis.
    expect(caught!.message).not.toContain(validPayload.actor_user_id!);
    expect(caught!.message).not.toContain(validPayload.tenant_id!);

    // No queue.add call happened.
    expect(queue.calls).toHaveLength(0);
  });

  it("rejects payload with wrong type on `actor_user_id` (number instead of uuid string)", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const malformed = {
      ...validPayload,
      actor_user_id: 12345 as unknown as string,
    };

    await expect(
      consumer.handle(envelope(malformed) as OutboxEventEnvelope<AuditEventCreatedPayload>),
    ).rejects.toThrow(/malformed payload/);

    expect(queue.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// AC-4: correlation propagation
// ---------------------------------------------------------------------------

describe("AuditEventCreatedConsumer — correlation propagation (AC-4)", () => {
  it("uses envelope.correlation_id as request_id when payload.request_id is null", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    const payloadNoRequestId: AuditEventCreatedPayload = {
      ...validPayload,
      request_id: null,
    };

    await consumer.handle(
      envelope(payloadNoRequestId, { correlation_id: "fallback-corr-001" }) as OutboxEventEnvelope<AuditEventCreatedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["request_id"]).toBe("fallback-corr-001");
  });

  it("keeps payload.request_id when it is present (does not overwrite with correlation_id)", async () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);

    await consumer.handle(
      envelope(validPayload, { correlation_id: "should-not-be-used" }) as OutboxEventEnvelope<AuditEventCreatedPayload>,
    );

    const data = queue.calls[0]!.data as Record<string, unknown>;
    expect(data["request_id"]).toBe(validPayload.request_id);
  });
});

// ---------------------------------------------------------------------------
// AC-6: consumer surface
// ---------------------------------------------------------------------------

describe("AuditEventCreatedConsumer — registry surface (AC-6)", () => {
  it("exposes stable consumerId and eventType for the drainer registry", () => {
    const queue = new FakeQueue();
    const consumer = new AuditEventCreatedConsumer(queue);
    expect(consumer.consumerId).toBe(AUDIT_EVENT_CREATED_CONSUMER_ID);
    expect(consumer.consumerId).toBe("worker.audit.event.created");
    expect(consumer.eventType).toBe("audit.event.created");
  });
});
