/**
 * 020-POLISH (T029) — connector_heartbeat_total signal emission.
 *
 * Every ACCEPTED heartbeat increments the SHARED unlabeled
 * `connector_heartbeat_total` counter (FR-018; registered in api.metrics.ts +
 * ALLOWED_METRIC_LABELS + the cardinality drift list). Proves the EMISSION by
 * mocking the helper (the OTel instrument is a no-op without a registered reader
 * — the 015/017/018 idiom). Docker-gated (WSL).
 */
import "reflect-metadata";

jest.mock("../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual("../../src/observability/metrics/api.metrics");
  return { ...actual, recordConnectorHeartbeat: jest.fn() };
});

import type { Pool } from "pg";

import { recordConnectorHeartbeat } from "../../src/observability/metrics/api.metrics";
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

const record = recordConnectorHeartbeat as jest.MockedFunction<
  typeof recordConnectorHeartbeat
>;
const TENANT_A = HEALTH_FIXTURE_IDS.tenantA;

let env: PgTestEnv | null = null;
let service: ConnectorHealthService;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConnectorHealthFixture(env);
    service = new ConnectorHealthService(env.app as unknown as Pool);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[connector-health signals.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(async () => {
  if (dockerSkipped || !env) return;
  record.mockClear();
  await env.admin.query(
    `DELETE FROM connector_health WHERE connector_registration_id = $1`,
    [REG_A_NEVER],
  );
});

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[connector-health signals.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

describe("020-POLISH — connector_heartbeat_total signal", () => {
  it("an accepted heartbeat increments the counter exactly once", async () => {
    if (maybeSkip()) return;
    await service.recordHeartbeat(
      { registrationId: REG_A_NEVER, tenantId: TENANT_A },
      { connectorVersion: "1.0.0" },
    );
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("each subsequent beat increments again (one per accepted beat)", async () => {
    if (maybeSkip()) return;
    await service.recordHeartbeat({ registrationId: REG_A_NEVER, tenantId: TENANT_A }, {});
    record.mockClear();
    await service.recordHeartbeat({ registrationId: REG_A_NEVER, tenantId: TENANT_A }, {});
    expect(record).toHaveBeenCalledTimes(1);
  });
});
