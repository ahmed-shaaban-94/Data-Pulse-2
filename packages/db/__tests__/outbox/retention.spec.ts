/**
 * T564 [P7][Track C] -- Outbox retention purge-eligibility test.
 *
 * Scope (1C-A, test-first):
 *   This spec is the contract pin for the future `retention.processor.ts`
 *   (T590, slice 1C-B). It exercises the SQL predicate the processor MUST
 *   use to choose rows for deletion. No processor code exists yet -- the
 *   purge is executed inline from the test using the production predicate,
 *   so when the processor lands in 1C-B it has a locked-in shape to satisfy.
 *
 * The retention windows (docs/outbox/lifecycle.md sections 3 + 5,
 * `tasks.md` T543/T590):
 *   - delivered                     -> 90 days
 *   - failed | dead_lettered        -> 365 days
 *   - audit-relevant (event_type = 'audit.event.created') -> 365 days even
 *     when delivered (FR-C-007 immutability obligation)
 *   - right-to-erasure target        -> overrides both windows
 *     (FR-C-004 / spec section 14.12)
 *
 * Schema reminder
 * ---------------
 * The 0006_outbox_events.sql migration does NOT add a per-row erasure-hold
 * column. Per `docs/outbox/lifecycle.md` line 87, the right-to-erasure flow
 * tombstones PII fields in the payload but leaves the row metadata (state,
 * timestamps, redacted error class) in place. Retention is therefore a
 * pure time-based purge: the tombstoning is performed by the out-of-band
 * erasure caller, and the retention processor is unaware of it.
 *
 * This test exercises that contract: PII tombstoning happens before the
 * purge runs; the purge then either keeps the row (timestamp still inside
 * the window) or deletes it (timestamp outside the window) -- without ever
 * needing to read the payload.
 *
 * Docker / Testcontainers: required. Set MIGRATION_TEST_ALLOW_SKIP=1 to
 * soft-skip in local environments without Docker (matches the convention
 * used in `repository.spec.ts`).
 */
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Fixture UUIDs -- prefix "0bd" (outbox-retention), distinct from other suites
// ---------------------------------------------------------------------------
const TENANT_R = "0bd00000-0000-7000-8000-000000000001";

// Delivered events
const EVENT_DELIVERED_FRESH = "0bd10000-0000-4000-8000-000000000001";
const EVENT_DELIVERED_OLD = "0bd10000-0000-4000-8000-000000000002";

// Failed events
const EVENT_FAILED_FRESH = "0bd20000-0000-4000-8000-000000000001";
const EVENT_FAILED_OLD = "0bd20000-0000-4000-8000-000000000002";

// Delivered audit.event.created -- inherits the 365-day window (FR-C-007)
const EVENT_AUDIT_DELIVERED_FRESH = "0bd25000-0000-4000-8000-000000000001"; //   1 day -- NOT eligible
const EVENT_AUDIT_DELIVERED_MID   = "0bd25000-0000-4000-8000-000000000002"; // 100 days -- NOT eligible (would be under 90d rule, but audit inherits 365d)
const EVENT_AUDIT_DELIVERED_OLD   = "0bd25000-0000-4000-8000-000000000003"; // 400 days -- eligible

// Dead-lettered events
const EVENT_DL_FRESH = "0bd30000-0000-4000-8000-000000000001";
const EVENT_DL_OLD = "0bd30000-0000-4000-8000-000000000002";

// Pending / claimed events (must NEVER be purged regardless of age)
const EVENT_PENDING_OLD = "0bd40000-0000-4000-8000-000000000001";
const EVENT_CLAIMED_OLD = "0bd40000-0000-4000-8000-000000000002";

// Erasure-tombstoned events
const EVENT_TOMBSTONED_FRESH = "0bd50000-0000-4000-8000-000000000001";
const EVENT_TOMBSTONED_OLD = "0bd50000-0000-4000-8000-000000000002";

// RT-6 cross-tenant RLS fixtures
const TENANT_OTHER = "0bd00000-0000-7000-8000-000000000002";
const EVENT_RT6_R_ELIGIBLE     = "0bd60000-0000-4000-8000-000000000001"; // belongs to TENANT_R; eligible (400d failed)
const EVENT_RT6_OTHER_ELIGIBLE = "0bd60000-0000-4000-8000-000000000002"; // belongs to TENANT_OTHER; eligible (400d failed)

