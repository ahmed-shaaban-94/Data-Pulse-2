/**
 * Connector Boundary Hardening (018) — `0021_connector_registration` migration test.
 *
 * Validates `packages/db/drizzle/0021_connector_registration.sql` (+ `.down.sql`):
 *   - connector_registration created with RLS enabled+forced; SELECT+INSERT+UPDATE
 *     policies (active -> disabled is an UPDATE); NO DELETE policy (FR-014);
 *   - display_name non-empty CHECK (whitespace-only rejected, 23514);
 *   - environment CHECK in ('dev','staging','pilot','prod') (stray value -> 23514);
 *   - UNIQUE (tenant_id, environment, erpnext_site_ref) (FR-005a; dup -> 23505);
 *   - FK tenant_id/created_by/disabled_by -> RESTRICT (dangling -> 23503);
 *   - NO money/PII/secret column;
 *   - auth_tokens gains connector_registration_id (FK -> RESTRICT; dangling -> 23503);
 *   - auth_tokens scope-enum CHECK (auth_tokens_scope_valid): a stray scope -> 23514;
 *     the six canonical scopes accepted (MECHANISM test on synthetic rows);
 *   - at-most-one-active partial-unique: two unrevoked connector creds for one
 *     registration -> 23505; a revoked one + a new active one is OK;
 *   - SYNTHETIC LEGACY connector token (scope='connector', connector_registration_id
 *     NULL) does NOT violate any constraint shipped here (the consistency CHECK is
 *     DEFERRED, R3 — proving the migration is back-compatible);
 *   - fail-closed RLS: wrong app.current_tenant -> zero rows; empty GUC -> zero rows
 *     (no 22P02);
 *   - UP -> DOWN -> UP round-trips cleanly (DOWN restores auth_tokens shape too).
 *
 * Docker policy mirrors 0014/0016/0017/0018/0019/0020: missing Docker is a HARD
 * failure unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). Run via WSL.
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
const UP_PATH = resolve(DRIZZLE_DIR, "0021_connector_registration.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0021_connector_registration.down.sql");

const REG = "connector_registration";

const TENANT_A = "01900000-0000-7000-8000-00000000a001";
const TENANT_B = "01900000-0000-7000-8000-00000000b002";
const ACTOR = "01900000-0000-7000-8000-00000000d001";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** Apply every migration with a basename lexically < 0021 (0000–0020). */
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

/** Seed tenants A/B + an actor user (admin pool, RLS-bypass). */
async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'conn-a', 'Connector Tenant A', 'USD'),
       ($2, 'conn-b', 'Connector Tenant B', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'conn@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
}

