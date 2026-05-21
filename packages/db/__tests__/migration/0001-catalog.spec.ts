/**
 * T326–T329 — Catalog migration verification (RED authoring under TDD).
 *
 * Feature: 003-catalog-foundation, Phase 2 §5.3.
 *
 * This file is authored BEFORE the catalog SQL migration (T330) exists. Per
 * `specs/003-catalog-foundation/tasks.md §5.3` the predecessor DAG is:
 *
 *     T320 [GATED]  — Drizzle schema source
 *       └─► T331 [GATED]  — catalog barrel re-export
 *             └─► T326     — forward-migration creation test (this file)
 *                   ├─► T327  — rollback / round-trip test (this file)
 *                   ├─► T328  — Q5 no-FK / soft-reference test (this file)
 *                   └─► T329  — Q1 money-column type + non-negative CHECK test (this file)
 *                         └─► T330 [GATED] — author the SQL migration + rollback
 *
 * Source-of-truth artifacts these assertions encode:
 *   - `specs/003-catalog-foundation/data-model.md`
 *       §2-§8 (per-table column shape, FKs, RLS policies, indexes, CHECKs)
 *       §9 (cross-entity FKs + ON DELETE behavior — RESTRICT / SET NULL / no CASCADE)
 *       §10 (RLS policy inventory — every catalog table has RLS enabled + FORCE RLS)
 *       §13 (`tenants.default_currency_code` Phase 2 column amendment)
 *   - `specs/003-catalog-foundation/migration-test-plan.md` §6-§12
 *     (the authoritative assertion inventory for T326–T329; this spec
 *     follows it byte-for-byte).
 *
 * RED expectation: the migration file `packages/db/drizzle/0001_catalog.sql`
 * does not exist yet. The `beforeAll` block reads it from disk; absent the
 * file, every test fails with a "Catalog migration file not yet authored"
 * error pointing at T330. That is the intended RED gate — when T330 lands,
 * these tests turn green without modification.
 *
 * Naming reconciliation note (migration-test-plan.md §5 / §16-R2): the
 * tasks.md path `packages/db/drizzle/0001_catalog.sql` collides with the
 * already-merged `0001_pos_operator_identity.sql`. T330 owns the rename
 * (the next free lex slot is `0007_catalog.sql` since `0006_outbox_events.sql`
 * is on main). This spec deliberately references the tasks.md path so the
 * RED reason is unambiguously "T330 has not authored the migration yet";
 * the assertion that resolves the filename mismatch lives inside T330's PR,
 * not here.
 *
 * Docker policy (matches `migration_0001.spec.ts`): a missing Docker
 * runtime is a HARD failure unless `MIGRATION_TEST_ALLOW_SKIP=1` is set,
 * in which case the suite emits a single "Docker NOT AVAILABLE" warning
 * and the per-test guards turn the assertions into a soft skip. CI MUST
 * NOT set `MIGRATION_TEST_ALLOW_SKIP=1`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  APP_ROLE_NAME,
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Migration file paths (the RED gate hangs off these — they do not yet exist)
// ---------------------------------------------------------------------------

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");

// tasks.md §5.3 authoritative path. T330 may rename this to `0007_catalog.sql`
// when reconciling the lex-order collision documented in
// `migration-test-plan.md §16-R2`. The test reads `CATALOG_UP_PATH` once at
// load time; renaming is a one-line edit here when T330 lands.
const CATALOG_UP_PATH = resolve(DRIZZLE_DIR, "0001_catalog.sql");
const CATALOG_DOWN_PATH = resolve(DRIZZLE_DIR, "0001_catalog.down.sql");

// ---------------------------------------------------------------------------
// Catalog inventory (per data-model.md §2-§8) — used by every test below
// ---------------------------------------------------------------------------

const CATALOG_TABLES = [
  "global_products",
  "tenant_products",
  "tenant_product_categories",
  "store_product_overrides",
  "product_aliases",
  "price_history",
  "unknown_items",
] as const;

/**
 * Money-column inventory per `migration-test-plan.md §9.1`. Every entry must
 * be `numeric(19,4)` (Q1) and carry a `CHECK (... >= 0)` constraint.
 */
const MONEY_COLUMNS: ReadonlyArray<{
  table: string;
  column: string;
  nullable: boolean;
}> = [
  { table: "global_products", column: "default_price", nullable: true },
  { table: "tenant_products", column: "default_price", nullable: true },
  { table: "store_product_overrides", column: "price", nullable: true },
  { table: "price_history", column: "price", nullable: false },
];

