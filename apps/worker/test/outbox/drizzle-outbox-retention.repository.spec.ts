/**
 * T590 -- DrizzleOutboxRetentionRepository integration tests.
 *
 * What this spec proves
 * ---------------------
 * The processor's contract is locked by retention.processor.spec.ts via a
 * fake repo. This spec proves the PRODUCTION repository -- the one that
 * runs in worker.module.ts wiring -- delivers the same contract against a
 * real Postgres 16 container with the real `outbox_events` table and the
 * real FORCE ROW LEVEL SECURITY policy applied.
 *
 *  DR-1 platform-admin sweep deletes BOTH tenants' eligible rows in one run
 *       (positive counterpart to packages/db/__tests__/outbox/retention.spec.ts
 *        suite RT-6, which proves tenant-scoped context CANNOT see the other
 *        tenant's eligible row).
 *  DR-2 fresh rows survive the sweep regardless of tenant.
 *  DR-3 active rows (pending, claimed) survive the sweep regardless of age.
 *  DR-4 a tombstoned-payload row remains purgeable when its timestamp
 *       crosses the cutoff -- the SQL never reads payload.
 *  DR-5 batch boundary: with batchSize=1, a single purgeBatch call deletes
 *       exactly one row.
 *  DR-6 idempotency: a second purge with the same cutoffs returns 0.
 *  DR-7 app role / RLS path is exercised -- the repository's pool is the
 *       non-superuser `app_test` pool, and the SQL relies on the
 *       runWithTenantContext platform-admin OR-branch to cross tenants.
 *
 * Docker / Testcontainers: required. Set MIGRATION_TEST_ALLOW_SKIP=1 to
 * soft-skip in local environments without Docker (matches existing
 * convention from rls.spec.ts and retention.spec.ts).
 */
