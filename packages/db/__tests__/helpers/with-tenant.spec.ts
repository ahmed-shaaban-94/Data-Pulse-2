/**
 * T070 — `withTenant` helper.
 *
 * Three layers of assertion:
 *   1. SQL-construction (no container): every read injects `tenant_id =
 *      tenantId` into the WHERE clause; for `tenants` itself, the predicate
 *      is `id = tenantId`.
 *   2. Integration (real Postgres via Testcontainers): seed multiple
 *      tenants and confirm `withTenant(db, A)` returns only A's rows.
 *   3. Refusal: writes that try to set `tenant_id` to a different tenant
 *      throw before any SQL is issued; updates that try to reassign
 *      tenant_id throw similarly.
 *   4. Coverage: every name in `TENANT_SCOPED_TABLES` is reachable through
 *      the helper.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  TENANT_SCOPED_TABLES,
  type WithTenantHelper,
  withTenant,
} from "../../src/helpers/with-tenant";
import {
  applyUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const TENANT_A = "0a000000-0000-7000-8000-00000000a001";
const TENANT_B = "0b000000-0000-7000-8000-00000000b001";

let env: PgTestEnv | null = null;
let pool: Pool | null = null;
let db: NodePgDatabase | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyUpAndCreateAppRole(env);
    pool = new Pool({ connectionString: env.adminUri });
    db = drizzle(pool);

    // Seed two tenants so integration tests have something to read.
    await pool.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'tenant-a', 'Tenant A'),
         ($2, 'tenant-b', 'Tenant B')
       ON CONFLICT DO NOTHING`,
      [TENANT_A, TENANT_B],
    );
    await pool.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'A-1', 'Store A1'),
         ($3, $2, 'A-2', 'Store A2'),
         ($4, $5, 'B-1', 'Store B1')
       ON CONFLICT DO NOTHING`,
      [
        "0a000000-0000-7000-8000-0000000000a1",
        TENANT_A,
        "0a000000-0000-7000-8000-0000000000a2",
        "0b000000-0000-7000-8000-0000000000b1",
        TENANT_B,
      ],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[with-tenant.spec] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (pool) await pool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

describe("withTenant — input validation", () => {
  it("throws on a non-UUID tenantId", () => {
    expect(() => withTenant(db!, "not-a-uuid")).toThrow(/UUID/i);
  });

  it("throws on empty string", () => {
    expect(() => withTenant(db!, "")).toThrow(/UUID/i);
  });
});

describe("withTenant — SQL construction", () => {
  let wt: WithTenantHelper;
  beforeAll(() => {
    wt = withTenant(db!, TENANT_A);
  });

  it("stores.select injects tenant_id predicate", () => {
    const built = wt.stores.select().toSQL();
    expect(built.sql).toMatch(/"stores"."tenant_id"\s*=\s*\$1/);
    expect(built.params).toContain(TENANT_A);
  });

  it("memberships.select injects tenant_id predicate", () => {
    const built = wt.memberships.select().toSQL();
    expect(built.sql).toMatch(/"memberships"."tenant_id"\s*=\s*\$1/);
    expect(built.params).toContain(TENANT_A);
  });

  it("tenants.select uses id = tenantId (not tenant_id)", () => {
    const built = wt.tenants.select().toSQL();
    expect(built.sql).toMatch(/"tenants"."id"\s*=\s*\$1/);
    expect(built.sql).not.toMatch(/"tenants"."tenant_id"/);
    expect(built.params).toContain(TENANT_A);
  });

  it("invitations.select injects tenant_id predicate", () => {
    const built = wt.invitations.select().toSQL();
    expect(built.sql).toMatch(/"invitations"."tenant_id"\s*=\s*\$1/);
  });

  it("audit_events.select injects tenant_id predicate", () => {
    const built = wt.auditEvents.select().toSQL();
    expect(built.sql).toMatch(/"audit_events"."tenant_id"\s*=\s*\$1/);
  });
});

describe("withTenant — integration (real Postgres)", () => {
  it("stores.select returns only Tenant A's rows", async () => {
    const wt = withTenant(db!, TENANT_A);
    const rows = await wt.stores.select();
    const codes = rows.map((r) => r.code).sort();
    expect(codes).toEqual(["A-1", "A-2"]);
  });

  it("stores.select returns only Tenant B's rows when scoped to B", async () => {
    const wt = withTenant(db!, TENANT_B);
    const rows = await wt.stores.select();
    const codes = rows.map((r) => r.code).sort();
    expect(codes).toEqual(["B-1"]);
  });

  it("tenants.select returns the bound tenant only", async () => {
    const wt = withTenant(db!, TENANT_A);
    const rows = await wt.tenants.select();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(TENANT_A);
  });
});

describe("withTenant — write refusal", () => {
  it("stores.insert refuses tenant_id mismatch", () => {
    const wt = withTenant(db!, TENANT_A);
    expect(() =>
      wt.stores.insert({
        id: "0a000000-0000-7000-8000-0000000000ff",
        tenantId: TENANT_B,
        code: "MISMATCH",
        name: "Should never be written",
      }),
    ).toThrow(/tenant_id/);
  });

  it("stores.update refuses reassigning tenant_id", () => {
    const wt = withTenant(db!, TENANT_A);
    expect(() =>
      wt.stores.update({ tenantId: TENANT_B }),
    ).toThrow(/tenant_id/);
  });

  it("memberships.insert refuses tenant_id mismatch", () => {
    const wt = withTenant(db!, TENANT_A);
    expect(() =>
      wt.memberships.insert({
        id: "0a000000-0000-7000-8000-0000000010ff",
        tenantId: TENANT_B,
        userId: "0a000000-0000-7000-8000-0000000020ff",
        roleId: "0a000000-0000-7000-8000-0000000030ff",
        storeAccessKind: "all",
      }),
    ).toThrow(/tenant_id/);
  });

  it("roles.insert refuses platform-scope (tenant_id IS NULL)", () => {
    const wt = withTenant(db!, TENANT_A);
    expect(() =>
      wt.roles.insert({
        id: "0a000000-0000-7000-8000-0000000040ff",
        tenantId: null,
        code: "platform_admin",
        name: "Platform Admin",
      }),
    ).toThrow(/tenant_id/);
  });

  it("roles.update refuses changing tenant_id to NULL or another tenant", () => {
    const wt = withTenant(db!, TENANT_A);
    expect(() => wt.roles.update({ tenantId: null })).toThrow(/tenant_id/);
    expect(() => wt.roles.update({ tenantId: TENANT_B })).toThrow(/tenant_id/);
  });

  it("audit_events.insert refuses null tenant_id", () => {
    const wt = withTenant(db!, TENANT_A);
    expect(() =>
      wt.auditEvents.insert({
        id: "0a000000-0000-7000-8000-0000000050ff",
        tenantId: null,
        action: "platform.event",
      }),
    ).toThrow(/tenant_id/);
  });
});

describe("withTenant — coverage", () => {
  it("every TENANT_SCOPED_TABLES name is reachable through the helper", () => {
    const wt = withTenant(db!, TENANT_A);
    // Map declared table names to expected helper keys (snake_case → camelCase).
    const tableToHelperKey: Record<string, keyof typeof wt> = {
      tenants: "tenants",
      stores: "stores",
      memberships: "memberships",
      store_access: "storeAccess",
      roles: "roles",
      auth_tokens: "authTokens",
      invitations: "invitations",
      audit_events: "auditEvents",
      idempotency_keys: "idempotencyKeys",
    };
    for (const tableName of TENANT_SCOPED_TABLES) {
      const helperKey = tableToHelperKey[tableName];
      expect(helperKey).toBeDefined();
      // Every helper namespace must at least expose `select`.
      const ns = wt[helperKey!] as { select?: unknown };
      expect(ns).toBeDefined();
      expect(typeof ns.select).toBe("function");
    }
  });
});
