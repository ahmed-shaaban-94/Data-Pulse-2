/**
 * POS Sale Posting to ERPNext (015) — `0019_erpnext_posting_status` migration test.
 *
 * Validates `packages/db/drizzle/0019_erpnext_posting_status.sql` (+ `.down.sql`):
 *   - the table is created with the data-model.md §5 column set, the kind/status/
 *     payload_hash/retry/document-ref-when-posted CHECKs, and the O-3 source-ref
 *     unique;
 *   - the kind CHECK: only 'sale_post' | 'reversal';
 *   - the status CHECK: only the four lifecycle states;
 *   - the document_ref-when-posted CHECK: posted REQUIRES document_ref; a
 *     non-posted row must leave it NULL;
 *   - the O-3 UNIQUE (tenant_id, source_ref_id): a 2nd row for the SAME originating
 *     row is rejected (23505), but TWO reversals of one sale (distinct
 *     source_ref_id) BOTH insert — even when they share the parent sale's
 *     (source_system, external_id) — the REVERSAL-CARDINALITY guarantee;
 *   - the composite FK (sale_id, tenant_id, store_id) -> sales;
 *   - fail-closed RLS: wrong app.current_tenant → zero rows; empty GUC → zero rows
 *     (no 22P02);
 *   - UP -> DOWN -> UP round-trips cleanly.
 *
 * Docker policy mirrors 0014/0016/0017/0018: missing Docker is a HARD failure
 * unless MIGRATION_TEST_ALLOW_SKIP=1 (CI MUST NOT set it). Run targeted via WSL.
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
const UP_PATH = resolve(DRIZZLE_DIR, "0019_erpnext_posting_status.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0019_erpnext_posting_status.down.sql");

const TABLE = "erpnext_posting_status";

// Hex-only UUID literals (memory: mnemonic prefixes a-f only).
const TENANT_A = "01900000-0000-7000-8000-0000000000a1";
const TENANT_B = "01900000-0000-7000-8000-0000000000b2";
const STORE_A = "01900000-0000-7000-8000-0000000000c1";
const ACTOR = "01900000-0000-7000-8000-0000000000d1";
const SALE_A = "01900000-0000-7000-8000-0000000000e1";
// Distinct originating rows (a sale + two terminal events of that sale).
const REF_SALE = SALE_A;
const REF_VOID = "01900000-0000-7000-8000-0000000000f1";
const REF_REFUND = "01900000-0000-7000-8000-0000000000f2";
const PAYLOAD_HASH = "a".repeat(64);

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** Apply every migration with a basename lexically < 0019 (0000–0018). */
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

/** Seed tenants A/B → store → actor → one parent sale (admin pool, RLS-bypass). */
async function seedParents(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code) VALUES
       ($1, 'eps-a', 'EPS Tenant A', 'USD'),
       ($2, 'eps-b', 'EPS Tenant B', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await pgEnv.admin.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'EPS1', 'EPS Store')
     ON CONFLICT (id) DO NOTHING`,
    [STORE_A, TENANT_A],
  );
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, password_hash) VALUES ($1, 'eps@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR],
  );
  // The parent sale the composite FK references.
  await pgEnv.admin.query(
    `INSERT INTO sales
       (id, tenant_id, store_id, currency_code, pos_total, occurred_at,
        business_date, source_system, external_id, payload_hash, created_by)
     VALUES ($1, $2, $3, 'USD', 10.00, now(), CURRENT_DATE,
        'pos-eps', 'SALE-EPS-1', $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [SALE_A, TENANT_A, STORE_A, PAYLOAD_HASH, ACTOR],
  );
}

/** Insert one posting-status row (admin pool, RLS-bypass). */
function insertStatus(
  pgEnv: PgTestEnv,
  opts: {
    id?: string;
    tenant?: string;
    store?: string;
    saleId?: string;
    kind?: string;
    sourceRefId?: string;
    sourceSystem?: string;
    externalId?: string;
    status?: string;
    documentRef?: string | null;
    retryCount?: number;
  },
): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO erpnext_posting_status
       (id, tenant_id, store_id, sale_id, kind, source_ref_id,
        source_system, external_id, payload_hash, status, document_ref, retry_count)
     VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      opts.id ?? null,
      opts.tenant ?? TENANT_A,
      opts.store ?? STORE_A,
      opts.saleId ?? SALE_A,
      opts.kind ?? "sale_post",
      opts.sourceRefId ?? REF_SALE,
      opts.sourceSystem ?? "pos-eps",
      opts.externalId ?? "SALE-EPS-1",
      PAYLOAD_HASH,
      opts.status ?? "pending",
      opts.documentRef ?? null,
      opts.retryCount ?? 0,
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
      console.warn(`\n[0019-erpnext-posting-status.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  // Re-grant AFTER 0019 so the app role has privileges on the new table
  // (ensureAppRole's GRANT ON ALL TABLES only covers tables existing at grant
  // time — the new table needs a re-grant, mirroring the real deploy order).
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

describe("0019 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0019 — table + RLS created", () => {
  it("creates erpnext_posting_status with RLS enabled + forced", async () => {
    if (skip()) return;
    const e = guard();
    const t = await e.admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [TABLE],
    );
    expect(t.rows[0]?.relrowsecurity).toBe(true);
    expect(t.rows[0]?.relforcerowsecurity).toBe(true);
    // SELECT + INSERT + UPDATE policies (mutable status table); NO DELETE policy.
    const pol = await e.admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1`,
      [TABLE],
    );
    const cmds = pol.rows.map((r) => r.cmd).sort();
    expect(cmds).toEqual(["INSERT", "SELECT", "UPDATE"]);
  });

  it("exposes NO money/amount column (state-only table)", async () => {
    if (skip()) return;
    const e = guard();
    const cols = await e.admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [TABLE],
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const forbidden of [
      "amount",
      "pos_total",
      "line_amount",
      "unit_price",
      "tax_amount",
      "total",
      "money",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // Sanity: the state columns ARE present.
    expect(names).toContain("status");
    expect(names).toContain("document_ref");
    expect(names).toContain("source_ref_id");
    expect(names).toContain("sequence");
  });
});