// PII canary -- if this string ever appears in a retention query result the
// test fails, proving the purge predicate does not need to read payload.
const PII_CANARY = "pii-canary@example.test";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'outbox-retention', 'Outbox Retention Tenant')`,
      [TENANT_R],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[outbox/retention.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[outbox/retention.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/**
 * Seed an outbox row directly via the admin pool so we control the exact
 * processed_at / occurred_at / created_at / updated_at backdates. Production
 * code never sets these explicitly; the retention test does because backdating
 * is the only way to exercise the window predicate without waiting 90 / 365
 * days.
 */
async function seedEvent(opts: {
  eventId: string;
  tenantId: string;
  /**
   * REQUIRED. The retention predicate keys off `event_type` (audit-relevant
   * events inherit the 365-day window even when delivered), so a defaulted
   * value would silently route fixture rows into the wrong window class.
   * Every call site MUST be explicit.
   */
  eventType: string;
  deliveryState: "pending" | "claimed" | "delivered" | "failed" | "dead_lettered";
  attempts?: number;
  payload?: Record<string, unknown>;
  ageDays: number; // 0 = now; positive numbers backdate processed_at/occurred_at
  includeProcessedAt?: boolean; // delivered/dead_lettered set this; pending/claimed/failed do not
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

  // Use a parameterised interval so the SQL is well-formed even when ageDays
  // is 0 (fresh). We backdate occurred_at AND created_at AND updated_at AND
  // (optionally) processed_at so any predicate the future processor chooses
  // is consistently expressible.
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

/**
 * The production purge predicate.
 *
 * This is the SQL shape the future `retention.processor.ts` (T590) MUST
 * implement. Pinning it here as a string constant means the processor
 * implementation has a locked-in contract: it can ship a thin wrapper
 * around this exact statement (parameterised on the runtime cutoffs)
 * and rely on this suite for behavioural coverage.
 *
 *   delivered          + processed_at < now() - 90d                -> purge
 *   failed | dead_letter + processed_at < now() - 365d             -> purge
 *
 *   Pending / claimed rows are NEVER purged regardless of age (active work).
 *
 *   Audit-relevant rows (event_type = 'audit.event.created') inherit the
 *   365-day window even when delivered (FR-C-007 audit immutability + the
 *   "audit-relevant" carve-out in lifecycle.md line 86). The processor
 *   MUST honour both classes.
 *
 * Returns the rows that ARE eligible for deletion. We assert against this
 * set rather than performing the DELETE first because eligibility is the
 * actual contract -- the DELETE itself is mechanical.
 */
const ELIGIBLE_SQL = `
  WITH cutoffs AS (
    SELECT
      now() - interval '90 days'  AS delivered_cutoff,
      now() - interval '365 days' AS failed_cutoff
  )
  SELECT event_id
    FROM outbox_events, cutoffs
   WHERE
     -- delivered non-audit rows older than 90d
     (delivery_state = 'delivered'
      AND event_type <> 'audit.event.created'
      AND processed_at < delivered_cutoff)
     OR
     -- failed / dead_lettered rows older than 365d
     (delivery_state IN ('failed', 'dead_lettered')
      AND COALESCE(processed_at, updated_at) < failed_cutoff)
     OR
     -- audit-relevant delivered rows inherit the 365d window
     (delivery_state = 'delivered'
      AND event_type = 'audit.event.created'
      AND processed_at < failed_cutoff)
