/**
 * 018-US4-GUARD (T050) — ConnectorAuthGuard usability predicate (FR-015/016/017).
 *
 * Proves the tightened guard accepts ONLY an active, instance-linked,
 * non-disabled connector credential and rejects every other condition with an
 * identical non-disclosing 401. Drives the guard via `AuthTokenRepository`
 * (the connector-only resolver `findActiveConnectorCredentialByTokenId`) against
 * a Testcontainers Postgres — the resolver IS the guard's load-bearing query, so
 * testing it directly covers the predicate without an app boot.
 *
 * Cases (each a connector token in a distinct state):
 *   §1 linked + active + non-disabled instance, same tenant  → resolves (allow)
 *   §2 unlinked (connector_registration_id NULL)             → null (reject)
 *   §3 revoked                                               → null (reject)
 *   §4 expired                                               → null (reject)
 *   §5 instance disabled                                     → null (reject)
 *   §6 cross-tenant (token tenant ≠ registration tenant)     → null (reject)
 * The dashboard/POS rejection + the principal.kind/scope gate are covered by the
 * guard's scope check + the session-only guard unit test; here we prove the
 * registration-link predicate the resolver enforces.
 */
import "reflect-metadata";

import { newId } from "@data-pulse-2/shared";
import { generateRawToken, hashToken } from "@data-pulse-2/auth";

import { AuthTokenRepository } from "../../../src/auth/auth-token.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../_helpers/postgres-container";
import {
  CONNECTOR_FIXTURE_IDS,
  REGISTRATION_A,
  REGISTRATION_B,
  seedConnectorFixture,
} from "../__support__/seed-connector";

const TENANT_A = CONNECTOR_FIXTURE_IDS.tenantA;
const TENANT_B = CONNECTOR_FIXTURE_IDS.tenantB;
const ACTOR_A = "0a000000-0000-7000-8000-0000000000ac";

let env: PgTestEnv | null = null;
let repo: AuthTokenRepository;
let dockerSkipped = false;

/** Create a fresh active registration for tenant A; return its id. */
async function freshRegistration(siteRef: string): Promise<string> {
  const id = newId();
  await env!.admin.query(
    `INSERT INTO connector_registration
       (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
     VALUES ($1, $2, 'G', $3, 'pilot', $4)`,
    [id, TENANT_A, siteRef, ACTOR_A],
  );
  return id;
}

/** Insert a connector token in a chosen state; return its id. */
async function insertConnectorToken(opts: {
  tenantId: string;
  registrationId: string | null;
  revoked?: boolean;
  expired?: boolean;
}): Promise<string> {
  const id = newId();
  await env!.admin.query(
    `INSERT INTO auth_tokens
       (id, token_hash, tenant_id, user_id, scope, expires_at, revoked_at, connector_registration_id)
     VALUES ($1, $2, $3, $4, 'connector',
             now() + ($5 || ' seconds')::interval,
             $6, $7)`,
    [
      id,
      hashToken(generateRawToken()),
      opts.tenantId,
      ACTOR_A,
      opts.expired ? "-3600" : "3600",
      opts.revoked ? new Date() : null,
      opts.registrationId,
    ],
  );
  return id;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConnectorFixture(env);
    repo = new AuthTokenRepository(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[connector-auth-guard.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[connector-auth-guard.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

describe("018-US4 — ConnectorAuthGuard usability predicate (resolver)", () => {
  it("§1 a linked + active + non-disabled connector token resolves to its registration", async () => {
    if (maybeSkip()) return;
    // A fresh registration (the seed's REGISTRATION_A already holds an active
    // credential — the at-most-one-active partial-unique forbids a 2nd).
    const reg = await freshRegistration("erp-guard-1.example");
    const id = await insertConnectorToken({ tenantId: TENANT_A, registrationId: reg });
    const resolved = await repo.findActiveConnectorCredentialByTokenId(id);
    expect(resolved).not.toBeNull();
    expect(resolved!.registrationId).toBe(reg);
    expect(resolved!.tenantId).toBe(TENANT_A);
    expect(resolved!.environment).toBe("pilot");
  });

  it("§2 an UNLINKED connector token (no registration) → rejected (null)", async () => {
    if (maybeSkip()) return;
    const id = await insertConnectorToken({ tenantId: TENANT_A, registrationId: null });
    expect(await repo.findActiveConnectorCredentialByTokenId(id)).toBeNull();
  });

  it("§3 a REVOKED connector token → rejected (null)", async () => {
    if (maybeSkip()) return;
    const id = await insertConnectorToken({
      tenantId: TENANT_A,
      registrationId: REGISTRATION_A,
      revoked: true,
    });
    expect(await repo.findActiveConnectorCredentialByTokenId(id)).toBeNull();
  });

  it("§4 an EXPIRED connector token → rejected (null)", async () => {
    if (maybeSkip()) return;
    // Fresh registration: an expired token is still unrevoked, so it would
    // collide with the seed's active credential on REGISTRATION_A.
    const reg = await freshRegistration("erp-guard-4.example");
    const id = await insertConnectorToken({
      tenantId: TENANT_A,
      registrationId: reg,
      expired: true,
    });
    expect(await repo.findActiveConnectorCredentialByTokenId(id)).toBeNull();
  });

  it("§5 a token whose instance is DISABLED → rejected (null)", async () => {
    if (maybeSkip()) return;
    // Disable REGISTRATION_B, then point a tenant-B token at it.
    await env!.admin.query(
      `UPDATE connector_registration SET disabled_at = now(), disabled_by = $2 WHERE id = $1`,
      [REGISTRATION_B, ACTOR_A],
    );
    const id = await insertConnectorToken({ tenantId: TENANT_B, registrationId: REGISTRATION_B });
    expect(await repo.findActiveConnectorCredentialByTokenId(id)).toBeNull();
    // Restore for any later test ordering safety.
    await env!.admin.query(
      `UPDATE connector_registration SET disabled_at = NULL, disabled_by = NULL WHERE id = $1`,
      [REGISTRATION_B],
    );
  });

  it("§6 a CROSS-TENANT token (token tenant ≠ registration tenant) → rejected (null)", async () => {
    if (maybeSkip()) return;
    // A tenant-B token pointing at a fresh tenant-A registration: the join's
    // cr.tenant_id = t.tenant_id clause fails (a fresh reg avoids colliding
    // with the seed's active credential on the partial-unique).
    const reg = await freshRegistration("erp-guard-6.example");
    const id = await insertConnectorToken({ tenantId: TENANT_B, registrationId: reg });
    expect(await repo.findActiveConnectorCredentialByTokenId(id)).toBeNull();
  });
});
