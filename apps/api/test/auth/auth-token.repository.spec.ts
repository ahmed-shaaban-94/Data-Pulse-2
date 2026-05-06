/**
 * T104 — AuthTokenRepository spec.
 *
 * Real Postgres via Testcontainers. Verifies:
 *   - issue + findActiveByRawToken round-trip
 *   - lookup by wrong raw token returns null
 *   - revoke makes the token disappear from active lookups
 *   - expired tokens are excluded
 *   - cross-tenant lookup via `runWithTenantContext` enforces RLS:
 *     a non-superuser app role with `app.current_tenant = A` can NOT see
 *     a token issued under `tenant_id = B`.
 */
import { generateRawToken, hashToken } from "@data-pulse-2/auth";
import { runWithTenantContext } from "@data-pulse-2/db/middleware/tenant-context";
import { newId } from "@data-pulse-2/shared";
import { Pool } from "pg";
import { AuthTokenRepository } from "../../src/auth/auth-token.repository";
import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

let env: PgTestEnv | null = null;
let repo: AuthTokenRepository;
let userId: string;
const TENANT_A = "0a000000-0000-7000-8000-0000000000a1";
const TENANT_B = "0b000000-0000-7000-8000-0000000000b1";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);

    userId = newId();
    await env.admin.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`,
      [userId, "token-test@example.com", "phc-placeholder"],
    );
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'tok-a', 'Tok A'), ($2, 'tok-b', 'Tok B')`,
      [TENANT_A, TENANT_B],
    );

    repo = new AuthTokenRepository(env.admin);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[auth-token.repository.spec] Docker NOT AVAILABLE: ${msg}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

const futureExpiry = (): Date => new Date(Date.now() + 60 * 60 * 1000);
const pastExpiry = (): Date => new Date(Date.now() - 60 * 1000);

describe("AuthTokenRepository", () => {
  it("issues a token and looks it up by raw form", async () => {
    const raw = generateRawToken();
    const tokenId = newId();
    const issued = await repo.issue(raw, {
      id: tokenId,
      tenantId: TENANT_A,
      userId,
      scope: "dashboard_api",
      expiresAt: futureExpiry(),
    });
    expect(issued.id).toBe(tokenId);
    expect(issued.tokenHash.equals(hashToken(raw))).toBe(true);

    const found = await repo.findActiveByRawToken(raw);
    expect(found?.id).toBe(tokenId);
  });

  it("returns null for a wrong raw token", async () => {
    const wrong = generateRawToken();
    expect(await repo.findActiveByRawToken(wrong)).toBeNull();
  });

  it("revoke makes the token disappear from active lookups", async () => {
    const raw = generateRawToken();
    const id = newId();
    await repo.issue(raw, {
      id,
      tenantId: TENANT_A,
      userId,
      scope: "dashboard_api",
      expiresAt: futureExpiry(),
    });
    expect(await repo.revoke(id)).toBe(true);
    expect(await repo.findActiveByRawToken(raw)).toBeNull();
  });

  it("revoke is idempotent (false on a second call)", async () => {
    const raw = generateRawToken();
    const id = newId();
    await repo.issue(raw, {
      id,
      tenantId: TENANT_A,
      userId,
      scope: "dashboard_api",
      expiresAt: futureExpiry(),
    });
    expect(await repo.revoke(id)).toBe(true);
    expect(await repo.revoke(id)).toBe(false);
  });

  it("expired tokens are not returned by findActiveByRawToken", async () => {
    const raw = generateRawToken();
    await repo.issue(raw, {
      id: newId(),
      tenantId: TENANT_A,
      userId,
      scope: "dashboard_api",
      expiresAt: pastExpiry(),
    });
    expect(await repo.findActiveByRawToken(raw)).toBeNull();
  });

  it("RLS hides cross-tenant tokens from a non-superuser app role", async () => {
    if (!env) throw new Error("env not initialized");

    // Issue a token under tenantB via the admin pool (RLS-bypass at insert).
    const rawB = generateRawToken();
    await repo.issue(rawB, {
      id: newId(),
      tenantId: TENANT_B,
      userId,
      scope: "dashboard_api",
      expiresAt: futureExpiry(),
    });

    // Look up via the non-superuser pool with app.current_tenant = A.
    // A different repo instance bound to env.app honours RLS.
    const appRepo = new AuthTokenRepository(env.app);
    const result = await runWithTenantContext(
      env.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => appRepo.findActiveByRawToken(rawB, client),
    );
    expect(result).toBeNull();

    // Same lookup, this time scoped to tenantB, should succeed.
    const visible = await runWithTenantContext(
      env.app,
      { tenantId: TENANT_B, isPlatformAdmin: false },
      async (client) => appRepo.findActiveByRawToken(rawB, client),
    );
    expect(visible).not.toBeNull();
    expect(visible?.tenantId).toBe(TENANT_B);
  });
});
