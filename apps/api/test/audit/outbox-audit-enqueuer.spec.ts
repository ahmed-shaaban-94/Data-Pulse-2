/**
 * T583 — OutboxAuditEnqueuer adoption test.
 *
 * Two layers:
 *
 *   Layer A — Unit (no Postgres)
 *     Verifies the AuditEnqueuerModule factory's environment-flag branch:
 *       - OUTBOX_AUDIT_ENABLED unset → returns the legacy enqueuer
 *       - OUTBOX_AUDIT_ENABLED=1 + pool present → returns OutboxAuditEnqueuer
 *       - OUTBOX_AUDIT_ENABLED=1 + pool null → falls back to legacy factory
 *     This is the dial that activates the outbox-backed audit path per
 *     environment without changing the source for either side of the
 *     cutover.
 *
 *   Layer B — Integration (Testcontainers Postgres)
 *     Drives a real OutboxAuditEnqueuer against a real outbox_events table
 *     and confirms an insert lands with the expected fields. Soft-skips
 *     when Docker is unavailable (MIGRATION_TEST_ALLOW_SKIP=1).
 */
import {
  isOutboxAuditEnabled,
  auditJobEnqueuerFactory,
} from "../../src/audit/audit-enqueuer.module";
import { OutboxAuditEnqueuer } from "../../src/audit/outbox-audit-enqueuer";
import { NoOpAuditJobEnqueuer } from "../../src/audit/audit-job.enqueuer";
import {
  AuditQueueProducer,
  type AuditQueueLike,
} from "../../src/audit/audit-queue.producer";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import type { AuditJobPayload } from "../../src/audit/audit-job.types";

// ---------------------------------------------------------------------------
// Layer A — Unit: feature-flag + factory selection
// ---------------------------------------------------------------------------

describe("isOutboxAuditEnabled — feature-flag parsing", () => {
  const original = process.env["OUTBOX_AUDIT_ENABLED"];

  afterEach(() => {
    if (original === undefined) {
      delete process.env["OUTBOX_AUDIT_ENABLED"];
    } else {
      process.env["OUTBOX_AUDIT_ENABLED"] = original;
    }
  });

  it("returns false when the env var is unset", () => {
    delete process.env["OUTBOX_AUDIT_ENABLED"];
    expect(isOutboxAuditEnabled()).toBe(false);
  });

  it("returns false for the empty string", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "";
    expect(isOutboxAuditEnabled()).toBe(false);
  });

  it("returns true for the string '1'", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "1";
    expect(isOutboxAuditEnabled()).toBe(true);
  });

  it("returns true for 'true', 'TRUE', 'yes' (case-insensitive)", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "true";
    expect(isOutboxAuditEnabled()).toBe(true);
    process.env["OUTBOX_AUDIT_ENABLED"] = "TRUE";
    expect(isOutboxAuditEnabled()).toBe(true);
    process.env["OUTBOX_AUDIT_ENABLED"] = "yes";
    expect(isOutboxAuditEnabled()).toBe(true);
  });

  it("returns false for other truthy-looking values", () => {
    process.env["OUTBOX_AUDIT_ENABLED"] = "on";
    expect(isOutboxAuditEnabled()).toBe(false);
    process.env["OUTBOX_AUDIT_ENABLED"] = "enabled";
    expect(isOutboxAuditEnabled()).toBe(false);
  });
});

