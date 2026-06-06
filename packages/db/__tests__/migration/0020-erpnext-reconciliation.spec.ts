/**
 * ERPNext Reconciliation & Repair (017) — `0020_erpnext_reconciliation` migration test.
 *
 * Validates `packages/db/drizzle/0020_erpnext_reconciliation.sql` (+ `.down.sql`):
 *   - THREE tables created (run + result + repair_attempt) with RLS enabled+forced;
 *   - run policies = SELECT+INSERT+UPDATE (mutable; running→terminal); result
 *     policies = SELECT+INSERT+UPDATE (open→repaired/accepted); repair_attempt
 *     policies = SELECT+INSERT ONLY (append-only; NO UPDATE, NO DELETE);
 *   - run.kind CHECK: STOCK-ONLY in v1 ('posting' rejected — the backlog is a
 *     read-projection, not a run; data-model §2.1);
 *   - run.status + finished-when-terminal CHECK;
 *   - result.mismatch_class CHECK = 014's vocabulary ONLY (a 015 posting category
 *     like 'validation' is rejected — READ-NOT-MIRROR / R2);
 *   - result.result_state CHECK (open|repaired|accepted);
 *   - result.run_id single-column FK → run(id) (a dangling run_id → 23503);
 *   - repair_attempt enums (target_kind/repair_kind/outcome);
 *   - NO money/valuation/PII column on any of the three;
 *   - fail-closed RLS: wrong app.current_tenant → zero rows; empty GUC → zero rows
 *     (no 22P02);
 *   - UP → DOWN → UP round-trips cleanly.
 *
 * Docker policy mirrors 0014/0016/0017/0018/0019: missing Docker is a HARD failure
 * unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). Run targeted via WSL.
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
const UP_PATH = resolve(DRIZZLE_DIR, "0020_erpnext_reconciliation.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0020_erpnext_reconciliation.down.sql");

const RUN = "erpnext_reconciliation_run";
const RESULT = "erpnext_reconciliation_result";
const ATTEMPT = "erpnext_reconciliation_repair_attempt";

const TENANT_A = "01900000-0000-7000-8000-0000000000a1";
const TENANT_B = "01900000-0000-7000-8000-0000000000b2";
const STORE_A = "01900000-0000-7000-8000-0000000000c1";
const ACTOR = "01900000-0000-7000-8000-0000000000d1";
const RUN_A = "01900000-0000-7000-8000-0000000000e1";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** Apply every migration with a basename lexically < 0020 (0000–0019). */
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

/** Seed tenants A/B → store → actor (admin pool, RLS-bypass). */
async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'erc-a', 'ERC Tenant A', 'USD'),
       ($2, 'erc-b', 'ERC Tenant B', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'ERC1', 'ERC Store')
     ON CONFLICT (id) DO NOTHING`,
    [STORE_A, TENANT_A],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'erc@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
}

/** Insert one run (admin pool). Returns the query promise. */
function insertRun(
  pgEnv: PgTestEnv,
  opts: { id?: string; tenant?: string; kind?: string; trigger?: string; status?: string; finishedAt?: string | null } = {},
): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO erpnext_reconciliation_run
       (id, tenant_id, store_id, kind, trigger, status, finished_at, actor_user_id)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)`,
    [
      opts.id ?? RUN_A,
      opts.tenant ?? TENANT_A,
      STORE_A,
      opts.kind ?? "stock",
      opts.trigger ?? "on_demand",
      opts.status ?? "running",
      opts.finishedAt ?? null,
      ACTOR,
    ],
  );
}

