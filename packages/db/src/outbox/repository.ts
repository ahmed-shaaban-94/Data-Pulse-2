/**
 * T560 (full), T580 (partial) — Outbox repository: claim / deliver / fail / dead-letter.
 *
 * This module provides the four state-machine operations the drainer needs:
 *
 *   claimBatch   — SELECT ... FOR UPDATE SKIP LOCKED → UPDATE to 'claimed', increment attempts
 *   markDelivered — UPDATE delivery_state='delivered', set processed_at
 *   markFailed    — UPDATE delivery_state='failed', set last_error + next_attempt_at (backoff)
 *   markDeadLettered — UPDATE delivery_state='dead_lettered', set processed_at + last_error
 *
 * The claim query is the drainer's SKIP LOCKED claim CTE: attempts incremented inside
 * the same UPDATE so the counter is consistent with the in-flight row state.
 *
 * Drainer RLS pattern (Constitution §II, lifecycle.md §6)
 * -------------------------------------------------------
 * The drainer must claim rows ACROSS tenants. The RLS policy on `outbox_events`
 * allows reads when `app.is_platform_admin = 'true'`. The claim function
 * therefore executes under `{ tenantId: null, isPlatformAdmin: true }` context.
 *
 * State-machine transitions:
 *   pending  → claimed       (claimBatch; attempts += 1)
 *   claimed  → delivered     (markDelivered; processed_at = now())
 *   claimed  → failed        (markFailed; last_error set, next_attempt_at set)
 *   failed   → claimed       (claimBatch re-claims eligible failed rows)
 *   claimed  → dead_lettered (markDeadLettered, when attempts === 8)
 *
 * Backoff schedule (lifecycle.md §4.2):
 *   attempts=1 → now() + 30s   (first failure, wait 30s before retry 2)
 *   attempts=2 → now() + 2min  (wait 2min before retry 3)
 *   attempts=3 → now() + 10min (wait 10min before retry 4)
 *   attempts=4..7 → now() + 1h (plateau — wait 1h before each remaining retry)
 *   attempts=8 → dead-letter   (budget exhausted; caller invokes markDeadLettered)
 *
 * Note: `attempts` is incremented AT CLAIM TIME. After the first claim,
 * `attempts=1`. If that attempt fails → `markFailed(attempts=1)` → wait 30s.
 * After the second claim, `attempts=2`. If that fails → `markFailed(attempts=2)` → wait 2min.
 * After the 8th claim, `attempts=8`. Consumer throws → `markDeadLettered(attempts=8)`.
 *
 * All operations accept an injected `Pool` (no Drizzle ORM — raw `pg` for
 * maximum transparency over the SKIP LOCKED query shape).
 */
import type { Pool, PoolClient } from "pg";
import { runWithTenantContext } from "../middleware/tenant-context";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the repository's state-transition functions when the precondition
 * for the transition is violated — i.e. the target row is NOT in `claimed`
 * state, the UPDATE matched zero (or more than one) rows, or the caller asked
 * for a transition the budget forbids (e.g. `markFailed` with attempts >=
 * `MAX_ATTEMPTS`).
 *
 * The drainer's safe-mark wrappers catch this, log the error class, and keep
 * polling. The named class is so `Error.name === "OutboxStateTransitionError"`
 * survives the drainer's `extractErrorClass(err)` redaction.
 */
export class OutboxStateTransitionError extends Error {
  override readonly name = "OutboxStateTransitionError";
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A claimed outbox event row — the subset of columns the drainer needs to
 * route the event to its consumer.
 */
export interface ClaimedOutboxEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly tenant_id: string;
  readonly store_id: string | null;
  readonly payload: unknown;
  readonly correlation_id: string | null;
  readonly occurred_at: Date;
  /** attempts has already been incremented by the claim CTE. */
  readonly attempts: number;
}

/** Injected for testability; production callers omit it. */
export type ClaimFn = (client: PoolClient, batchSize: number) => Promise<ClaimedOutboxEvent[]>;

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

/**
 * Compute `next_attempt_at` delay (in ms) for a failed event, given the
 * `attempts` count AFTER the just-completed claim/failure was recorded.
 *
 *   attempts ≤ 1 → 30s    (first failure — wait 30s before the second claim)
 *   attempts = 2 → 2min   (wait before the third claim)
 *   attempts = 3 → 10min  (wait before the fourth claim)
 *   attempts ≥ 4 → 1h     (plateau — applies for retries 5, 6, 7)
 *   attempts = 8 → caller MUST invoke markDeadLettered instead of markFailed
 *                  (markFailed itself throws OutboxStateTransitionError when
 *                  attempts ≥ MAX_ATTEMPTS).
 *
 * Locked by the `nextAttemptDelayMs backoff schedule (unit)` suite in
 * `packages/db/__tests__/outbox/repository-runtime.spec.ts`.
 */