import {
  applyAllUpAndCreateAppRole,
  APP_ROLE_NAME,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../../packages/db/__tests__/_helpers/postgres-container";
import { DrizzleOutboxRetentionRepository } from "../../src/outbox/drizzle-outbox-retention.repository";
import { computeRetentionCutoffs } from "../../src/outbox/retention.policy";

// ---------------------------------------------------------------------------
// Fixture UUIDs -- prefix "dor" (drizzle outbox retention)
// ---------------------------------------------------------------------------
const TENANT_A = "d0a00000-0000-7000-8000-000000000001";
const TENANT_B = "d0b00000-0000-7000-8000-000000000002";

// Eligible (purge-target) rows
const EVENT_A_DELIVERED_OLD       = "d0e10000-0000-4000-8000-000000000001"; // tenant A, delivered, 100d -- eligible (>90d non-audit)
const EVENT_B_FAILED_OLD          = "d0e20000-0000-4000-8000-000000000002"; // tenant B, failed,    400d -- eligible (>365d)
const EVENT_A_AUDIT_DELIVERED_OLD = "d0e30000-0000-4000-8000-000000000003"; // tenant A, delivered audit, 400d -- eligible (audit 365d)
const EVENT_B_TOMBSTONED_OLD      = "d0e40000-0000-4000-8000-000000000004"; // tenant B, delivered, 100d, payload tombstoned -- eligible

// Survivors (must NOT be deleted)
const EVENT_A_DELIVERED_FRESH     = "d0f10000-0000-4000-8000-000000000001"; // tenant A, delivered, 1d  -- fresh
const EVENT_B_FAILED_FRESH        = "d0f20000-0000-4000-8000-000000000002"; // tenant B, failed,    30d -- fresh
const EVENT_A_AUDIT_DELIVERED_MID = "d0f30000-0000-4000-8000-000000000003"; // tenant A, delivered audit, 100d -- inside 365d window
const EVENT_A_PENDING_OLD         = "d0c10000-0000-4000-8000-000000000001"; // tenant A, pending,   500d -- ACTIVE, never purged
const EVENT_B_CLAIMED_OLD         = "d0c20000-0000-4000-8000-000000000002"; // tenant B, claimed,   500d -- ACTIVE, never purged

const PII_CANARY = "pii-canary@example.test";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    // Seed both tenants as superuser (RLS bypassed at seed time by design).
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'dor-tenant-a', 'DOR Tenant A'),
         ($2, 'dor-tenant-b', 'DOR Tenant B')`,
      [TENANT_A, TENANT_B],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[outbox/drizzle-outbox-retention.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    // eslint-disable-next-line no-console
    console.warn("[outbox/drizzle-outbox-retention.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/**
 * Seed a single outbox event via the superuser pool (RLS bypassed at seed
 * time by design -- matches retention.spec.ts's seedEvent helper).
 *
 * `processed_at` is backdated when deliveryState is 'delivered' or
 * 'dead_lettered'. `occurred_at`, `created_at`, `updated_at` are all
 * backdated together so any predicate the production processor uses is
 * consistently expressible.
 */
async function seedEvent(opts: {
  eventId: string;
  tenantId: string;
  eventType: string;
  deliveryState: "pending" | "claimed" | "delivered" | "failed" | "dead_lettered";
  attempts?: number;
  ageDays: number;
  payload?: Record<string, unknown>;
  includeProcessedAt?: boolean;
}): Promise<void> {
  const {
    eventId,
    tenantId,
    eventType,
    deliveryState,
    attempts = 0,
    payload = { ref: eventId, actor_label: PII_CANARY },
    ageDays,
    includeProcessedAt = deliveryState === "delivered" || deliveryState === "dead_lettered",
  } = opts;

  await env!.admin.query(
    `INSERT INTO outbox_events
       (event_id, tenant_id, event_type, payload,
        delivery_state, attempts,
        occurred_at, created_at, updated_at, processed_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6,
       now() - make_interval(days => $7),
       now() - make_interval(days => $7),
       now() - make_interval(days => $7),
       CASE WHEN $8::boolean THEN now() - make_interval(days => $7) ELSE NULL END
     )
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId,
      tenantId,
      eventType,
      JSON.stringify(payload),
      deliveryState,
      attempts,
      ageDays,
      includeProcessedAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// One-time seed of the cross-tenant fixture (in beforeAll so all suites
// share the same fixture state until the DR-1 platform sweep purges it).
// ---------------------------------------------------------------------------
beforeAll(async () => {
  if (dockerSkipped) return;

  // Eligible rows -- four flavours across two tenants.
  await seedEvent({
    eventId: EVENT_A_DELIVERED_OLD,
    tenantId: TENANT_A,
    eventType: "test.non_audit",
    deliveryState: "delivered",
    ageDays: 100,
  });
  await seedEvent({
    eventId: EVENT_B_FAILED_OLD,
    tenantId: TENANT_B,
    eventType: "test.non_audit",
    deliveryState: "failed",
    attempts: 3,
    ageDays: 400,
  });
  await seedEvent({
    eventId: EVENT_A_AUDIT_DELIVERED_OLD,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "delivered",
    ageDays: 400,
  });
  await seedEvent({
    eventId: EVENT_B_TOMBSTONED_OLD,
    tenantId: TENANT_B,
    eventType: "test.non_audit",
    deliveryState: "delivered",
    ageDays: 100,
  });
  // Tombstone EVENT_B_TOMBSTONED_OLD's PII payload BEFORE the sweep -- this is
  // the out-of-band right-to-erasure pattern documented in
  // docs/outbox/lifecycle.md line 87 and tested in retention.spec.ts RT-4.
  await env!.admin.query(
    `UPDATE outbox_events
        SET payload = jsonb_set(payload, '{actor_label}', '"[ERASED]"', true)
      WHERE event_id = $1`,
    [EVENT_B_TOMBSTONED_OLD],
  );

  // Survivors -- five flavours that must NOT be deleted.
  await seedEvent({
    eventId: EVENT_A_DELIVERED_FRESH,
    tenantId: TENANT_A,
    eventType: "test.non_audit",
    deliveryState: "delivered",
    ageDays: 1,
  });
  await seedEvent({
    eventId: EVENT_B_FAILED_FRESH,
    tenantId: TENANT_B,
    eventType: "test.non_audit",
    deliveryState: "failed",
    attempts: 1,
    ageDays: 30,
  });
  await seedEvent({
    eventId: EVENT_A_AUDIT_DELIVERED_MID,
    tenantId: TENANT_A,
    eventType: "audit.event.created",
    deliveryState: "delivered",
    ageDays: 100, // inside 365d window for audit -> survives
  });
  await seedEvent({
    eventId: EVENT_A_PENDING_OLD,
    tenantId: TENANT_A,
    eventType: "test.non_audit",
    deliveryState: "pending",
    ageDays: 500,
  });
  await seedEvent({
    eventId: EVENT_B_CLAIMED_OLD,
    tenantId: TENANT_B,
    eventType: "test.non_audit",
    deliveryState: "claimed",
    attempts: 1,
    ageDays: 500,
  });
}, 60_000);

