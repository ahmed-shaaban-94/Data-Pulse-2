/**
 * T301 — worker queue.config spec.
 *
 * Three concerns:
 *
 * 1. Re-export identity
 *    The worker shim must re-export the SAME object references as the
 *    shared package (toBe, not toEqual). A copy-paste regression where
 *    someone inlines a duplicate constant would silently allow the two
 *    sides to diverge; this pin catches it at the import boundary.
 *
 * 2. DLQ metric registry — presence and coverage
 *    - Exactly three entries (email + audit + session-revoke).
 *    - Each descriptor is structurally valid (non-empty strings).
 *    - metric keys follow the `queue.<name>.dlq` convention.
 *    - Registry is deeply frozen (immutability — same rationale as shared).
 *
 * 3. Registry–worker consistency
 *    Every queue named in the registry matches a known `*_QUEUE_NAME`
 *    constant. Drift between the registry and the worker class is the
 *    most common source of "metrics say OK but queue is silently dead"
 *    bugs.
 *
 * No BullMQ runtime, no Redis, no Postgres.
 */
import {
  DEFAULT_JOB_OPTIONS,
  DEFAULT_WORKER_OPTIONS,
  deepFreeze as workerDeepFreeze,
  DLQ_METRIC_REGISTRY,
  type DlqMetricDescriptor,
} from "../../src/queues/queue.config";

import {
  DEFAULT_JOB_OPTIONS as SHARED_JOB_OPTIONS,
  DEFAULT_WORKER_OPTIONS as SHARED_WORKER_OPTIONS,
  deepFreeze as sharedDeepFreeze,
} from "@data-pulse-2/shared/queues/queue-config";

import { EMAIL_QUEUE_NAME } from "../../src/email/email.worker";
import { AUDIT_QUEUE_NAME } from "../../src/audit/audit.worker";
import { SESSION_REVOKE_JOB_NAME } from "../../src/auth/session-revoke.processor";

// ---------------------------------------------------------------------------
// 1. Re-export identity — worker shim must not duplicate shared constants
// ---------------------------------------------------------------------------

describe("worker queue.config — re-export identity", () => {
  it("DEFAULT_JOB_OPTIONS is the same object reference as the shared constant", () => {
    expect(DEFAULT_JOB_OPTIONS).toBe(SHARED_JOB_OPTIONS);
  });

  it("DEFAULT_WORKER_OPTIONS is the same object reference as the shared constant", () => {
    expect(DEFAULT_WORKER_OPTIONS).toBe(SHARED_WORKER_OPTIONS);
  });

  it("deepFreeze re-export resolves to the same function as the shared export", () => {
    expect(workerDeepFreeze).toBe(sharedDeepFreeze);
  });
});

// ---------------------------------------------------------------------------
// 2. DLQ_METRIC_REGISTRY — coverage, shape, and immutability
// ---------------------------------------------------------------------------

describe("DLQ_METRIC_REGISTRY — coverage", () => {
  it("contains exactly three entries (email + audit + session-revoke)", () => {
    expect(DLQ_METRIC_REGISTRY).toHaveLength(3);
  });

  it("contains an entry for the email queue", () => {
    const found = DLQ_METRIC_REGISTRY.find((d) => d.queueName === EMAIL_QUEUE_NAME);
    expect(found).toBeDefined();
  });

  it("contains an entry for the audit queue", () => {
    const found = DLQ_METRIC_REGISTRY.find((d) => d.queueName === AUDIT_QUEUE_NAME);
    expect(found).toBeDefined();
  });

  it("contains an entry for the session-revoke queue", () => {
    const found = DLQ_METRIC_REGISTRY.find((d) => d.queueName === SESSION_REVOKE_JOB_NAME);
    expect(found).toBeDefined();
  });

  it("queue names are non-empty strings", () => {
    for (const d of DLQ_METRIC_REGISTRY) {
      expect(typeof d.queueName).toBe("string");
      expect(d.queueName.length).toBeGreaterThan(0);
    }
  });

  it("metric keys are non-empty strings", () => {
    for (const d of DLQ_METRIC_REGISTRY) {
      expect(typeof d.metricKey).toBe("string");
      expect(d.metricKey.length).toBeGreaterThan(0);
    }
  });
});

describe("DLQ_METRIC_REGISTRY — metric key convention", () => {
  it("email metric key follows queue.<name>.dlq convention", () => {
    const d = DLQ_METRIC_REGISTRY.find((e) => e.queueName === EMAIL_QUEUE_NAME)!;
    expect(d.metricKey).toBe(`queue.${EMAIL_QUEUE_NAME}.dlq`);
  });

  it("audit metric key follows queue.<name>.dlq convention", () => {
    const d = DLQ_METRIC_REGISTRY.find((e) => e.queueName === AUDIT_QUEUE_NAME)!;
    expect(d.metricKey).toBe(`queue.${AUDIT_QUEUE_NAME}.dlq`);
  });

  it("session-revoke metric key follows queue.<name>.dlq convention", () => {
    const d = DLQ_METRIC_REGISTRY.find((e) => e.queueName === SESSION_REVOKE_JOB_NAME)!;
    expect(d.metricKey).toBe(`queue.${SESSION_REVOKE_JOB_NAME}.dlq`);
  });

  it("all metric keys start with 'queue.' prefix", () => {
    for (const d of DLQ_METRIC_REGISTRY) {
      expect(d.metricKey).toMatch(/^queue\./);
    }
  });

  it("all metric keys end with '.dlq' suffix", () => {
    for (const d of DLQ_METRIC_REGISTRY) {
      expect(d.metricKey).toMatch(/\.dlq$/);
    }
  });
});

describe("DLQ_METRIC_REGISTRY — immutability", () => {
  it("registry array is frozen at the top level", () => {
    expect(Object.isFrozen(DLQ_METRIC_REGISTRY)).toBe(true);
  });

  it("each descriptor object is frozen (deep freeze)", () => {
    for (const d of DLQ_METRIC_REGISTRY) {
      expect(Object.isFrozen(d)).toBe(true);
    }
  });

  it("mutating a descriptor throws in strict mode", () => {
    "use strict";
    const d = DLQ_METRIC_REGISTRY[0]!;
    expect(() => {
      (d as unknown as { queueName: string }).queueName = "tampered";
    }).toThrow();
  });

  it("mutating the registry array throws in strict mode", () => {
    "use strict";
    expect(() => {
      (DLQ_METRIC_REGISTRY as unknown as DlqMetricDescriptor[])[0] = {
        queueName: "tampered",
        metricKey: "tampered",
      };
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Registry–worker consistency
// ---------------------------------------------------------------------------

describe("DLQ_METRIC_REGISTRY — worker class consistency", () => {
  const knownQueueNames = new Set([EMAIL_QUEUE_NAME, AUDIT_QUEUE_NAME, SESSION_REVOKE_JOB_NAME]);

  it("every registry entry references a known *_QUEUE_NAME constant", () => {
    for (const d of DLQ_METRIC_REGISTRY) {
      expect(knownQueueNames.has(d.queueName)).toBe(true);
    }
  });

  it("queue names in the registry are unique (no duplicate queue entry)", () => {
    const names = DLQ_METRIC_REGISTRY.map((d) => d.queueName);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it("metric keys in the registry are unique (no two queues share a metric key)", () => {
    const keys = DLQ_METRIC_REGISTRY.map((d) => d.metricKey);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });
});
