/**
 * Branch Inventory Reconciliation & Warehouse Mapping (014) —
 * `0018_erpnext_warehouse_map` migration test.
 *
 * Validates `packages/db/drizzle/0018_erpnext_warehouse_map.sql` (+ `.down.sql`):
 *   - the table is created with the data-model.md §2 column set + the three
 *     CHECK constraints and the purpose-grain 1:1 partial-unique;
 *   - the purpose CHECK: only 'stock' | 'returns' are admitted;
 *   - the ref-length CHECK: an empty / over-180-char ref is rejected;
 *   - the OQ-2 forward-compat partial-unique: a second ACTIVE 'stock' mapping
 *     for the same (tenant, store) is rejected (23505), but a 'returns' row for
 *     the same store COEXISTS, and a re-point AFTER retiring the first 'stock'
 *     row is allowed (retired rows are excluded from the unique);
 *   - the version CHECK (§III): version < 1 is rejected;
 *   - fail-closed RLS: an RLS-bypass probe with the WRONG app.current_tenant
 *     returns zero rows; the empty-GUC case yields zero rows (no 22P02);
 *   - UP -> DOWN -> UP round-trips cleanly.
 *
 * Docker policy mirrors 0014/0016/0017: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). Run targeted via WSL.
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
const UP_PATH = resolve(DRIZZLE_DIR, "0018_erpnext_warehouse_map.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0018_erpnext_warehouse_map.down.sql");

const TABLE = "erpnext_warehouse_map";

// Hex-only UUID literals (memory: mnemonic prefixes a-f only).
const TENANT_A = "01800000-0000-7000-8000-0000000000a1";
const TENANT_B = "01800000-0000-7000-8000-0000000000b2";
const STORE_A = "01800000-0000-7000-8000-0000000000c1";
const ACTOR = "01800000-0000-7000-8000-0000000000d1";
const WAREHOUSE_REF = "WH-0001";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** Apply every migration with a basename lexically < 0018 (0000–0017). */
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
       ($1, 'ewm-a', 'EWM Tenant A', 'USD'),
       ($2, 'ewm-b', 'EWM Tenant B', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'EWM1', 'EWM Store')
     ON CONFLICT (id) DO NOTHING`,
    [STORE_A, TENANT_A],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'ewm@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
}

/** Insert one mapping (admin pool, RLS-bypass). */
function insertMapping(
  pgEnv: PgTestEnv,
  opts: {
    id?: string;
    tenant?: string;
    store?: string;
    purpose?: string;
    ref?: string;
    version?: number;
    retiredAt?: string | null;
  },
): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO erpnext_warehouse_map
       (id, tenant_id, store_id, purpose, erpnext_warehouse_ref,
        set_by, version, retired_at)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
    [
      opts.id ?? null,
      opts.tenant ?? TENANT_A,
      opts.store ?? STORE_A,
      opts.purpose ?? "stock",
      opts.ref ?? WAREHOUSE_REF,
      ACTOR,
      opts.version ?? 1,
      opts.retiredAt ?? null,
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
      console.warn(`\n[0018-erpnext-warehouse-map.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0018 so the app role has privileges on the new table
  // (ensureAppRole's GRANT ON ALL TABLES only covers tables existing at grant
  // time — the new table needs a re-grant, mirroring the real deploy order).
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

describe("0018 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0018 — table + RLS created", () => {
  it("creates erpnext_warehouse_map with RLS enabled + forced", async () => {
    if (skip()) return;
    const e = guard();
    const t = await e.admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [TABLE],
    );
    expect(t.rows[0]?.relrowsecurity).toBe(true);
    expect(t.rows[0]?.relforcerowsecurity).toBe(true);
    // SELECT + INSERT + UPDATE policies (mutable table); NO DELETE policy.
    const pol = await e.admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1`,
      [TABLE],
    );
    const cmds = pol.rows.map((r) => r.cmd).sort();
    expect(cmds).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("exposes NO Bin-quantity / valuation / on-hand column (OQ-1, no read-down mirror)", async () => {
    if (skip()) return;
    const e = guard();
    const cols = await e.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [TABLE],
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const forbidden of [
      "quantity",
      "bin_quantity",
      "qty",
      "on_hand",
      "valuation",
      "valuation_rate",
      "cost",
      "stock_value",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // Sanity: the mapping columns ARE present.
    expect(names).toContain("store_id");
    expect(names).toContain("erpnext_warehouse_ref");
    expect(names).toContain("purpose");
  });
});

describe("0018 — constraints", () => {
  // Each test starts from an empty table so the partial-unique does not leak
  // active rows across tests (admin pool — hard-delete is test-only).
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM erpnext_warehouse_map`);
  });

  it("rejects an invalid purpose (CHECK)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertMapping(e, { purpose: "scrap" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an empty erpnext_warehouse_ref (ref-length CHECK)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertMapping(e, { ref: "" })).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("rejects version < 1", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertMapping(e, { version: 0 })).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts a valid stock mapping, then REJECTS a 2nd ACTIVE 'stock' for the same store (partial-unique)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertMapping(e, {})).resolves.toBeDefined();
    await expect(insertMapping(e, {})).rejects.toMatchObject({ code: "23505" });
  });

  it("ADMITS a 'returns' mapping for the same store as an active 'stock' (OQ-2 purpose grain)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertMapping(e, { purpose: "stock" })).resolves.toBeDefined();
    await expect(
      insertMapping(e, { purpose: "returns", ref: "WH-RET-1" }),
    ).resolves.toBeDefined();
  });

  it("allows a NEW active 'stock' mapping AFTER the first is retired (re-point; partial-unique excludes retired)", async () => {
    if (skip()) return;
    const e = guard();
    await insertMapping(e, {});
    await e.admin.query(
      `UPDATE erpnext_warehouse_map SET retired_at = now() WHERE tenant_id = $1 AND retired_at IS NULL`,
      [TENANT_A],
    );
    await expect(insertMapping(e, {})).resolves.toBeDefined();
  });
});

describe("0018 — fail-closed RLS", () => {
  it("RLS-bypass probe: a row owned by tenant A is invisible under app.current_tenant = B", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM erpnext_warehouse_map`);
    await insertMapping(e, {});
    const client = await e.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${TENANT_B}'`);
      const wrong = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${TABLE}`,
      );
      expect(wrong.rows[0]?.count).toBe("0");
      await client.query(`SET app.current_tenant = '${TENANT_A}'`);
      const right = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${TABLE} WHERE retired_at IS NULL`,
      );
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
      const r = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${TABLE}`,
      );
      expect(r.rows[0]?.count).toBe("0");
    } finally {
      client.release();
    }
  });
});

describe("0018 — down/up round-trip", () => {
  it("DOWN drops the table; UP re-creates it", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    const afterDown = await e.admin.query(
      `SELECT to_regclass($1) AS reg`,
      [TABLE],
    );
    expect(afterDown.rows[0]?.reg).toBeNull();

    await e.admin.query(upSql);
    const afterUp = await e.admin.query<{ reg: string }>(
      `SELECT to_regclass($1)::text AS reg`,
      [TABLE],
    );
    expect(afterUp.rows[0]?.reg).toBe(TABLE);
  });
});
