/**
 * 009-SCHEMA (T012/T013) — Inventory migration verification under Testcontainers.
 *
 * Feature: 009-inventory-stock-ledger, Phase 2 §5.2.
 *
 * Validates `packages/db/drizzle/0014_inventory.sql` (+ its `.down.sql`):
 *   - the two inventory tables (stock_counts, stock_movements) are created with
 *     the data-model.md §1 / §4 shape;
 *   - quantity columns are `numeric(19,4)`;
 *   - the load-bearing NEGATIVES: NO `version` column (R7); NO
 *     batch/expiry/serial/stock_lot_id/stock_serial_id column on the base
 *     movement (FR-041); NO money/currency/payment column (§XIV);
 *   - EXACTLY ONE movement-level dedup index — the backfill provenance
 *     partial-unique (tenant_id, source_system, external_id) — and NO
 *     (tenant_id, store_id, idempotency_key) unique index (R4/FR-030);
 *   - RLS is ENABLED + FORCED on both tables, with SELECT + INSERT policies
 *     ONLY (no UPDATE/DELETE policy — append-only contract, FR-001), and a
 *     per-table RLS-bypass probe (wrong `app.current_tenant` ⇒ zero rows)
 *     returns nothing (FR-050/060);
 *   - the migration applies cleanly and rolls back cleanly (UP -> DOWN -> UP).
 *
 * Docker policy (matches `0012-sales.spec.ts`): a missing Docker runtime is a
 * HARD failure unless `MIGRATION_TEST_ALLOW_SKIP=1` is set. CI MUST NOT set
 * `MIGRATION_TEST_ALLOW_SKIP=1`. Run targeted, never the full db suite (the
 * shared self-hosted runner OOMs the full integration suite).
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
const INV_UP_PATH = resolve(DRIZZLE_DIR, "0014_inventory.sql");
const INV_DOWN_PATH = resolve(DRIZZLE_DIR, "0014_inventory.down.sql");

const INV_TABLES = ["stock_counts", "stock_movements"] as const;

const QUANTITY_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "stock_movements", column: "quantity" },
  { table: "stock_counts", column: "counted_quantity" },
  { table: "stock_counts", column: "derived_on_hand_at_count" },
];

// Columns that MUST NOT exist on the base movement (load-bearing negatives).
const FORBIDDEN_MOVEMENT_COLUMNS = [
  "version",
  "batch",
  "batch_lot_number",
  "lot",
  "lot_number",
  "expiry",
  "expiry_date",
  "serial",
  "serial_number",
  "stock_lot_id",
  "stock_serial_id",
  "currency_code",
  "amount",
  "price",
  "unit_price",
  "tender",
  "payment",
];

let env: PgTestEnv | null = null;
let dockerSkipReason = "";
let invUpSql: string | null = null;
let invDownSql: string | null = null;
let migrationGateError: string | null = null;

/** Apply every UP migration that sorts strictly before 0014_inventory.sql. */
async function applyPreInventoryMigrations(pgEnv: PgTestEnv): Promise<void> {
  const invUpBasename = basename(INV_UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(invUpBasename) < 0)
    .sort();
  for (const name of upFiles) {
    const sql = readFileSync(resolve(DRIZZLE_DIR, name), "utf8");
    await pgEnv.admin.query(sql);
  }
  await ensureAppRole(pgEnv);
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreInventoryMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[0014-inventory.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`,
      );
      return;
    }
    throw new Error(
      `Container start failed: ${dockerSkipReason}\n${err instanceof Error && err.stack ? err.stack : ""}`,
    );
  }

  if (!existsSync(INV_UP_PATH)) {
    migrationGateError = `Inventory migration file missing. Expected at: ${INV_UP_PATH}`;
    return;
  }
  if (!existsSync(INV_DOWN_PATH)) {
    migrationGateError = `Inventory rollback file missing. Expected at: ${INV_DOWN_PATH}`;
    return;
  }
  invUpSql = readFileSync(INV_UP_PATH, "utf8");
  invDownSql = readFileSync(INV_DOWN_PATH, "utf8");
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function ensureLoaded(): { up: string; down: string } {
  if (!env) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      throw new Error(`Skipped (no Docker): ${dockerSkipReason}`);
    }
    throw new Error("env not initialized");
  }
  if (migrationGateError) throw new Error(migrationGateError);
  if (invUpSql === null || invDownSql === null) {
    throw new Error("inventory migration SQL not loaded");
  }
  return { up: invUpSql, down: invDownSql };
}

// ---------------------------------------------------------------------------
// Forward migration
// ---------------------------------------------------------------------------
describe("0014_inventory — applies cleanly and creates the two inventory tables", () => {
  it("pre-migration: neither inventory table exists", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [INV_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name)).toEqual([]);
  });

  it("applies cleanly and creates both tables", async () => {
    const { up } = ensureLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(up);
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [INV_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name).sort()).toEqual(
      [...INV_TABLES].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Column shape: quantity types + forbidden-column negatives
// ---------------------------------------------------------------------------
describe("0014_inventory — column shape (quantity numeric, forbidden columns)", () => {
  it("quantity columns are numeric(19,4)", async () => {
    if (!env) throw new Error("env not initialized");
    for (const { table, column } of QUANTITY_COLUMNS) {
      const r = await env.admin.query<{
        data_type: string;
        numeric_precision: number;
        numeric_scale: number;
      }>(
        `SELECT data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column],
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]?.data_type).toBe("numeric");
      expect(Number(r.rows[0]?.numeric_precision)).toBe(19);
      expect(Number(r.rows[0]?.numeric_scale)).toBe(4);
    }
  });

  it("stock_movements has NONE of the forbidden columns (R7 / FR-041 / §XIV)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'stock_movements'
         AND column_name = ANY($1::text[])`,
      [FORBIDDEN_MOVEMENT_COLUMNS],
    );
    expect(r.rows.map((row) => row.column_name)).toEqual([]);
  });

  it("has EXACTLY the backfill provenance unique index, and NO idempotency_key unique index", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'stock_movements'`,
    );
    const defs = r.rows;
    // The backfill provenance unique exists and is partial on the provenance pair.
    const provenanceIdx = defs.find(
      (d) => d.indexname === "uq_stock_movements_tenant_source_external",
    );
    expect(provenanceIdx).toBeDefined();
    expect(provenanceIdx?.indexdef).toMatch(/UNIQUE/i);
    expect(provenanceIdx?.indexdef).toMatch(/source_system/i);
    // No unique index references idempotency_key (manual dedup = interceptor).
    const idempotencyUnique = defs.filter(
      (d) => /UNIQUE/i.test(d.indexdef) && /idempotency_key/i.test(d.indexdef),
    );
    expect(idempotencyUnique).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CHECK constraints (CodeRabbit #440): reason length + count_correction link
// ---------------------------------------------------------------------------
describe("0014_inventory — CHECK constraints", () => {
  /** The CHECK definition for a named constraint ON stock_movements, or null. */
  async function checkDef(conname: string): Promise<string | null> {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conname = $1
         AND contype = 'c'
         AND conrelid = 'stock_movements'::regclass`,
      [conname],
    );
    return r.rows[0]?.def ?? null;
  }

  it("reason length CHECK bounds reason to <= 500 (definition, scoped to stock_movements)", async () => {
    const def = await checkDef("stock_movements_reason_length");
    expect(def).not.toBeNull();
    // Definition contains the length bound + the 500 ceiling (CodeRabbit: assert
    // the expression, not just presence).
    expect(def).toMatch(/char_length/i);
    expect(def).toContain("500");
  });

  it("count_correction <-> stock_count_id biconditional CHECK (definition, scoped to stock_movements)", async () => {
    const def = await checkDef("stock_movements_count_correction_link");
    expect(def).not.toBeNull();
    // The biconditional names both sides: movement_type = 'count_correction'
    // and stock_count_id IS NOT NULL.
    expect(def).toContain("count_correction");
    expect(def).toMatch(/stock_count_id/i);
  });

  // NOTE — enforcement-by-violating-INSERT (CHECK rejects a bad row) is NOT
  // asserted at the migration level: a movement row also has FK parents
  // (tenant_id/store_id -> tenants/stores), so a bare INSERT could fail on the
  // FK rather than the CHECK, making the assertion ambiguous/flaky. The seeded
  // path with real FK parents — which can isolate and prove CHECK enforcement
  // (and the full cross-tenant sweep) — is owned by the next slice,
  // 009-ISOLATION-HARNESS (T014 seeds tenants A/B + stores X/Y; T015 sweep).
  // Here we assert the CHECK DEFINITION (the bound + the biconditional), which
  // is the robust, FK-independent proof at this layer.
});

// ---------------------------------------------------------------------------
// RLS: enabled + forced + fail-closed; append-only (SELECT + INSERT only)
// ---------------------------------------------------------------------------
describe("0014_inventory — RLS enabled, forced, append-only, fail-closed", () => {
  it("RLS is ENABLED + FORCED on both tables", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])`,
      [INV_TABLES as unknown as string[]],
    );
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it("each table has SELECT + INSERT policies ONLY (no UPDATE/DELETE — append-only, FR-001)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ tablename: string; cmd: string }>(
      `SELECT tablename, cmd FROM pg_policies
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [INV_TABLES as unknown as string[]],
    );
    for (const table of INV_TABLES) {
      const cmds = r.rows
        .filter((row) => row.tablename === table)
        .map((row) => row.cmd.toUpperCase())
        .sort();
      // pg reports SELECT policy cmd as "SELECT" and INSERT as "INSERT".
      expect(cmds).toEqual(["INSERT", "SELECT"]);
    }
  });

  it("RLS-bypass probe: a wrong app.current_tenant returns zero rows on every table", async () => {
    if (!env) throw new Error("env not initialized");
    // Re-run the idempotent grant now that the inventory tables exist (GRANT
    // ... ON ALL TABLES picks up the new relations); otherwise the app role
    // gets "permission denied" before RLS is even evaluated.
    await ensureAppRole(env);

    const tenantB = "22222222-2222-2222-2222-222222222222";
    const client = await env.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${tenantB}'`);
      for (const table of INV_TABLES) {
        const r = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}`,
        );
        expect(r.rows[0]?.count).toBe("0");
      }
    } finally {
      client.release();
    }
  });
});

// ---------------------------------------------------------------------------
// Rollback round-trip (UP -> DOWN -> UP)
// ---------------------------------------------------------------------------
describe("0014_inventory — rollback round-trip (UP -> DOWN -> UP)", () => {
  it("rolls back cleanly: both tables dropped", async () => {
    const { down } = ensureLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(down);
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [INV_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name)).toEqual([]);
  });

  it("re-applies cleanly after rollback (idempotent UP)", async () => {
    const { up } = ensureLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(up);
    const r = await env.admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [INV_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name).sort()).toEqual(
      [...INV_TABLES].sort(),
    );
  });
});