/** Insert one result row for a run (admin pool). */
function insertResult(
  pgEnv: PgTestEnv,
  opts: { runId?: string; tenant?: string; mismatchClass?: string; resultState?: string } = {},
): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO erpnext_reconciliation_result
       (id, run_id, tenant_id, mismatch_class, result_state)
     VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
    [
      opts.runId ?? RUN_A,
      opts.tenant ?? TENANT_A,
      opts.mismatchClass ?? "quantity_divergence",
      opts.resultState ?? "open",
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
      console.warn(`\n[0020-erpnext-reconciliation.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0020 so the app role has privileges on the three new tables
  // (ensureAppRole's GRANT ON ALL TABLES only covers tables existing at grant time).
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

describe("0020 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0020 — tables + RLS created", () => {
  it("all three tables have RLS enabled + forced", async () => {
    if (skip()) return;
    const e = guard();
    for (const table of [RUN, RESULT, ATTEMPT]) {
      const t = await e.admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
        [table],
      );
      expect(t.rows[0]?.relrowsecurity).toBe(true);
      expect(t.rows[0]?.relforcerowsecurity).toBe(true);
    }
  });

  it("run + result are mutable (SELECT+INSERT+UPDATE); repair_attempt is APPEND-ONLY (SELECT+INSERT)", async () => {
    if (skip()) return;
    const e = guard();
    const cmdsFor = async (table: string) => {
      const pol = await e.admin.query<{ cmd: string }>(
        `SELECT cmd FROM pg_policies WHERE tablename = $1`,
        [table],
      );
      return pol.rows.map((r) => r.cmd).sort();
    };
    expect(await cmdsFor(RUN)).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(await cmdsFor(RESULT)).toEqual(["INSERT", "SELECT", "UPDATE"]);
    // Append-only: no UPDATE, no DELETE.
    expect(await cmdsFor(ATTEMPT)).toEqual(["INSERT", "SELECT"]);
  });

  it("exposes NO money/valuation/PII column on any of the three", async () => {
    if (skip()) return;
    const e = guard();
    for (const table of [RUN, RESULT, ATTEMPT]) {
      const cols = await e.admin.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      const names = cols.rows.map((r) => r.column_name);
      for (const forbidden of [
        "amount", "pos_total", "line_amount", "unit_price", "total",
        "money", "valuation", "cost", "price", "email", "password_hash",
      ]) {
        expect(names).not.toContain(forbidden);
      }
    }
  });
});

describe("0020 — constraints", () => {
  beforeEach(async () => {
    if (skip()) return;
    const e = guard();
    // result → run FK means result must clear first.
    await e.admin.query(`DELETE FROM ${ATTEMPT}`);
    await e.admin.query(`DELETE FROM ${RESULT}`);
    await e.admin.query(`DELETE FROM ${RUN}`);
  });

  it("run.kind is STOCK-ONLY — 'posting' is rejected (the backlog is a read-projection, not a run)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertRun(e, { kind: "posting" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertRun(e, { kind: "stock" })).resolves.toBeDefined();
  });

  it("run.status CHECK + finished-when-terminal CHECK", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertRun(e, { status: "queued" })).rejects.toMatchObject({ code: "23514" });
    // running MUST have NULL finished_at.
    await expect(
      insertRun(e, { status: "running", finishedAt: "2026-06-06T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "23514" });
    // completed MUST have a finished_at.
    await expect(
      insertRun(e, { status: "completed", finishedAt: null }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertRun(e, { status: "completed", finishedAt: "2026-06-06T00:00:00Z" }),
    ).resolves.toBeDefined();
  });

  it("result.mismatch_class = 014 vocabulary ONLY — a 015 posting category is rejected (READ-NOT-MIRROR)", async () => {
    if (skip()) return;
    const e = guard();
    await insertRun(e, {});
    // 014 stock classes accepted.
    for (const cls of [
      "match", "quantity_divergence", "unmapped_store", "unmapped_item",
      "dp2_only", "erpnext_only", "negative_balance_flagged",
    ]) {
      await expect(insertResult(e, { mismatchClass: cls })).resolves.toBeDefined();
    }
    // A 015 posting category (validation/closed_period/unmapped_account) is NOT a
    // 014 stock class → rejected. Posting dead-letters are read in place, never
    // mirrored as 017 results.
    await expect(insertResult(e, { mismatchClass: "validation" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertResult(e, { mismatchClass: "closed_period" })).rejects.toMatchObject({ code: "23514" });
  });

  it("result.result_state CHECK (open|repaired|accepted)", async () => {
    if (skip()) return;
    const e = guard();
    await insertRun(e, {});
    await expect(insertResult(e, { resultState: "pending" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertResult(e, { resultState: "accepted" })).resolves.toBeDefined();
  });

  it("result.run_id is a single-column FK to run(id) — a dangling run_id is rejected (23503)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertResult(e, { runId: "01900000-0000-7000-8000-0000000000ee" }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("repair_attempt enums: target_kind / repair_kind / outcome CHECKs", async () => {
    if (skip()) return;
    const e = guard();
    const insertAttempt = (opts: { targetKind?: string; repairKind?: string; outcome?: string }) =>
      e.admin.query(
        `INSERT INTO ${ATTEMPT} (id, tenant_id, target_kind, target_ref_id, repair_kind, actor_user_id, outcome)
         VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), $3, $4, $5)`,
        [TENANT_A, opts.targetKind ?? "posting", opts.repairKind ?? "re_post", ACTOR, opts.outcome ?? "eligible_again"],
      );
    await expect(insertAttempt({ targetKind: "sale" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertAttempt({ repairKind: "amend" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertAttempt({ outcome: "done" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertAttempt({})).resolves.toBeDefined();
  });
});

describe("0020 — fail-closed RLS", () => {
  it("RLS-bypass probe: a run owned by tenant A is invisible under app.current_tenant = B", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM ${RESULT}`);
    await e.admin.query(`DELETE FROM ${RUN}`);
    await insertRun(e, {});
    const client = await e.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${TENANT_B}'`);
      const wrong = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${RUN}`);
      expect(wrong.rows[0]?.count).toBe("0");
      await client.query(`SET app.current_tenant = '${TENANT_A}'`);
      const right = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${RUN}`);
      expect(Number(right.rows[0]?.count)).toBeGreaterThanOrEqual(1);
    } finally {
      client.release();
    }
  });

  it("empty GUC fails closed (zero rows, no 22P02) on all three tables", async () => {
    if (skip()) return;
    const e = guard();
    const client = await e.app.connect();
    try {
      await client.query(`RESET app.current_tenant`);
      for (const table of [RUN, RESULT, ATTEMPT]) {
        const r = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
        expect(r.rows[0]?.count).toBe("0");
      }
    } finally {
      client.release();
    }
  });
});

describe("0020 — down/up round-trip", () => {
  it("DOWN drops all three tables; UP re-creates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    for (const table of [RUN, RESULT, ATTEMPT]) {
      const afterDown = await e.admin.query(`SELECT to_regclass($1) AS reg`, [table]);
      expect(afterDown.rows[0]?.reg).toBeNull();
    }
    await e.admin.query(upSql);
    for (const table of [RUN, RESULT, ATTEMPT]) {
      const afterUp = await e.admin.query<{ reg: string }>(
        `SELECT to_regclass($1)::text AS reg`,
        [table],
      );
      expect(afterUp.rows[0]?.reg).toBe(table);
    }
    await ensureAppRole(e);
  });
});