// ---------------------------------------------------------------------------
// Helper: query the outbox via the superuser so RLS is bypassed and the
// test can observe the final row set without itself having to set GUCs.
// ---------------------------------------------------------------------------
async function survivors(): Promise<Set<string>> {
  const r = await env!.admin.query<{ event_id: string }>(
    "SELECT event_id FROM outbox_events",
  );
  return new Set(r.rows.map((row) => row.event_id));
}

async function tombstonedPayload(): Promise<{ actor_label?: unknown }> {
  // Look up tombstoned row via superuser BEFORE the purge. After purge the
  // row is gone (DR-4 covers that). This helper is used to prove the payload
  // is tombstoned at seed time.
  const r = await env!.admin.query<{ payload: { actor_label?: unknown } }>(
    "SELECT payload FROM outbox_events WHERE event_id = $1",
    [EVENT_B_TOMBSTONED_OLD],
  );
  return r.rows[0]?.payload ?? {};
}

// ---------------------------------------------------------------------------
// DR-7 (pre-flight): prove the repo is constructed against env.app (non-
// superuser) and exercises the runWithTenantContext platform-admin path
// ---------------------------------------------------------------------------
describe("DrizzleOutboxRetentionRepository -- app-role / platform-admin context (DR-7)", () => {
  it("env.app role is the non-superuser app_test role (DR-7a)", async () => {
    if (maybeSkip()) return;
    const client = await env!.app.connect();
    try {
      const r = await client.query<{ current_user: string }>("SELECT current_user");
      expect(r.rows[0]!.current_user).toBe(APP_ROLE_NAME);
    } finally {
      client.release();
    }
  });

  it("the tombstoned payload no longer carries the PII canary (DR-7b precondition for DR-4)", async () => {
    if (maybeSkip()) return;
    const payload = await tombstonedPayload();
    expect(payload.actor_label).toBe("[ERASED]");
    expect(JSON.stringify(payload)).not.toContain(PII_CANARY);
  });
});

