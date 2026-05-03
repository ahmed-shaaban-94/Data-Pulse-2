/**
 * T091 — WorkerModule + workerFactoryProviderFactory spec.
 *
 * Verifies the production-vs-dev REDIS_URL branch behaviour at the
 * factory level, plus a smoke test that the Nest module assembles its
 * provider graph in the dev/no-Redis path. We never start a real
 * BullMQ Worker — production-path tests only check the factory CLASS
 * is `BullMqWorkerFactory`, not that it boots a Worker.
 *
 * NODE_ENV strategy
 * -----------------
 * Each test mutates `NODE_ENV` and `REDIS_URL` via the local helpers
 * below and restores them in `afterEach`. No global default.
 */
import { Test } from "@nestjs/testing";
import {
  BullMqWorkerFactory,
  NoOpWorkerFactory,
  workerFactoryProviderFactory,
  WorkerModule,
} from "../src/worker.module";
import { EmailWorker } from "../src/email/email.worker";
import { DEFAULT_WORKER_OPTIONS } from "@data-pulse-2/shared/queues/queue-config";

const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_REDIS_URL = process.env["REDIS_URL"];

afterEach(() => {
  // Restore env between tests. `delete env.X` if the original was unset
  // — assigning `undefined` would set it to the literal string "undefined".
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

describe("workerFactoryProviderFactory — REDIS_URL branch behaviour", () => {
  it("throws when NODE_ENV=production and REDIS_URL is missing (fail loud)", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["REDIS_URL"];
    expect(() => workerFactoryProviderFactory()).toThrow(
      /REDIS_URL is required in production/,
    );
  });

  it("returns a NoOpWorkerFactory when not in production and REDIS_URL is missing", () => {
    process.env["NODE_ENV"] = "development";
    delete process.env["REDIS_URL"];
    const f = workerFactoryProviderFactory();
    expect(f).toBeInstanceOf(NoOpWorkerFactory);
  });

  it("returns a NoOpWorkerFactory when NODE_ENV is unset (treated as non-production)", () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    const f = workerFactoryProviderFactory();
    expect(f).toBeInstanceOf(NoOpWorkerFactory);
  });

  it("returns a BullMqWorkerFactory when REDIS_URL is set, regardless of NODE_ENV", () => {
    process.env["NODE_ENV"] = "production";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    const f = workerFactoryProviderFactory();
    expect(f).toBeInstanceOf(BullMqWorkerFactory);
  });
});

describe("NoOpWorkerFactory.create", () => {
  it("returns a worker whose close() resolves and on() is a no-op", async () => {
    const f = new NoOpWorkerFactory();
    const w = f.create(
      "email",
      async () => {
        // never invoked — NoOpWorker doesn't dispatch jobs
      },
      DEFAULT_WORKER_OPTIONS,
    );
    expect(() => w.on("error", () => undefined)).not.toThrow();
    await expect(w.close()).resolves.toBeUndefined();
  });

  it("accepts the WorkerStartOptions argument and ignores it (interface parity)", () => {
    const f = new NoOpWorkerFactory();
    expect(() =>
      f.create("email", async () => undefined, DEFAULT_WORKER_OPTIONS),
    ).not.toThrow();
  });
});

describe("BullMqWorkerFactory — interface shape", () => {
  // We deliberately do NOT instantiate the underlying bullmq.Worker here
  // (it would require Redis). We only verify the factory's `create`
  // method signature accepts the options argument; the actual spread
  // into `new Worker(...)` is type-checked by `tsc -p tsconfig.build.json`
  // and exercised end-to-end on a Redis-equipped environment.
  it("create() takes (queueName, handler, options)", () => {
    const f = new BullMqWorkerFactory("redis://localhost:6379");
    expect(typeof f.create).toBe("function");
    expect(f.create.length).toBe(3);
  });
});

describe("WorkerModule — Nest DI graph (dev / no-Redis path)", () => {
  it("resolves EmailWorker without booting Redis or BullMQ", async () => {
    delete process.env["NODE_ENV"];
    delete process.env["REDIS_URL"];
    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    const emailWorker = moduleRef.get(EmailWorker);
    expect(emailWorker).toBeInstanceOf(EmailWorker);

    // Calling start() on the dev-path worker exercises the NoOp
    // factory; it must not throw and must not require Redis.
    expect(() => emailWorker.start()).not.toThrow();
    await emailWorker.close();
    await moduleRef.close();
  });
});
