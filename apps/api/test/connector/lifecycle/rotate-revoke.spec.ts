/**
 * 018-US2-ROTATE-REVOKE (T060) — atomic immediate-revoke rotation + revoke.
 *
 * Service-level Testcontainers spec (no app boot — the @Idempotent interceptor
 * on the routes is the platform's, tested elsewhere; here we prove the rotate/
 * revoke LOGIC). Drives ConnectorRegistrationService against env.app (RLS
 * pool). Proves:
 *   §1 rotate is atomic immediate-revoke — old credential revoked, new issued
 *      for the SAME registration, at most one active afterward;
 *   §2 rotate raw secret returned once + differs from the prior;
 *   §3 rollback-on-failure — if the new-credential insert throws, the old stays
 *      active (no lockout, FR-009);
 *   §4 revoke one credential — rejected afterward, registration stays active;
 *   §5 revoke is idempotent (already-revoked → success no-op);
 *   §6 rotate of a disabled instance → not_found.
 */
import "reflect-metadata";

import type { Pool } from "pg";

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
let dockerSkipped = false;

async function activeCount(instanceId: string): Promise<number> {
  const r = await env!.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM auth_tokens
      WHERE connector_registration_id = $1 AND scope = 'connector' AND revoked_at IS NULL`,
    [instanceId],
  );
  return Number(r.rows[0]!.n);
}

/** Register a fresh instance + issue its first credential; return its id. */
async function freshInstanceWithCredential(siteRef: string): Promise<string> {
  const reg = await service.register({
    tenantId: TENANT_A,
    actorUserId: ACTOR_A,
    displayName: "Rot",
    erpnextSiteRef: siteRef,
    environment: "pilot",
  });
  if (reg.kind !== "ok") throw new Error("register failed");
  const id = reg.instance.id;
  const issued = await service.issue({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
  if (issued.kind !== "ok") throw new Error("issue failed");
  return id;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConnectorFixture(env);
    const localEnv = env;
    service = new ConnectorRegistrationService(localEnv.app as unknown as Pool);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[rotate-revoke.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[rotate-revoke.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

describe("018-US2 — rotate", () => {
  it("§1+§2 rotate is atomic immediate-revoke: old revoked, new active, at-most-one, fresh secret", async () => {
    if (maybeSkip()) return;
    const id = await freshInstanceWithCredential("erp-rot-1.example");
    expect(await activeCount(id)).toBe(1);

    const before = await service.list({ tenantId: TENANT_A });
    const beforeCredId = before.find((i) => i.id === id)!.active_credential!.credential_id;

    const rot = await service.rotate({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(rot.kind).toBe("ok");
    if (rot.kind !== "ok") return;
    expect(rot.credential.secret).toEqual(expect.any(String));
    expect(rot.credential.credential_id).not.toBe(beforeCredId);
    // Exactly one active credential afterward (old revoked, new active).
    expect(await activeCount(id)).toBe(1);
    const after = await service.list({ tenantId: TENANT_A });
    expect(after.find((i) => i.id === id)!.active_credential!.credential_id).toBe(
      rot.credential.credential_id,
    );
  });

  it("§3 rollback-on-failure: if the new-credential step throws, the old credential stays active (FR-009)", async () => {
    if (maybeSkip()) return;
    const id = await freshInstanceWithCredential("erp-rot-3.example");
    const before = await service.list({ tenantId: TENANT_A });
    const oldCredId = before.find((i) => i.id === id)!.active_credential!.credential_id;

    // Force the new-credential INSERT to fail AFTER the revoke, inside the same
    // transaction, via a temporary BEFORE INSERT trigger on auth_tokens that
    // raises. This is the deterministic, DB-level way to prove the rotate tx
    // rolls back (named-export spies are not redefinable under this transpile).
    await env!.admin.query(`
      CREATE FUNCTION _rot_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure during rotation'; END; $$;
      CREATE TRIGGER _rot_fail_trg BEFORE INSERT ON auth_tokens
        FOR EACH ROW EXECUTE FUNCTION _rot_fail();
    `);
    try {
      await expect(
        service.rotate({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id }),
      ).rejects.toThrow(/injected failure/);
    } finally {
      await env!.admin.query(
        `DROP TRIGGER IF EXISTS _rot_fail_trg ON auth_tokens; DROP FUNCTION IF EXISTS _rot_fail();`,
      );
    }

    // The transaction rolled back: the OLD credential is still active (no lockout).
    expect(await activeCount(id)).toBe(1);
    const after = await service.list({ tenantId: TENANT_A });
    expect(after.find((i) => i.id === id)!.active_credential!.credential_id).toBe(oldCredId);
  });

  it("§6 rotate of a disabled instance → not_found", async () => {
    if (maybeSkip()) return;
    const id = await freshInstanceWithCredential("erp-rot-6.example");
    await env!.admin.query(
      `UPDATE connector_registration SET disabled_at = now(), disabled_by = $2 WHERE id = $1`,
      [id, ACTOR_A],
    );
    const rot = await service.rotate({ tenantId: TENANT_A, actorUserId: ACTOR_A, instanceId: id });
    expect(rot.kind).toBe("not_found");
  });
});

describe("018-US2 — revoke", () => {
  it("§4+§5 revoke one credential: rejected after, registration stays active, idempotent", async () => {
    if (maybeSkip()) return;
    const id = await freshInstanceWithCredential("erp-rev-4.example");
    const list = await service.list({ tenantId: TENANT_A });
    const credId = list.find((i) => i.id === id)!.active_credential!.credential_id;

    const rev = await service.revoke({ tenantId: TENANT_A, actorUserId: ACTOR_A, credentialId: credId });
    expect(rev.kind).toBe("ok");
    expect(await activeCount(id)).toBe(0);

    // Registration still present + active.
    const after = await service.list({ tenantId: TENANT_A });
    const inst = after.find((i) => i.id === id);
    expect(inst).toBeDefined();
    expect(inst!.disabled_at).toBeNull();
    expect(inst!.active_credential).toBeNull();

    // Idempotent: a second revoke is a success no-op.
    const rev2 = await service.revoke({ tenantId: TENANT_A, actorUserId: ACTOR_A, credentialId: credId });
    expect(rev2.kind).toBe("ok");
  });

  it("revoke of a cross-tenant / absent credential → not_found (non-disclosing)", async () => {
    if (maybeSkip()) return;
    const rev = await service.revoke({
      tenantId: TENANT_A,
      actorUserId: ACTOR_A,
      credentialId: "0f000000-0000-7000-8000-00000000dead",
    });
    expect(rev.kind).toBe("not_found");
  });
});
