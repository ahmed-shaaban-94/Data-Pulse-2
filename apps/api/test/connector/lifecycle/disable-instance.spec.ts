/**
 * 018-US3-DISABLE (T070) — logical instance disable.
 *
 * Service-level Testcontainers spec. Proves:
 *   §1 disable sets disabled_at/disabled_by; the instance's credential becomes
 *      unusable at the guard resolver (predicate clause 7);
 *   §2 NO rows deleted — the registration + its credential rows persist (FR-014);
 *   §3 idempotent — re-disabling an already-disabled instance is a success no-op;
 *   §4 issuing a credential for a disabled instance → not_found;
 *   §5 cross-tenant / absent id → not_found (non-disclosing).
 */
import "reflect-metadata";

import type { Pool } from "pg";

import { AuthTokenRepository } from "../../../src/auth/auth-token.repository";
import { ConnectorRegistrationService } from "../../../src/connector/connector-registration.service";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import { CONNECTOR_FIXTURE_IDS, seedConnectorFixture } from "../__support__/seed-connector";

const TENANT_A = CONNECTOR_FIXTURE_IDS.tenantA;
const ACTOR_A = "0a000000-0000-7000-8000-0000000000ac";

let env: PgTestEnv | null = null;
let service: ConnectorRegistrationService;
let repo: AuthTokenRepository;
let dockerSkipped = false;

async function rowCounts(instanceId: string): Promise<{ regs: number; creds: number }> {
  const regs = await env!.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM connector_registration WHERE id = $1`,
    [instanceId],
  );
  const creds = await env!.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth_tokens WHERE connector_registration_id = $1`,
    [instanceId],
  );
  return { regs: Number(regs.rows[0]!.n), creds: Number(creds.rows[0]!.n) };
}

/** Register a fresh instance + issue a credential; return { id, credentialId }. */
async function freshInstance(siteRef: string): Promise<{ id: string; credentialId: string }> {
  const reg = await service.register({
    tenantId: TENANT_A,
    actorUserId: ACTOR_A,
    displayName: "Dis",
    erpnextSiteRef: siteRef,
    environment: "pilot",
  });
  if (reg.kind !== "ok") throw new Error("register failed");
  const issued = await service.issue({
    tenantId: TENANT_A,
    actorUserId: ACTOR_A,
    instanceId: reg.instance.id,
  });
  if (issued.kind !== "ok") throw new Error("issue failed");
  return { id: reg.instance.id, credentialId: issued.credential.credential_id };
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConnectorFixture(env);
    service = new ConnectorRegistrationService(env.app as unknown as Pool);
    repo = new AuthTokenRepository(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[disable-instance.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[disable-instance.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

describe("018-US3 — disable instance", () => {
  it("§1+§2 disable makes the credential unusable at the guard, deletes no rows", async () => {
    if (maybeSkip()) return;
    const { id, credentialId } = await freshInstance("erp-dis-1.example");
    // The credential resolves before disable.
    const tokenId = (
      await env!.admin.query<{ id: string }>(
        `SELECT id FROM auth_tokens WHERE id = $1`,
        [credentialId],
      )
    ).rows[0]!.id;
    expect(await repo.findActiveConnectorCredentialByTokenId(tokenId)).not.toBeNull();

    const res = await service.disable({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") expect(res.instance.disabled_at).not.toBeNull();

    // The credential is now unusable at the guard (predicate clause 7).
    expect(await repo.findActiveConnectorCredentialByTokenId(tokenId)).toBeNull();

    // No rows deleted (FR-014).
    const counts = await rowCounts(id);
    expect(counts.regs).toBe(1);
    expect(counts.creds).toBe(1);
  });

  it("§3 idempotent — re-disabling an already-disabled instance is a success no-op", async () => {
    if (maybeSkip()) return;
    const { id } = await freshInstance("erp-dis-3.example");
    const first = await service.disable({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(first.kind).toBe("ok");
    const second = await service.disable({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(second.kind).toBe("ok");
    // Exactly one disabled audit row (the first transition only).
    const audits = await env!.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE action = 'connector.registration.disabled' AND target_id = $1`,
      [id],
    );
    expect(Number(audits.rows[0]!.n)).toBe(1);
  });

  it("§4 issuing a credential for a disabled instance → not_found", async () => {
    if (maybeSkip()) return;
    const { id } = await freshInstance("erp-dis-4.example");
    await service.disable({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    const issued = await service.issue({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(issued.kind).toBe("not_found");
  });

  it("§5 cross-tenant / absent id → not_found (non-disclosing)", async () => {
    if (maybeSkip()) return;
    const res = await service.disable({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      instanceId: CONNECTOR_FIXTURE_IDS.registrationB, // tenant B's — invisible to A
    });
    expect(res.kind).toBe("not_found");
  });
});
