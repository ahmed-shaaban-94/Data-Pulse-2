/**
 * OutboxRetentionScheduler -- T590 Layer B.
 *
 * Registers a daily BullMQ repeatable job so `OutboxRetentionWorker` fires
 * once every 24 hours to purge eligible outbox_events rows.
 *
 * Uses `Queue.upsertJobScheduler` (BullMQ >= 5.x). The call is idempotent:
 * re-running `onModuleInit` with the same job name simply updates the
 * existing schedule in Redis without duplicating jobs.
 *
 * REDIS_URL policy (mirrors `AuditRetentionScheduler`):
 *   - production + no REDIS_URL  -> throw at boot (fail loud)
 *   - non-production + no REDIS_URL -> no-op (safe dev/CI path)
 *   - REDIS_URL present -> register the scheduler
 *
 * Cadence
 * -------
 * 24h matches the audit-retention parallel and the policy doc
 * (docs/outbox/lifecycle.md section 5 -- "daily retention worker").
 *
 * Testability
 * -----------
 * Tests do NOT wait 24h. The scheduler is unit-tested by mocking BullMQ's
 * Queue and asserting `upsertJobScheduler` was called with the expected
 * cadence and job name. End-to-end behaviour is exercised by calling
 * `OutboxRetentionProcessor.process()` directly (Layer A) or by enqueuing
 * a one-off job through the worker glue.
 */
import { Injectable, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { OUTBOX_RETENTION_JOB_NAME } from "./retention.processor";
import { OUTBOX_RETENTION_QUEUE_NAME } from "./retention.worker";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class OutboxRetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  async onModuleInit(): Promise<void> {
    const url = process.env["REDIS_URL"];
    if (!url) {
      if (process.env["NODE_ENV"] === "production") {
        throw new Error(
          "OutboxRetentionScheduler: REDIS_URL is required in production " +
            "(cannot schedule outbox retention sweep without Redis).",
        );
      }
      return;
    }
    this.queue = new Queue(OUTBOX_RETENTION_QUEUE_NAME, {
      connection: { url },
    });
    await this.queue.upsertJobScheduler(
      OUTBOX_RETENTION_JOB_NAME,
      { every: TWENTY_FOUR_HOURS_MS },
      { name: OUTBOX_RETENTION_JOB_NAME, data: {} },
    );
  }

  async onModuleDestroy(): Promise<void> {
    const q = this.queue;
    this.queue = null;
    if (q !== null) {
      await q.close();
    }
  }
}
