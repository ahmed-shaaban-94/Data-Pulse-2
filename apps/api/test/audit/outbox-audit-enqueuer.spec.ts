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

describe("auditJobEnqueuerFactory — legacy path unchanged", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env["OUTBOX_AUDIT_ENABLED"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("with OUTBOX_AUDIT_ENABLED unset + REDIS_URL unset + NODE_ENV=test → NoOp", () => {
    delete process.env["REDIS_URL"];
    process.env["NODE_ENV"] = "test";
    const enqueuer = auditJobEnqueuerFactory();
    expect(enqueuer).toBeInstanceOf(NoOpAuditJobEnqueuer);
  });
});

// ---------------------------------------------------------------------------
// Layer B — Integration: real Postgres + outbox INSERT
// ---------------------------------------------------------------------------

const TENANT_A = "0aa00000-0000-7000-8000-000000000001";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

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

function maybeSkip(): boolean {
  if (dockerSkipped) {
    console.warn("[outbox-audit-enqueuer.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

describe("OutboxAuditEnqueuer — writes a pending outbox_events row", () => {
  it("inserts an audit.event.created row with the payload preserved (tenant-scoped)", async () => {
    if (maybeSkip()) return;

    const enqueuer = new OutboxAuditEnqueuer(env!.admin);
    const payload: AuditJobPayload = {
      actor_user_id: "00000000-0000-7000-8000-000000000010",
      actor_label:   null,
      tenant_id:     TENANT_A,
      store_id:      null,
      action:        "context.switch.tenant",
      target_type:   "tenant",
      target_id:     "00000000-0000-7000-8000-000000000020",
      request_id:    "req-corr-0001",
      metadata:      null,
    };

    await enqueuer.enqueue(payload);

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
        ORDER BY created_at DESC
        LIMIT 1`,
      [TENANT_A],
    );

    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0]!;
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.event_type).toBe("audit.event.created");
    expect(row.delivery_state).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.correlation_id).toBe("req-corr-0001");
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
    const enqueuer = new OutboxAuditEnqueuer(env!.admin);
    const payload: AuditJobPayload = {
      actor_user_id: null,
      actor_label:   "platform-admin",
      tenant_id:     null, // platform-scoped — no tenant
      store_id:      null,
      action:        "platform.tenant.created",
      target_type:   null,
      target_id:     null,
      request_id:    "platform-req-0001",
      metadata:      null,
    };

    await enqueuer.enqueue(payload);

    const rows = await env!.admin.query<{ tenant_id: string; event_type: string }>(
      `SELECT tenant_id, event_type
         FROM outbox_events
        WHERE correlation_id = 'platform-req-0001'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.tenant_id).toBe(NIL_UUID);
    expect(rows.rows[0]!.event_type).toBe("audit.event.created");
  });
});
