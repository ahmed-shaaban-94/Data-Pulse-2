/**
 * T562 — Drainer-level retry-budget test.
 *
 * Drives the DrainerProcessor through the full state machine for a poison
 * event and proves:
 *   - Attempts are incremented at claim time (1, 2, ..., 8).
 *   - After the 8th failure, the row transitions to `dead_lettered` (not `failed`).
 *   - No 9th claim is possible — the dead_lettered row is invisible to claimBatch.
 *
 * The repository-level R-12 case proves the SQL transitions are correct in
 * isolation. This spec proves the drainer's branch logic (attempts ≥ MAX_ATTEMPTS
 * → markDeadLettered) is wired correctly end-to-end.
 *
 * Set MIGRATION_TEST_ALLOW_SKIP=1 to soft-skip if Docker is unavailable.
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import type { OutboxConsumer, OutboxEventEnvelope } from "@data-pulse-2/shared";
import type { ClaimedOutboxEvent } from "@data-pulse-2/db";
import { DrainerProcessor } from "../../src/outbox/drainer.processor";
import { OutboxConsumerRegistry } from "../../src/outbox/registry";

const TENANT_A = "0bb00000-0000-7000-8000-000000000001";
const EV_POISON = "0bd00000-0000-4000-8000-000000000001";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'budget-test-tenant', 'Budget Test')`,
      [TENANT_A],
    );
    await env.admin.query(
      `INSERT INTO outbox_events
         (event_id, tenant_id, event_type, payload, delivery_state, attempts)
       VALUES ($1, $2, 'test.event.poison', '{"poison":true}'::jsonb, 'pending', 0)`,
      [EV_POISON, TENANT_A],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      console.warn(`\n[outbox/retry-budget.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    console.warn("[outbox/retry-budget.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/**
 * Per-tick claim helper for the test — claims only EV_POISON, ignoring any
 * other pending rows. We bypass the backoff window check (next_attempt_at)
 * by allowing the test to drive ticks in tight succession; this is the
 * scenario the test specifically wants to prove (8 transitions, then dead).
 *
 * The helper also clears next_attempt_at on the row before each claim so the
 * row remains eligible across all 8 ticks without waiting wall-clock time.
 */
function makeBudgetClaimFn() {
  return async (_pool: unknown, _batchSize: number): Promise<ClaimedOutboxEvent[]> => {
    // Reset next_attempt_at so the row is immediately eligible.
    await env!.admin.query(
      `UPDATE outbox_events SET next_attempt_at=NULL WHERE event_id=$1 AND delivery_state IN ('pending','failed')`,
      [EV_POISON],
    );
    const res = await env!.admin.query<ClaimedOutboxEvent>(
      `WITH claimed AS (
         UPDATE outbox_events
            SET delivery_state='claimed', attempts=attempts+1, updated_at=now()
          WHERE event_id=$1 AND delivery_state IN ('pending','failed')
          RETURNING event_id, event_type, tenant_id, store_id, payload, correlation_id, occurred_at, attempts
       ) SELECT * FROM claimed`,
      [EV_POISON],
    );
    return res.rows;
  };
}

describe("T562: drainer-level retry-budget — 8 attempts then dead_lettered", () => {
  it("transitions through 8 failed claims and ends in dead_lettered with attempts=8", async () => {
    if (maybeSkip()) return;

    // Poison consumer — always throws a known, redacted error class.
    class PoisonError extends Error {
      override readonly name = "PoisonError";
    }

    const poisonConsumer: OutboxConsumer<unknown> = {
      consumerId: "test.poison-consumer",
      eventType: "test.event.poison",
      async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
        throw new PoisonError("payload-redacted");
      },
    };

    const registry = new OutboxConsumerRegistry();
    registry.register(poisonConsumer);

    const drainer = new DrainerProcessor({
      pool: env!.admin,
      registry,
      claimFn: makeBudgetClaimFn() as (
        pool: import("pg").Pool,
        batchSize: number,
      ) => Promise<ClaimedOutboxEvent[]>,
    });

    // Drive 8 ticks. Each tick: claim → consumer throws → drainer marks failed
    // (attempts 1..7) or dead_lettered (attempts === 8).
    for (let i = 0; i < 8; i++) {
      await drainer.tick();
    }

    const r = await env!.admin.query<{
      delivery_state: string;
      attempts: number;
      last_error: string | null;
      processed_at: string | null;
    }>(
      `SELECT delivery_state, attempts, last_error, processed_at FROM outbox_events WHERE event_id=$1`,
      [EV_POISON],
    );

    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.delivery_state).toBe("dead_lettered");
    expect(r.rows[0]!.attempts).toBe(8);
    expect(r.rows[0]!.last_error).toBe("PoisonError");
    expect(r.rows[0]!.processed_at).not.toBeNull();
  });

  it("no 9th claim — dead_lettered row is invisible to the production claimBatch", async () => {
    if (maybeSkip()) return;

    // Use the REAL claimBatch (not the test helper) — confirms the
    // dead_lettered → invisible invariant at the SQL level.
    const { claimBatch } = await import("@data-pulse-2/db");
    const claimed = await claimBatch(env!.admin, 100);
    const dead = claimed.find((row) => row.event_id === EV_POISON);
    expect(dead).toBeUndefined();
  });
});
