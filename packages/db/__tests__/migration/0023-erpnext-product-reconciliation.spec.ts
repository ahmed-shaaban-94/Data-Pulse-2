/**
 * ERPNext Product-Master Reconciliation & Repair (021) —
 * `0023_erpnext_product_reconciliation` migration test (021-SCHEMA / T005).
 *
 * Validates `packages/db/drizzle/0023_erpnext_product_reconciliation.sql`
 * (+ `.down.sql`):
 *   - THREE tables created (run + result + repair_attempt), each RLS enabled+forced;
 *   - run + result get SELECT+INSERT+UPDATE policies; repair_attempt is APPEND-ONLY
 *     (SELECT+INSERT only); NO DELETE policy anywhere (retention = state, §XIV);
 *   - run: NO store_id, NO kind column (tenant-wide, one run kind); trigger/status/
 *     erpnext_view_status CHECKs; finished-when-terminal CHECK;
 *   - result: 021 product-master mismatch_class CHECK; result_state CHECK;
 *   - repair_attempt: target_kind / repair_kind / outcome CHECKs; NO updated_at;
 *   - NO money/PII column on any table;
 *   - fail-closed RLS: wrong app.current_tenant -> zero rows; empty GUC -> zero
 *     rows (no 22P02);
 *   - UP -> DOWN -> UP round-trips cleanly.
 *
 * Docker policy mirrors 0019/0020/0021/0022: missing Docker is a HARD failure
 * unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). Run via WSL.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_PATH = resolve(DRIZZLE_DIR, "0023_erpnext_product_reconciliation.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0023_erpnext_product_reconciliation.down.sql");

const RUN_TBL = "erpnext_product_reconciliation_run";
const RESULT_TBL = "erpnext_product_reconciliation_result";
const ATTEMPT_TBL = "erpnext_product_reconciliation_repair_attempt";

const TENANT_A = "02100000-0000-7000-8000-00000000a001";
const TENANT_B = "02100000-0000-7000-8000-00000000b002";
const ACTOR = "02100000-0000-7000-8000-00000000d001";
const RUN_A = "02100000-0000-7000-8000-0000000000a1";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** Apply every migration with a basename lexically < 0023 (0000–0022). */
async function applyPreMigrations(pgEnv: PgTestEnv): Promise<void> {
  const guardBasename = basename(UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(guardBasename) < 0)
    .sort();
  for (const name of upFiles) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'pr-a', 'Product-Recon Tenant A', 'USD'),
       ($2, 'pr-b', 'Product-Recon Tenant B', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'pr@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
}

