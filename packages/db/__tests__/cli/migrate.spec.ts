/**
 * T065 — Migration runner CLI spec.
 *
 * Spawns `node packages/db/dist/cli/migrate.js` as a real child process so
 * we test the script's actual exit codes, argv parsing, and effects on the
 * live database — not module-level stubs.
 *
 * Boots its own postgres:16-alpine container (separate from migration.spec.ts
 * because the CLI test must control ledger state precisely).
 */
import { spawn, type SpawnOptions } from "node:child_process";
import { resolve } from "node:path";
import { startPgEnv, stopPgEnv, type PgTestEnv } from "../_helpers/postgres-container";

const CLI_PATH = resolve(__dirname, "..", "..", "dist", "cli", "migrate.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<CliResult> {
  return new Promise((resolveResult, rejectResult) => {
    const opts: SpawnOptions = {
      env: { ...process.env, ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
    };
    const child = spawn(process.execPath, [CLI_PATH, ...args], opts);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", rejectResult);
    child.on("close", (code) =>
      resolveResult({ code: code ?? -1, stdout, stderr }),
    );
  });
}

let env: PgTestEnv | null = null;

beforeAll(async () => {
  try {
    env = await startPgEnv();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[cli/migrate.spec] Docker NOT AVAILABLE — skipping. Reason: ${message}\n`,
      );
      return;
    }
    throw new Error(`Container start failed: ${message}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

describe("data-pulse-migrate CLI", () => {
  // --- argv / env validation paths (do not need a fresh DB) ----------------

  it("exits 3 when no subcommand is given", async () => {
    const r = await runCli([], { DATABASE_URL: env!.adminUri });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/usage: data-pulse-migrate/);
  });

  it("exits 3 on an unknown subcommand", async () => {
    const r = await runCli(["bogus"], { DATABASE_URL: env!.adminUri });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/unknown subcommand/);
  });

  it("exits 2 when DATABASE_URL is missing", async () => {
    // Build an env that explicitly removes DATABASE_URL.
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k !== "DATABASE_URL" && typeof v === "string") cleanEnv[k] = v;
    }
    const r = await new Promise<CliResult>((resolveResult) => {
      const child = spawn(process.execPath, [CLI_PATH, "up"], {
        env: cleanEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
      child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
      child.on("close", (code) =>
        resolveResult({ code: code ?? -1, stdout, stderr }),
      );
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/DATABASE_URL/);
  });

  // --- Live up / down / status (state shared with the rest of this block) -

  /**
   * Expected migration ledger. Update this list as new migrations land —
   * the rest of the suite derives every other assertion from it.
   *
   * Order matches lex-sorted filenames in `packages/db/drizzle/`, which is
   * the order the runner applies (and the inverse order it rolls back).
   */
  const EXPECTED_MIGRATIONS = [
    "0000_initial",
    "0001_pos_operator_identity",
    "0002_shifts",
    "0003_session_active_store_tenant_invariant",
    "0004_audit_retention_marker",
    "0005_audit_retention_privileges",
    "0006_outbox_events",
    "0007_catalog",
    "0008_catalog_store_read_isolation",
    "0009_catalog_store_empty_guc_fix",
    "0010_catalog_tenant_empty_guc_fix",
    "0011_catalog_store_carveout_sentinel",
    "0012_sales",
    "0013_store_timezone",
    "0014_inventory",
    "0015_pos_catalog_read_down",
    "0016_inventory_unit_guard",
  ] as const;

  const LATEST_MIGRATION = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 1]!;
  const SECOND_LATEST_MIGRATION = EXPECTED_MIGRATIONS[EXPECTED_MIGRATIONS.length - 2]!;

  it("up applies all pending migrations and writes the ledger", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["up"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    for (const id of EXPECTED_MIGRATIONS) {
      expect(r.stdout).toMatch(new RegExp(`up: applying ${id}`));
      expect(r.stdout).toMatch(new RegExp(`up: applied ${id}`));
    }

    const ledger = await env.admin.query<{ id: string }>(
      "SELECT id FROM _drizzle_migrations ORDER BY id ASC",
    );
    expect(ledger.rows.map((row) => row.id)).toEqual([...EXPECTED_MIGRATIONS]);

    const tables = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    `, [["tenants", "devices", "shifts"]]);
    expect(tables.rows[0]?.count).toBe("3");
  });

  it("up is idempotent on a second run", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["up"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no pending migrations/);
    const ledger = await env.admin.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM _drizzle_migrations",
    );
    expect(ledger.rows[0]?.count).toBe(String(EXPECTED_MIGRATIONS.length));
  });

  it(`status reports applied=${EXPECTED_MIGRATIONS.length}, pending=0`, async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["status"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(
      new RegExp(`status: ${EXPECTED_MIGRATIONS.length} applied, 0 pending`),
    );
    for (const id of EXPECTED_MIGRATIONS) {
      expect(r.stdout).toMatch(new RegExp(`applied  ${id}`));
    }
  });

  it(
    "down rolls back the most recent migration only and updates the ledger",
    async () => {
      if (!env) throw new Error("env not initialized");
      // Runner.down rolls back exactly one migration per call (the most
      // recent applied). With the full chain applied, the first down rolls
      // back LATEST_MIGRATION, leaving the rest in the ledger.
      const r = await runCli(["down"], { DATABASE_URL: env.adminUri });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`down: rolled back ${LATEST_MIGRATION}`));

      const ledger = await env.admin.query<{ id: string }>(
        "SELECT id FROM _drizzle_migrations ORDER BY id ASC",
      );
      expect(ledger.rows.map((row) => row.id)).toEqual(
        EXPECTED_MIGRATIONS.slice(0, -1),
      );

      // Rolling back the latest migration does not touch the catalog: all seven
      // catalog tables introduced by 0007 are still present afterwards.
      const catalogCount = await env.admin.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      `, [[
        "global_products",
        "tenant_products",
        "tenant_product_categories",
        "store_product_overrides",
        "product_aliases",
        "price_history",
        "unknown_items",
      ]]);
      expect(catalogCount.rows[0]?.count).toBe("7");

      // outbox_events from 0006 is still present.
      const outboxTable = await env.admin.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'outbox_events'
      `);
      expect(outboxTable.rows[0]?.count).toBe("1");

      // retention_marked_at column is still present.
      const column = await env.admin.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'audit_events'
          AND column_name = 'retention_marked_at'
      `);
      expect(column.rows[0]?.count).toBe("1");

      // The 0003 trigger, shifts, and foundation tables are still here.
      const trigger = await env.admin.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM pg_trigger
        WHERE tgname = 'sessions_active_store_tenant_check'
      `);
      expect(trigger.rows[0]?.count).toBe("1");

      const remaining = await env.admin.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
      `, [["tenants", "users", "devices", "shifts"]]);
      expect(remaining.rows[0]?.count).toBe("4");
    },
  );

  it("up after down re-applies the rolled-back migration", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["up"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`up: applying ${LATEST_MIGRATION}`));
    // Re-applying the latest migration leaves all seven catalog tables from
    // 0007 intact; the catalog set is unaffected by the latest migration.
    const catalogCount = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    `, [[
      "global_products",
      "tenant_products",
      "tenant_product_categories",
      "store_product_overrides",
      "product_aliases",
      "price_history",
      "unknown_items",
    ]]);
    expect(catalogCount.rows[0]?.count).toBe("7");
  });

  it(
    "concurrent up calls serialize via pg_advisory_lock",
    async () => {
      if (!env) throw new Error("env not initialized");

      // Nothing to do — both should succeed quickly with "no pending"
      // because we're already at head from the previous test. We're
      // checking that the lock doesn't deadlock or error, not that it
      // does meaningful work.
      const [a, b] = await Promise.all([
        runCli(["up"], { DATABASE_URL: env.adminUri }),
        runCli(["up"], { DATABASE_URL: env.adminUri }),
      ]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
    },
  );

  it("down repeatedly fully unwinds the chain", async () => {
    if (!env) throw new Error("env not initialized");
    // The previous `up after down` test left the full chain applied. Each
    // `down` rolls back the most recent migration; we iterate from the
    // tail of EXPECTED_MIGRATIONS down to 0000_initial, then assert one
    // extra `down` reports nothing left.
    for (const id of [...EXPECTED_MIGRATIONS].reverse()) {
      const r = await runCli(["down"], { DATABASE_URL: env.adminUri });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`down: rolled back ${id}`));
    }

    const empty = await runCli(["down"], { DATABASE_URL: env.adminUri });
    expect(empty.code).toBe(0);
    expect(empty.stdout).toMatch(/down: nothing to roll back/);

    // SECOND_LATEST_MIGRATION is referenced so the symbol stays alive even if
    // a future test drops down to it explicitly; no-op assertion otherwise.
    expect(SECOND_LATEST_MIGRATION).toBeTruthy();
  });
});