export function nextAttemptDelayMs(attempts: number): number {
  // attempts is the count AFTER the current (failed) claim.
  // We use it to determine how long to wait before the NEXT attempt.
  if (attempts <= 1) return 30_000;          // wait 30s before attempt 2
  if (attempts === 2) return 2 * 60_000;     // wait 2min before attempt 3
  if (attempts === 3) return 10 * 60_000;    // wait 10min before attempt 4
  return 60 * 60_000;                        // plateau — wait 1h for attempts 4..7
}

/** Max attempts before dead-lettering. */
export const MAX_ATTEMPTS = 8;

// ---------------------------------------------------------------------------
// claimBatch — FOR UPDATE SKIP LOCKED
// ---------------------------------------------------------------------------

/**
 * Claim up to `batchSize` pending/failed-eligible rows atomically.
 *
 * Executes under a platform-admin context so the RLS policy allows the drainer
 * to see rows across all tenants. The UPDATE increments `attempts` in the
 * same CTE as the SELECT, ensuring the counter is accurate for the current
 * processing attempt before the consumer sees the row.
 *
 * The claim CTE pattern (drainer-design.md §2):
 *   1. Inner SELECT picks claimable rows (state IN ('pending','failed') AND
 *      next_attempt_at IS NULL OR <= now()) ordered by occurred_at ASC FOR
 *      UPDATE SKIP LOCKED LIMIT $batchSize.
 *   2. Outer UPDATE sets delivery_state='claimed', attempts+=1, updated_at=now().
 *   3. RETURNING gives the drainer the data it needs to dispatch consumers.
 */
export async function claimBatch(
  pool: Pool,
  batchSize = 50,
): Promise<ClaimedOutboxEvent[]> {
  assertPositiveBatchSize(batchSize);
  return runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      return _claimBatchOnClient(client, batchSize);
    },
  );
}

/**
 * Validate `batchSize` at the function boundary.
 *
 * Postgres's `LIMIT` rejects non-positive integers and `LIMIT NaN` is a
 * parse error, but failing fast with a clear JS error is much more
 * debuggable than a downstream `invalid input syntax` message that
 * surfaces inside the claim CTE under a wrapped runWithTenantContext.
 *
 * Throwing `RangeError` (a built-in) makes the cause obvious without
 * adding a new error class to the public surface for a guard-rail.
 */
function assertPositiveBatchSize(batchSize: number): void {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new RangeError(
      `claimBatch: batchSize must be a positive integer, got ${String(batchSize)}.`,
    );
  }
}

/**
 * Internal: runs the claim CTE on an already-open, context-set `PoolClient`.
 *
 * Kept module-private — no consumer outside this file calls it. The
 * previous `export` made it part of `packages/db`'s public surface and
 * obligated us to maintain its signature for downstream callers; nothing
 * actually used it. Unit tests of the claim CTE shape go through
 * `claimBatch(pool, batchSize)` and rely on a real Pool (Testcontainers).
 */
async function _claimBatchOnClient(
  client: PoolClient,
  batchSize: number,
): Promise<ClaimedOutboxEvent[]> {
  const res = await client.query<{
    event_id: string;
    event_type: string;
    tenant_id: string;
    store_id: string | null;
    payload: unknown;
    correlation_id: string | null;
    occurred_at: Date;
    attempts: number;
  }>(
    `WITH claimed AS (
       UPDATE outbox_events
          SET delivery_state = 'claimed',
              attempts       = attempts + 1,
              updated_at     = now()
        WHERE event_id IN (
          SELECT event_id
            FROM outbox_events
           WHERE delivery_state IN ('pending', 'failed')
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           ORDER BY occurred_at ASC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
       RETURNING
          event_id,
          event_type,
          tenant_id,
          store_id,
          payload,
          correlation_id,
          occurred_at,
          attempts
     )
     SELECT * FROM claimed`,
    [batchSize],
  );

  return res.rows.map((r) => ({
    event_id: r.event_id,
    event_type: r.event_type,
    tenant_id: r.tenant_id,
    store_id: r.store_id,
    payload: r.payload,
    correlation_id: r.correlation_id,
    occurred_at: r.occurred_at,
    attempts: r.attempts,
  }));
}

// ---------------------------------------------------------------------------
// markDelivered
// ---------------------------------------------------------------------------

