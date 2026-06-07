/**
 * 018-ISOLATION-HARNESS (T030) — connector_registration RLS isolation sweep.
 *
 * Proves the tenant isolation shipped with migration 0021 holds for
 * connector_registration. DB/RLS-layer only — mirrors the 017-owned
 * `reconciliation-sweep.spec.ts`: raw `set_config` GUC manipulation inside
 * explicit BEGIN/ROLLBACK transactions on the non-superuser `app_test` pool, so
 * GUC bleed between tests is impossible (LOCAL scope discards on ROLLBACK).
 *
 * These probes characterise ALREADY-SHIPPED behaviour (the 0021 RLS policies),
 * so the suite is GREEN. The operations-level cross-tenant 404 (a list/disable
 * addressing a foreign id) is exercised in 018-US1/US3 where the controller
 * exists and a NON-DISCLOSING 404 can be asserted.
 *
 * Coverage
 * --------
 * §A wrong-tenant GUC     → only the GUC tenant's registration rows are visible
 * §B unset-tenant GUC     → fail-closed (0 rows); INSERT denied
 * §C cross-tenant read    → tenant A cannot SELECT tenant B's registration
 * §D cross-tenant INSERT  → tenant A cannot write a registration tagged tenant B
 * §E no DELETE policy     → connector_registration has SELECT+INSERT+UPDATE only
 *                           (disable is logical; FR-014)
 * §F no store RLS axis    → VACUOUS: registration is tenant-local (no store axis).
 */
import { type PoolClient } from "pg";

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

let env: PgTestEnv | null = null;
let dockerSkipped = false;

const TENANT_A = CONNECTOR_FIXTURE_IDS.tenantA;
const TENANT_B = CONNECTOR_FIXTURE_IDS.tenantB;
const ACTOR_A = "0a000000-0000-7000-8000-0000000000ac";

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedConnectorFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[connector-sweep.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[connector-sweep.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

async function withRawClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await env!.app.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("ROLLBACK");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

type PgErr = Error & { code?: string };
const DENIAL_SQLSTATES = new Set(["42501", "23514", "22P02"]);

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const err = caught as PgErr;
  if (!DENIAL_SQLSTATES.has(err.code as string)) {
    throw new Error(`Expected SQLSTATE in {42501, 23514, 22P02}, got ${err.code}: ${err.message}`);
  }
}

describe("018 §A — connector_registration wrong-tenant GUC", () => {
  it("tenant-B GUC exposes only tenant-B registrations", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_B]);
      const r = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM connector_registration`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.tenant_id).toBe(TENANT_B);
  });

  it("tenant-A GUC never surfaces the tenant-B registration", async () => {
    if (maybeSkip()) return;
    const ids = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      const r = await client.query<{ id: string }>(`SELECT id FROM connector_registration`);
      return r.rows.map((x) => x.id);
    });
    expect(ids).toContain(REGISTRATION_A);
    expect(ids).not.toContain(REGISTRATION_B);
  });
});

describe("018 §B — unset-tenant GUC fails closed", () => {
  it("SELECT returns 0 rows from connector_registration", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(`RESET app.current_tenant`);
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM connector_registration`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("INSERT is denied with no tenant GUC", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(`RESET app.current_tenant`);
      await expectDenied(
        client.query(
          `INSERT INTO connector_registration
             (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
           VALUES (gen_random_uuid(), $1, 'X', 'erp.example', 'pilot', $2)`,
          [TENANT_A, ACTOR_A],
        ),
      );
    });
  });
});

describe("018 §C — cross-tenant read", () => {
  it("tenant-A GUC reading the tenant-B registration id returns 0 rows", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM connector_registration WHERE id = $1`,
        [REGISTRATION_B],
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });
});

describe("018 §D — cross-tenant INSERT", () => {
  it("tenant-A GUC inserting a tenant-B-tagged registration is denied (WITH CHECK)", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      await expectDenied(
        client.query(
          `INSERT INTO connector_registration
             (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
           VALUES (gen_random_uuid(), $1, 'X', 'erp.example', 'pilot', $2)`,
          [TENANT_B, ACTOR_A],
        ),
      );
    });
  });
});

describe("018 §E — disable is logical (no DELETE policy)", () => {
  it("connector_registration has SELECT + INSERT + UPDATE policies, NO DELETE", async () => {
    if (maybeSkip()) return;
    const cmds = await withRawClient(async (client) => {
      const r = await client.query<{ cmd: string }>(
        `SELECT cmd FROM pg_policies WHERE tablename = 'connector_registration'`,
      );
      return r.rows.map((x) => x.cmd).sort();
    });
    expect(cmds).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });
});

describe("018 §F — no store RLS axis (vacuous cross-store)", () => {
  it("setting only the tenant GUC surfaces the tenant's registration", async () => {
    if (maybeSkip()) return;
    const ids = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      const r = await client.query<{ id: string }>(`SELECT id FROM connector_registration`);
      return r.rows.map((x) => x.id);
    });
    expect(ids).toContain(REGISTRATION_A);
  });
});
