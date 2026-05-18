/**
 * OutboxRetentionProcessor -- T590.
 *
 * Scheduled BullMQ processor that purges `outbox_events` rows past the
 * documented retention windows (docs/outbox/lifecycle.md section 5,
 * FR-C-007 audit-relevant carve-out, FR-C-004 right-to-erasure pass-through).
 *
 * Mirrors `audit-retention.processor.ts` -- same Layer-A / Layer-B split,
 * same DI seam, same Zod-validated payload, same batched loop. The two
 * differences from the audit-retention parallel:
 *
 *   1. DELETE (not UPDATE): outbox rows are purged outright once outside
 *      the retention window. Audit rows are mark-only (immutable facts).
 *   2. Two windows + audit carve-out: delivered non-audit -> 90d,
 *      failed/dead_lettered -> 365d, delivered audit.event.created -> 365d.
 *      The repository composes all three branches into a single SQL.
 *
 * Layered architecture
 * --------------------
 *   Layer A (this file): pure `(jobName, data) -> repo.purgeBatch(cutoffs, batchSize)`.
 *     Knows nothing about BullMQ runtime, Redis, retry, or DB connection.
 *   Layer B (retention.worker.ts + retention.scheduler.ts): BullMQ Worker
 *     bootstrap, daily repeatable-job schedule.
 *
 * Right-to-erasure
 * ----------------
 * Per docs/outbox/lifecycle.md line 87, right-to-erasure tombstones the
 * payload's PII fields out-of-band but leaves row metadata in place. The
 * purge predicate keys exclusively on `delivery_state`, `event_type`, and
 * timestamps -- it never reads the payload. So a tombstoned row crosses
 * its window cutoff and is purged exactly like any other row. This is the
 * test contract pinned by packages/db/__tests__/outbox/retention.spec.ts
 * suite RT-4 ("tombstoning does not interact with retention").
 *
 * Tenant context
 * --------------
 * The repository wraps each batch in
 *   `runWithTenantContext({ tenantId: null, isPlatformAdmin: true })`
 * so the platform-admin OR-branch of the outbox_events RLS policy applies
 * and a single sweep covers all tenants. This is the SAME posture the
 * outbox drainer uses for `claimBatch` (packages/db/src/outbox/repository.ts).
 * The platform-admin sweep is the positive counterpart to the tenant-scoped
 * negative locked by retention.spec.ts RT-6.
 *
 * Concurrency with the drainer
 * ----------------------------
 * The repository SQL uses `FOR UPDATE SKIP LOCKED` on the inner candidate
 * select. The drainer's `claimBatch` uses the same pattern. The two are
 * mutually non-blocking: a row claimed by the drainer is skipped by the
 * purge selector, and vice versa. Active rows (pending/claimed) are
 * excluded from the purge predicate regardless.
 *
 * Idempotency
 * -----------
 * A second run produces zero deletes once all eligible rows have been
 * purged; the loop terminates when a batch returns fewer than BATCH_SIZE
 * rows. Re-running the processor with the same clock is safe.
 *
 * Cross-app isolation
 * -------------------
 * This file MUST NOT import from `apps/api`. It MAY import from
 * `@data-pulse-2/db` -- the retention SQL contract lives in the worker
 * because the processor is worker-owned; the seam between processor and
 * production repository is the `OutboxRetentionRepository` interface
 * declared here.
 *
 * Logging policy
 * --------------
 * The processor returns `{ purgedCount, batchCount, durationMs }` for the
 * worker glue to log. The worker emits ONLY counts, batch sizes, duration,
 * and safe error class names -- never payloads, never PII. Mirrors the
 * drainer's PII-safe logging policy (drainer.processor.ts lines 307-334).
 */
import { Injectable, Inject, Optional } from "@nestjs/common";
import { z } from "zod";
import {
  BATCH_SIZE,
  computeRetentionCutoffs,
  type RetentionCutoffs,
} from "./retention.policy";

// ---------------------------------------------------------------------------
// Job name
// ---------------------------------------------------------------------------

/**
 * BullMQ job name. Must match the repeatable-job definition in
 * `retention.scheduler.ts`. Pinned by a unit test.
 *
 * Naming convention: `<domain>-<verb>` hyphenated, matching existing
 * patterns ("audit-retention-sweep", "audit-fanout", "soft-delete-sweep").
 */
export const OUTBOX_RETENTION_JOB_NAME = "outbox-retention-sweep";

// ---------------------------------------------------------------------------
// Scheduled job payload schema
// ---------------------------------------------------------------------------

