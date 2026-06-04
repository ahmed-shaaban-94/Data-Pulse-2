/**
 * Product Master from ERPNext (013) — `0017_erpnext_item_map` migration test.
 *
 * Validates `packages/db/drizzle/0017_erpnext_item_map.sql` (+ `.down.sql`):
 *   - the table is created with the data-model.md §2 column set + the three
 *     CHECK constraints and the 1:1 partial-unique;
 *   - the CONFIRMED-ONLY invariant CHECK (data-model §3): a row cannot be
 *     state='confirmed' without confirmed_by/confirmed_at, nor state='suggested'
 *     while carrying them;
 *   - the 1:1 partial-unique (OQ-2): a second ACTIVE mapping for the same
 *     (tenant, product) is rejected (23505), but a re-point AFTER retiring the
 *     first is allowed (retired rows are excluded from the unique);
 *   - the version CHECK (§III): version < 1 is rejected;
 *   - fail-closed RLS: an RLS-bypass probe with the WRONG app.current_tenant
 *     returns zero rows; the empty-GUC case yields zero rows (no 22P02);
 *   - UP -> DOWN -> UP round-trips cleanly.
 *
 * Docker policy mirrors 0014/0016: missing Docker is a HARD failure unless
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
const UP_PATH = resolve(DRIZZLE_DIR, "0017_erpnext_item_map.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0017_erpnext_item_map.down.sql");

const TABLE = "erpnext_item_map";

// Hex-only UUID literals (memory: mnemonic prefixes a-f only).
const TENANT_A = "01700000-0000-7000-8000-0000000000a1";
const TENANT_B = "01700000-0000-7000-8000-0000000000b2";
const STORE_A = "01700000-0000-7000-8000-0000000000c1";
const PRODUCT_A = "01700000-0000-7000-8000-0000000000e1";
const ACTOR = "01700000-0000-7000-8000-0000000000d1";
const ITEM_REF = "ITEM-0001";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** Apply every migration with a basename lexically < 0017 (0000–0016). */
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

/** Seed tenants A/B → store → product → actor (admin pool, RLS-bypass). */
async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'eim-a', 'EIM Tenant A', 'USD'),
       ($2, 'eim-b', 'EIM Tenant B', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'EIM1', 'EIM Store')
     ON CONFLICT (id) DO NOTHING`,
    [STORE_A, TENANT_A],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'eim@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
  await pgEnv.admin.query(
    `INSERT INTO tenant_products (id, tenant_id, name, tax_category, is_active, created_by, updated_by)
       VALUES ($1, $2, 'EIM Product', 'standard', true, $3, $3)
     ON CONFLICT (id) DO NOTHING`,
    [PRODUCT_A, TENANT_A, ACTOR],
  );
}

/**
 * Insert one mapping (admin pool, RLS-bypass). `confirmedBy` is the literal
 * value for confirmed_by; when it is non-null, confirmed_at is set to now()
 * (so the caller can build both valid and CHECK-violating combinations).
 * Stable parameter numbering — confirmed_at is derived in SQL, not a param.
 */
function insertMapping(
  pgEnv: PgTestEnv,
  opts: {
    id?: string;
    tenant?: string;
    product?: string;
    state?: string;
    confirmedBy?: string | null;
    /** When true, force confirmed_at NULL even though confirmed_by is set (to hit the CHECK). */
    confirmedAtNull?: boolean;
    version?: number;
    retiredAt?: string | null;
    source?: string;
  },
): Promise<unknown> {
  const confirmedBy = opts.confirmedBy ?? null;
  // confirmed_at mirrors confirmed_by (now() when present) unless explicitly forced NULL.
  const confirmedAtExpr =
    confirmedBy !== null && !opts.confirmedAtNull ? "now()" : "NULL";
  return pgEnv.admin.query(
    `INSERT INTO erpnext_item_map
       (id, tenant_id, tenant_product_id, erpnext_item_ref, state, suggestion_source,
        suggested_by, confirmed_by, confirmed_at, version, retired_at)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, ${confirmedAtExpr}, $9, $10::timestamptz)`,
    [
      opts.id ?? null,
      opts.tenant ?? TENANT_A,
      opts.product ?? PRODUCT_A,
      ITEM_REF,
      opts.state ?? "suggested",
      opts.source ?? "manual",
      ACTOR,
      confirmedBy,
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
      console.warn(`\n[0017-erpnext-item-map.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0017 so the app role has privileges on the new table
  // (ensureAppRole's GRANT ON ALL TABLES only covers tables existing at grant
  // time — the new table needs a re-grant, mirroring the real deploy order:
  // migrate, then (re)apply grants).
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

describe("0017 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0017 — table + RLS created", () => {
  it("creates erpnext_item_map with RLS enabled + forced", async () => {
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
});

describe("0017 — constraints", () => {
  // Each test starts from an empty table so the 1:1 partial-unique does not
  // leak active rows across tests (admin pool — hard-delete is test-only).
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM erpnext_item_map`);
  });

  it("rejects state='confirmed' without confirm provenance (confirmed-only CHECK)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertMapping(e, { state: "confirmed", confirmedBy: null }),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });

  it("rejects state='suggested' that carries confirm provenance", async () => {
    if (skip()) return;
    const e = guard();
    // state='suggested' but confirmed_by set (confirmed_at follows) → CHECK violation.
    await expect(
      insertMapping(e, { state: "suggested", confirmedBy: ACTOR }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects version < 1", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertMapping(e, { version: 0 })).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts a valid suggested mapping, then REJECTS a 2nd ACTIVE one (1:1 partial-unique)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertMapping(e, {})).resolves.toBeDefined();
    await expect(insertMapping(e, {})).rejects.toMatchObject({ code: "23505" }); // unique_violation
  });

  it("accepts a valid confirmed mapping (confirmed-only CHECK passes when provenance present)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertMapping(e, { state: "confirmed", confirmedBy: ACTOR }),
    ).resolves.toBeDefined();
  });

  it("allows a NEW active mapping AFTER the first is retired (re-point; partial-unique excludes retired)", async () => {
    if (skip()) return;
    const e = guard();
    await insertMapping(e, {});
    await e.admin.query(
      `UPDATE erpnext_item_map SET retired_at = now() WHERE tenant_id = $1 AND retired_at IS NULL`,
      [TENANT_A],
    );
    await expect(insertMapping(e, {})).resolves.toBeDefined();
  });
});

describe("0017 — fail-closed RLS", () => {
  it("RLS-bypass probe: a row owned by tenant A is invisible under app.current_tenant = B", async () => {
    if (skip()) return;
    const e = guard();
    // Clean slate, then seed one active mapping for tenant A (admin pool, bypasses RLS).
    await e.admin.query(`DELETE FROM erpnext_item_map`);
    await insertMapping(e, {});
    const client = await e.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${TENANT_B}'`);
      const wrong = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${TABLE}`,
      );
      expect(wrong.rows[0]?.count).toBe("0");
      // Correct tenant sees its own active row.
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
      // RESET so a pooled connection cannot carry a prior test's GUC. An unset
      // app.current_tenant → current_setting(..., true) = '' → CASE → NULL → 0 rows.
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

describe("0017 — down/up round-trip", () => {
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
