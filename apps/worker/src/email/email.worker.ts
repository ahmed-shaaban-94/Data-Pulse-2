/**
 * EmailWorker — slice 6 (T090).
 *
 * Thin BullMQ glue. Knows two things and only two things:
 *   1. The queue name (`"email"`, mirroring `apps/api/src/auth/auth.module.ts`).
 *   2. How to delegate `(job.name, job.data)` to the injected
 *      `EmailProcessor` from PR #15.
 *
 * Everything else — retry/backoff/DLQ policy (T092 / T301), provider
 * SDK selection (PQ-1), and metrics — lives in other slices. Keeping
 * this glue layer thin means the BullMQ runtime is contained to one
 * file and unit-tested by injecting a `WorkerFactory` interface.
 *
 * Why a `WorkerFactory` instead of constructing `new Worker(...)` here?
 * --------------------------------------------------------------------
 *   - Tests can inject a `FakeWorkerFactory` and capture the registered
 *     handler without booting Redis or BullMQ.
 *   - Production wiring (`worker.module.ts`) injects a
 *     `BullMqWorkerFactory` that builds the real BullMQ `Worker`.
 *   - Same `*Like`-interface pattern PR #14 (`QueueLike`) and PR #15
 *     (`RecordingEmailAdapter`) used. One repo idiom.
 *
 * Lifecycle
 * ---------
 *   - `start()` constructs the underlying worker via the factory and
 *     subscribes to its `"error"` event for diagnostic logging only
 *     (T092 / T301 will configure retry/backoff/DLQ).
 *   - `close()` shuts the worker down cleanly (drains in-flight jobs).
 *     Called by Nest's `onModuleDestroy` hook, which `main.ts` triggers
 *     on SIGTERM / SIGINT.
 *
 * Idempotent: calling `start()` twice or `close()` before `start()` is
 * tolerated; the test pins both behaviours.
 */
import {
  Inject,
  Injectable,
  type OnModuleDestroy,
} from "@nestjs/common";
import { EmailProcessor } from "./email.processor";

/**
 * The queue name shared with `EmailQueueProducer`. Mirrors
 * `EMAIL_QUEUE_NAME` in `apps/api/src/auth/auth.module.ts`.
 *
 * The literal MUST equal the producer's literal; a unit test pins
 * the string so any future drift fails CI loudly. We deliberately do
 * NOT import from `apps/api` — apps must not depend on each other.
 */
export const EMAIL_QUEUE_NAME = "email";

/**
 * The handler the BullMQ worker invokes for each job. We narrow to
 * just the two fields we use — the test fakes don't need to mock the
 * entire BullMQ `Job` type.
 */
export interface JobLike {
  readonly name: string;
  readonly data: unknown;
}

export type EmailJobHandler = (job: JobLike) => Promise<void>;

/**
 * Minimal surface our underlying worker exposes. Lets tests substitute
 * a `FakeWorker` without pulling in BullMQ's actual `Worker` class
 * (which would require Redis to construct).
 */
export interface WorkerLike {
  on(event: "error", listener: (err: Error) => void): unknown;
  close(): Promise<void>;
}

/**
 * Builds the underlying `WorkerLike` for a given (queueName, handler).
 * Production: `BullMqWorkerFactory` (in `worker.module.ts`) constructs
 * a real `bullmq.Worker`. Dev / test without Redis: `NoOpWorkerFactory`
 * returns a `NoOpWorker` whose `close()` is a no-op.
 */
export interface WorkerFactory {
  create(queueName: string, handler: EmailJobHandler): WorkerLike;
}

export const WORKER_FACTORY = "WORKER_FACTORY";

@Injectable()
export class EmailWorker implements OnModuleDestroy {
  private worker: WorkerLike | null = null;

  constructor(
    private readonly processor: EmailProcessor,
    @Inject(WORKER_FACTORY)
    private readonly workerFactory: WorkerFactory,
  ) {}

  /**
   * Constructs the BullMQ worker and starts consuming. Idempotent:
   * a second `start()` is a no-op.
   */
  start(): void {
    if (this.worker !== null) return;
    this.worker = this.workerFactory.create(
      EMAIL_QUEUE_NAME,
      (job) => this.processor.process(job.name, job.data),
    );
    this.worker.on("error", (err) => {
      // Diagnostic only. Retry/DLQ policy belongs to T092 / T301.
      // Stderr is structured-ish JSON without PII.
      const line = JSON.stringify({
        level: "error",
        component: "email.worker",
        message: err.message,
        name: err.name,
      });
      process.stderr.write(line + "\n");
    });
  }

  /**
   * Shuts the worker down cleanly. Idempotent: closing before start or
   * twice in a row is tolerated.
   */
  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w !== null) {
      await w.close();
    }
  }

  /** Nest lifecycle hook — fires on `app.close()` from `main.ts`. */
  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