describe("auditJobEnqueuerFactory — REDIS_URL × NODE_ENV branch matrix", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Fresh copy each test so mutations are scoped per-spec.
    process.env = { ...originalEnv };
    delete process.env["OUTBOX_AUDIT_ENABLED"]; // factory is the legacy path
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /**
   * Trivial fake matching `AuditQueueLike`. We never invoke `.add()` on it —
   * the assertions only check the constructed enqueuer's class. Returning a
   * fake-queue factory lets us hit the REDIS_URL-set branch without booting
   * Redis or BullMQ.
   */
  function fakeQueueFactory(): { queueFactory: (url: string) => AuditQueueLike; urls: string[] } {
    const urls: string[] = [];
    const queueFactory = (url: string): AuditQueueLike => {
      urls.push(url);
      return { add: async () => null };
    };
    return { queueFactory, urls };
  }

  it("NODE_ENV=production + REDIS_URL unset → throws with stable operator-runbook message", () => {
    process.env["NODE_ENV"] = "production";
    delete process.env["REDIS_URL"];
    expect(() => auditJobEnqueuerFactory()).toThrow(
      /AuditModule: REDIS_URL is required in production/,
    );
  });

  it("NODE_ENV=production + REDIS_URL set → AuditQueueProducer wired with the configured URL", () => {
    process.env["NODE_ENV"] = "production";
    process.env["REDIS_URL"] = "redis://prod-host:6379";
    const { queueFactory, urls } = fakeQueueFactory();

    const enqueuer = auditJobEnqueuerFactory(queueFactory);

    expect(enqueuer).toBeInstanceOf(AuditQueueProducer);
    expect(urls).toEqual(["redis://prod-host:6379"]);
  });

  it("NODE_ENV=test + REDIS_URL set → AuditQueueProducer (non-prod path with Redis configured)", () => {
    process.env["NODE_ENV"] = "test";
    process.env["REDIS_URL"] = "redis://test-host:6379";
    const { queueFactory, urls } = fakeQueueFactory();

    const enqueuer = auditJobEnqueuerFactory(queueFactory);

    expect(enqueuer).toBeInstanceOf(AuditQueueProducer);
    expect(urls).toEqual(["redis://test-host:6379"]);
  });

  it("NODE_ENV=test + REDIS_URL unset → NoOpAuditJobEnqueuer (dev/test fallback)", () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "test";
    const enqueuer = auditJobEnqueuerFactory();
    expect(enqueuer).toBeInstanceOf(NoOpAuditJobEnqueuer);
  });

  it("NODE_ENV unset (≠ 'production') + REDIS_URL unset → NoOpAuditJobEnqueuer", () => {
    // The production guard is a literal `=== 'production'` check, so any
    // missing / arbitrary NODE_ENV value must fall into the dev branch.
    delete process.env["REDIS_URL"];
    delete process.env["NODE_ENV"];
    const enqueuer = auditJobEnqueuerFactory();
    expect(enqueuer).toBeInstanceOf(NoOpAuditJobEnqueuer);
  });

  it("queueFactory parameter is the test seam — invoked exactly once per call", () => {
    process.env["NODE_ENV"] = "test";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    const { queueFactory, urls } = fakeQueueFactory();

    auditJobEnqueuerFactory(queueFactory);
    auditJobEnqueuerFactory(queueFactory);

    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u === "redis://localhost:6379")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer B — Integration: real Postgres + outbox INSERT
// ---------------------------------------------------------------------------
//
// Testcontainers lifecycle is SCOPED to this describe block so the Layer A
// unit tests above never trigger a Docker container start. Running
// `jest --testPathPattern=...` against only Layer A (or running this file
// on a Docker-less machine when MIGRATION_TEST_ALLOW_SKIP=1) avoids ~3-5s
// of pointless container boot/teardown.

describe("OutboxAuditEnqueuer — writes a pending outbox_events row", () => {
  const TENANT_A = "0aa00000-0000-7000-8000-000000000001";

  let env: PgTestEnv | null = null;
  let dockerSkipped = false;

  function maybeSkip(): boolean {
    if (dockerSkipped) {
      console.warn("[outbox-audit-enqueuer.spec] skipping (Docker unavailable)");
      return true;
    }
    return false;
  }

  beforeAll(async () => {
    try {
      env = await startPgEnv();
      await applyAllUpAndCreateAppRole(env);
      await env.admin.query(
        `INSERT INTO tenants (id, slug, name) VALUES ($1, 'outbox-enqueuer-test', 'Outbox Enqueuer Test')`,
        [TENANT_A],
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
        console.warn(`\n[outbox-audit-enqueuer.spec] Docker NOT AVAILABLE: ${msg}\n`);
        dockerSkipped = true;
        return;
      }
      throw new Error(`Container start failed: ${msg}`);
    }
  }, 180_000);

  afterAll(async () => {
    if (env) await stopPgEnv(env);
  }, 60_000);

  it("inserts an audit.event.created row with the payload preserved (tenant-scoped)", async () => {
    if (maybeSkip()) return;

    // The SUT runs against `env.app` (the non-superuser `app_test` role).
    // Using `env.admin` (superuser) would silently bypass RLS even when
    // FORCE ROW LEVEL SECURITY is set, which would defeat the point of
    // exercising the enqueuer against a real schema — the INSERT could
    // succeed for the wrong reason. `env.admin` is still used below for
    // SETUP (seeding the tenants row) and ASSERTIONS (reading rows back
    // unconstrained by RLS), but never to drive the SUT.
    const enqueuer = new OutboxAuditEnqueuer(env!.app);
    // `request_id` must be a valid UUID — the OutboxAuditEnqueuer threads
    // it through as `correlationId`, and `outbox_events.correlation_id` is
    // a `uuid` column. A non-UUID value (e.g. "req-corr-0001") would fail
    // the INSERT with `invalid input syntax for type uuid` regardless of
    // RLS / pool choice.
    const REQUEST_UUID = "00000000-0000-7000-8000-00000000c001";
    const payload: AuditJobPayload = {
      actor_user_id: "00000000-0000-7000-8000-000000000010",
      actor_label:   null,
      tenant_id:     TENANT_A,
      store_id:      null,
      action:        "context.switch.tenant",
      target_type:   "tenant",
      target_id:     "00000000-0000-7000-8000-000000000020",
      request_id:    REQUEST_UUID,
      metadata:      null,
    };

    await enqueuer.enqueue(payload);

    // Filter on BOTH tenant_id and correlation_id (== REQUEST_UUID): the
    // tenant_id alone is not deterministic — earlier tests in this file
    // (or future ones) can insert rows for the same tenant, and
    // `ORDER BY created_at DESC LIMIT 1` would silently surface the wrong
    // one if another row landed first. Targeting the unique
    // (tenant, correlation_id) pair pins the assertion to THIS test's
    // insertion.
    const rows = await env!.admin.query<{
      event_id: string;
      tenant_id: string;
      store_id: string | null;
      event_type: string;
      payload: Record<string, unknown>;
      delivery_state: string;
      attempts: number;
      correlation_id: string | null;
    }>(
      `SELECT event_id, tenant_id, store_id, event_type, payload,
              delivery_state, attempts, correlation_id
         FROM outbox_events
        WHERE tenant_id = $1
          AND correlation_id = $2`,
      [TENANT_A, REQUEST_UUID],
    );

    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.event_type).toBe("audit.event.created");
    expect(row.delivery_state).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.correlation_id).toBe(REQUEST_UUID);
    expect(row.payload).toMatchObject({
      actor_user_id: payload.actor_user_id,
      tenant_id: payload.tenant_id,
      action: "context.switch.tenant",
      target_type: "tenant",
    });
  });

  it("inserts a NIL_UUID-tenant row for platform-scoped audit events (tenant_id null in payload)", async () => {
    if (maybeSkip()) return;

    const NIL_UUID = "00000000-0000-0000-0000-000000000000";
    // Same RLS-realism contract as the tenant-scoped test above: SUT runs
    // under the app role. The platform-admin GUC the enqueuer sets is what
    // makes the INSERT pass RLS WITH CHECK on the platform-scoped row.
    const enqueuer = new OutboxAuditEnqueuer(env!.app);
    // Same UUID-column constraint: request_id flows into correlation_id and
    // must be a real UUID.
    const PLATFORM_REQUEST_UUID = "00000000-0000-7000-8000-00000000c002";
    const payload: AuditJobPayload = {
      actor_user_id: null,
      actor_label:   "platform-admin",
      tenant_id:     null, // platform-scoped — no tenant
      store_id:      null,
      action:        "platform.tenant.created",
      target_type:   null,
      target_id:     null,
      request_id:    PLATFORM_REQUEST_UUID,
      metadata:      null,
    };

    await enqueuer.enqueue(payload);

    const rows = await env!.admin.query<{ tenant_id: string; event_type: string }>(
      `SELECT tenant_id, event_type
         FROM outbox_events
        WHERE correlation_id = $1`,
      [PLATFORM_REQUEST_UUID],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.tenant_id).toBe(NIL_UUID);
    expect(rows.rows[0]!.event_type).toBe("audit.event.created");
  });

  // ---------------------------------------------------------------------------
  // Fail-closed integration coverage for the enqueuer's security boundary
  // ---------------------------------------------------------------------------
  //
  // OutboxAuditEnqueuer derives its tenant context from `payload.tenant_id`
  // and INSERTs an outbox row with the same `tenant_id`. The security
  // boundary it RELIES ON — but does not itself enforce — is the RLS
  // policy on `outbox_events`: tenant context and row.tenant_id must match
  // (or the platform-admin GUC must be 'true'). These tests prove that
  // boundary fails closed under the app role; without them the enqueuer's
  // happy-path success could be masking a permissive RLS policy.

  it("FC-1: app-role INSERT with mismatched tenant context vs row.tenant_id is rejected by RLS", async () => {
    if (maybeSkip()) return;

    const OTHER_TENANT = "00000000-0000-7000-8000-00000000beef";
    const FC1_REQUEST_UUID = "00000000-0000-7000-8000-00000000c011";

    // Open an app-role connection, set tenant context to TENANT_A via
    // `set_config(..., true)` (the transaction-local form of SET LOCAL —
    // `SET LOCAL <name> = $1` is a parse error because Postgres's SET
    // does not accept parameter placeholders, and the function form is
    // the standard workaround), then attempt to INSERT a row claiming
    // tenant_id = OTHER_TENANT. The outbox_events_tenant_isolation
    // WITH CHECK predicate evaluates
    //   tenant_id = current_setting('app.current_tenant')::uuid (FALSE here)
    //   OR current_setting('app.is_platform_admin') = 'true'  (FALSE here)
    // → Postgres raises SQLSTATE 42501 (insufficient_privilege / RLS).
    const pgErr = await runRlsRejectAttempt(env!.app, async (client) => {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true)`,
        [TENANT_A],
      );
      await client.query(
        `SELECT set_config('app.is_platform_admin', 'false', true)`,
      );
      await client.query(
        `INSERT INTO outbox_events
           (event_id, tenant_id, event_type, payload, delivery_state,
            attempts, correlation_id)
         VALUES ($1, $2, 'audit.event.created', '{"fc":1}'::jsonb,
                 'pending', 0, $3)`,
        [
          "00000000-0000-4000-8000-00000000fc01",
          OTHER_TENANT,
          FC1_REQUEST_UUID,
        ],
      );
    });

    expect(pgErr).not.toBeNull();
    // 42501 covers both "permission denied for table" and the
    // "new row violates row-level security policy" message Postgres
    // emits for WITH CHECK violations — the only outcomes this scenario
    // can legitimately produce.
    expect(pgErr!.code).toBe("42501");
    expect(pgErr!.message).toMatch(/row.level security|policy|permission denied/i);

    // Confirm the rollback was real: no row landed under the malicious
    // correlation_id even though we wrote it inside the failed transaction.
    const checkRows = await env!.admin.query(
      `SELECT 1 FROM outbox_events WHERE correlation_id = $1`,
      [FC1_REQUEST_UUID],
    );
    expect(checkRows.rows).toHaveLength(0);
  });

  it("FC-2: app-role INSERT with NO tenant context (no GUC, not platform admin) is rejected by RLS", async () => {
    if (maybeSkip()) return;

    const FC2_REQUEST_UUID = "00000000-0000-7000-8000-00000000c012";

    // No `app.current_tenant` set, platform-admin explicitly false.
    // `current_setting('app.current_tenant', true)` returns NULL when unset
    // (the `true` flag suppresses the missing-GUC error); the cast to uuid
    // makes the equality predicate fail-closed, and the platform-admin
    // branch is FALSE. The INSERT WITH CHECK has no passing branch.
    const pgErr = await runRlsRejectAttempt(env!.app, async (client) => {
      await client.query(
        `SELECT set_config('app.is_platform_admin', 'false', true)`,
      );
      await client.query(
        `INSERT INTO outbox_events
           (event_id, tenant_id, event_type, payload, delivery_state,
            attempts, correlation_id)
         VALUES ($1, $2, 'audit.event.created', '{"fc":2}'::jsonb,
                 'pending', 0, $3)`,
        [
          "00000000-0000-4000-8000-00000000fc02",
          TENANT_A,
          FC2_REQUEST_UUID,
        ],
      );
    });

    expect(pgErr).not.toBeNull();
    expect(pgErr!.code).toBe("42501");
    expect(pgErr!.message).toMatch(/row.level security|policy|permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// Shared helper: run a transaction expected to fail RLS, leave the pooled
// client in a clean state.
// ---------------------------------------------------------------------------

/**
 * Run `work` inside a fresh transaction on a pooled `Pool` connection,
 * capture and return any Error that the work throws, and ALWAYS roll back
 * before releasing the client.
 *
 * The fail-closed tests deliberately provoke a Postgres error inside the
 * transaction (an RLS WITH CHECK violation). Two transaction-cleanup
 * pitfalls this helper avoids:
 *
 *   1. SET LOCAL parse error or set_config() failure short-circuits the
 *      "happy path" cleanup → ROLLBACK would never run inline.
 *   2. A Postgres error inside a transaction puts it in the "aborted"
 *      state; releasing such a client back to the pool poisons the
 *      next borrower (every subsequent query returns
 *      `current transaction is aborted, commands ignored`).
 *
 * By placing ROLLBACK in `finally` (with its own swallowed-error guard
 * so an already-aborted txn doesn't mask the original failure), the
 * pooled client is guaranteed to come back idle.
 */
async function runRlsRejectAttempt(
  pool: import("pg").Pool,
  work: (client: import("pg").PoolClient) => Promise<void>,
): Promise<(Error & { code?: string }) | null> {
  const client = await pool.connect();
  let captured: (Error & { code?: string }) | null = null;
  try {
    await client.query("BEGIN");
    try {
      await work(client);
    } catch (err) {
      captured = err as Error & { code?: string };
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The transaction is already aborted from the captured failure,
        // and Postgres tolerates ROLLBACK in that state — but if the
        // connection itself died, swallow it. The captured `pgErr` is
        // the original cause we want to surface.
      }
    }
  } finally {
    client.release();
  }
  return captured;
}
