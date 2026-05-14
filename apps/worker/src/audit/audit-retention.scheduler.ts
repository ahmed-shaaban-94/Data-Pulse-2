/**
 * AuditRetentionScheduler — T311 Layer B.
 *
 * Registers a daily BullMQ repeatable job so `AuditRetentionWorker` fires
 * once every 24 hours to mark eligible audit_events rows.
 *
 * Uses `Queue.upsertJobScheduler` (BullMQ ≥ 5.x).  The call is idempotent:
 * re-running `onModuleInit` with the same schedulerId simply updates the
 * existing schedule in Redis without duplicating jobs.
 *
 * REDIS_URL policy (mirrors workerFactoryProviderFactory):
 *   - production + no REDIS_URL  → throw at boot (fail loud)
 *   - non-production + no REDIS_URL → no-op (safe dev/CI path)
 *   - REDIS_URL present → register the scheduler
 */
import { Injectable, type OnModuleInit, type OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { AUDIT_RETENTION_JOB_NAME } from "./audit-retention.processor";
import { AUDIT_RETENTION_QUEUE_NAME } from "./audit-retention.worker";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuditRetentionScheduler implements OnModuleInit, OnModuleDestroy {
  private queue: Queue | null = null;

  async onModuleInit(): Promise<void> {
    const url = process.env["REDIS_URL"];
    if (!url) {
      if (process.env["NODE_ENV"] === "production") {
        throw new Error(
          "AuditRetentionScheduler: REDIS_URL is required in production " +
            "(cannot schedule audit retention sweep without Redis).",
        );
      }
      return;
    }
    this.queue = new Queue(AUDIT_RETENTION_QUEUE_NAME, {
      connection: { url },
    });
    await this.queue.upsertJobScheduler(
      AUDIT_RETENTION_JOB_NAME,
      { every: TWENTY_FOUR_HOURS_MS },
      { name: AUDIT_RETENTION_JOB_NAME, data: {} },
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