// ---------------------------------------------------------------------------
// DR-5 + DR-6: batch boundary and idempotency on a single eligible row
// (Run this BEFORE the big sweep so we control the row set exactly.)
// ---------------------------------------------------------------------------
describe("DrizzleOutboxRetentionRepository -- batch boundary + idempotency (DR-5, DR-6)", () => {
  it("with batchSize=1, exactly one row is deleted per call (DR-5)", async () => {
    if (maybeSkip()) return;

    // 4 eligible rows seeded; with batchSize=1, two consecutive calls delete
    // 1+1 = 2 of them, leaving 2 eligible rows for the DR-1 sweep below.
    const repo = new DrizzleOutboxRetentionRepository(env!.app);
    const cutoffs = computeRetentionCutoffs(new Date());

    const firstCount = await repo.purgeBatch(cutoffs, 1);
    expect(firstCount).toBe(1);
    const secondCount = await repo.purgeBatch(cutoffs, 1);
    expect(secondCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DR-1 + DR-2 + DR-3 + DR-4: full sweep covers both tenants, leaves
// survivors intact, tombstoned row goes through the time-based predicate.
// ---------------------------------------------------------------------------
describe("DrizzleOutboxRetentionRepository -- platform-admin cross-tenant sweep (DR-1..DR-4)", () => {
  it("a full sweep deletes the remaining eligible rows from BOTH tenants (DR-1)", async () => {
    if (maybeSkip()) return;

    // 2 eligible rows remain after DR-5 above (4 seeded - 2 deleted = 2).
    // Plus the audit-delivered-old + tombstoned rows -- depends on which two
    // DR-5 took first. Either way, the platform sweep must reduce the
    // eligible set to zero across BOTH tenants.
    const repo = new DrizzleOutboxRetentionRepository(env!.app);
    const cutoffs = computeRetentionCutoffs(new Date());

    // Sweep with a generous batch size so a single call drains everything.
    const purged = await repo.purgeBatch(cutoffs, 1000);
    expect(purged).toBeGreaterThan(0);

    // All four originally-eligible event ids must be gone.
    const remaining = await survivors();
    expect(remaining.has(EVENT_A_DELIVERED_OLD)).toBe(false);
    expect(remaining.has(EVENT_B_FAILED_OLD)).toBe(false);
    expect(remaining.has(EVENT_A_AUDIT_DELIVERED_OLD)).toBe(false);
    // DR-4 piggy-backs: the tombstoned row crossed its 90d delivered cutoff
    // and the sweep purged it WITHOUT needing to read the payload.
    expect(remaining.has(EVENT_B_TOMBSTONED_OLD)).toBe(false);
  });

  it("fresh rows from both tenants survive (DR-2)", async () => {
    if (maybeSkip()) return;
    const remaining = await survivors();
    expect(remaining.has(EVENT_A_DELIVERED_FRESH)).toBe(true);
    expect(remaining.has(EVENT_B_FAILED_FRESH)).toBe(true);
    // 100d-old audit-delivered is inside the 365d audit window -> survives.
    expect(remaining.has(EVENT_A_AUDIT_DELIVERED_MID)).toBe(true);
  });

  it("active rows (pending, claimed) survive even at 500 days old (DR-3)", async () => {
    if (maybeSkip()) return;
    const remaining = await survivors();
    expect(remaining.has(EVENT_A_PENDING_OLD)).toBe(true);
    expect(remaining.has(EVENT_B_CLAIMED_OLD)).toBe(true);
  });

  it("tombstoned-payload row was purged purely by timestamp -- payload was never required (DR-4)", async () => {
    if (maybeSkip()) return;
    // Re-asserted from DR-1 for clarity: a row whose payload has been
    // tombstoned by an out-of-band right-to-erasure flow STILL falls through
    // the retention sweep when its timestamp crosses the cutoff. The
    // predicate keys on delivery_state + event_type + processed_at only,
    // exactly as retention.spec.ts RT-4 demands.
    const remaining = await survivors();
    expect(remaining.has(EVENT_B_TOMBSTONED_OLD)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DR-6: idempotency -- a second sweep with the same cutoffs is a no-op
// ---------------------------------------------------------------------------
describe("DrizzleOutboxRetentionRepository -- idempotent re-run (DR-6)", () => {
  it("re-running the sweep with the same cutoffs returns 0 (DR-6)", async () => {
    if (maybeSkip()) return;
    const repo = new DrizzleOutboxRetentionRepository(env!.app);
    const cutoffs = computeRetentionCutoffs(new Date());
    const purged = await repo.purgeBatch(cutoffs, 1000);
    expect(purged).toBe(0);
  });
});
