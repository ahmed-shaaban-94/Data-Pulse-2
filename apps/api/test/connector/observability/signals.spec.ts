/**
 * signals.spec.ts — 018-POLISH (T090) observability signal verification.
 *
 * Every connector lifecycle action (register / issue / rotate / revoke /
 * disable) increments the SHARED `connector_lifecycle_total` counter (018's
 * §FR-022a signal, registered in api.metrics.ts + ALLOWED_METRIC_LABELS + the
 * cardinality drift list). UNLABELED (the affected tenant/instance/credential/
 * actor lives on connector_registration / auth_tokens + audit_events). Proves
 * the EMISSION by mocking the helper (the OTel instrument is a no-op without a
 * registered reader — the 015/017 idiom). Docker-gated (WSL).
 */
import "reflect-metadata";

jest.mock("../../../src/observability/metrics/api.metrics", () => {
  const actual = jest.requireActual("../../../src/observability/metrics/api.metrics");
  return { ...actual, recordConnectorLifecycle: jest.fn() };
});

import type { Pool } from "pg";

import { recordConnectorLifecycle } from "../../../src/observability/metrics/api.metrics";
import { ConnectorRegistrationService } from "../../../src/connector/connector-registration.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import { CONNECTOR_FIXTURE_IDS, seedConnectorFixture } from "../__support__/seed-connector";

const record = recordConnectorLifecycle as jest.MockedFunction<typeof recordConnectorLifecycle>;

const TENANT_A = CONNECTOR_FIXTURE_IDS.tenantA;
const ACTOR_A = "0a000000-0000-7000-8000-0000000000ac";

let env: PgTestEnv | null = null;
let service: ConnectorRegistrationService;
let skip = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConnectorFixture(env);
    service = new ConnectorRegistrationService(env.app as unknown as Pool);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      skip = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[connector signals.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => record.mockClear());

function maybeSkip(): boolean {
  if (skip) {
    // eslint-disable-next-line no-console
    console.warn("[connector signals.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

async function freshInstanceId(site: string): Promise<string> {
  const reg = await service.register({
    tenantId: TENANT_A,
    actorUserId: ACTOR_A,
    displayName: "Sig",
    erpnextSiteRef: site,
    environment: "pilot",
  });
  if (reg.kind !== "ok") throw new Error("register failed");
  return reg.instance.id;
}

describe("018-POLISH — connector_lifecycle_total signal", () => {
  it("register increments the lifecycle counter exactly once", async () => {
    if (maybeSkip()) return;
    await freshInstanceId("erp-sig-reg.example");
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("issue increments the lifecycle counter exactly once", async () => {
    if (maybeSkip()) return;
    const id = await freshInstanceId("erp-sig-iss.example");
    record.mockClear();
    await service.issue({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("rotate increments the lifecycle counter exactly once", async () => {
    if (maybeSkip()) return;
    const id = await freshInstanceId("erp-sig-rot.example");
    await service.issue({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    record.mockClear();
    await service.rotate({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("revoke increments the lifecycle counter exactly once", async () => {
    if (maybeSkip()) return;
    const id = await freshInstanceId("erp-sig-rev.example");
    const issued = await service.issue({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    if (issued.kind !== "ok") throw new Error("issue failed");
    record.mockClear();
    await service.revoke({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      credentialId: issued.credential.credential_id,
    });
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("disable increments the lifecycle counter exactly once (and not again on re-disable)", async () => {
    if (maybeSkip()) return;
    const id = await freshInstanceId("erp-sig-dis.example");
    record.mockClear();
    await service.disable({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(record).toHaveBeenCalledTimes(1);
    record.mockClear();
    await service.disable({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(record).toHaveBeenCalledTimes(0); // idempotent no-op → no second emit
  });
});
