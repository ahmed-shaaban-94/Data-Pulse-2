/**
 * 015-ISOLATION-HARNESS (T020) — erpnext_posting_status RLS isolation sweep.
 *
 * Proves the tenant isolation shipped with migration 0019 holds for the
 * `erpnext_posting_status` table. DB/RLS-layer only — mirrors the 014-owned
 * `apps/api/test/catalog/erpnext-warehouse-map/isolation/warehouse-map-sweep.spec.ts`:
 * raw `set_config` GUC manipulation inside explicit BEGIN/ROLLBACK transactions
 * on the non-superuser `app_test` pool, so GUC bleed between tests is impossible
 * (LOCAL scope discards on ROLLBACK).
 *
 * These probes characterise ALREADY-SHIPPED behaviour (the 0019 RLS policies),
 * so the suite is GREEN — the same posture as the schema round-trip test. The
 * operations-level cross-tenant 404 (a pull/ack addressing a foreign workItemRef
 * / cursor) is exercised in 015-US1-FEED / 015-US2-ACK, where the controller
 * exists and a meaningful NON-DISCLOSING 404 can be asserted.
 *
 * Coverage
 * --------
 * §A wrong-tenant GUC      → only the GUC tenant's rows are visible
 * §B unset-tenant GUC      → fail-closed (0 rows); INSERT denied
 * §C cross-tenant read     → tenant A cannot SELECT tenant B's posting row
 * §D cross-tenant INSERT   → tenant A cannot write a row tagged tenant B
 * §E multiple-per-sale     → a sale_post + a reversal coexist for tenant A
 *                            (the REVERSAL-CARDINALITY shape, keyed on
 *                            source_ref_id, not the sale)
 * §F cross-store           → VACUOUS: erpnext_posting_status has NO store RLS
 *                            axis (store_id is a tenant-local FK) — asserted.
 */
import { type PoolClient } from "pg";

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../../../_helpers/postgres-container";
import { ACTOR_A, STORE_A_X } from "../../__support__/isolation-harness";
import { SALE_A_X } from "../../sales/__support__/seed-sales";
import {
  POSTING_STATUS_FIXTURE_IDS,
  POST_A_PENDING,
  POST_A_REVERSAL,
  POST_B_POSTED,
  seedPostingStatusFixture,
} from "../__support__/seed-posting-status";

// ---------------------------------------------------------------------------
// Suite-level state
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

const TENANT_A = POSTING_STATUS_FIXTURE_IDS.tenantA;
const TENANT_B = POSTING_STATUS_FIXTURE_IDS.tenantB;

// ---- Lifecycle ------------------------------------------------------------

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedPostingStatusFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[posting-status-sweep.spec] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn("[posting-status-sweep.spec] skipping — Docker unavailable");
    return true;
  }
  return false;
}

// ---- Raw probe helper -----------------------------------------------------
// Non-superuser client, explicit BEGIN/ROLLBACK so set_config LOCAL is
// discarded — no GUC bleed across pooled connections.

