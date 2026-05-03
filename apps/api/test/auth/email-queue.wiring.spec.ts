/**
 * email-queue.wiring spec — T301-partial.
 *
 * Verifies that `emailJobEnqueuerFactory()` constructs the BullMQ
 * `Queue` with `defaultJobOptions: DEFAULT_JOB_OPTIONS` from
 * `@data-pulse-2/shared`. This is the producer-side single-source-of-
 * truth wiring; the worker-side equivalent lives in
 * `apps/worker/test/email/email.worker.spec.ts`.
 *
 * Approach
 * --------
 * `jest.mock("bullmq")` replaces the BullMQ runtime with a mock
 * `Queue` constructor that records its (name, opts) args. No Redis,
 * no `ioredis-mock`, no Testcontainers. The factory function is
 * imported and invoked directly — we deliberately do NOT boot the
 * full `AuthModule` Nest DI graph (which would also pull in
 * `pg.Pool` and require `DATABASE_URL`).
 *
 * NODE_ENV / REDIS_URL state is mutated per-test and restored in
 * afterEach.
 */
import { DEFAULT_JOB_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

const queueCalls: Array<{ name: string; opts: Record<string, unknown> }> = [];

jest.mock("bullmq", () => {
  return {
    Queue: jest.fn().mockImplementation(function (this: unknown, name: string, opts: Record<string, unknown>) {
      queueCalls.push({ name, opts });
      return { add: jest.fn() };
    }),
  };
});

// Import AFTER `jest.mock` so the factory's `new Queue(...)` resolves to the mock.
// Use a require so the import is evaluated when the test file runs.
import {
  emailJobEnqueuerFactory,
  EMAIL_QUEUE_NAME,
} from "../../src/auth/auth.module";
import { EmailQueueProducer } from "../../src/auth/email-queue.producer";
import { NoOpEmailJobEnqueuer } from "../../src/auth/email-job.enqueuer";

const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_REDIS_URL = process.env["REDIS_URL"];

beforeEach(() => {
  queueCalls.length = 0;
});

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) {
    delete process.env["NODE_ENV"];
  } else {
    process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  }
  if (ORIGINAL_REDIS_URL === undefined) {
    delete process.env["REDIS_URL"];
  } else {
    process.env["REDIS_URL"] = ORIGINAL_REDIS_URL;
  }
});

describe("emailJobEnqueuerFactory — REDIS_URL branch behaviour", () => {
  it("throws when NODE_ENV=production and REDIS_URL is missing (fail loud)", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["REDIS_URL"];
    expect(() => emailJobEnqueuerFactory()).toThrow(
      /REDIS_URL is required in production/,
    );
    expect(queueCalls).toHaveLength(0);
  });

  it("returns a NoOpEmailJobEnqueuer when not in production and REDIS_URL is missing", () => {
    process.env["NODE_ENV"] = "development";
    delete process.env["REDIS_URL"];
    const out = emailJobEnqueuerFactory();
    expect(out).toBeInstanceOf(NoOpEmailJobEnqueuer);
    expect(queueCalls).toHaveLength(0);
  });

  it("returns a NoOp enqueuer when NODE_ENV is unset", () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    const out = emailJobEnqueuerFactory();
    expect(out).toBeInstanceOf(NoOpEmailJobEnqueuer);
  });
});

describe("emailJobEnqueuerFactory — Queue construction wiring", () => {
  it("constructs the BullMQ Queue with the 'email' queue name", () => {
    process.env["NODE_ENV"] = "production";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    emailJobEnqueuerFactory();
    expect(queueCalls).toHaveLength(1);
    expect(queueCalls[0]!.name).toBe(EMAIL_QUEUE_NAME);
    expect(queueCalls[0]!.name).toBe("email");
  });

  it("passes the connection URL through to the Queue", () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    emailJobEnqueuerFactory();
    expect(queueCalls[0]!.opts["connection"]).toEqual({
      url: "redis://localhost:6379",
    });
  });

  it("passes DEFAULT_JOB_OPTIONS from @data-pulse-2/shared as defaultJobOptions", () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    emailJobEnqueuerFactory();
    expect(queueCalls[0]!.opts["defaultJobOptions"]).toBe(DEFAULT_JOB_OPTIONS);
  });

  it("the forwarded defaultJobOptions equal the shared retry/backoff/DLQ values", () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    emailJobEnqueuerFactory();
    const opts = queueCalls[0]!.opts["defaultJobOptions"] as typeof DEFAULT_JOB_OPTIONS;
    expect(opts.attempts).toBe(DEFAULT_JOB_OPTIONS.attempts);
    expect(opts.backoff).toEqual(DEFAULT_JOB_OPTIONS.backoff);
    expect(opts.removeOnComplete).toEqual(DEFAULT_JOB_OPTIONS.removeOnComplete);
    expect(opts.removeOnFail).toEqual(DEFAULT_JOB_OPTIONS.removeOnFail);
  });

  it("returns an EmailQueueProducer wrapping the Queue", () => {
    process.env["REDIS_URL"] = "redis://localhost:6379";
    const out = emailJobEnqueuerFactory();
    expect(out).toBeInstanceOf(EmailQueueProducer);
  });
});
