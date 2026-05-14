/**
 * AuditRetentionScheduler unit tests — T311 Layer B.
 *
 * BullMQ's Queue class is mocked so no Redis connection is attempted.
 * env vars (REDIS_URL, NODE_ENV) are managed per-test and restored in
 * afterEach.
 *
 * Coverage:
 *   - queue name passed to Queue constructor is "audit-retention"
 *   - upsertJobScheduler called with job name "audit-retention-sweep"
 *   - cadence is exactly 24 hours (86400000 ms)
 *   - payload passed to upsertJobScheduler is {}
 *   - onModuleDestroy() closes the queue
 *   - onModuleDestroy() before onModuleInit() is a tolerated no-op
 *   - onModuleDestroy() is idempotent (second call does not re-close)
 *   - no-op when non-production and REDIS_URL is absent
 *   - throws when NODE_ENV=production and REDIS_URL is absent
 */

// jest.mock is hoisted before imports; the factory returns jest.fn() mocks
// whose instances are accessible via (Queue as jest.Mock).mock after import.
jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    upsertJobScheduler: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

import { Queue } from "bullmq";
import { AuditRetentionScheduler } from "../../src/audit/audit-retention.scheduler";
import { AUDIT_RETENTION_JOB_NAME } from "../../src/audit/audit-retention.processor";
import { AUDIT_RETENTION_QUEUE_NAME } from "../../src/audit/audit-retention.worker";

const MockQueue = Queue as unknown as jest.Mock;

const ORIGINAL_REDIS_URL = process.env["REDIS_URL"];
const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const FAKE_REDIS_URL = "redis://localhost:6379";

afterEach(() => {
  jest.clearAllMocks();
  if (ORIGINAL_REDIS_URL === undefined) {
    delete process.env["REDIS_URL"];
  } else {
    process.env["REDIS_URL"] = ORIGINAL_REDIS_URL;
  }
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env["NODE_ENV"];
  } else {
    process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLastInstance(): {
  upsertJobScheduler: jest.Mock;
  close: jest.Mock;
} {
  const result = MockQueue.mock.results[MockQueue.mock.results.length - 1];
  if (!result) throw new Error("Queue constructor was not called");
  return result.value as { upsertJobScheduler: jest.Mock; close: jest.Mock };
}

// ---------------------------------------------------------------------------
// Queue name
// ---------------------------------------------------------------------------

describe("AuditRetentionScheduler — queue name", () => {
  it("creates a Queue with name 'audit-retention'", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    expect(MockQueue).toHaveBeenCalledWith(
      "audit-retention",
      expect.anything(),
    );
  });

  it("queue name matches AUDIT_RETENTION_QUEUE_NAME constant", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    expect(MockQueue.mock.calls[0]![0]).toBe(AUDIT_RETENTION_QUEUE_NAME);
  });
});

// ---------------------------------------------------------------------------
// Connection options
// ---------------------------------------------------------------------------

describe("AuditRetentionScheduler — Redis connection", () => {
  it("passes REDIS_URL as connection.url to the Queue constructor", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    expect(MockQueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ connection: { url: FAKE_REDIS_URL } }),
    );
  });
});

// ---------------------------------------------------------------------------
// Job name
// ---------------------------------------------------------------------------

describe("AuditRetentionScheduler — job name", () => {
  it("registers scheduler with job name 'audit-retention-sweep'", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    const instance = getLastInstance();
    expect(instance.upsertJobScheduler).toHaveBeenCalledWith(
      "audit-retention-sweep",
      expect.anything(),
      expect.anything(),
    );
  });

  it("schedulerId matches AUDIT_RETENTION_JOB_NAME constant", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    const instance = getLastInstance();
    const [schedulerId] = instance.upsertJobScheduler.mock.calls[0] as [string];
    expect(schedulerId).toBe(AUDIT_RETENTION_JOB_NAME);
  });
});

// ---------------------------------------------------------------------------
// Cadence — 24 hours
// ---------------------------------------------------------------------------

describe("AuditRetentionScheduler — 24h cadence", () => {
  it("repeat options contain every: 86400000 (24h in ms)", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    const instance = getLastInstance();
    const [, repeatOpts] = instance.upsertJobScheduler.mock.calls[0] as [
      string,
      { every: number },
    ];
    expect(repeatOpts.every).toBe(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

describe("AuditRetentionScheduler — job template payload", () => {
  it("job template data is {} (empty object)", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    const instance = getLastInstance();
    const [, , jobTemplate] = instance.upsertJobScheduler.mock.calls[0] as [
      string,
      unknown,
      { name: string; data: unknown },
    ];
    expect(jobTemplate.data).toEqual({});
  });

  it("job template name matches the scheduler ID", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    const instance = getLastInstance();
    const [schedulerId, , jobTemplate] = instance.upsertJobScheduler.mock.calls[0] as [
      string,
      unknown,
      { name: string; data: unknown },
    ];
    expect(jobTemplate.name).toBe(schedulerId);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle — close
// ---------------------------------------------------------------------------

describe("AuditRetentionScheduler — onModuleDestroy", () => {
  it("closes the queue on destroy", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    const instance = getLastInstance();
    await scheduler.onModuleDestroy();
    expect(instance.close).toHaveBeenCalledTimes(1);
  });

  it("onModuleDestroy before onModuleInit is a tolerated no-op", async () => {
    delete process.env["REDIS_URL"];
    const scheduler = new AuditRetentionScheduler();
    await expect(scheduler.onModuleDestroy()).resolves.toBeUndefined();
  });

  it("onModuleDestroy is idempotent — second call does not re-close", async () => {
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    const instance = getLastInstance();
    await scheduler.onModuleDestroy();
    await scheduler.onModuleDestroy();
    expect(instance.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// REDIS_URL policy
// ---------------------------------------------------------------------------

describe("AuditRetentionScheduler — REDIS_URL policy", () => {
  it("is a no-op in non-production when REDIS_URL is absent", async () => {
    process.env["NODE_ENV"] = "development";
    delete process.env["REDIS_URL"];
    const scheduler = new AuditRetentionScheduler();
    await expect(scheduler.onModuleInit()).resolves.toBeUndefined();
    expect(MockQueue).not.toHaveBeenCalled();
  });

  it("is a no-op when NODE_ENV is unset and REDIS_URL is absent", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    const scheduler = new AuditRetentionScheduler();
    await expect(scheduler.onModuleInit()).resolves.toBeUndefined();
    expect(MockQueue).not.toHaveBeenCalled();
  });

  it("throws in production when REDIS_URL is absent", async () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["REDIS_URL"];
    const scheduler = new AuditRetentionScheduler();
    await expect(scheduler.onModuleInit()).rejects.toThrow(
      /REDIS_URL is required in production/,
    );
  });

  it("production throw message names AuditRetentionScheduler", async () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["REDIS_URL"];
    const scheduler = new AuditRetentionScheduler();
    await expect(scheduler.onModuleInit()).rejects.toThrow(
      /AuditRetentionScheduler/,
    );
  });

  it("registers the scheduler when REDIS_URL is set in production", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["REDIS_URL"] = FAKE_REDIS_URL;
    const scheduler = new AuditRetentionScheduler();
    await scheduler.onModuleInit();
    expect(MockQueue).toHaveBeenCalledTimes(1);
    await scheduler.onModuleDestroy();
  });
});
