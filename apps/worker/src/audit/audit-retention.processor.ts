/**
 * AuditRetentionProcessor — T311.
 *
 * Scheduled BullMQ processor that marks `audit_events` rows as past the
 * documented 365-day retention window. Fires on a daily repeatable job
 * (Layer B wiring deferred — see KNOWN GAPS below).
 *
 * Layered architecture (mirrors SoftDeleteSweepProcessor / AuditFanoutProcessor)
 * ------------------------------------------------------------------------------
 *   Layer A (this file): pure `(jobName, data) → repo.markBatch(cutoff, now, batchSize)`.
 *     Knows nothing about BullMQ runtime, Redis, retry, or DB connection.
 *   Layer B (deferred): BullMQ `Worker` bootstrap, repeatable-job schedule
 *     (daily cadence), Redis connection, `worker.module.ts` registration, and
 *     the production `DrizzleAuditRetentionRepository` implementation.
 *
 * Retention policy
 * ----------------
 * Rows where `occurred_at < computeCutoff(now)` AND `retention_marked_at IS NULL`
 * are updated: `retention_marked_at = now`. Cutoff is exactly 365 UTC days before
 * the reference instant. The predicate is strict `<` — a row at exactly the
 * cutoff is not yet eligible. See `audit-retention.policy.ts`.
 *
 * Retention lifecycle write boundary (processor-enforced, NOT DB-enforced)
 * -----------------------------------------------------------------------
 * Audit facts (id, occurred_at, action, actor_*, tenant_id, store_id,
 * target_*, metadata, request_id) are NEVER touched by this processor. The
 * repository interface exposes a single mutating method (`markBatch`) and
 * implementations MUST NOT update any column other than `retention_marked_at`.
 *
 * This boundary is enforced ONLY by the processor / repository abstraction in
 * this PR. There is intentionally no DB-layer column-scoped UPDATE grant: the
 * production worker-role pattern that would back such a grant has not yet been
 * approved, and shipping a test-role-only grant would have been a false claim
 * of immutability. The DB-layer enforcement and its invariant test are
 * deferred to a follow-up PR. See KNOWN GAPS below.
 *
 * Idempotency
 * -----------
 * The `IS NULL` filter ensures a second run produces 0 marks for any rows
 * already swept. Re-running the processor with the same clock is safe.
 *
 * Batching
 * --------
 * One `UPDATE … LIMIT 1000` per batch keeps individual transactions short and
 * avoids long-hold lock contention on `audit_events`. The loop continues until
 * a batch returns fewer than `BATCH_SIZE` rows (the final partial batch).
 *
 * Return value
 * ------------
 * Returns `{ markedCount, batchCount }` so callers (including tests) can
 * assert the sweep's effect. The Layer-B wiring MAY emit a structured pino
 * log line using this return value:
 *   logger.info({ event: 'audit_retention_sweep.complete', correlation_id,
 *     rows_marked: markedCount, batches: batchCount, cutoff_days: 365 })
 *
 * Cross-app isolation
 * -------------------
 * This file MUST NOT import from `apps/api` or `@data-pulse-2/db`.
 *
 * KNOWN GAPS (deferred to follow-up PRs):
 *   1. Not registered in `worker.module.ts` and has no BullMQ `Worker`
 *      bootstrap. Layer B wiring — including the production
 *      DrizzleAuditRetentionRepository, daily repeatable-job schedule, and
 *      `worker.module.ts` DI registration — is deferred.
 *   2. No DB-layer column-scoped UPDATE grant restricting writes to
 *      `retention_marked_at`. Deferred until a verified production
 *      worker-role pattern exists.
 *   3. No DB-layer invariant test asserting the column-scoped grant
 *      boundary. Deferred together with (2).
 *
 * What this PR ships: Layer A retention marker behavior — policy module,
 * processor abstraction, schema column + indexes, and unit tests pinning
 * cutoff math, batching, idempotency, and the write-only-marker contract
 * at the repository seam.
 */
import { Injectable, Inject, Optional } from "@nestjs/common";
import { z } from "zod";
import {
  BATCH_SIZE,
  computeCutoff,
} from "./audit-retention.policy";

// ---------------------------------------------------------------------------
// Job name
// ---------------------------------------------------------------------------

