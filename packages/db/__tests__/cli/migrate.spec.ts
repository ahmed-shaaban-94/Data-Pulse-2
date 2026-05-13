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

  it("up applies all pending migrations and writes the ledger", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["up"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/up: applying 0000_initial/);
    expect(r.stdout).toMatch(/up: applied 0000_initial/);
    expect(r.stdout).toMatch(/up: applying 0001_pos_operator_identity/);
    expect(r.stdout).toMatch(/up: applied 0001_pos_operator_identity/);
    expect(r.stdout).toMatch(/up: applying 0002_shifts/);
    expect(r.stdout).toMatch(/up: applied 0002_shifts/);
    expect(r.stdout).toMatch(/up: applying 0003_session_active_store_tenant_invariant/);
    expect(r.stdout).toMatch(/up: applied 0003_session_active_store_tenant_invariant/);

    const ledger = await env.admin.query<{ id: string }>(
      "SELECT id FROM _drizzle_migrations ORDER BY id ASC",
    );
    expect(ledger.rows.map((row) => row.id)).toEqual([
      "0000_initial",
      "0001_pos_operator_identity",
      "0002_shifts",
      "0003_session_active_store_tenant_invariant",
    ]);

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
    expect(ledger.rows[0]?.count).toBe("4");
  });

  it("status reports applied=4, pending=0", async () => {
    if (!env) throw new Error("env not initialized");
    const r = await runCli(["status"], { DATABASE_URL: env.adminUri });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/status: 4 applied, 0 pending/);
    expect(r.stdout).toMatch(/applied  0000_initial/);
    expect(r.stdout).toMatch(/applied  0001_pos_operator_identity/);
    expect(r.stdout).toMatch(/applied  0002_shifts/);
    expect(r.stdout).toMatch(/applied  0003_session_active_store_tenant_invariant/);
  });

  it(
    "down rolls back the most recent migration only and updates the ledger",
    async () => {
      if (!env) throw new Error("env not initialized");
      // Runner.down rolls back exactly one migration per call (the most
      // recent applied). With 4 migrations applied, the first down rolls
      // back 0003_session_active_store_tenant_invariant, leaving 0000,
      // 0001, and 0002 in the ledger.
      const r = await runCli(["down"], { DATABASE_URL: env.adminUri });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/down: rolled back 0003_session_active_store_tenant_invariant/);

      const ledger = await env.admin.query<{ id: string }>(
        "SELECT id FROM _drizzle_migrations ORDER BY id ASC",
      );
      expect(ledger.rows.map((row) => row.id)).toEqual([
        "0000_initial",
        "0001_pos_operator_identity",
        "0002_shifts",
      ]);

      // Trigger is gone after 0003 rollback...
      const trigger = await env.admin.query<{ count: string }>(`
        SELECT COUNT(*)::text AS count FROM pg_trigger
        WHERE tgname = 'sessions_active_store_tenant_check'
      `);
      expect(trigger.rows[0]?.count).toBe("0");

      // ...but shifts and foundation tables are still here (0002 not rolled back).
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
    expect(r.stdout).toMatch(/up: applying 0003_session_active_store_tenant_invariant/);
    const trigger = await env.admin.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM pg_trigger
      WHERE tgname = 'sessions_active_store_tenant_check'
    `);
    expect(trigger.rows[0]?.count).toBe("1");
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
    // First down: rolls back 0003 (most recent after the previous up restored it).
    const first = await runCli(["down"], { DATABASE_URL: env.adminUri });
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/down: rolled back 0003_session_active_store_tenant_invariant/);

    // Second down: rolls back 0002.
    const second = await runCli(["down"], { DATABASE_URL: env.adminUri });
    expect(second.code).toBe(0);
    expect(second.stdout).toMatch(/down: rolled back 0002_shifts/);

    // Third down: rolls back 0001.
    const third = await runCli(["down"], { DATABASE_URL: env.adminUri });
    expect(third.code).toBe(0);
    expect(third.stdout).toMatch(/down: rolled back 0001_pos_operator_identity/);

    // Fourth down: rolls back 0000.
    const fourth = await runCli(["down"], { DATABASE_URL: env.adminUri });
    expect(fourth.code).toBe(0);
    expect(fourth.stdout).toMatch(/down: rolled back 0000_initial/);

    // Fifth down: nothing left.
    const fifth = await runCli(["down"], { DATABASE_URL: env.adminUri });
    expect(fifth.code).toBe(0);
    expect(fifth.stdout).toMatch(/down: nothing to roll back/);
  });
});