async function withRawClient<T>(
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
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

// ---- Denial-assertion helper ----------------------------------------------

type PgErr = Error & { code?: string };
const DENIAL_SQLSTATES = new Set(["42501", "23514", "22P02"]);

async function expectDeniedByPolicyOrCast(
  promise: Promise<unknown>,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  const err = caught as PgErr;
  expect(typeof err.code).toBe("string");
  if (!DENIAL_SQLSTATES.has(err.code as string)) {
    throw new Error(
      `Expected SQLSTATE in {42501, 23514, 22P02}, got ${err.code}: ${err.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// §A — wrong-tenant GUC: only the GUC tenant's rows are visible
// ---------------------------------------------------------------------------

describe("015 §A — erpnext_posting_status wrong-tenant GUC", () => {
  it("tenant-B GUC exposes only tenant-B rows", async () => {
    if (maybeSkip()) return;
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_B,
      ]);
      const r = await client.query<{ id: string; tenant_id: string }>(
        `SELECT id, tenant_id FROM erpnext_posting_status ORDER BY id`,
      );
      return r.rows;
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tenant_id).toBe(TENANT_B);
    }
  });

  it("tenant-A GUC never surfaces the tenant-B posting row", async () => {
    if (maybeSkip()) return;
    const ids = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string }>(
        `SELECT id FROM erpnext_posting_status ORDER BY id`,
      );
      return r.rows.map((x) => x.id);
    });
    expect(ids).toContain(POST_A_PENDING);
    expect(ids).not.toContain(POST_B_POSTED);
  });
});

// ---------------------------------------------------------------------------
// §B — unset-tenant GUC: fail-closed
// ---------------------------------------------------------------------------

describe("015 §B — erpnext_posting_status unset-tenant GUC", () => {
  it("unset tenant GUC: SELECT returns 0 rows (empty-GUC CASE guard)", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(`RESET app.current_tenant`);
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM erpnext_posting_status`,
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });

  it("unset tenant GUC: INSERT is denied", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(`RESET app.current_tenant`);
      await expectDeniedByPolicyOrCast(
        client.query(
          `INSERT INTO erpnext_posting_status
             (id, tenant_id, store_id, sale_id, kind, source_ref_id,
              source_system, external_id, payload_hash, status)
           VALUES (gen_random_uuid(), $1, $2, $3, 'sale_post', $3,
              'pos', 'BYPASS', $4, 'pending')`,
          [TENANT_A, STORE_A_X, SALE_A_X, "a".repeat(64)],
        ),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// §C — cross-tenant read: tenant A cannot read tenant B's row
// ---------------------------------------------------------------------------

describe("015 §C — erpnext_posting_status cross-tenant read", () => {
  it("tenant-A GUC reading the tenant-B posting row id returns 0 rows", async () => {
    if (maybeSkip()) return;
    const count = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM erpnext_posting_status WHERE id = $1`,
        [POST_B_POSTED],
      );
      return r.rows[0]?.count;
    });
    expect(count).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// §D — cross-tenant INSERT: tenant A cannot write a row tagged tenant B
// ---------------------------------------------------------------------------

describe("015 §D — erpnext_posting_status cross-tenant INSERT", () => {
  it("tenant-A GUC inserting a tenant-B-tagged row is denied (WITH CHECK)", async () => {
    if (maybeSkip()) return;
    await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      await expectDeniedByPolicyOrCast(
        client.query(
          `INSERT INTO erpnext_posting_status
             (id, tenant_id, store_id, sale_id, kind, source_ref_id,
              source_system, external_id, payload_hash, status)
           VALUES (gen_random_uuid(), $1, $2, $2, 'sale_post', $2,
              'pos', 'XTENANT', $3, 'pending')`,
          [TENANT_B, STORE_A_X, "a".repeat(64)],
        ),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// §E — multiple posting rows per sale (REVERSAL-CARDINALITY shape)
// ---------------------------------------------------------------------------

describe("015 §E — multiple posting rows per sale", () => {
  it("tenant A carries BOTH a sale_post and a reversal row (keyed on source_ref_id)", async () => {
    if (maybeSkip()) return;
    const kinds = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string; kind: string }>(
        `SELECT id, kind FROM erpnext_posting_status
         WHERE id IN ($1, $2) ORDER BY id`,
        [POST_A_PENDING, POST_A_REVERSAL],
      );
      return r.rows;
    });
    expect(kinds).toHaveLength(2);
    const byKind = new Set(kinds.map((k) => k.kind));
    expect(byKind.has("sale_post")).toBe(true);
    expect(byKind.has("reversal")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §F — cross-store: VACUOUS (no store RLS axis)
// ---------------------------------------------------------------------------

describe("015 §F — erpnext_posting_status has no store RLS axis", () => {
  it("store_id is a tenant-local FK, NOT a second RLS axis (no app.current_store gating)", async () => {
    if (maybeSkip()) return;
    // Setting only the tenant GUC (no app.current_store) still surfaces the
    // tenant's rows across stores — proving there is no store-axis filter to
    // probe (unlike 003's store-override table). Deliberately vacuous.
    const rows = await withRawClient(async (client) => {
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [
        TENANT_A,
      ]);
      const r = await client.query<{ id: string }>(
        `SELECT id FROM erpnext_posting_status`,
      );
      return r.rows.map((x) => x.id);
    });
    expect(rows).toContain(POST_A_PENDING);
    // ACTOR_A is unused at the RLS layer here; referenced to keep the import
    // meaningful and document that actor is not an RLS axis either.
    expect(typeof ACTOR_A).toBe("string");
  });
});