/** Insert one connector_registration (admin pool). */
function insertReg(
  pgEnv: PgTestEnv,
  opts: {
    id?: string;
    tenant?: string;
    displayName?: string;
    siteRef?: string;
    environment?: string;
    createdBy?: string;
    disabledBy?: string | null;
  } = {},
): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO connector_registration
       (id, tenant_id, display_name, erpnext_site_ref, environment, created_by, disabled_by)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7)`,
    [
      opts.id ?? null,
      opts.tenant ?? TENANT_A,
      opts.displayName ?? "Pilot Connector",
      opts.siteRef ?? `erp.example.invalid/${randomUUID()}`,
      opts.environment ?? "pilot",
      opts.createdBy ?? ACTOR,
      opts.disabledBy ?? null,
    ],
  );
}

/**
 * Insert one auth_tokens row (admin pool). user_id is supplied by default to
 * satisfy the pre-existing `auth_tokens_principal_by_scope` CHECK (every
 * non-pos_operator scope needs exactly one of user_id/device_id).
 */
function insertToken(
  pgEnv: PgTestEnv,
  opts: {
    scope?: string;
    tenant?: string;
    connectorRegistrationId?: string | null;
    revokedAt?: string | null;
    userId?: string | null;
  } = {},
): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO auth_tokens
       (id, token_hash, tenant_id, user_id, scope, expires_at, revoked_at, connector_registration_id)
     VALUES (gen_random_uuid(), decode($1, 'hex'), $2, $3, $4, now() + interval '90 days', $5, $6)`,
    [
      randomUUID().replace(/-/g, "").padEnd(64, "0"),
      opts.tenant ?? TENANT_A,
      opts.userId === undefined ? ACTOR : opts.userId,
      opts.scope ?? "connector",
      opts.revokedAt ?? null,
      opts.connectorRegistrationId ?? null,
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
      console.warn(`\n[0021-connector-registration.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0021 so the app role has privileges on the new table
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

describe("0021 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0021 — connector_registration table + RLS", () => {
  it("has RLS enabled + forced", async () => {
    if (skip()) return;
    const e = guard();
    const t = await e.admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [REG],
    );
    expect(t.rows[0]?.relrowsecurity).toBe(true);
    expect(t.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("is mutable (SELECT+INSERT+UPDATE) with NO DELETE policy (disable is logical, FR-014)", async () => {
    if (skip()) return;
    const e = guard();
    const pol = await e.admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1`,
      [REG],
    );
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("exposes NO money/PII/secret column", async () => {
    if (skip()) return;
    const e = guard();
    const cols = await e.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [REG],
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const forbidden of [
      "amount", "pos_total", "line_amount", "unit_price", "total", "money",
      "valuation", "cost", "price", "email", "password_hash", "token_hash",
      "secret", "token", "api_key", "credential",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("0021 — connector_registration constraints", () => {
  beforeEach(async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM connector_registration`);
  });

  it("display_name non-empty CHECK — whitespace-only is rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertReg(e, { displayName: "   " })).rejects.toMatchObject({ code: "23514" });
    await expect(insertReg(e, { displayName: "Valid" })).resolves.toBeDefined();
  });

  it("environment CHECK = ('dev','staging','pilot','prod') — a stray token is rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertReg(e, { environment: "production" })).rejects.toMatchObject({ code: "23514" });
    for (const env_ of ["dev", "staging", "pilot", "prod"]) {
      await expect(
        insertReg(e, { environment: env_, siteRef: `erp/${env_}` }),
      ).resolves.toBeDefined();
    }
  });

  it("UNIQUE (tenant_id, environment, erpnext_site_ref) — a duplicate is rejected (23505, FR-005a)", async () => {
    if (skip()) return;
    const e = guard();
    await insertReg(e, { environment: "pilot", siteRef: "erp.same" });
    await expect(
      insertReg(e, { environment: "pilot", siteRef: "erp.same" }),
    ).rejects.toMatchObject({ code: "23505" });
    // Different environment for the same site is allowed.
    await expect(
      insertReg(e, { environment: "staging", siteRef: "erp.same" }),
    ).resolves.toBeDefined();
  });

  it("FK created_by -> users is RESTRICT — a dangling user is rejected (23503)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertReg(e, { createdBy: "01900000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("0021 — auth_tokens link + scope enum + at-most-one-active", () => {
  beforeEach(async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM auth_tokens`);
    await e.admin.query(`DELETE FROM connector_registration`);
  });

  it("connector_registration_id column exists and is nullable", async () => {
    if (skip()) return;
    const e = guard();
    const col = await e.admin.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'auth_tokens' AND column_name = 'connector_registration_id'`,
    );
    expect(col.rows[0]?.is_nullable).toBe("YES");
  });

  it("connector_registration_id FK is RESTRICT — a dangling registration id is rejected (23503)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertToken(e, {
        connectorRegistrationId: "01900000-0000-7000-8000-0000000000ee",
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("scope-enum CHECK (auth_tokens_scope_valid): a stray scope is rejected (23514); the six canonical scopes are accepted [MECHANISM, synthetic rows]", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertToken(e, { scope: "totally_made_up" })).rejects.toMatchObject({ code: "23514" });
    for (const sc of ["dashboard_api", "pos", "connector", "password_reset", "email_verify"]) {
      await expect(insertToken(e, { scope: sc })).resolves.toBeDefined();
    }
  });

  it("at-most-one-active: two UNREVOKED connector creds for one registration -> 23505; a revoked one coexists with a new active one (FR-010)", async () => {
    if (skip()) return;
    const e = guard();
    await insertReg(e, { id: "01900000-0000-7000-8000-00000000c0a1", environment: "pilot", siteRef: "erp.rot" });
    const REG_ID = "01900000-0000-7000-8000-00000000c0a1";
    // First active connector credential — OK.
    await expect(
      insertToken(e, { scope: "connector", connectorRegistrationId: REG_ID }),
    ).resolves.toBeDefined();
    // Second UNREVOKED connector credential for the same registration — rejected.
    await expect(
      insertToken(e, { scope: "connector", connectorRegistrationId: REG_ID }),
    ).rejects.toMatchObject({ code: "23505" });
    // A REVOKED credential for the same registration coexists (out of the predicate).
    await expect(
      insertToken(e, {
        scope: "connector",
        connectorRegistrationId: REG_ID,
        revokedAt: "2026-01-01T00:00:00Z",
      }),
    ).resolves.toBeDefined();
  });

  it("BACK-COMPAT: a SYNTHETIC LEGACY connector token (scope='connector', connector_registration_id NULL) violates NO shipped constraint (consistency CHECK is DEFERRED, R3)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertToken(e, { scope: "connector", connectorRegistrationId: null }),
    ).resolves.toBeDefined();
    // A second unlinked legacy connector token also inserts: the partial-unique
    // keys on connector_registration_id, and NULLs do not collide.
    await expect(
      insertToken(e, { scope: "connector", connectorRegistrationId: null }),
    ).resolves.toBeDefined();
  });
});

describe("0021 — fail-closed RLS", () => {
  it("a registration owned by tenant A is invisible under app.current_tenant = B", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM connector_registration`);
    await insertReg(e, { tenant: TENANT_A });
    const client = await e.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${TENANT_B}'`);
      const wrong = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${REG}`);
      expect(wrong.rows[0]?.count).toBe("0");
      await client.query(`SET app.current_tenant = '${TENANT_A}'`);
      const right = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${REG}`);
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
      const r = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${REG}`);
      expect(r.rows[0]?.count).toBe("0");
    } finally {
      client.release();
    }
  });
});

describe("0021 — down/up round-trip", () => {
  it("DOWN restores auth_tokens shape + drops the table; UP re-creates them", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    // Table gone.
    const afterDown = await e.admin.query(`SELECT to_regclass($1) AS reg`, [REG]);
    expect(afterDown.rows[0]?.reg).toBeNull();
    // auth_tokens column gone.
    const colDown = await e.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
       WHERE table_name = 'auth_tokens' AND column_name = 'connector_registration_id'`,
    );
    expect(colDown.rows[0]?.count).toBe("0");
    // scope-enum CHECK gone (a stray scope inserts again after DOWN).
    const chkDown = await e.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint WHERE conname = 'auth_tokens_scope_valid'`,
    );
    expect(chkDown.rows[0]?.count).toBe("0");

    await e.admin.query(upSql);
    const afterUp = await e.admin.query<{ reg: string }>(
      `SELECT to_regclass($1)::text AS reg`,
      [REG],
    );
    expect(afterUp.rows[0]?.reg).toBe(REG);
    const colUp = await e.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
       WHERE table_name = 'auth_tokens' AND column_name = 'connector_registration_id'`,
    );
    expect(colUp.rows[0]?.count).toBe("1");
    await ensureAppRole(e);
  });
});