`;

// ---------------------------------------------------------------------------
// Suite 1: Delivered events -- 90-day window
// ---------------------------------------------------------------------------
describe("outbox retention -- delivered events 90-day window (RT-1)", () => {
  beforeAll(async () => {
    if (dockerSkipped) return;
    // Fresh delivered: 1 day old, NOT eligible.
    await seedEvent({
      eventId: EVENT_DELIVERED_FRESH,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "delivered",
      ageDays: 1,
    });
    // Old delivered: 100 days old, eligible.
    await seedEvent({
      eventId: EVENT_DELIVERED_OLD,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "delivered",
      ageDays: 100,
    });
  });

  it("a delivered event 1 day old is NOT eligible for purge (RT-1a)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).not.toContain(EVENT_DELIVERED_FRESH);
  });

  it("a delivered event 100 days old IS eligible for purge (RT-1b)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).toContain(EVENT_DELIVERED_OLD);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Failed / dead-lettered events -- 365-day window
// ---------------------------------------------------------------------------
describe("outbox retention -- failed/dead_lettered events 365-day window (RT-2)", () => {
  beforeAll(async () => {
    if (dockerSkipped) return;
    // Failed fresh: 30 days, NOT eligible.
    await seedEvent({
      eventId: EVENT_FAILED_FRESH,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "failed",
      attempts: 3,
      ageDays: 30,
    });
    // Failed old: 400 days, eligible.
    await seedEvent({
      eventId: EVENT_FAILED_OLD,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "failed",
      attempts: 3,
      ageDays: 400,
    });
    // Dead-lettered fresh: 90 days, NOT eligible (failed window is 365d).
    await seedEvent({
      eventId: EVENT_DL_FRESH,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "dead_lettered",
      attempts: 8,
      ageDays: 90,
    });
    // Dead-lettered old: 400 days, eligible.
    await seedEvent({
      eventId: EVENT_DL_OLD,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "dead_lettered",
      attempts: 8,
      ageDays: 400,
    });
  });

  it("a failed event 30 days old is NOT eligible for purge (RT-2a)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).not.toContain(EVENT_FAILED_FRESH);
  });

  it("a failed event 400 days old IS eligible for purge (RT-2b)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).toContain(EVENT_FAILED_OLD);
  });

  it("a dead_lettered event 90 days old is NOT eligible (failed window is 365d) (RT-2c)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).not.toContain(EVENT_DL_FRESH);
  });

  it("a dead_lettered event 400 days old IS eligible for purge (RT-2d)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).toContain(EVENT_DL_OLD);
  });
});

// ---------------------------------------------------------------------------
// Suite 2.5: Audit events (delivered) -- 365-day window (audit-relevant carve-out)
// ---------------------------------------------------------------------------
//
// Rationale: `audit.event.created` is the first registered outbox event type
// (FR-C-007) and is audit-relevant -- it MUST inherit the 365-day window even
// when delivered (docs/outbox/lifecycle.md section 5, line 86; FR-C-007 audit
// immutability). This is the branch of ELIGIBLE_SQL that filters
// `delivery_state = 'delivered' AND event_type = 'audit.event.created'`
// against the 365-day cutoff rather than the 90-day cutoff.
//
// The 100-day-old case is the critical boundary: a delivered non-audit event
// at 100 days IS eligible (RT-1b), but a delivered audit event at 100 days
// MUST NOT be (audit carve-out). This suite locks that distinction.
describe("outbox retention -- audit events 365-day window (RT-2.5)", () => {
  beforeAll(async () => {
    if (dockerSkipped) return;
    // 1 day old -- inside both windows; NOT eligible.
    await seedEvent({
      eventId: EVENT_AUDIT_DELIVERED_FRESH,
      tenantId: TENANT_R,
      eventType: "audit.event.created",
      deliveryState: "delivered",
      ageDays: 1,
    });
    // 100 days old -- crosses 90d cutoff but inside 365d; NOT eligible (audit carve-out).
    await seedEvent({
      eventId: EVENT_AUDIT_DELIVERED_MID,
      tenantId: TENANT_R,
      eventType: "audit.event.created",
      deliveryState: "delivered",
      ageDays: 100,
    });
    // 400 days old -- crosses 365d cutoff; eligible.
    await seedEvent({
      eventId: EVENT_AUDIT_DELIVERED_OLD,
      tenantId: TENANT_R,
      eventType: "audit.event.created",
      deliveryState: "delivered",
      ageDays: 400,
    });
  });

  it("a delivered audit event 1 day old is NOT eligible for purge (RT-2.5a)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).not.toContain(EVENT_AUDIT_DELIVERED_FRESH);
  });

  it("a delivered audit event 100 days old is NOT eligible -- audit inherits 365d window (RT-2.5b)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).not.toContain(EVENT_AUDIT_DELIVERED_MID);
  });

  it("a delivered audit event 400 days old IS eligible for purge (RT-2.5c)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).toContain(EVENT_AUDIT_DELIVERED_OLD);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Active rows are never purged (regardless of age)
// ---------------------------------------------------------------------------
describe("outbox retention -- active rows are never purged (RT-3)", () => {
  beforeAll(async () => {
    if (dockerSkipped) return;
    // A pending row 500 days old (extreme case -- never delivered, never failed)
    await seedEvent({
      eventId: EVENT_PENDING_OLD,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "pending",
      ageDays: 500,
    });
    // A claimed row 500 days old (drainer crashed mid-claim; needs operator triage)
    await seedEvent({
      eventId: EVENT_CLAIMED_OLD,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "claimed",
      attempts: 1,
      ageDays: 500,
    });
  });

  it("a pending row 500 days old is NOT eligible (active work) (RT-3a)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).not.toContain(EVENT_PENDING_OLD);
  });

  it("a claimed row 500 days old is NOT eligible (active work; needs triage) (RT-3b)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    expect(ids).not.toContain(EVENT_CLAIMED_OLD);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: PII erasure tombstoning -- predicate does not read payload
// ---------------------------------------------------------------------------
describe("outbox retention -- right-to-erasure tombstoning (RT-4)", () => {
  beforeAll(async () => {
    if (dockerSkipped) return;
    // Two rows: one inside the window (fresh), one outside. Both have their
    // PII fields tombstoned by an out-of-band erasure caller BEFORE the
    // purge predicate runs. The predicate must give the same answer it
    // would have given on the un-tombstoned row -- proving the purge does
    // not need to read payload.
    await seedEvent({
      eventId: EVENT_TOMBSTONED_FRESH,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "delivered",
      ageDays: 1,
      payload: { ref: EVENT_TOMBSTONED_FRESH, actor_label: PII_CANARY },
    });
    await seedEvent({
      eventId: EVENT_TOMBSTONED_OLD,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "delivered",
      ageDays: 100,
      payload: { ref: EVENT_TOMBSTONED_OLD, actor_label: PII_CANARY },
    });

    // Simulate the out-of-band right-to-erasure tombstoning: replace the
    // PII-carrying field with a sentinel. Schema is unchanged; this is a
    // JSONB UPDATE only.
    await env!.admin.query(
      `UPDATE outbox_events
          SET payload = jsonb_set(payload, '{actor_label}', '"[ERASED]"', true),
              updated_at = updated_at  -- keep updated_at backdated so timestamps still drive eligibility
        WHERE event_id IN ($1, $2)`,
      [EVENT_TOMBSTONED_FRESH, EVENT_TOMBSTONED_OLD],
    );
  });

  it("tombstoning removes the PII canary from the payload (RT-4a)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ payload: { actor_label: string } }>(
      "SELECT payload FROM outbox_events WHERE event_id IN ($1, $2)",
      [EVENT_TOMBSTONED_FRESH, EVENT_TOMBSTONED_OLD],
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.payload.actor_label).toBe("[ERASED]");
      expect(JSON.stringify(row.payload)).not.toContain(PII_CANARY);
    }
  });

  it("the purge predicate gives the same answer on tombstoned rows -- it does not read payload (RT-4b)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    const ids = r.rows.map((row) => row.event_id);
    // Fresh tombstoned row: still inside the 90d delivered window -> NOT eligible.
    expect(ids).not.toContain(EVENT_TOMBSTONED_FRESH);
    // Old tombstoned row: outside the 90d delivered window -> eligible.
    expect(ids).toContain(EVENT_TOMBSTONED_OLD);
  });

  it("a tombstoned row that is also purge-eligible carries no PII canary (RT-4c)", async () => {
    if (maybeSkip()) return;
    // Scope the projection to the TOMBSTONED rows only. Other suites seed
    // non-tombstoned eligible rows that still carry the canary -- that is
    // by design (the canary tests the purge predicate, not erasure). The
    // assertion here is narrow: ONCE a row has been tombstoned, the canary
    // is gone regardless of where the row sits in the retention window.
    const r = await env!.admin.query<{
      event_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_id, payload
         FROM outbox_events
        WHERE event_id IN ($1, $2)`,
      [EVENT_TOMBSTONED_FRESH, EVENT_TOMBSTONED_OLD],
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      const serialised = JSON.stringify(row.payload);
      expect(serialised).not.toContain(PII_CANARY);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 5: DELETE shape -- the processor's mechanical step
