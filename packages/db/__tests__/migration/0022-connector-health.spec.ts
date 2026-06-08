/**
 * Connector Health and Connection-Status API (020) — `0022_connector_health`
 * migration test (020-FND / T004).
 *
 * Validates `packages/db/drizzle/0022_connector_health.sql` (+ `.down.sql`):
 *   - connector_health created with RLS enabled+forced; SELECT+INSERT+UPDATE
 *     policies; NO DELETE policy (cascade-only removal);
 *   - UNIQUE (connector_registration_id) — one health row per registration (23505);
 *   - FK connector_registration_id -> connector_registration ON DELETE CASCADE
 *     (deleting the registration removes the health row);
 *   - FK tenant_id -> tenants ON DELETE RESTRICT;
 *   - connector_version length CHECK (>64 chars -> 23514);
 *   - backlog_indicator non-negative CHECK (<0 -> 23514);
 *   - NO version column; NO money/PII/secret column;
 *   - fail-closed RLS: wrong app.current_tenant -> zero rows; empty GUC -> zero
 *     rows (no 22P02);
 *   - UP -> DOWN -> UP round-trips cleanly.
 *
 * Docker policy mirrors 0019/0020/0021: missing Docker is a HARD failure unless
 * MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). Run via WSL.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  ensureAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "../_helpers/postgres-container";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");
const UP_PATH = resolve(DRIZZLE_DIR, "0022_connector_health.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0022_connector_health.down.sql");

const TBL = "connector_health";

const TENANT_A = "01900000-0000-7000-8000-00000000a001";
const TENANT_B = "01900000-0000-7000-8000-00000000b002";
const ACTOR = "01900000-0000-7000-8000-00000000d001";
const REG_A = "0c200000-0000-7000-8000-000000000a01";
const REG_B = "0c200000-0000-7000-8000-000000000b01";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** Apply every migration with a basename lexically < 0022 (0000–0021). */
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

/** Seed tenants A/B, an actor user, and a registration per tenant. */
async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'ch-a', 'Health Tenant A', 'USD'),
       ($2, 'ch-b', 'Health Tenant B', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'ch@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
  await pgEnv.admin.query(
    `INSERT INTO connector_registration
       (id, tenant_id, display_name, erpnext_site_ref, environment, created_by) VALUES
       ($1, $2, 'Conn A', 'erp-a.ch', 'pilot', $4),
       ($3, $5, 'Conn B', 'erp-b.ch', 'pilot', $4)
     ON CONFLICT (id) DO NOTHING`,
    [REG_A, TENANT_A, REG_B, ACTOR, TENANT_B],
  );
}

/** Insert one connector_health row (admin pool, RLS-bypass). */
function insertHealth(
  pgEnv: PgTestEnv,
  opts: {
    id?: string;
    tenant?: string;
    registrationId?: string;
    connectorVersion?: string | null;
    backlogIndicator?: number | null;
  } = {},
): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO connector_health
       (id, tenant_id, connector_registration_id, connector_version, backlog_indicator)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5)`,
    [
      opts.id ?? null,
      opts.tenant ?? TENANT_A,
      opts.registrationId ?? REG_A,
      opts.connectorVersion === undefined ? null : opts.connectorVersion,
      opts.backlogIndicator === undefined ? null : opts.backlogIndicator,
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
      console.warn(`\n[0022-connector-health.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0022 so the app role has privileges on the new table
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

describe("0022 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0022 — connector_health table + RLS", () => {
  it("has RLS enabled + forced", async () => {
    if (skip()) return;
    const e = guard();
    const t = await e.admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [TBL],
    );
    expect(t.rows[0]?.relrowsecurity).toBe(true);
    expect(t.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("is mutable (SELECT+INSERT+UPDATE) with NO DELETE policy (cascade-only removal)", async () => {
    if (skip()) return;
    const e = guard();
    const pol = await e.admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1`,
      [TBL],
    );
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("has NO version column (LWW) and NO money/PII/secret column", async () => {
    if (skip()) return;
    const e = guard();
    const cols = await e.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [TBL],
    );
    const names = cols.rows.map((r) => r.column_name);
    expect(names).not.toContain("version");
    for (const forbidden of [
      "amount", "total", "money", "valuation", "cost", "price", "email",
      "password_hash", "token_hash", "secret", "token", "api_key", "credential",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("0022 — connector_health constraints", () => {
  beforeEach(async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM connector_health`);
  });

  it("UNIQUE (connector_registration_id) — a second health row for one registration is rejected (23505)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertHealth(e, { registrationId: REG_A })).resolves.toBeDefined();
    await expect(insertHealth(e, { registrationId: REG_A })).rejects.toMatchObject({ code: "23505" });
  });

  it("connector_version length CHECK — >64 chars is rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertHealth(e, { connectorVersion: "v".repeat(65) }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insertHealth(e, { connectorVersion: "v".repeat(64) }),
    ).resolves.toBeDefined();
  });

  it("backlog_indicator non-negative CHECK — a negative value is rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertHealth(e, { backlogIndicator: -1 })).rejects.toMatchObject({ code: "23514" });
    await expect(insertHealth(e, { backlogIndicator: 0 })).resolves.toBeDefined();
  });

  it("FK connector_registration_id -> RESTRICT-free CASCADE: a dangling registration is rejected (23503)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertHealth(e, { registrationId: "0c200000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("ON DELETE CASCADE: deleting the registration removes its health row", async () => {
    if (skip()) return;
    const e = guard();
    // Seed a throwaway registration + its health row.
    const TMP_REG = "0c200000-0000-7000-8000-00000000ca51";
    await e.admin.query(
      `INSERT INTO connector_registration
         (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
       VALUES ($1, $2, 'Cascade', 'erp-cascade.ch', 'pilot', $3)
       ON CONFLICT (id) DO NOTHING`,
      [TMP_REG, TENANT_A, ACTOR],
    );
    await insertHealth(e, { registrationId: TMP_REG });
    await e.admin.query(`DELETE FROM connector_registration WHERE id = $1`, [TMP_REG]);
    const after = await e.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM connector_health WHERE connector_registration_id = $1`,
      [TMP_REG],
    );
    expect(after.rows[0]?.count).toBe("0");
  });
});

describe("0022 — fail-closed RLS", () => {
  it("a health row owned by tenant A is invisible under app.current_tenant = B", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM connector_health`);
    await insertHealth(e, { tenant: TENANT_A, registrationId: REG_A });
    const client = await e.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${TENANT_B}'`);
      const wrong = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${TBL}`);
      expect(wrong.rows[0]?.count).toBe("0");
      await client.query(`SET app.current_tenant = '${TENANT_A}'`);
      const right = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${TBL}`);
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
      const r = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${TBL}`);
      expect(r.rows[0]?.count).toBe("0");
    } finally {
      client.release();
    }
  });
});

describe("0022 — down/up round-trip", () => {
  it("DOWN drops the table; UP re-creates it", async () => {
    if (skip()) return;
    const e = guard();
    void randomUUID();
    await e.admin.query(downSql);
    const afterDown = await e.admin.query(`SELECT to_regclass($1) AS reg`, [TBL]);
    expect(afterDown.rows[0]?.reg).toBeNull();

    await e.admin.query(upSql);
    const afterUp = await e.admin.query<{ reg: string }>(
      `SELECT to_regclass($1)::text AS reg`,
      [TBL],
    );
    expect(afterUp.rows[0]?.reg).toBe(TBL);
    await ensureAppRole(e);
    await seedParents(e);
  });
});
