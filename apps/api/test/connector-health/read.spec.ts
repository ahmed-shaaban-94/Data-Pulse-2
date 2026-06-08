/**
 * 020-US1 / US3 (T010, T012, T027) — operator connection-status reads + RLS.
 *
 * Exercises ConnectorHealthService.listHealth / getHealth against a
 * Testcontainers Postgres 16 with the RLS-active `app` pool (the production
 * runtime role). Proves:
 *   - list returns each registration with identity + derived verdict +
 *     secondsSinceLastSeen + the most-recent self-reported fields; no secret;
 *   - the verdicts: healthy (recent last_seen_at), never_seen (no health row),
 *     disabled (018 disabled_at — never healthy);
 *   - stale when last_seen_at is past the 5-minute threshold;
 *   - detail (getHealth) returns the single-instance shape incl. reportedFieldsAt;
 *   - cross-tenant getHealth -> null (RLS-scoped) -> the controller's safe 404;
 *   - RLS bypass probe: tenant B cannot see tenant A's health rows.
 *
 * Docker-gated (WSL): missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it).
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
  REG_A_DISABLED,
  REG_A_HEALTHY,
  REG_A_NEVER,
  REG_B,
  seedConnectorHealthFixture,
} from "./__support__/seed-connector-health";

const TENANT_A = HEALTH_FIXTURE_IDS.tenantA;
const TENANT_B = HEALTH_FIXTURE_IDS.tenantB;

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
      console.warn(`\n[connector-health read.spec] Docker NOT AVAILABLE: ${msg}\n`);
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

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[connector-health read.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

function guard(): PgTestEnv {
  if (!env) throw new Error("env not initialized");
  return env;
}

describe("020-US1 — listHealth", () => {
  it("lists tenant A's registrations with identity + derived verdict + no secret", async () => {
    if (maybeSkip()) return;
    const items = await service.listHealth({ tenantId: TENANT_A });
    const byId = new Map(items.map((i) => [i.connectorId, i]));

    // Only tenant A's registrations are visible (RLS) — B is absent.
    expect(byId.has(REG_B)).toBe(false);
    expect(byId.has(REG_A_HEALTHY)).toBe(true);
    expect(byId.has(REG_A_NEVER)).toBe(true);
    expect(byId.has(REG_A_DISABLED)).toBe(true);

    const healthy = byId.get(REG_A_HEALTHY)!;
    expect(healthy.liveness).toBe("healthy");
    expect(healthy.lastSeenAt).not.toBeNull();
    expect(healthy.secondsSinceLastSeen).toBeGreaterThanOrEqual(0);
    expect(healthy.connectorVersion).toBe("1.2.3");
    expect(healthy.backlogIndicator).toBe(0);
    expect(healthy.erpnextReachable).toBe(true);
    expect(healthy.displayName).toBe("A Healthy");
    expect(healthy.environment).toBe("pilot");
    // §IV — no raw-row id / tenant_id / secret leaks into the projection.
    expect(healthy).not.toHaveProperty("id");
    expect(healthy).not.toHaveProperty("tenant_id");
    expect(healthy).not.toHaveProperty("tenantId");

    const never = byId.get(REG_A_NEVER)!;
    expect(never.liveness).toBe("never_seen");
    expect(never.lastSeenAt).toBeNull();
    expect(never.secondsSinceLastSeen).toBeNull();
    expect(never.connectorVersion).toBeNull();

    // Disabled wins over an otherwise-healthy window — never reported healthy.
    const disabled = byId.get(REG_A_DISABLED)!;
    expect(disabled.liveness).toBe("disabled");
  });

  it("a registration whose last heartbeat is past the 5-min threshold is stale", async () => {
    if (maybeSkip()) return;
    const e = guard();
    // Push REG_A_HEALTHY's last_seen_at well past the threshold, then re-read.
    await e.admin.query(
      `UPDATE connector_health SET last_seen_at = now() - interval '10 minutes'
        WHERE connector_registration_id = $1`,
      [REG_A_HEALTHY],
    );
    try {
      const items = await service.listHealth({ tenantId: TENANT_A });
      const healthy = items.find((i) => i.connectorId === REG_A_HEALTHY)!;
      expect(healthy.liveness).toBe("stale");
      expect(healthy.secondsSinceLastSeen).toBeGreaterThan(5 * 60);
    } finally {
      // Restore to healthy for any later assertion.
      await e.admin.query(
        `UPDATE connector_health SET last_seen_at = now()
          WHERE connector_registration_id = $1`,
        [REG_A_HEALTHY],
      );
    }
  });

  it("returns an empty array for a tenant with no registrations", async () => {
    if (maybeSkip()) return;
    const items = await service.listHealth({
      tenantId: "0c200000-0000-7000-8000-00000c020e00",
    });
    expect(items).toEqual([]);
  });
});

describe("020-US3 — getHealth (single-instance detail)", () => {
  it("returns the single-instance detail incl. reportedFieldsAt + self-reported fields", async () => {
    if (maybeSkip()) return;
    const view = await service.getHealth({
      tenantId: TENANT_A,
      registrationId: REG_A_HEALTHY,
    });
    expect(view).not.toBeNull();
    expect(view!.connectorId).toBe(REG_A_HEALTHY);
    expect(view!.liveness).toBe("healthy");
    expect(view!.reportedFieldsAt).not.toBeNull();
    expect(view!.connectorVersion).toBe("1.2.3");
    expect(view!.erpnextReachable).toBe(true);
  });

  it("a never-seen registration's detail returns never_seen + null fields", async () => {
    if (maybeSkip()) return;
    const view = await service.getHealth({
      tenantId: TENANT_A,
      registrationId: REG_A_NEVER,
    });
    expect(view!.liveness).toBe("never_seen");
    expect(view!.lastSeenAt).toBeNull();
    expect(view!.reportedFieldsAt).toBeNull();
  });

  it("cross-tenant getHealth returns null (RLS-scoped) — controller maps to safe 404", async () => {
    if (maybeSkip()) return;
    // Tenant A asks for tenant B's registration -> RLS hides it -> null.
    const view = await service.getHealth({
      tenantId: TENANT_A,
      registrationId: REG_B,
    });
    expect(view).toBeNull();
  });

  it("an absent registration id returns null", async () => {
    if (maybeSkip()) return;
    const view = await service.getHealth({
      tenantId: TENANT_A,
      registrationId: "0c200000-0000-7000-8000-00000c020fff",
    });
    expect(view).toBeNull();
  });
});

describe("020 — RLS bypass probe on connector_health", () => {
  it("tenant B cannot see tenant A's health rows (wrong app.current_tenant -> 0 rows)", async () => {
    if (maybeSkip()) return;
    const e = guard();
    const client = await e.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${TENANT_B}'`);
      const wrong = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM connector_health`,
      );
      expect(wrong.rows[0]?.count).toBe("0");
      await client.query(`SET app.current_tenant = '${TENANT_A}'`);
      const right = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM connector_health`,
      );
      expect(Number(right.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
  });

  it("empty GUC fails closed (zero rows, no 22P02)", async () => {
    if (maybeSkip()) return;
    const e = guard();
    const client = await e.app.connect();
    try {
      await client.query(`RESET app.current_tenant`);
      const r = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM connector_health`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } finally {
      client.release();
    }
  });
});