// ---------------------------------------------------------------------------
// Suite setup — start container + apply pre-catalog migrations
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipReason = "";
let catalogUpSql: string | null = null;
let catalogDownSql: string | null = null;
let migrationGateError: string | null = null;

beforeAll(async () => {
  // Phase 1: confirm Docker is reachable and apply existing (pre-catalog)
  // migrations. Even if T330 has not landed, we still want to know that
  // the Testcontainers harness boots — otherwise the RED reason is
  // ambiguous (could be Docker, could be T330).
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[0001-catalog.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`,
      );
      return;
    }
    throw new Error(
      `Container start failed: ${dockerSkipReason}\n${err instanceof Error && err.stack ? err.stack : ""}`,
    );
  }

  // Phase 2: read the catalog migration SQL. If T330 has not landed,
  // record the precise reason so per-test failures point at the right
  // gate rather than at the harness.
  if (!existsSync(CATALOG_UP_PATH)) {
    migrationGateError = `Catalog migration file not yet authored (T330 gated). Expected at: ${CATALOG_UP_PATH}`;
    return;
  }
  if (!existsSync(CATALOG_DOWN_PATH)) {
    migrationGateError = `Catalog rollback file not yet authored (T330 gated). Expected at: ${CATALOG_DOWN_PATH}`;
    return;
  }
  catalogUpSql = readFileSync(CATALOG_UP_PATH, "utf8");
  catalogDownSql = readFileSync(CATALOG_DOWN_PATH, "utf8");
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

/**
 * Per-test guard. Returns the loaded UP SQL string. Throws when Docker is
 * unavailable (skip path if `MIGRATION_TEST_ALLOW_SKIP=1`), or when the
 * harness is up but the catalog migration file does not yet exist — the
 * latter is the intended RED signal pointing at T330.
 *
 * Returning the SQL (rather than declaring an `asserts catalogUpSql is
 * string` predicate) sidesteps a TypeScript limitation: `asserts` only
 * narrows *named parameters* of the asserting function, not module-scope
 * mutables.
 */
function ensureCatalogMigrationLoaded(): string {
  if (!env) {
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      throw new Error(`Skipped (no Docker): ${dockerSkipReason}`);
    }
    throw new Error("env not initialized");
  }
  if (migrationGateError) {
    throw new Error(migrationGateError);
  }
  if (catalogUpSql === null) {
    throw new Error("catalog UP SQL not loaded");
  }
  return catalogUpSql;
}

function ensureCatalogRollbackLoaded(): { up: string; down: string } {
  const up = ensureCatalogMigrationLoaded();
  if (catalogDownSql === null) {
    throw new Error("catalog DOWN SQL not loaded");
  }
  return { up, down: catalogDownSql };
}

// ---------------------------------------------------------------------------
// T326 — forward migration creation: pre-state + post-state inventory
// ---------------------------------------------------------------------------

describe("T326 — catalog migration applies cleanly and creates the full inventory", () => {
  it("pre-migration: none of the seven catalog tables exist on a clean container", async () => {
    if (!env) throw new Error("env not initialized");
    // This assertion runs BEFORE applying the catalog migration. It exercises
    // the harness contract: `applyAllUpAndCreateAppRole` (called in beforeAll)
    // applies every existing migration in lex order, none of which create
    // catalog tables. If a future migration on main accidentally creates
    // a catalog table, this test fails loudly — that is the intended guard.
    const r = await env.admin.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name
      `,
      [CATALOG_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name)).toEqual([]);
  });

  it("pre-migration: tenants.default_currency_code does not yet exist (data-model.md §13 amendment lands in T330)", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tenants'
          AND column_name = 'default_currency_code'
      `,
    );
    expect(r.rowCount).toBe(0);
  });

  it("applies cleanly and creates all seven catalog tables", async () => {
    const upSql = ensureCatalogMigrationLoaded();
    if (!env) throw new Error("env not initialized");
    await env.admin.query(upSql);

    const r = await env.admin.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name
      `,
      [CATALOG_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name).sort()).toEqual(
      [...CATALOG_TABLES].sort(),
    );
  });

  it("adds tenants.default_currency_code (char(3) NOT NULL DEFAULT) per data-model.md §13", async () => {
    ensureCatalogMigrationLoaded();
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      data_type: string;
      is_nullable: string;
      character_maximum_length: number | null;
      column_default: string | null;
    }>(
      `
        SELECT data_type, is_nullable, character_maximum_length, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tenants'
          AND column_name = 'default_currency_code'
      `,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.data_type).toBe("character");
    expect(r.rows[0]?.character_maximum_length).toBe(3);
    expect(r.rows[0]?.is_nullable).toBe("NO");
    // data-model.md §13: column is non-null with a DEFAULT (commonly 'USD').
    // Don't pin the literal — assert that some default is declared.
    expect(r.rows[0]?.column_default).not.toBeNull();
  });

  it("enables RLS with FORCE on every catalog table (Constitution §2)", async () => {
    ensureCatalogMigrationLoaded();
    if (!env) throw new Error("env not initialized");
    // migration-test-plan.md §6.5 / §10: every catalog table has both
    // relrowsecurity = true AND relforcerowsecurity = true so the runtime
    // (non-superuser) role cannot bypass RLS even when the policy set is
    // permissive. The app_test role MUST NOT have BYPASSRLS.
    const r = await env.admin.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `
        SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class
        WHERE relname = ANY($1::text[])
        ORDER BY relname
      `,
      [CATALOG_TABLES as unknown as string[]],
    );
    expect(r.rowCount).toBe(CATALOG_TABLES.length);
    for (const row of r.rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }

    // Runtime role must NOT bypass RLS — Constitution §2 fail-closed.
    const bypassCheck = await env.admin.query<{ rolbypassrls: boolean }>(
      `SELECT rolbypassrls FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE_NAME],
    );
    expect(bypassCheck.rows[0]?.rolbypassrls).toBe(false);
  });

  it("declares at least one RLS policy on every tenant-scoped catalog table (data-model.md §10)", async () => {
    ensureCatalogMigrationLoaded();
    if (!env) throw new Error("env not initialized");
    // migration-test-plan.md §10: every catalog table carries at least one
    // policy. The full per-table policy inventory is asserted by T326's
    // §6.5 work in the migration-test-plan; here we exercise the
    // single-policy floor so RLS-enabled-but-no-policies (a fail-closed
    // configuration that would silently break reads) is caught.
    for (const table of CATALOG_TABLES) {
      const r = await env.admin.query<{ count: string }>(
        `
          SELECT count(*)::text AS count
          FROM pg_policies
          WHERE schemaname = 'public' AND tablename = $1
        `,
        [table],
      );
      const count = Number(r.rows[0]?.count ?? "0");
      expect(count).toBeGreaterThanOrEqual(1);
    }
  });

  it("declares the seven canonical partial UNIQUE indexes from data-model.md (Q4 / Q7 / Q9)", async () => {
    ensureCatalogMigrationLoaded();
    if (!env) throw new Error("env not initialized");
    // migration-test-plan.md §11: the partial UNIQUE indexes that enforce
    // alias uniqueness (Q4), active category-name uniqueness (Q7), and
    // at-most-one-open-interval (Q9). Plain non-unique indexes are not
    // gated here; the full index inventory belongs in the migration-level
    // expansion of this suite when T330 lands.
    const PARTIAL_UQ_INDEXES = [
      "UQ_idx_tenant_product_categories_tenant_name",
      "UQ_idx_store_product_overrides_product_store",
      "UQ_idx_product_aliases_tenant_wide",
      "UQ_idx_product_aliases_external_pos_id",
      "UQ_idx_product_aliases_store_scoped",
      "UQ_idx_price_history_tenant_open",
      "UQ_idx_price_history_store_open",
    ];
    const r = await env.admin.query<{
      indexname: string;
      indisunique: boolean;
      pred: string | null;
    }>(
      `
        SELECT c.relname AS indexname,
               pi.indisunique,
               pg_get_expr(pi.indpred, pi.indrelid) AS pred
        FROM pg_index pi
        JOIN pg_class c ON c.oid = pi.indexrelid
        WHERE c.relname = ANY($1::text[])
        ORDER BY c.relname
      `,
      [PARTIAL_UQ_INDEXES],
    );
    expect(r.rows.map((row) => row.indexname).sort()).toEqual(
      [...PARTIAL_UQ_INDEXES].sort(),
    );
    for (const row of r.rows) {
      expect(row.indisunique).toBe(true);
      // Partial — must carry a WHERE predicate. NULL means the index covers
      // every row, which would break Q4 / Q7 / Q9 semantics.
      expect(row.pred).not.toBeNull();
    }
  });

  it("declares the canonical CHECK constraints across catalog tables (data-model.md §2-§8)", async () => {
    ensureCatalogMigrationLoaded();
    if (!env) throw new Error("env not initialized");
    // migration-test-plan.md §12 enumerates the CHECK constraint set. We
    // assert the structurally load-bearing ones here — currency pairing
    // (Q2), interval order on price_history (Q9), resolution consistency
    // on unknown_items (Q10). The full per-constraint inventory is the
    // T326 work that T330's PR completes.
    const CANONICAL_CHECKS = [
      "global_products_currency_paired",
      "tenant_products_currency_paired",
      "store_product_overrides_currency_paired",
      "price_history_interval_order",
      "price_history_price_positive",
      "unknown_items_resolved_fields_consistent",
    ];
    const r = await env.admin.query<{ conname: string }>(
      `
        SELECT conname
        FROM pg_constraint
        WHERE conname = ANY($1::text[]) AND contype = 'c'
        ORDER BY conname
      `,
      [CANONICAL_CHECKS],
    );
    expect(r.rows.map((row) => row.conname).sort()).toEqual(
      [...CANONICAL_CHECKS].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// T327 — rollback restores pre-migration state (UP → DOWN → UP cycle)
// ---------------------------------------------------------------------------

describe("T327 — rollback removes everything T326 verified", () => {
  it("DOWN removes all seven catalog tables", async () => {
    const { down: downSql } = ensureCatalogRollbackLoaded();
    if (!env) throw new Error("env not initialized");
    // The UP migration was applied by the T326 `applies cleanly` test
    // above. Apply the rollback now and re-assert the pre-migration state.
    await env.admin.query(downSql);

    const r = await env.admin.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name
      `,
      [CATALOG_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name)).toEqual([]);
  });

  it("DOWN removes the tenants.default_currency_code column (data-model.md §13)", async () => {
    ensureCatalogRollbackLoaded();
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tenants'
          AND column_name = 'default_currency_code'
      `,
    );
    expect(r.rowCount).toBe(0);
  });

  it("DOWN leaves no orphan RLS policies or indexes on the catalog table set", async () => {
    ensureCatalogRollbackLoaded();
    if (!env) throw new Error("env not initialized");
    // Each `regclass` cast on a now-absent table would throw; route through
    // `to_regclass` and filter NULLs (matches migration-test-plan §7.2).
    const orphanPolicies = await env.admin.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM pg_policies
        WHERE tablename = ANY($1::text[])
      `,
      [CATALOG_TABLES as unknown as string[]],
    );
    expect(Number(orphanPolicies.rows[0]?.count ?? "0")).toBe(0);

    const orphanIndexes = await env.admin.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])
      `,
      [CATALOG_TABLES as unknown as string[]],
    );
    expect(Number(orphanIndexes.rows[0]?.count ?? "0")).toBe(0);
  });

  it("UP → DOWN → UP cycle restores the post-migration state (idempotent forward apply)", async () => {
    const { up: upSql } = ensureCatalogRollbackLoaded();
    if (!env) throw new Error("env not initialized");
    // Re-apply the UP migration. All seven tables MUST exist again.
    await env.admin.query(upSql);

    const r = await env.admin.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name
      `,
      [CATALOG_TABLES as unknown as string[]],
    );
    expect(r.rows.map((row) => row.table_name).sort()).toEqual(
      [...CATALOG_TABLES].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// T328 — Q5: source_global_product_id is a soft reference (NO FK at all)
// ---------------------------------------------------------------------------

describe("T328 — Q5: no FK between tenant_products and global_products", () => {
  it("no foreign key exists from tenant_products to global_products in either direction", async () => {
    ensureCatalogMigrationLoaded();
    if (!env) throw new Error("env not initialized");
    // migration-test-plan.md §8.2 + §8.5: data-model.md §3 explicitly says
    // there is NO FK between these tables. The strictest reading of
    // tasks.md §5.3 ("no FK has CASCADE") is "no FK exists". We assert
    // both directions — there is no architectural reason for the reverse
    // FK either.
    const forward = await env.admin.query<{ conname: string }>(
      `
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_class cf ON cf.oid = c.confrelid
        WHERE t.relname = 'tenant_products'
          AND cf.relname = 'global_products'
          AND c.contype = 'f'
      `,
    );
    expect(forward.rowCount).toBe(0);

    const reverse = await env.admin.query<{ conname: string }>(
      `
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_class cf ON cf.oid = c.confrelid
        WHERE t.relname = 'global_products'
          AND cf.relname = 'tenant_products'
          AND c.contype = 'f'
      `,
    );
    expect(reverse.rowCount).toBe(0);
  });

  it("tenant_products.source_global_product_id exists as uuid NULL (soft provenance reference)", async () => {
    ensureCatalogMigrationLoaded();
    if (!env) throw new Error("env not initialized");
    const r = await env.admin.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `
        SELECT data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tenant_products'
          AND column_name = 'source_global_product_id'
      `,
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0]?.data_type).toBe("uuid");
    expect(r.rows[0]?.is_nullable).toBe("YES");
  });

  it("hard-deleting the referenced global product leaves the tenant product intact (no cascade behavior)", async () => {
    ensureCatalogMigrationLoaded();
    if (!env) throw new Error("env not initialized");
    // migration-test-plan.md §8.4 — copy-on-adopt-snapshot guarantee:
    // platform-side delete must NOT cascade or constrain tenant data.
    // The exact column/seed shape depends on T330's authored schema;
    // when T330 lands, replace these placeholders with real fixture
    // INSERTs that match the data-model.md §2/§3 column lists.
    //
    // This assertion is kept structural: pull the column lists from
    // information_schema, find the PK + minimal-NOT-NULL set on both
    // tables, seed via parameterized INSERT, hard-DELETE the global row,
    // and re-SELECT the tenant row.
    //
    // RED today: data-model.md §3 declares `source_global_product_id` is
    // intentionally without an FK, but until T330 authors the migration,
    // this test cannot run. After T330 lands, T330's PR will replace this
    // structural skeleton with a concrete seed/delete/select round-trip
    // pinned to the authored column set.
    throw new Error(
      "T330 must author the soft-reference behavioral fixture: seed a global product + tenant product with matching source_global_product_id, DELETE the global, re-SELECT the tenant, assert the tenant row survives.",
    );
  });
});

