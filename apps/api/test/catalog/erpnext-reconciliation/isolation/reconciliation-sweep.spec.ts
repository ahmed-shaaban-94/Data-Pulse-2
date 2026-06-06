/**
 * 017-ISOLATION-HARNESS (T020) — erpnext_reconciliation_* RLS isolation sweep.
 *
 * Proves the tenant isolation shipped with migration 0020 holds for all three
 * 017 tables (run + result + repair_attempt). DB/RLS-layer only — mirrors the
 * 015-owned `posting-status-sweep.spec.ts`: raw `set_config` GUC manipulation
 * inside explicit BEGIN/ROLLBACK transactions on the non-superuser `app_test`
 * pool, so GUC bleed between tests is impossible (LOCAL scope discards on
 * ROLLBACK).
 *
 * These probes characterise ALREADY-SHIPPED behaviour (the 0020 RLS policies),
 * so the suite is GREEN. The operations-level cross-tenant 404 (a list/repair/
 * run-get addressing a foreign id) is exercised in 017-US1/US2/US3 where the
 * controller exists and a NON-DISCLOSING 404 can be asserted.
 *
 * Coverage
 * --------
 * §A wrong-tenant GUC     → only the GUC tenant's run rows are visible
 * §B unset-tenant GUC     → fail-closed (0 rows) on all three tables; INSERT denied
 * §C cross-tenant read    → tenant A cannot SELECT tenant B's run
 * §D cross-tenant INSERT  → tenant A cannot write a run tagged tenant B (WITH CHECK)
 * §E append-only          → repair_attempt has SELECT+INSERT only (no UPDATE policy)
 * §F cross-store          → VACUOUS: no store RLS axis (store_id is tenant-local).
 */
import { type PoolClient } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ACTOR_A, STORE_A_X } from "../../__support__/isolation-harness";
import {
  RECONCILIATION_FIXTURE_IDS,
  RUN_A,
  RUN_B,
  seedReconciliationFixture,
} from "../__support__/seed-reconciliation";

let env: PgTestEnv | null = null;
let dockerSkipped = false;

const TENANT_A = RECONCILIATION_FIXTURE_IDS.tenantA;
const TENANT_B = RECONCILIATION_FIXTURE_IDS.tenantB;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedReconciliationFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[reconciliation-sweep.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[reconciliation-sweep.spec] skipping — Docker unavailable");
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

describe("017 §A — erpnext_reconciliation_run wrong-tenant GUC", () => {
  it("tenant-B GUC exposes only tenant-B runs", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_B]);
      const r = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM erpnext_reconciliation_run`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.tenant_id).toBe(TENANT_B);
  });

  it("tenant-A GUC never surfaces the tenant-B run", async () => {
    if (maybeSkip()) return;
    const ids = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      const r = await client.query<{ id: string }>(`SELECT id FROM erpnext_reconciliation_run`);
      return r.rows.map((x) => x.id);
    });
    expect(ids).toContain(RUN_A);
    expect(ids).not.toContain(RUN_B);
  });
});

describe("017 §B — unset-tenant GUC fails closed on all three tables", () => {
  it("SELECT returns 0 rows from run / result / repair_attempt", async () => {
    if (maybeSkip()) return;
    const counts = await withRawClient(async (client) => {
      await client.query(`RESET app.current_tenant`);
      const out: Record<string, string | undefined> = {};
      for (const table of [
        "erpnext_reconciliation_run",
        "erpnext_reconciliation_result",
        "erpnext_reconciliation_repair_attempt",
      ]) {
        const r = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${table}`);
        out[table] = r.rows[0]?.count;
      }
      return out;
    });
    expect(counts["erpnext_reconciliation_run"]).toBe("0");
    expect(counts["erpnext_reconciliation_result"]).toBe("0");
    expect(counts["erpnext_reconciliation_repair_attempt"]).toBe("0");
  });

  it("INSERT into run is denied with no tenant GUC", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(`RESET app.current_tenant`);
      await expectDenied(
        client.query(
          `INSERT INTO erpnext_reconciliation_run
             (id, tenant_id, store_id, kind, trigger, status)
           VALUES (gen_random_uuid(), $1, $2, 'stock', 'on_demand', 'running')`,
          [TENANT_A, STORE_A_X],
        ),
      );
    });
  });
});

describe("017 §C — cross-tenant read", () => {
  it("tenant-A GUC reading the tenant-B run id returns 0 rows", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM erpnext_reconciliation_run WHERE id = $1`,
        [RUN_B],
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });
});

describe("017 §D — cross-tenant INSERT", () => {
  it("tenant-A GUC inserting a tenant-B-tagged run is denied (WITH CHECK)", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      await expectDenied(
        client.query(
          `INSERT INTO erpnext_reconciliation_run
             (id, tenant_id, store_id, kind, trigger, status)
           VALUES (gen_random_uuid(), $1, $2, 'stock', 'on_demand', 'running')`,
          [TENANT_B, STORE_A_X],
        ),
      );
    });
  });
});

describe("017 §E — repair_attempt is append-only", () => {
  it("repair_attempt has SELECT + INSERT policies ONLY (no UPDATE, no DELETE)", async () => {
    if (maybeSkip()) return;
    const cmds = await withRawClient(async (client) => {
      const r = await client.query<{ cmd: string }>(
        `SELECT cmd FROM pg_policies WHERE tablename = 'erpnext_reconciliation_repair_attempt'`,
      );
      return r.rows.map((x) => x.cmd).sort();
    });
    expect(cmds).toEqual(["INSERT", "SELECT"]);
  });
});

describe("017 §F — no store RLS axis (vacuous cross-store)", () => {
  it("setting only the tenant GUC surfaces the tenant's run regardless of store", async () => {
    if (maybeSkip()) return;
    const ids = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      const r = await client.query<{ id: string }>(`SELECT id FROM erpnext_reconciliation_run`);
      return r.rows.map((x) => x.id);
    });
    expect(ids).toContain(RUN_A);
    expect(typeof ACTOR_A).toBe("string"); // actor is not an RLS axis either
  });
});