// ---------------------------------------------------------------------------
//
// Order independence: the three assertions below each make an INDEPENDENT
// observation of post-purge state. The DELETE itself (and its before/after
// snapshots) runs in `beforeAll`, so removing or reordering any single
// `it` does not break the others. Re-running an individual test via
// `--testNamePattern="RT-5b"` also works.
describe("outbox retention -- DELETE shape (RT-5)", () => {
  // Captured in beforeAll; read-only thereafter. Initialised to undefined so
  // a Docker-skip path leaves them untouched and the per-test guards short-
  // circuit before any assertion fires.
  let eligibleIdsBefore: Set<string> | undefined;
  let deletedIds: Set<string> | undefined;

  beforeAll(async () => {
    if (dockerSkipped) return;

    // Snapshot eligibility BEFORE the DELETE, then run the DELETE with the
    // same predicate, then keep both sets in module scope for the per-test
    // observations. The DELETE is fired exactly once per test-suite run.
    const before = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    eligibleIdsBefore = new Set(before.rows.map((r) => r.event_id));

    const deleted = await env!.admin.query<{ event_id: string }>(
      `WITH cutoffs AS (
         SELECT now() - interval '90 days'  AS delivered_cutoff,
                now() - interval '365 days' AS failed_cutoff
       )
       DELETE FROM outbox_events
        USING cutoffs
        WHERE (delivery_state = 'delivered'
               AND event_type <> 'audit.event.created'
               AND processed_at < delivered_cutoff)
           OR (delivery_state IN ('failed','dead_lettered')
               AND COALESCE(processed_at, updated_at) < failed_cutoff)
           OR (delivery_state = 'delivered'
               AND event_type = 'audit.event.created'
               AND processed_at < failed_cutoff)
        RETURNING event_id`,
    );
    deletedIds = new Set(deleted.rows.map((r) => r.event_id));
  });

  it("the DELETE affects exactly the rows the eligibility predicate identified (RT-5a)", () => {
    if (maybeSkip()) return;
    expect(deletedIds).toEqual(eligibleIdsBefore);
    // Sanity: at least one row was deleted (the suite seeded multiple
    // window-crossing rows). If this fails the seed/window pair is wrong.
    expect(deletedIds!.size).toBeGreaterThan(0);
  });

  it("after purge, the eligibility predicate returns no rows (RT-5b -- idempotency)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string }>(ELIGIBLE_SQL);
    expect(r.rows).toHaveLength(0);
  });

  it("after purge, active rows (pending/claimed) are still present (RT-5c)", async () => {
    if (maybeSkip()) return;
    const r = await env!.admin.query<{ event_id: string; delivery_state: string }>(
      "SELECT event_id, delivery_state FROM outbox_events WHERE event_id IN ($1, $2)",
      [EVENT_PENDING_OLD, EVENT_CLAIMED_OLD],
    );
    expect(r.rows).toHaveLength(2);
    const states = r.rows.map((row) => row.delivery_state).sort();
    expect(states).toEqual(["claimed", "pending"]);
  });
});

