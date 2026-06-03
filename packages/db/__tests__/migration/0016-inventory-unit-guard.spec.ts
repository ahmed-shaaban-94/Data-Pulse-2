/**
 * 009 follow-up (issue #465, part A) — established-unit guard migration test.
 *
 * Validates `packages/db/drizzle/0016_inventory_unit_guard.sql` (+ `.down.sql`):
 *   - the EXCLUDE constraint `stock_movements_one_unit_per_product` enforces at
 *     most ONE distinct stocking_unit per (store_id, tenant_product_ref):
 *       · two movements in the SAME unit for one (store, product) → allowed
 *         (the common case — a product has many same-unit movements);
 *       · a movement in a DIFFERENT unit for that (store, product) → rejected
 *         with SQLSTATE 23P01 (exclusion_violation) — FR-022 backstop;
 *       · an ad-hoc NULL-product movement is unconstrained (partial WHERE, R5),
 *         and two NULL-product movements in different units coexist;
 *   - the SELF-GUARD: applying 0016 over data that ALREADY has a divergent
 *     (store, product) unit group aborts with a clear check_violation (it does
 *     NOT silently add a half-broken constraint);
 *   - btree_gist is installed by the migration;
 *   - UP → DOWN → UP round-trips cleanly (constraint gone after down, re-addable).
 *
 * Docker policy mirrors 0014-inventory.spec: missing Docker is a HARD failure
 * unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). Run targeted.
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
const GUARD_UP_PATH = resolve(DRIZZLE_DIR, "0016_inventory_unit_guard.sql");
const GUARD_DOWN_PATH = resolve(DRIZZLE_DIR, "0016_inventory_unit_guard.down.sql");

const CONSTRAINT_NAME = "stock_movements_one_unit_per_product";

// Hex-only UUID literals (memory: mnemonic prefixes a-f only).
const TENANT = "0e150000-0000-7000-8000-0000000000a1";
const STORE = "0e150000-0000-7000-8000-0000000000b1";
const PRODUCT = "0e150000-0000-7000-8000-0000000000e1";
const ACTOR = "0e150000-0000-7000-8000-0000000000c1";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let guardUpSql = "";
let guardDownSql = "";

/** Apply every migration with a basename lexically < 0016 (i.e. 0000–0015). */
async function applyPreGuardMigrations(pgEnv: PgTestEnv): Promise<void> {
  const guardBasename = basename(GUARD_UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(guardBasename) < 0)
    .sort();
  for (const name of upFiles) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

/** Seed tenant → store → product → actor user (admin pool, RLS-bypass). */
async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code)
       VALUES ($1, 'unit-guard', 'Unit Guard Tenant', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name)
       VALUES ($1, $2, 'UG1', 'Unit Guard Store')
     ON CONFLICT (id) DO NOTHING`,
    [STORE, TENANT],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'ug@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
  await pgEnv.admin.query(
    `INSERT INTO tenant_products
       (id, tenant_id, name, tax_category, is_active, created_by, updated_by)
       VALUES ($1, $2, 'Unit Guard Product', 'standard', true, $3, $3)
     ON CONFLICT (id) DO NOTHING`,
    [PRODUCT, TENANT, ACTOR],
  );
}

/** Insert one movement (admin pool). Returns the promise so callers can assert reject. */
function insertMovement(
  pgEnv: PgTestEnv,
  opts: { unit: string; productRef: string | null; id?: string },
): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO stock_movements
       (id, tenant_id, store_id, movement_type, quantity, stocking_unit,
        tenant_product_ref, occurred_at, created_by)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, 'inbound', 1::numeric(19,4),
             $4, $5, now(), $6)`,
    [opts.id ?? null, TENANT, STORE, opts.unit, opts.productRef, ACTOR],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreGuardMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0016-inventory-unit-guard.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  guardUpSql = readFileSync(GUARD_UP_PATH, "utf8");
  guardDownSql = readFileSync(GUARD_DOWN_PATH, "utf8");
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

describe("0016 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(GUARD_UP_PATH)).toBe(true);
    expect(existsSync(GUARD_DOWN_PATH)).toBe(true);
  });
});