/**
 * Scheduled sweeps carry no required payload fields. Passthrough so BullMQ's
 * internal metadata (repeatJobKey, timestamp) does not cause validation
 * failures -- same shape as `audit-retention.processor.ts`.
 */
const OutboxRetentionJobSchema = z.object({}).passthrough();

export type OutboxRetentionJobData = z.infer<typeof OutboxRetentionJobSchema>;

// ---------------------------------------------------------------------------
// DB seam
// ---------------------------------------------------------------------------

/**
 * Minimal seam for the outbox retention purge operation.
 *
 * `purgeBatch` runs ONE batched DELETE inside a platform-admin tenant
 * context. The SQL must:
 *
 *   1. Use the predicate from packages/db/__tests__/outbox/retention.spec.ts
 *      ELIGIBLE_SQL (three OR-branches: delivered-non-audit < deliveredCutoff,
 *      failed/dead_lettered < failedCutoff, delivered-audit < failedCutoff).
 *   2. Bound the work via `FOR UPDATE SKIP LOCKED LIMIT batchSize` on the
 *      inner candidate SELECT so concurrent drainer ticks are not blocked.
 *   3. Order by `occurred_at ASC` so repeated runs over the same data are
 *      stable and the oldest rows go first (helps operator observability).
 *   4. Return the actual number of rows deleted (0 <= result <= batchSize).
 *
 * Any DB error propagates unwrapped so BullMQ can apply retry/backoff.
 *
 * There is NO mark method -- outbox retention deletes outright. Audit
 * facts are immutable and use a separate mark-only repository
 * (`AuditRetentionRepository`).
 */
export interface OutboxRetentionRepository {
  purgeBatch(cutoffs: RetentionCutoffs, batchSize: number): Promise<number>;
}

/** DI token for the outbox retention repository seam. */
export const OUTBOX_RETENTION_REPO = "OUTBOX_RETENTION_REPO";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface OutboxRetentionSweepResult {
  /** Total rows purged across all batches in this sweep run. */
  purgedCount: number;
  /** Number of DELETE batches executed (including the terminal partial batch). */
  batchCount: number;
  /** Wall-clock duration of the sweep, in milliseconds. Useful for operator dashboards. */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class MalformedOutboxRetentionJobError extends Error {
  constructor(jobName: string, issue: string) {
    super(`Malformed outbox-retention job '${jobName}': ${issue}`);
    this.name = "MalformedOutboxRetentionJobError";
  }
}

export class UnknownOutboxRetentionJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown outbox-retention job name: '${jobName}'`);
    this.name = "UnknownOutboxRetentionJobError";
  }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

@Injectable()
export class OutboxRetentionProcessor {
  constructor(
    @Optional()
    @Inject(OUTBOX_RETENTION_REPO)
    private readonly repo: OutboxRetentionRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Process the scheduled outbox-retention-sweep job.
   *
   * 1. Validates the job name and payload shape (rejects unknown job names
   *    or non-object payloads with a redacted error class).
   * 2. Computes the two cutoffs via `computeRetentionCutoffs(clock())`.
   * 3. Calls `repo.purgeBatch` in a loop until a batch returns fewer than
   *    BATCH_SIZE rows (sweep has exhausted all eligible rows).
   * 4. Returns `{ purgedCount, batchCount, durationMs }`.
   */
  async process(
    jobName: string,
    data: unknown,
  ): Promise<OutboxRetentionSweepResult> {
    if (jobName !== OUTBOX_RETENTION_JOB_NAME) {
      throw new UnknownOutboxRetentionJobError(jobName);
    }

    parseJobData(jobName, data);

    const startedAt = Date.now();
    const now = this.clock();
    const cutoffs = computeRetentionCutoffs(now);

    let purgedCount = 0;
    let batchCount = 0;
    let batchPurged: number;

    do {
      batchPurged = await this.repo.purgeBatch(cutoffs, BATCH_SIZE);
      purgedCount += batchPurged;
      batchCount += 1;
    } while (batchPurged === BATCH_SIZE);

    return {
      purgedCount,
      batchCount,
      durationMs: Date.now() - startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJobData(
  jobName: string,
  data: unknown,
): OutboxRetentionJobData {
  const result = OutboxRetentionJobSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const issue = first
      ? `${first.path.join(".") || "<root>"}: ${first.message}`
      : "validation failed";
    throw new MalformedOutboxRetentionJobError(jobName, issue);
  }
  return result.data;
}