// ---------------------------------------------------------------------------
// Suite 6: Cross-tenant RLS regression -- predicate respects tenant isolation
// ---------------------------------------------------------------------------
//
// What this proves
// ----------------
// All preceding suites pin ELIGIBLE_SQL via `env.admin.query()`, which runs
// as the Postgres superuser and BYPASSES RLS by definition. That asserts the
// SQL SHAPE of the predicate but NOT that the production retention path
// respects tenant isolation. The future `retention.processor.ts` (slice 1C-B)
// will run as the non-superuser app role under a tenant GUC context, so the
// predicate's behaviour MUST be re-asserted under that posture.
//
// This suite uses `env.app` (the non-superuser `app_test` role) inside a
// transaction with `set_config('app.current_tenant', $1, true)` so the
// outbox_events FORCE ROW LEVEL SECURITY policy is exercised. With the row
// visibility predicate `current_setting('app.current_tenant', true)::uuid =
// tenant_id`, a TENANT_R context MUST NOT see TENANT_OTHER's events even
// though both are independently purge-eligible by the time-window predicate.
//
// Setup posture
// -------------
// RT-6 seeds its own fixtures in its `beforeAll` (rather than the top-level
// `beforeAll`) because RT-5's DELETE runs between top-level setup and RT-6's
// tests, and would wipe any pre-seeded eligible rows. Seeding here keeps the
// fixture lifetime scoped to this suite.
describe("outbox retention -- cross-tenant RLS regression (RT-6)", () => {
  beforeAll(async () => {
    if (dockerSkipped) return;

    // Seed the second tenant. ON CONFLICT DO NOTHING so a re-run of the
    // suite (or a future suite that also needs TENANT_OTHER) is safe.
    await env!.admin.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1, 'outbox-retention-other', 'Outbox Retention Other Tenant')
       ON CONFLICT (id) DO NOTHING`,
      [TENANT_OTHER],
    );

    // One purge-eligible (failed, 400d) event per tenant. Both rows are
    // unambiguously in the failed/dead_lettered 365d window. The retention
    // predicate ON ITS OWN matches both rows; only RLS distinguishes them.
    await seedEvent({
      eventId: EVENT_RT6_R_ELIGIBLE,
      tenantId: TENANT_R,
      eventType: "test.non_audit",
      deliveryState: "failed",
      attempts: 3,
      ageDays: 400,
    });
    await seedEvent({
      eventId: EVENT_RT6_OTHER_ELIGIBLE,
      tenantId: TENANT_OTHER,
      eventType: "test.non_audit",
      deliveryState: "failed",
      attempts: 3,
      ageDays: 400,
    });
  });

  it("RT-6 excludes another tenant's purge-eligible rows under app-role RLS context", async () => {
    if (maybeSkip()) return;

    // Step 1: confirm via the superuser that both fixtures exist and would
    // BOTH match the bare retention predicate when RLS is bypassed. This
    // makes the RLS-enforced result below meaningful -- without this guard
    // a regression in fixture seeding could silently pass the RLS check.
    const adminPreflight = await env!.admin.query<{ event_id: string }>(
      `${ELIGIBLE_SQL}
         AND event_id IN ($1, $2)`,
      [EVENT_RT6_R_ELIGIBLE, EVENT_RT6_OTHER_ELIGIBLE],
    );
    const adminIds = new Set(adminPreflight.rows.map((r) => r.event_id));
    expect(adminIds).toEqual(new Set([EVENT_RT6_R_ELIGIBLE, EVENT_RT6_OTHER_ELIGIBLE]));

    // Step 2: re-run the SAME predicate as the non-superuser app role under
    // TENANT_R's GUC context. RLS must filter TENANT_OTHER's row out.
    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      // set_config with `is_local = true` scopes the GUC to this transaction
      // exactly like `SET LOCAL`, but allows parameter binding. The
      // production retention processor will use the same pattern through
      // its `runWithTenantContext` helper.
      await client.query(
        "SELECT set_config('app.current_tenant', $1, true)",
        [TENANT_R],
      );
      // Defence in depth: explicitly disable the platform-admin OR-branch
      // so we are genuinely testing tenant-id-based RLS filtering, not the
      // platform-admin bypass path the drainer uses.
      await client.query(
        "SELECT set_config('app.is_platform_admin', 'false', true)",
      );

      const appResult = await client.query<{ event_id: string }>(
        `${ELIGIBLE_SQL}
           AND event_id IN ($1, $2)`,
        [EVENT_RT6_R_ELIGIBLE, EVENT_RT6_OTHER_ELIGIBLE],
      );
      const appIds = new Set(appResult.rows.map((r) => r.event_id));

      // Positive: TENANT_R's eligible row IS visible.
      expect(appIds).toContain(EVENT_RT6_R_ELIGIBLE);
      // Negative: TENANT_OTHER's eligible row is filtered out by RLS even
      // though the time-window predicate matches it.
      expect(appIds).not.toContain(EVENT_RT6_OTHER_ELIGIBLE);

      await client.query("ROLLBACK");
    } catch (err: unknown) {
      // Ensure the pooled client is never returned in an aborted-tx state.
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw err;
    } finally {
      client.release();
    }
  });
});
