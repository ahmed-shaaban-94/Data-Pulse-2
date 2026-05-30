/**
 * 008 US2 (FR-023) — store-timezone migration verification under Testcontainers.
 *
 * Validates `packages/db/drizzle/0013_store_timezone.sql` (+ its `.down.sql`):
 *   - adds `stores.timezone` as TEXT NOT NULL DEFAULT 'UTC';
 *   - existing/new store rows backfill to 'UTC' (no behavior change until an
 *     operator sets a real zone);
 *   - the migration applies cleanly and rolls back cleanly (UP -> DOWN -> UP).
 *
 * Docker policy (matches `0012-sales.spec.ts`): a missing Docker runtime is a
 * HARD failure unless `MIGRATION_TEST_ALLOW_SKIP=1`. CI MUST NOT set it.
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
const TZ_UP_PATH = resolve(DRIZZLE_DIR, "0013_store_timezone.sql");
const TZ_DOWN_PATH = resolve(DRIZZLE_DIR, "0013_store_timezone.down.sql");

const TENANT_ID = "0e000000-0000-7000-8000-0000000013a1";
const STORE_ID = "0e000000-0000-7000-8000-0000000013b1";

let env: PgTestEnv | null = null;
let dockerSkipReason = "";
let upSql: string | null = null;
let downSql: string | null = null;

/** Apply every UP migration that sorts strictly before 0013_store_timezone.sql. */
async function applyPreMigrations(pgEnv: PgTestEnv): Promise<void> {
  const target = basename(TZ_UP_PATH);
  const upFiles = readdirSync(DRIZZLE_DIR)
    .filter((n) => /^\d{4}_.+\.sql$/.test(n) && !n.endsWith(".down.sql"))
    .filter((n) => n.localeCompare(target) < 0)
    .sort();
  for (const name of upFiles) {
    await pgEnv.admin.query(readFileSync(resolve(DRIZZLE_DIR, name), "utf8"));
  }
  await ensureAppRole(pgEnv);
}

async function timezoneColumn(): Promise<{
  data_type: string;
  is_nullable: string;
  column_default: string | null;
} | null> {
  if (!env) throw new Error("env not initialized");
  const r = await env.admin.query<{
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'stores'
        AND column_name = 'timezone'`,
  );
  return r.rows[0] ?? null;
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreMigrations(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0013-store-timezone.spec] Docker NOT AVAILABLE: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  if (!existsSync(TZ_UP_PATH) || !existsSync(TZ_DOWN_PATH)) {
    throw new Error("0013 migration up/down file missing");
  }
  upSql = readFileSync(TZ_UP_PATH, "utf8");
  downSql = readFileSync(TZ_DOWN_PATH, "utf8");
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function ensureLoaded(): { up: string; down: string } {
  if (!env) throw new Error(`Skipped (no Docker): ${dockerSkipReason}`);
  if (upSql === null || downSql === null) throw new Error("0013 SQL not loaded");
  return { up: upSql, down: downSql };
}

describe("0013_store_timezone — adds stores.timezone", () => {
  it("pre-migration: stores has no timezone column", async () => {
    if (!env) throw new Error("env not initialized");
    expect(await timezoneColumn()).toBeNull();
  });

  it("applies cleanly: timezone is TEXT NOT NULL DEFAULT 'UTC'", async () => {
    const { up } = ensureLoaded();
    await env!.admin.query(up);
    const col = await timezoneColumn();
    expect(col).not.toBeNull();
    expect(col?.data_type).toBe("text");
    expect(col?.is_nullable).toBe("NO");
    expect(col?.column_default).toMatch(/'UTC'/);
  });

  it("a newly inserted store backfills to 'UTC' (no timezone supplied)", async () => {
    if (!env) throw new Error("env not initialized");
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name, default_currency_code)
       VALUES ($1, 'tz-spec', 'TZ Spec Tenant', 'USD')`,
      [TENANT_ID],
    );
    await env.admin.query(
      `INSERT INTO stores (id, tenant_id, code, name)
       VALUES ($1, $2, 'TZ1', 'TZ Store')`,
      [STORE_ID, TENANT_ID],
    );
    const r = await env.admin.query<{ timezone: string }>(
      `SELECT timezone FROM stores WHERE id = $1`,
      [STORE_ID],
    );
    expect(r.rows[0]?.timezone).toBe("UTC");
  });

  it("rolls back and re-applies cleanly (UP -> DOWN -> UP)", async () => {
    const { up, down } = ensureLoaded();
    await env!.admin.query(down);
    expect(await timezoneColumn()).toBeNull();
    await env!.admin.query(up);
    const col = await timezoneColumn();
    expect(col?.is_nullable).toBe("NO");
    expect(col?.column_default).toMatch(/'UTC'/);
  });
});