/**
 * Transition a claimed row to `delivered`. Sets `processed_at = now()`.
 *
 * Strict mode (state-machine invariant)
 * -------------------------------------
 * The UPDATE matches only rows whose current `delivery_state = 'claimed'`.
 * If the affected row count is not exactly 1, the function throws
 * `OutboxStateTransitionError`. Reasons that could trigger this:
 *   - someone else transitioned the row (delivered/failed/dead_lettered)
 *   - the row was deleted (retention purge)
 *   - the row never existed (caller programming error)
 *
 * Executed under platform-admin context so the drainer can update any tenant's row.
 * `last_error` is NOT cleared — it retains the last-known failure class for audit
 * context (per Slice 1A schema intent).
 */
export async function markDelivered(pool: Pool, eventId: string): Promise<void> {
  await runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      const res = await client.query(
        `UPDATE outbox_events
            SET delivery_state = 'delivered',
                processed_at   = now(),
                updated_at     = now()
          WHERE event_id = $1
            AND delivery_state = 'claimed'`,
        [eventId],
      );
      assertSingleRow(res.rowCount, "markDelivered", eventId);
    },
  );
}

// ---------------------------------------------------------------------------
// markFailed
// ---------------------------------------------------------------------------

/**
 * Transition a claimed row to `failed`. Sets `last_error` (redacted error class
 * only — never the full exception string, never PII) and schedules `next_attempt_at`
 * per the backoff schedule.
 *
 * Strict mode (state-machine invariants)
 * --------------------------------------
 * 1. Rejects `attempts >= MAX_ATTEMPTS` — the budget is exhausted at that
 *    point and the caller MUST invoke `markDeadLettered` instead. Throwing
 *    here is defence in depth in case the drainer's routing logic regresses.
 * 2. The UPDATE matches only rows whose current `delivery_state = 'claimed'`.
 *    Throws `OutboxStateTransitionError` if the affected row count is not
 *    exactly 1 (someone else moved the row, retention purged it, or the
 *    event_id never existed).
 */
export async function markFailed(
  pool: Pool,
  eventId: string,
  attempts: number,
  errorClass: string,
): Promise<void> {
  if (attempts >= MAX_ATTEMPTS) {
    throw new OutboxStateTransitionError(
      `markFailed: attempts=${attempts} has reached MAX_ATTEMPTS=${MAX_ATTEMPTS}; ` +
        `caller must invoke markDeadLettered. event_id=${eventId}`,
    );
  }

  const delayMs = nextAttemptDelayMs(attempts);
  const nextAttemptAt = new Date(Date.now() + delayMs);

  await runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      const res = await client.query(
        `UPDATE outbox_events
            SET delivery_state  = 'failed',
                last_error      = $2,
                next_attempt_at = $3,
                updated_at      = now()
          WHERE event_id = $1
            AND delivery_state = 'claimed'`,
        [eventId, errorClass, nextAttemptAt.toISOString()],
      );
      assertSingleRow(res.rowCount, "markFailed", eventId);
    },
  );
}

// ---------------------------------------------------------------------------
// markDeadLettered
// ---------------------------------------------------------------------------

/**
 * Transition a claimed row to `dead_lettered`. Sets `processed_at = now()`.
 *
 * Strict mode: matches only `delivery_state = 'claimed'`. Throws
 * `OutboxStateTransitionError` if the row count is not exactly 1.
 *
 * Called when `attempts` reaches `MAX_ATTEMPTS` (8) — the retry budget is
 * exhausted. The row remains in the table for 365-day retention (lifecycle.md
 * §3). No 9th claim will be made.
 */
export async function markDeadLettered(
  pool: Pool,
  eventId: string,
  errorClass: string,
): Promise<void> {
  await runWithTenantContext(
    pool,
    { tenantId: null, isPlatformAdmin: true },
    async (client) => {
      const res = await client.query(
        `UPDATE outbox_events
            SET delivery_state = 'dead_lettered',
                last_error     = $2,
                processed_at   = now(),
                updated_at     = now()
          WHERE event_id = $1
            AND delivery_state = 'claimed'`,
        [eventId, errorClass],
      );
      assertSingleRow(res.rowCount, "markDeadLettered", eventId);
    },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strict-mode invariant for the three state-transition functions: the UPDATE
 * must have matched exactly one row. Zero rows means the precondition failed
 * (row not in `claimed` state, deleted, or never existed). More than one is
 * impossible because `event_id` is the PRIMARY KEY, but we still assert it
 * defensively.
 */
function assertSingleRow(
  rowCount: number | null,
  op: "markDelivered" | "markFailed" | "markDeadLettered",
  eventId: string,
): void {
  if (rowCount === 1) return;
  throw new OutboxStateTransitionError(
    `${op}: expected exactly 1 'claimed' row for event_id=${eventId}, ` +
      `UPDATE affected ${rowCount ?? 0}. Row is not in 'claimed' state, ` +
      `was deleted, or never existed.`,
  );
}