/**
 * BullMQ job name this processor handles. Must match the repeatable-job
 * definition in the Layer-B wiring (deferred). Pinned by a unit test.
 *
 * Convention: `<domain>-<verb>` hyphenated, matching the existing patterns
 * ("audit-fanout", "soft-delete-sweep").
 */
export const AUDIT_RETENTION_JOB_NAME = "audit-retention-sweep";

// ---------------------------------------------------------------------------
// Scheduled job payload schema
// ---------------------------------------------------------------------------

/**
 * Scheduled sweeps carry no required payload fields. Passthrough so BullMQ's
 * internal metadata (repeatJobKey, timestamp, etc.) does not cause validation
 * failures — matching the pattern in SoftDeleteSweepJobSchema.
 */
const AuditRetentionJobSchema = z.object({}).passthrough();

export type AuditRetentionJobData = z.infer<typeof AuditRetentionJobSchema>;

// ---------------------------------------------------------------------------
// DB seam (local — no import from @data-pulse-2/db)
// ---------------------------------------------------------------------------

/**
 * Minimal seam for the audit retention mark operation.
 *
 * `markBatch` performs one batched UPDATE:
 *   UPDATE audit_events
 *   SET retention_marked_at = markedAt
 *   WHERE occurred_at < cutoff
 *     AND retention_marked_at IS NULL
 *   LIMIT batchSize
 *
 * Returns the number of rows actually marked (0 ≤ result ≤ batchSize).
 * Any DB error propagates unwrapped so BullMQ can apply retry/backoff.
 *
 * IMPORTANT: The implementation MUST NOT update any column other than
 * `retention_marked_at`. Audit facts are immutable.
 *
 * There is NO delete method — deletion of audit rows is prohibited by
 * Constitution §XIII and is not in scope for this foundation.
 */
export interface AuditRetentionRepository {
  markBatch(cutoff: Date, markedAt: Date, batchSize: number): Promise<number>;
}

/** DI token for the audit retention repository seam. */
export const AUDIT_RETENTION_REPO = "AUDIT_RETENTION_REPO";

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface AuditRetentionSweepResult {
  /** Total number of audit_events rows marked in this sweep run. */
  markedCount: number;
  /** Number of UPDATE batches executed (including the terminal empty/partial batch). */
  batchCount: number;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class MalformedAuditRetentionJobError extends Error {
  constructor(jobName: string, issue: string) {
    super(`Malformed audit-retention job '${jobName}': ${issue}`);
    this.name = "MalformedAuditRetentionJobError";
  }
}

export class UnknownAuditRetentionJobError extends Error {
  constructor(jobName: string) {
    super(`Unknown audit-retention job name: '${jobName}'`);
    this.name = "UnknownAuditRetentionJobError";
  }
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

@Injectable()
export class AuditRetentionProcessor {
  constructor(
    @Optional()
    @Inject(AUDIT_RETENTION_REPO)
    private readonly repo: AuditRetentionRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Process the scheduled audit-retention-sweep job.
   *
   * 1. Validates the job name and payload.
   * 2. Computes the cutoff via `computeCutoff(clock())`.
   * 3. Calls `repo.markBatch` in a loop until the batch is smaller than
   *    `BATCH_SIZE` (the sweep has exhausted all eligible rows).
   * 4. Returns `{ markedCount, batchCount }`.
   *
   * No rows are deleted. Only `retention_marked_at` is written.
   */
  async process(
    jobName: string,
    data: unknown,
  ): Promise<AuditRetentionSweepResult> {
    if (jobName !== AUDIT_RETENTION_JOB_NAME) {
      throw new UnknownAuditRetentionJobError(jobName);
    }

    parseJobData(jobName, data);

    const now = this.clock();
    const cutoff = computeCutoff(now);

    let markedCount = 0;
    let batchCount = 0;
    let batchMarked: number;

    do {
      batchMarked = await this.repo.markBatch(cutoff, now, BATCH_SIZE);
      markedCount += batchMarked;
      batchCount += 1;
    } while (batchMarked === BATCH_SIZE);

    return { markedCount, batchCount };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJobData(
  jobName: string,
  data: unknown,
): AuditRetentionJobData {
  const result = AuditRetentionJobSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const issue = first
      ? `${first.path.join(".") || "<root>"}: ${first.message}`
      : "validation failed";
    throw new MalformedAuditRetentionJobError(jobName, issue);
  }
  return result.data;
}