describe("0019 — constraints", () => {
  // Each test starts from an empty table so the O-3 unique does not leak rows
  // across tests (admin pool — hard-delete is test-only).
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM erpnext_posting_status`);
  });

  it("rejects an invalid kind (CHECK)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertStatus(e, { kind: "amend" })).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects an invalid status (CHECK)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertStatus(e, { status: "queued" })).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a posted row WITHOUT document_ref (posted<=>document_ref CHECK)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertStatus(e, { status: "posted", documentRef: null }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a NON-posted row WITH a document_ref (posted<=>document_ref CHECK)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertStatus(e, { status: "pending", documentRef: "ACC-SINV-0001" }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts a posted row WITH document_ref", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertStatus(e, { status: "posted", documentRef: "ACC-SINV-0001" }),
    ).resolves.toBeDefined();
  });

  it("rejects a malformed payload_hash (CHECK)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      e.admin.query(
        `INSERT INTO erpnext_posting_status
           (id, tenant_id, store_id, sale_id, kind, source_ref_id,
            source_system, external_id, payload_hash, status)
         VALUES (gen_random_uuid(), $1, $2, $3, 'sale_post', $4, 'pos-eps', 'X', 'NOTHEX', 'pending')`,
        [TENANT_A, STORE_A, SALE_A, REF_SALE],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects a row whose (sale_id, tenant_id, store_id) has no parent sale (composite FK)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertStatus(e, { saleId: "01900000-0000-7000-8000-0000000000ee" }),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("accepts a sale_post, then REJECTS a 2nd row for the SAME source_ref_id (O-3 unique)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertStatus(e, { sourceRefId: REF_SALE })).resolves.toBeDefined();
    await expect(insertStatus(e, { sourceRefId: REF_SALE })).rejects.toMatchObject({ code: "23505" });
  });

  it("REVERSAL-CARDINALITY: a sale_post + TWO reversals of one sale (distinct source_ref_id) ALL insert — even sharing the sale's (source_system, external_id)", async () => {
    if (skip()) return;
    const e = guard();
    // The sale post.
    await expect(
      insertStatus(e, { kind: "sale_post", sourceRefId: REF_SALE }),
    ).resolves.toBeDefined();
    // Two partial refunds (terminal events) of the SAME sale. Worst case: the POS
    // gave them the SAME (source_system, external_id) as the parent sale — keying
    // O-3 on (source_system, external_id) would 23505 here. Keyed on source_ref_id,
    // both insert.
    await expect(
      insertStatus(e, {
        kind: "reversal",
        sourceRefId: REF_VOID,
        sourceSystem: "pos-eps",
        externalId: "SALE-EPS-1",
      }),
    ).resolves.toBeDefined();
    await expect(
      insertStatus(e, {
        kind: "reversal",
        sourceRefId: REF_REFUND,
        sourceSystem: "pos-eps",
        externalId: "SALE-EPS-1",
      }),
    ).resolves.toBeDefined();
    const count = await e.admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${TABLE} WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(count.rows[0]?.count).toBe("3");
  });

  it("assigns a monotonic sequence (feed cursor source)", async () => {
    if (skip()) return;
    const e = guard();
    await insertStatus(e, { sourceRefId: REF_SALE });
    await insertStatus(e, { kind: "reversal", sourceRefId: REF_VOID });
    const seqs = await e.admin.query<{ sequence: string }>(
      `SELECT sequence::text AS sequence FROM ${TABLE} WHERE tenant_id = $1 ORDER BY sequence`,
      [TENANT_A],
    );
    expect(seqs.rows).toHaveLength(2);
    expect(Number(seqs.rows[1]!.sequence)).toBeGreaterThan(Number(seqs.rows[0]!.sequence));
  });
});

describe("0019 — fail-closed RLS", () => {
  it("RLS-bypass probe: a row owned by tenant A is invisible under app.current_tenant = B", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(`DELETE FROM erpnext_posting_status`);
    await insertStatus(e, {});
    const client = await e.app.connect();
    try {
      await client.query(`SET app.current_tenant = '${TENANT_B}'`);
      const wrong = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${TABLE}`,
      );
      expect(wrong.rows[0]?.count).toBe("0");
      await client.query(`SET app.current_tenant = '${TENANT_A}'`);
      const right = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${TABLE}`,
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

describe("0019 — down/up round-trip", () => {
  it("DOWN drops the table; UP re-creates it", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    const afterDown = await e.admin.query(`SELECT to_regclass($1) AS reg`, [TABLE]);
    expect(afterDown.rows[0]?.reg).toBeNull();

    await e.admin.query(upSql);
    const afterUp = await e.admin.query<{ reg: string }>(
      `SELECT to_regclass($1)::text AS reg`,
      [TABLE],
    );
    expect(afterUp.rows[0]?.reg).toBe(TABLE);
    // Re-grant after the UP re-create so subsequent app-pool tests still work.
    await ensureAppRole(e);
  });
});
