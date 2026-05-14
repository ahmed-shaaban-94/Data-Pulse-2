/**
 * T207 [US5] — RLS bypass probe.
 *
 * Verifies that a raw SQL SELECT issued by the non-superuser `app_test`
 * role — with `app.current_tenant` set to tenant A — cannot read a store
 * that belongs to tenant B.
 *
 * Why this test matters:
 *   RLS policies on `stores` are defined at the DB level and are
 *   policy-enforced for non-superuser connections.  Testcontainers-backed
 *   specs that use `env.admin` (DB superuser) bypass RLS regardless of
 *   FORCE ROW LEVEL SECURITY.  This probe explicitly uses `env.app` to
 *   connect as the non-superuser `app_test` role so the isolation is real.
 *
 * Probe structure:
 *   1. Seed two tenants and one store each as superuser (RLS bypassed for setup).
 *   2. Open a transaction on `env.app` (non-superuser).
 *   3. SET LOCAL app.current_tenant = '<tenant A id>'.
 *   4. SELECT * FROM stores WHERE id = '<tenant B store id>'.
 *   5. Assert zero rows.
 *   6. Positive control: same query for tenant A's store returns one row.
 *
 * If Docker is unavailable the test soft-skips with a clear warning when
 * MIGRATION_TEST_ALLOW_SKIP=1 is set, matching the pattern used across the
 * rest of packages/db/__tests__/.
 */
import {
  APP_ROLE_NAME,
  applyUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "./_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Fixture IDs — prefix "07" (T207), no collision with other fixtures
// ---------------------------------------------------------------------------

const TENANT_A  = "07a00000-0000-7000-8000-000000000001";
const TENANT_B  = "07b00000-0000-7000-8000-000000000002";
const STORE_A   = "07a00000-0000-7000-8000-000000000011";
const STORE_B   = "07b00000-0000-7000-8000-000000000022";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyUpAndCreateAppRole(env);

    // Seed as superuser — RLS is bypassed at setup time by design.
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES
         ($1, 'rls-probe-tenant-a', 'RLS Probe Tenant A'),
         ($2, 'rls-probe-tenant-b', 'RLS Probe Tenant B')`,
      [TENANT_A, TENANT_B],
    );
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES
         ($1, $2, 'RLS-A-1', 'RLS Probe Store A1'),
         ($3, $4, 'RLS-B-1', 'RLS Probe Store B1')`,
      [STORE_A, TENANT_A, STORE_B, TENANT_B],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[rls.bypass.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
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
    console.warn("[rls.bypass.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

describe("RLS bypass probe — app role with wrong tenant context", () => {
  it("returns zero rows for a cross-tenant store lookup (G-1)", async () => {
    if (maybeSkip()) return;

    // Acquire a dedicated client from the non-superuser pool.  Using a pool
    // query would risk the GUC leaking across connections; a client inside
    // BEGIN ensures SET LOCAL is scoped to this transaction only.
    const client = await env!.app.connect();
    try {
      // Verify we're running as the non-superuser app role — if this is the
      // superuser, the test would pass vacuously because superusers bypass RLS.
      const whoami = await client.query<{ current_user: string }>(
        "SELECT current_user",
      );
      expect(whoami.rows[0]?.current_user).toBe(APP_ROLE_NAME);

      await client.query("BEGIN");
      // SET LOCAL is transaction-scoped — the GUC is unset on COMMIT/ROLLBACK.
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      // Negative control: tenant A context must not see tenant B's store.
      const result = await client.query<{ id: string }>(
        "SELECT * FROM stores WHERE id = $1",
        [STORE_B],
      );
      expect(result.rows).toHaveLength(0);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("returns one row for tenant A's own store when context matches (G-2 positive control)", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_A}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      const result = await client.query<{ id: string; tenant_id: string }>(
        "SELECT id, tenant_id FROM stores WHERE id = $1",
        [STORE_A],
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.tenant_id).toBe(TENANT_A);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("returns zero rows for tenant B's store when context is switched to tenant B and querying tenant A store (G-3 symmetric)", async () => {
    if (maybeSkip()) return;

    const client = await env!.app.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL app.current_tenant = '${TENANT_B}'`);
      await client.query(`SET LOCAL app.is_platform_admin = 'false'`);

      // Tenant B context cannot see tenant A's store.
      const result = await client.query<{ id: string }>(
        "SELECT * FROM stores WHERE id = $1",
        [STORE_A],
      );
      expect(result.rows).toHaveLength(0);

      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

describe("RLS bypass probe — app role attributes (G-5)", () => {
  it("app_test role has rolbypassrls = false (G-5)", async () => {
    if (maybeSkip()) return;

    // Query pg_catalog.pg_roles as the superuser (admin pool).
    // rolbypassrls = false means the role is subject to RLS policies —
    // a role with rolbypassrls = true would silently skip all RLS checks
    // even without superuser privileges, invalidating the G-1..G-3 probes.
    const result = await env!.admin.query<{
      rolname: string;
      rolbypassrls: boolean;
    }>(
      "SELECT rolname, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1",
      [APP_ROLE_NAME],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.rolbypassrls).toBe(false);
  });
});