describe("0016 — self-guard aborts over pre-existing divergent data", () => {
  it("RAISEs when a (store, product) already spans two units, and adds NO constraint", async () => {
    if (dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") return;
    const e = guard();
    await seedParents(e);

    // Seed a DIVERGENT group BEFORE the guard migration: same (store, product),
    // two different units. (Possible today — the constraint isn't applied yet.)
    await insertMovement(e, { unit: "ea", productRef: PRODUCT });
    await insertMovement(e, { unit: "kg", productRef: PRODUCT });

    // Applying 0016 must abort (self-guard), not add a half-broken constraint.
    await expect(e.admin.query(guardUpSql)).rejects.toMatchObject({ code: "23514" }); // check_violation

    const c = await e.admin.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = $1`,
      [CONSTRAINT_NAME],
    );
    expect(c.rows).toHaveLength(0);

    // Clean up the divergent rows so the next describe starts from clean data.
    await e.admin.query(`DELETE FROM stock_movements WHERE store_id = $1`, [STORE]);
  });
});

describe("0016 — constraint enforces one unit per (store, product) on clean data", () => {
  beforeAll(async () => {
    if (dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") return;
    const e = guard();
    await seedParents(e);
    // Data is clean now (divergent rows deleted above) → guard passes, constraint lands.
    await e.admin.query(guardUpSql);
  });

  it("installs btree_gist + the EXCLUDE constraint", async () => {
    if (dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") return;
    const e = guard();
    const ext = await e.admin.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'btree_gist'`,
    );
    expect(ext.rows).toHaveLength(1);
    const con = await e.admin.query<{ contype: string }>(
      `SELECT contype FROM pg_constraint WHERE conname = $1`,
      [CONSTRAINT_NAME],
    );
    expect(con.rows[0]?.contype).toBe("x"); // 'x' = exclusion constraint
  });

  it("allows many movements in the SAME unit for one (store, product)", async () => {
    if (dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") return;
    const e = guard();
    await expect(insertMovement(e, { unit: "ea", productRef: PRODUCT })).resolves.toBeDefined();
    await expect(insertMovement(e, { unit: "ea", productRef: PRODUCT })).resolves.toBeDefined();
  });

  it("REJECTS a movement in a DIFFERENT unit for that (store, product) — 23P01", async () => {
    if (dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") return;
    const e = guard();
    await expect(
      insertMovement(e, { unit: "kg", productRef: PRODUCT }),
    ).rejects.toMatchObject({ code: "23P01" }); // exclusion_violation
  });

  it("does NOT constrain ad-hoc NULL-product movements (partial WHERE, R5)", async () => {
    if (dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") return;
    const e = guard();
    // Two NULL-product movements in DIFFERENT units coexist — the guard skips them.
    await expect(insertMovement(e, { unit: "ea", productRef: null })).resolves.toBeDefined();
    await expect(insertMovement(e, { unit: "kg", productRef: null })).resolves.toBeDefined();
  });
});

describe("0016 — down/up round-trip", () => {
  it("DOWN drops the constraint; UP re-adds it (idempotent re-up)", async () => {
    if (dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") return;
    const e = guard();
    await e.admin.query(guardDownSql);
    const afterDown = await e.admin.query(
      `SELECT conname FROM pg_constraint WHERE conname = $1`,
      [CONSTRAINT_NAME],
    );
    expect(afterDown.rows).toHaveLength(0);

    // After down, a divergent unit is allowed again (constraint gone).
    await expect(insertMovement(e, { unit: "lb", productRef: PRODUCT })).resolves.toBeDefined();

    // Re-up now FAILS the self-guard (we just created divergent data) — proving
    // the guard also protects the re-up path. Clean up, then re-up succeeds.
    await expect(e.admin.query(guardUpSql)).rejects.toMatchObject({ code: "23514" });
    await e.admin.query(
      `DELETE FROM stock_movements WHERE store_id = $1 AND stocking_unit <> 'ea'`,
      [STORE],
    );
    await expect(e.admin.query(guardUpSql)).resolves.toBeDefined();
    const reUp = await e.admin.query(
      `SELECT conname FROM pg_constraint WHERE conname = $1`,
      [CONSTRAINT_NAME],
    );
    expect(reUp.rows).toHaveLength(1);
  });
});