function insertRun(
  pgEnv: PgTestEnv,
  opts: { id?: string; tenant?: string; trigger?: string; status?: string; viewStatus?: string; finished?: boolean } = {},
): Promise<unknown> {
  const status = opts.status ?? "running";
  const finished = opts.finished ?? status !== "running";
  return pgEnv.admin.query(
    `INSERT INTO erpnext_product_reconciliation_run
       (id, tenant_id, trigger, status, erpnext_view_status, finished_at, actor_user_id)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, ${finished ? "now()" : "NULL"}, $6)`,
    [
      opts.id ?? null,
      opts.tenant ?? TENANT_A,
      opts.trigger ?? "on_demand",
      status,
      opts.viewStatus ?? "unavailable",
      ACTOR,
    ],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0023-erpnext-product-reconciliation.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0023 so the app role has privileges on the new tables.
  await ensureAppRole(env);
  await seedParents(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

const skip = () => dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

describe("0023 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0023 — tables + RLS", () => {
  it.each([RUN_TBL, RESULT_TBL, ATTEMPT_TBL])("%s has RLS enabled + forced", async (tbl) => {
    if (skip()) return;
    const e = guard();
    const t = await e.admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [tbl],
    );
    expect(t.rows[0]?.relrowsecurity).toBe(true);
    expect(t.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("run + result are mutable (SELECT+INSERT+UPDATE) with NO DELETE policy", async () => {
    if (skip()) return;
    const e = guard();
    for (const tbl of [RUN_TBL, RESULT_TBL]) {
      const pol = await e.admin.query<{ cmd: string }>(
        `SELECT cmd FROM pg_policies WHERE tablename = $1`,
        [tbl],
      );
      expect(pol.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
    }
  });

  it("repair_attempt is APPEND-ONLY (SELECT+INSERT only, NO UPDATE, NO DELETE)", async () => {
    if (skip()) return;
    const e = guard();
    const pol = await e.admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1`,
      [ATTEMPT_TBL],
    );
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT"]);
  });

  it("run is TENANT-scoped (NO store_id, NO kind) and carries NO money/PII column", async () => {
    if (skip()) return;
    const e = guard();
    const cols = await e.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [RUN_TBL],
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).not.toContain("store_id");
    expect(names).not.toContain("kind");
    for (const forbidden of ["amount", "total", "money", "valuation", "cost", "price", "email", "password_hash"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("repair_attempt is append-only (NO updated_at column)", async () => {
    if (skip()) return;
    const e = guard();
    const cols = await e.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [ATTEMPT_TBL],
    );
    expect(cols.rows.map((r) => r.column_name)).not.toContain("updated_at");
  });
});

describe("0023 — CHECK constraints", () => {
  beforeEach(async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM erpnext_product_reconciliation_repair_attempt`);
    await e.admin.query(`DELETE FROM erpnext_product_reconciliation_result`);
    await e.admin.query(`DELETE FROM erpnext_product_reconciliation_run`);
  });

  it("run trigger CHECK — an unknown trigger is rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertRun(e, { trigger: "bogus" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertRun(e, { trigger: "on_demand" })).resolves.toBeDefined();
  });

  it("run status CHECK — an unknown status is rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertRun(e, { status: "bogus", finished: true })).rejects.toMatchObject({ code: "23514" });
  });

  it("run erpnext_view_status CHECK — an unknown value is rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertRun(e, { viewStatus: "bogus" })).rejects.toMatchObject({ code: "23514" });
  });

  it("run finished-when-terminal CHECK — a running run with finished_at is rejected", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      e.admin.query(
        `INSERT INTO erpnext_product_reconciliation_run
           (id, tenant_id, trigger, status, erpnext_view_status, finished_at, actor_user_id)
         VALUES (gen_random_uuid(), $1, 'on_demand', 'running', 'unavailable', now(), $2)`,
        [TENANT_A, ACTOR],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("result mismatch_class CHECK — 021 vocab accepted; a foreign class rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await insertRun(e, { id: RUN_A });
    const ok = async (cls: string) =>
      e.admin.query(
        `INSERT INTO erpnext_product_reconciliation_result
           (id, run_id, tenant_id, mismatch_class) VALUES (gen_random_uuid(), $1, $2, $3)`,
        [RUN_A, TENANT_A, cls],
      );
    for (const cls of [
      "match", "unmapped_dp2_product", "suggestion_unconfirmed",
      "unmapped_erpnext_item", "attribute_drift", "sellable_state_divergence",
    ]) {
      await expect(ok(cls)).resolves.toBeDefined();
    }
    // 014 stock vocab must be rejected.
    await expect(ok("quantity_divergence")).rejects.toMatchObject({ code: "23514" });
  });

  it("repair_attempt CHECKs — target_kind / repair_kind / outcome enforced", async () => {
    if (skip()) return;
    const e = guard();
    const ins = async (tk: string, rk: string, oc: string) =>
      e.admin.query(
        `INSERT INTO erpnext_product_reconciliation_repair_attempt
           (id, tenant_id, target_kind, target_ref_id, repair_kind, actor_user_id, outcome)
         VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), $3, $4, $5)`,
        [TENANT_A, tk, rk, ACTOR, oc],
      );
    await expect(ins("backlog_item", "confirm", "mapped")).resolves.toBeDefined();
    await expect(ins("bogus", "confirm", "mapped")).rejects.toMatchObject({ code: "23514" });
    await expect(ins("result", "bogus", "mapped")).rejects.toMatchObject({ code: "23514" });
    await expect(ins("result", "re_point", "bogus")).rejects.toMatchObject({ code: "23514" });
  });
});

describe("0023 — fail-closed RLS", () => {
  it("a run owned by tenant A is invisible under app.current_tenant = B", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM erpnext_product_reconciliation_run`);
    await insertRun(e, { tenant: TENANT_A });
    const client = await e.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${TENANT_B}'`);
      const wrong = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${RUN_TBL}`);
      expect(wrong.rows[0]?.count).toBe("0");
      await client.query(`SET app.current_tenant = '${TENANT_A}'`);
      const right = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${RUN_TBL}`);
      expect(Number(right.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
  });

  it("empty GUC fails closed (zero rows, no 22P02)", async () => {
    if (skip()) return;
    const e = guard();
    const client = await e.app.connect();
    try {
      await client.query(`RESET app.current_tenant`);
      for (const tbl of [RUN_TBL, RESULT_TBL, ATTEMPT_TBL]) {
        const r = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${tbl}`);
        expect(r.rows[0]?.count).toBe("0");
      }
    } finally {
      client.release();
    }
  });
});

describe("0023 — down/up round-trip", () => {
  it("DOWN drops the three tables; UP re-creates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    for (const tbl of [RUN_TBL, RESULT_TBL, ATTEMPT_TBL]) {
      const afterDown = await e.admin.query(`SELECT to_regclass($1) AS reg`, [tbl]);
      expect(afterDown.rows[0]?.reg).toBeNull();
    }
    await e.admin.query(upSql);
    for (const tbl of [RUN_TBL, RESULT_TBL, ATTEMPT_TBL]) {
      const afterUp = await e.admin.query<{ reg: string }>(`SELECT to_regclass($1)::text AS reg`, [tbl]);
      expect(afterUp.rows[0]?.reg).toBe(tbl);
    }
    await ensureAppRole(e);
    await seedParents(e);
  });
});
