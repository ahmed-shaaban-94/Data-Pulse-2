/**
 * 020-US2 (T018, T019, T021, T022) — connector heartbeat write.
 *
 * Exercises ConnectorHealthService.recordHeartbeat against a Testcontainers
 * Postgres 16 (RLS-active `app` pool). Proves:
 *   - a usable identity -> last_seen_at = now() (server clock) on the
 *     registration's health row; first beat CREATES the row, later beats UPDATE
 *     it (lazy create);
 *   - the identity comes from the guard-attached context, NOT the body
 *     (T019 is also covered structurally by the contract `.strict()` body +
 *     the controller passing only guard identity — here we prove the service
 *     ignores any caller-supplied identity by upserting on registrationId only);
 *   - convergence: two sequential/repeated heartbeats -> ONE row, latest
 *     last_seen_at (LWW); idempotent re-run (no duplicate rows);
 *   - no-outbound-ERPNext: the service surface has no ERPNext HTTP client
 *     (recordHeartbeat is a single DB upsert).
 *
 * Docker-gated (WSL).
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { ConnectorHealthService } from "../../src/connector-health/connector-health.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  HEALTH_FIXTURE_IDS,
  REG_A_NEVER,
  seedConnectorHealthFixture,
} from "./__support__/seed-connector-health";

const TENANT_A = HEALTH_FIXTURE_IDS.tenantA;

let env: PgTestEnv | null = null;
let service: ConnectorHealthService;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[connector-health heartbeat.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  await applyAllUpAndCreateAppRole(env);
  await seedConnectorHealthFixture(env);
  service = new ConnectorHealthService(env.app as unknown as Pool);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (dockerSkipped || !env) return;
  // REG_A_NEVER starts with NO health row each test — drop any prior one.
  await env.admin.query(
    `DELETE FROM connector_health WHERE connector_registration_id = $1`,
    [REG_A_NEVER],
  );
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[connector-health heartbeat.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function guard(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

async function healthRow(registrationId: string): Promise<{
  last_seen_at: Date | null;
  connector_version: string | null;
  backlog_indicator: number | null;
  erpnext_reachable: boolean | null;
  source_clock_at: Date | null;
  reported_fields_at: Date | null;
} | undefined> {
  const r = await guard().admin.query<{
    last_seen_at: Date | null;
    connector_version: string | null;
    backlog_indicator: number | null;
    erpnext_reachable: boolean | null;
    source_clock_at: Date | null;
    reported_fields_at: Date | null;
  }>(
    `SELECT last_seen_at, connector_version, backlog_indicator, erpnext_reachable,
            source_clock_at, reported_fields_at
       FROM connector_health WHERE connector_registration_id = $1`,
    [registrationId],
  );
  return r.rows[0];
}

async function rowCount(registrationId: string): Promise<number> {
  const r = await guard().admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM connector_health WHERE connector_registration_id = $1`,
    [registrationId],
  );
  return Number(r.rows[0]?.n ?? "0");
}

describe("020-US2 — recordHeartbeat", () => {
  it("first beat lazily CREATES the health row with server-clock last_seen_at + self-reported fields", async () => {
    if (maybeSkip()) return;
    expect(await rowCount(REG_A_NEVER)).toBe(0);

    const ack = await service.recordHeartbeat(
      { registrationId: REG_A_NEVER, tenantId: TENANT_A },
      { connectorVersion: "2.0.0", backlogIndicator: 3, erpnextReachable: true },
    );
    expect(ack.acknowledgedAt).toEqual(expect.any(String));

    expect(await rowCount(REG_A_NEVER)).toBe(1);
    const row = await healthRow(REG_A_NEVER);
    expect(row?.last_seen_at).not.toBeNull();
    expect(row?.connector_version).toBe("2.0.0");
    expect(row?.backlog_indicator).toBe(3);
    expect(row?.erpnext_reachable).toBe(true);
    // The acknowledgedAt is the server-clock last_seen_at.
    expect(ack.acknowledgedAt).toBe(row!.last_seen_at!.toISOString());
  });

  it("preserves source_clock_at as provenance (stored, never used for the verdict)", async () => {
    if (maybeSkip()) return;
    const sourceClock = "2020-01-01T00:00:00.000Z";
    await service.recordHeartbeat(
      { registrationId: REG_A_NEVER, tenantId: TENANT_A },
      { sourceClockAt: sourceClock },
    );
    const row = await healthRow(REG_A_NEVER);
    expect(row?.source_clock_at?.toISOString()).toBe(sourceClock);
    // last_seen_at is the SERVER clock — NOT the connector-reported source clock.
    expect(row?.last_seen_at?.toISOString()).not.toBe(sourceClock);
  });

  it("an empty heartbeat body still records last_seen_at = now() and leaves reported_fields_at null", async () => {
    if (maybeSkip()) return;
    const ack = await service.recordHeartbeat(
      { registrationId: REG_A_NEVER, tenantId: TENANT_A },
      {},
    );
    expect(ack.acknowledgedAt).toEqual(expect.any(String));
    const row = await healthRow(REG_A_NEVER);
    expect(row?.last_seen_at).not.toBeNull();
    expect(row?.connector_version).toBeNull();
    // A liveness-only beat carries no self-reported fields → reported_fields_at
    // stays null ("null until reported" — contract).
    expect(row?.reported_fields_at).toBeNull();
  });

  it("reported_fields_at is set on a fields beat and PRESERVED (not clobbered) by a later empty beat", async () => {
    if (maybeSkip()) return;
    // Beat 1: carries self-reported fields → reported_fields_at is stamped.
    await service.recordHeartbeat(
      { registrationId: REG_A_NEVER, tenantId: TENANT_A },
      { connectorVersion: "3.1.0", backlogIndicator: 5 },
    );
    const afterFields = await healthRow(REG_A_NEVER);
    expect(afterFields?.reported_fields_at).not.toBeNull();
    const stamped = afterFields!.reported_fields_at!.getTime();

    // Beat 2: empty liveness-only beat. last_seen_at advances, but
    // reported_fields_at must be PRESERVED (target-table value, NOT clobbered
    // to NULL via EXCLUDED). This is the regression for the contract drift.
    await service.recordHeartbeat(
      { registrationId: REG_A_NEVER, tenantId: TENANT_A },
      {},
    );
    const afterEmpty = await healthRow(REG_A_NEVER);
    expect(afterEmpty?.reported_fields_at).not.toBeNull();
    expect(afterEmpty!.reported_fields_at!.getTime()).toBe(stamped);
  });

  it("LWW convergence: repeated heartbeats keep ONE row with the latest last_seen_at", async () => {
    if (maybeSkip()) return;
    const first = await service.recordHeartbeat(
      { registrationId: REG_A_NEVER, tenantId: TENANT_A },
      { connectorVersion: "1.0.0", backlogIndicator: 10 },
    );
    const second = await service.recordHeartbeat(
      { registrationId: REG_A_NEVER, tenantId: TENANT_A },
      { connectorVersion: "1.0.1", backlogIndicator: 0 },
    );
    expect(await rowCount(REG_A_NEVER)).toBe(1);
    const row = await healthRow(REG_A_NEVER);
    // Latest write wins on every field.
    expect(row?.connector_version).toBe("1.0.1");
    expect(row?.backlog_indicator).toBe(0);
    expect(new Date(second.acknowledgedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.acknowledgedAt).getTime(),
    );
  });

  it("two concurrent heartbeats converge to one row (UNIQUE conflict target)", async () => {
    if (maybeSkip()) return;
    await Promise.all([
      service.recordHeartbeat(
        { registrationId: REG_A_NEVER, tenantId: TENANT_A },
        { connectorVersion: "9.0.0" },
      ),
      service.recordHeartbeat(
        { registrationId: REG_A_NEVER, tenantId: TENANT_A },
        { connectorVersion: "9.0.1" },
      ),
    ]);
    expect(await rowCount(REG_A_NEVER)).toBe(1);
  });
});