// ---------------------------------------------------------------------------
// T329 — Q1: every money column is numeric(19,4) with a non-negative CHECK
// ---------------------------------------------------------------------------

describe("T329 — Q1: money columns are numeric(19,4) with non-negative CHECK", () => {
  it.each(MONEY_COLUMNS)(
    "$table.$column is numeric(19, 4) with the expected nullability",
    async ({ table, column, nullable }) => {
      ensureCatalogMigrationLoaded();
      if (!env) throw new Error("env not initialized");
      const r = await env.admin.query<{
        data_type: string;
        numeric_precision: number | null;
        numeric_scale: number | null;
        is_nullable: string;
      }>(
        `
          SELECT data_type, numeric_precision, numeric_scale, is_nullable
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_name = $2
        `,
        [table, column],
      );
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]?.data_type).toBe("numeric");
      // migration-test-plan.md §16-R6: guard against unbounded numeric —
      // `numeric` with no (p, s) reports NULL precision and would silently
      // pass any `precision === 19 && scale === 4` check that compared
      // NULL to NULL. Explicit non-null guard catches that.
      expect(r.rows[0]?.numeric_precision).not.toBeNull();
      expect(r.rows[0]?.numeric_precision).toBe(19);
      expect(r.rows[0]?.numeric_scale).toBe(4);
      expect(r.rows[0]?.is_nullable).toBe(nullable ? "YES" : "NO");
    },
  );

  it.each(MONEY_COLUMNS)(
    "$table.$column has a CHECK constraint enforcing the column is >= 0",
    async ({ table, column }) => {
      ensureCatalogMigrationLoaded();
      if (!env) throw new Error("env not initialized");
      // migration-test-plan.md §9.3 / §12: every money column must carry a
      // named CHECK constraint with predicate referencing the column and
      // a `>= 0` test. Constraint naming is left to T330 (see
      // migration-test-plan.md §17-Q2 for suggested names); we match
      // structurally by inspecting `pg_get_constraintdef` output.
      const r = await env.admin.query<{
        conname: string;
        def: string;
      }>(
        `
          SELECT conname, pg_get_constraintdef(oid) AS def
          FROM pg_constraint
          WHERE conrelid = ($1::regclass)
            AND contype = 'c'
            AND pg_get_constraintdef(oid) ILIKE '%' || $2 || '%'
            AND pg_get_constraintdef(oid) ILIKE '%>=%0%'
        `,
        [table, column],
      );
      expect(r.rowCount).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(MONEY_COLUMNS)(
    "$table rejects negative values inserted into $column at the row level",
    async ({ table, column, nullable: _nullable }) => {
      ensureCatalogMigrationLoaded();
      if (!env) throw new Error("env not initialized");
      // migration-test-plan.md §9.4: live exercise of the predicate. The
      // exact set of NOT-NULL companion columns depends on the authored
      // schema (T330), so we cannot stage a complete INSERT here without
      // pinning it to a specific column shape that does not yet exist.
      //
      // The structural assertion above (`pg_get_constraintdef ... >= 0`)
      // proves the constraint EXISTS. T330's PR replaces this stub with
      // a real `INSERT ... VALUES (..., -0.01, ...)` round-trip whose
      // companion columns match the authored schema.
      throw new Error(
        `T330 must author a live INSERT round-trip for ${table}.${column} = -0.01 and assert the CHECK fires. Companion NOT-NULL columns depend on T330's authored schema.`,
      );
    },
  );
});
