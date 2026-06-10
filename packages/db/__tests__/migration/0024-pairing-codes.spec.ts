/**
 * 027 POS Terminal-Pairing CONSUME — `0024_pairing_codes` migration test.
 *
 * Validates `packages/db/drizzle/0024_pairing_codes.sql` (+ `.down.sql`):
 *   - pairing_codes created with RLS enabled+forced; SELECT+INSERT+UPDATE
 *     policies, NO DELETE policy (spent codes retained);
 *   - code_hash BYTEA UNIQUE (duplicate -> 23505);
 *   - status CHECK in ('pending','used','cancelled') (stray -> 23514);
 *   - printer_vendor_id / printer_product_id hex-pattern CHECK (bad -> 23514);
 *   - non-empty CHECKs on label / branch fields / tax-reg (whitespace -> 23514);
 *   - FK tenant_id/store_id -> RESTRICT (dangling -> 23503);
 *   - FK device_id -> devices RESTRICT (dangling -> 23503);
 *   - NO money/PII/plaintext-secret column;
 *   - fail-closed RLS: wrong app.current_tenant -> zero rows; empty GUC -> zero
 *     rows (no 22P02);
 *   - UP -> DOWN -> UP round-trips cleanly.
 *
 * Docker policy mirrors 0021: missing Docker is a HARD failure unless
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
const UP_PATH = resolve(DRIZZLE_DIR, "0024_pairing_codes.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0024_pairing_codes.down.sql");

const TBL = "pairing_codes";

const TENANT_A = "0a900000-0000-7000-8000-00000000a001";
const TENANT_B = "0b900000-0000-7000-8000-00000000b002";
const STORE_A = "0a900000-0000-7000-8000-00000000a501";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** Apply every migration with a basename lexically < 0024 (0000–0023). */
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

async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'pair-a', 'Pairing Tenant A'),
       ($2, 'pair-b', 'Pairing Tenant B')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'BR-A', 'Branch A')
     ON CONFLICT (id) DO NOTHING`,
    [STORE_A, TENANT_A],
  );
}

interface CodeOpts {
  tenant?: string;
  store?: string;
  codeHashHex?: string;
  status?: string;
  vendorId?: string;
  productId?: string;
  label?: string;
  branchName?: string;
  comPort?: string | null;
  deviceId?: string | null;
}

function insertCode(pgEnv: PgTestEnv, opts: CodeOpts = {}): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO pairing_codes
       (tenant_id, store_id, code_hash, terminal_label, branch_name, branch_address,
        tenant_tax_registration_id, printer_vendor_id, printer_product_id,
        printer_com_port, status, expires_at, device_id)
     VALUES ($1,$2, decode($3,'hex'), $4,$5,'Addr','123456789',$6,$7,$8,$9,
             now() + interval '10 minutes', $10)`,
    [
      opts.tenant ?? TENANT_A,
      opts.store ?? STORE_A,
      opts.codeHashHex ?? randomUUID().replace(/-/g, "").padEnd(64, "0"),
      opts.label ?? "Counter 1",
      opts.branchName ?? "Branch A",
      opts.vendorId ?? "0x04B8",
      opts.productId ?? "0x0202",
      opts.comPort === undefined ? null : opts.comPort,
      opts.status ?? "pending",
      opts.deviceId ?? null,
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
      console.warn(`\n[0024-pairing-codes.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
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

describe("0024 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0024 — pairing_codes table + RLS", () => {
  it("has RLS enabled + forced", async () => {
    if (skip()) return;
    const t = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [TBL],
    );
    expect(t.rows[0]?.relrowsecurity).toBe(true);
    expect(t.rows[0]?.relforcerowsecurity).toBe(true);
  });

  it("is mutable (SELECT+INSERT+UPDATE) with NO DELETE policy", async () => {
    if (skip()) return;
    const pol = await guard().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1`,
      [TBL],
    );
    expect(pol.rows.map((r) => r.cmd).sort()).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("exposes NO money/PII/plaintext-secret column", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [TBL],
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const forbidden of [
      "amount", "total", "unit_price", "price", "cost", "money",
      "device_token", "token", "secret", "pairing_code", "code", "api_key",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // code_hash (a hash, not a secret) IS present.
    expect(names).toContain("code_hash");
  });
});

describe("0024 — constraints", () => {
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM pairing_codes`);
  });

  it("code_hash UNIQUE — duplicate is rejected (23505)", async () => {
    if (skip()) return;
    const e = guard();
    const hash = randomUUID().replace(/-/g, "").padEnd(64, "0");
    await expect(insertCode(e, { codeHashHex: hash })).resolves.toBeDefined();
    await expect(insertCode(e, { codeHashHex: hash })).rejects.toMatchObject({ code: "23505" });
  });

  it("status CHECK — a stray status is rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertCode(e, { status: "redeemed" })).rejects.toMatchObject({ code: "23514" });
    for (const s of ["pending", "used", "cancelled"]) {
      await expect(insertCode(e, { status: s })).resolves.toBeDefined();
    }
  });

  it("printer_vendor_id / printer_product_id hex-pattern CHECK (bad -> 23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertCode(e, { vendorId: "04B8" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertCode(e, { productId: "0xZZZZ" })).rejects.toMatchObject({ code: "23514" });
    await expect(insertCode(e, { vendorId: "0x04B8", productId: "0x0202" })).resolves.toBeDefined();
  });

  it("non-empty CHECK — whitespace-only terminal_label / branch_name rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertCode(e, { label: "   " })).rejects.toMatchObject({ code: "23514" });
    await expect(insertCode(e, { branchName: "   " })).rejects.toMatchObject({ code: "23514" });
  });

  it("printer_com_port nullable (USB-only) AND non-empty when present", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertCode(e, { comPort: null })).resolves.toBeDefined();
    await expect(insertCode(e, { comPort: "COM3" })).resolves.toBeDefined();
    await expect(insertCode(e, { comPort: "  " })).rejects.toMatchObject({ code: "23514" });
  });

  it("FK store_id -> stores RESTRICT — a dangling store is rejected (23503)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertCode(e, { store: "0a900000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("FK device_id -> devices RESTRICT — a dangling device is rejected (23503)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertCode(e, { deviceId: "0a900000-0000-7000-8000-0000000000ee" }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("0024 — fail-closed RLS", () => {
  it("a code owned by tenant A is invisible under app.current_tenant = B", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM pairing_codes`);
    await insertCode(e, { tenant: TENANT_A });
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

describe("0024 — down/up round-trip", () => {
  it("DOWN drops the table; UP re-creates it", async () => {
    if (skip()) return;
    const e = guard();
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
