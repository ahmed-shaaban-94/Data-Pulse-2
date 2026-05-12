/**
 * T072 — DB session middleware (`runWithTenantContext`).
 *
 * Verifies, against real Postgres:
 *   - Inside `work(...)`, both GUCs are set to the requested values.
 *   - After the callback returns, the GUC is unset (no leak across pooled
 *     acquisitions).
 *   - Concurrent callers see independent contexts.
 *   - Errors propagate AND trigger a ROLLBACK (no partial writes leak).
 *   - The non-superuser `app_test` role + the middleware together produce
 *     the expected RLS isolation.
 */
import { Pool } from "pg";
import {
  APP_ROLE_NAME,
  applyUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";
import {
  readTenantContext,
  runWithTenantContext,
} from "../../src/middleware/tenant-context";

const TENANT_A = "0a000000-0000-7000-8000-00000000a002";
const TENANT_B = "0b000000-0000-7000-8000-00000000b002";

let env: PgTestEnv | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyUpAndCreateAppRole(env);
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'tc-tenant-a', 'TC Tenant A'),
         ($2, 'tc-tenant-b', 'TC Tenant B')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TENANT_B],
    );
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'TC-A-1', 'TC Store A1'),
         ($3, $4, 'TC-B-1', 'TC Store B1')
       ON CONFLICT DO NOTHING`,
      [
        "0a000000-0000-7000-8000-00000000aa01",
        TENANT_A,
        "0b000000-0000-7000-8000-00000000bb01",
        TENANT_B,
      ],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[tenant-context.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("runWithTenantContext — input validation", () => {
  it("throws on a non-UUID tenantId", async () => {
    await expect(
      runWithTenantContext(env!.admin, {
        tenantId: "not-a-uuid",
        isPlatformAdmin: false,
      }, async () => undefined),
    ).rejects.toThrow(/UUID/i);
  });

  it("accepts null tenantId for platform-admin paths", async () => {
    const ctx = await runWithTenantContext(env!.admin, {
      tenantId: null,
      isPlatformAdmin: true,
    }, async (client) => readTenantContext(client));
    // NIL UUID is set as the GUC value; readTenantContext returns it as-is.
    expect(ctx.currentTenant).toBe("00000000-0000-0000-0000-000000000000");
    expect(ctx.isPlatformAdmin).toBe("true");
  });

  it("rejects non-boolean isPlatformAdmin", async () => {
    await expect(
      runWithTenantContext(
        env!.admin,
        // @ts-expect-error — testing the runtime guard
        { tenantId: TENANT_A, isPlatformAdmin: "yes" },
        async () => undefined,
      ),
    ).rejects.toThrow(/boolean/i);
  });
});

describe("runWithTenantContext — GUCs inside the transaction", () => {
  it("sets app.current_tenant and app.is_platform_admin", async () => {
    const ctx = await runWithTenantContext(
      env!.admin,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => readTenantContext(client),
    );
    expect(ctx.currentTenant).toBe(TENANT_A);
    expect(ctx.isPlatformAdmin).toBe("false");
  });

  it("returns the value the callback returns", async () => {
    const value = await runWithTenantContext(
      env!.admin,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async () => 42,
    );
    expect(value).toBe(42);
  });
});

describe("runWithTenantContext — GUCs do not leak", () => {
  it("after callback, a fresh acquisition shows no app.current_tenant", async () => {
    // Force a single connection so the next acquisition is the same physical
    // socket — the strongest possible "did SET LOCAL leak" check.
    const pool = new Pool({ connectionString: env!.adminUri, max: 1 });
    try {
      await runWithTenantContext(
        pool,
        { tenantId: TENANT_A, isPlatformAdmin: true },
        async () => undefined,
      );
      const client = await pool.connect();
      try {
        const ctx = await readTenantContext(client);
        expect(ctx.currentTenant).toBeNull();
        expect(ctx.isPlatformAdmin).toBeNull();
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });
});

describe("runWithTenantContext — concurrent safety", () => {
  it("two simultaneous calls see independent tenant contexts", async () => {
    // max: 2 so both calls get a real connection in parallel.
    const pool = new Pool({ connectionString: env!.adminUri, max: 2 });
    try {
      const [a, b] = await Promise.all([
        runWithTenantContext(
          pool,
          { tenantId: TENANT_A, isPlatformAdmin: false },
          async (client) => {
            // Hold the GUC inside a brief sleep so contexts overlap.
            await client.query("SELECT pg_sleep(0.05)");
            return readTenantContext(client);
          },
        ),
        runWithTenantContext(
          pool,
          { tenantId: TENANT_B, isPlatformAdmin: false },
          async (client) => {
            await client.query("SELECT pg_sleep(0.05)");
            return readTenantContext(client);
          },
        ),
      ]);
      expect(a.currentTenant).toBe(TENANT_A);
      expect(b.currentTenant).toBe(TENANT_B);
    } finally {
      await pool.end();
    }
  });
});

describe("runWithTenantContext — error path", () => {
  it("rolls back and re-throws when the callback throws", async () => {
    const pool = new Pool({ connectionString: env!.adminUri, max: 1 });
    try {
      const sentinelStoreId = "0a000000-0000-7000-8000-0000000099ee";

      await expect(
        runWithTenantContext(
          pool,
          { tenantId: TENANT_A, isPlatformAdmin: false },
          async (client) => {
            await client.query(
              "INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'TC-ROLLBACK', 'Should rollback')",
              [sentinelStoreId, TENANT_A],
            );
            throw new Error("boom");
          },
        ),
      ).rejects.toThrow(/boom/);

      // The INSERT must NOT have committed.
      const r = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM stores WHERE id = $1",
        [sentinelStoreId],
      );
      expect(r.rows[0]?.count).toBe("0");

      // The pool's connection must be usable again — release happened in finally.
      const ping = await pool.query<{ ok: number }>("SELECT 1::int AS ok");
      expect(ping.rows[0]?.ok).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

describe("runWithTenantContext — RLS smoke (non-superuser app role)", () => {
  it("with tenantA context, app role sees only tenant A's stores", async () => {
    const ctx = await runWithTenantContext(
      env!.app,
      { tenantId: TENANT_A, isPlatformAdmin: false },
      async (client) => {
        const me = await client.query<{ current_user: string }>(
          "SELECT current_user",
        );
        const stores = await client.query<{ tenant_id: string; code: string }>(
          "SELECT tenant_id, code FROM stores ORDER BY code",
        );
        return { me, stores };
      },
    );
    expect(ctx.me.rows[0]?.current_user).toBe(APP_ROLE_NAME);
    const codes = ctx.stores.rows.map((r) => r.code);
    // Only A's stores visible.
    expect(codes.every((c) => c.startsWith("TC-A") || c.startsWith("A-"))).toBe(true);
    expect(codes).not.toContain("TC-B-1");
    expect(codes).not.toContain("B-1");
  });

  it("with tenantB context, app role sees only tenant B's stores", async () => {
    const ctx = await runWithTenantContext(
      env!.app,
      { tenantId: TENANT_B, isPlatformAdmin: false },
      async (client) => {
        const stores = await client.query<{ code: string }>(
          "SELECT code FROM stores ORDER BY code",
        );
        return stores;
      },
    );
    const codes = ctx.rows.map((r) => r.code);
    expect(codes.every((c) => c.startsWith("TC-B") || c.startsWith("B-"))).toBe(true);
    expect(codes).not.toContain("TC-A-1");
    expect(codes).not.toContain("A-1");
  });

  it("null tenantId + isPlatformAdmin:true does not throw a uuid cast error (app role)", async () => {
    // Regression: tenantId:null must not map to '' which throws
    // "invalid input syntax for type uuid: ''" before the is_platform_admin
    // OR-branch is evaluated.
    await expect(
      runWithTenantContext(
        env!.app,
        { tenantId: null, isPlatformAdmin: true },
        async (client) => {
          // A real SELECT against an RLS-protected table is required; reading
          // GUCs alone would pass even with the '' bug.
          await client.query("SELECT id FROM stores LIMIT 1");
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("null tenantId + isPlatformAdmin:false does not throw and returns no rows (app role)", async () => {
    // With no tenant and no platform-admin flag the RLS policy must produce
    // an empty result set, not a uuid cast error.
    const result = await runWithTenantContext(
      env!.app,
      { tenantId: null, isPlatformAdmin: false },
      async (client) => {
        return client.query<{ id: string }>("SELECT id FROM stores LIMIT 1");
      },
    );
    // NIL UUID never matches a real tenant_id, so no rows are visible.
    expect(result.rows).toHaveLength(0);
  });
});
