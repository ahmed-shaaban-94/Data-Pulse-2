/**
 * 029 DP-2 Provider-Neutral Identity Link — `0025_external_identity_links`
 * migration test.
 *
 * Validates `packages/db/drizzle/0025_external_identity_links.sql` (+ `.down.sql`):
 *   - external_identity_links created with the 028 §16 fields (provider_key,
 *     issuer, subject, user_id, email, status, linked_at, last_verified_at,
 *     disabled_at);
 *   - TENANT-AGNOSTIC: NO RLS (relrowsecurity = false), mirroring `users` — NOT
 *     the tenant-scoped `devices`/0024 FORCE-RLS pattern (the load-bearing T1
 *     decision; the resolver reads this pre-tenant-context);
 *   - uniqueness (provider_key, issuer, subject) -> one user_id (duplicate 23505);
 *   - single ACTIVE link per user_id (partial-unique; 2nd active 23505; a
 *     disabled row does NOT block a fresh active link — future dual-link shape);
 *   - status CHECK in ('active','disabled') (stray 23514);
 *   - non-empty CHECKs on provider_key / issuer / subject (whitespace 23514);
 *   - status/disabled_at consistency CHECK (active+disabled_at OR disabled+NULL
 *     rejected, 23514);
 *   - user_id FK -> users RESTRICT (dangling 23503);
 *   - NO money column;
 *   - BACKFILL (T7): COUNT(links) == COUNT(users WHERE clerk_user_id IS NOT NULL)
 *     after UP (mapped -> link, none dropped — fail-closed/surfaced); a mapped
 *     user resolves to its link via (provider_key, subject); idempotent re-run
 *     of the backfill INSERT adds nothing;
 *   - BRIDGE COLUMN (T8/N-7): users.clerk_user_id, users_clerk_user_id_uidx, and
 *     users_clerk_user_id_format ALL still present after 0025 — demote, not drop;
 *   - UP -> DOWN -> UP round-trips cleanly.
 *
 * Docker policy mirrors 0024: missing Docker is a HARD failure unless
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
const UP_PATH = resolve(DRIZZLE_DIR, "0025_external_identity_links.sql");
const DOWN_PATH = resolve(DRIZZLE_DIR, "0025_external_identity_links.down.sql");

const TBL = "external_identity_links";
const CLERK_ISSUER = "https://clerk.dp2.local";

// Three users seeded BEFORE 0025 applies, so the backfill maps exactly two
// (those with a non-null clerk_user_id).
const USER_MAPPED_1 = "0e900000-0000-7000-8000-00000000e001";
const USER_MAPPED_2 = "0e900000-0000-7000-8000-00000000e002";
const USER_NO_CLERK = "0e900000-0000-7000-8000-00000000e003";
const SUB_1 = "user_clerk_backfill_001";
const SUB_2 = "user_clerk_backfill_002";

let env: PgTestEnv | null = null;
let dockerSkipReason: string | null = null;
let upSql = "";
let downSql = "";

/** Apply every migration with a basename lexically < 0025 (0000–0024). */
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

/** Seed users that the 0025 backfill will (or won't) map. */
async function seedUsers(pgEnv: PgTestEnv): Promise<void> {
  await pgEnv.admin.query(
    `INSERT INTO users (id, email, display_name, clerk_user_id) VALUES
       ($1, 'm1@id.example', 'Mapped 1', $2),
       ($3, 'm2@id.example', 'Mapped 2', $4),
       ($5, 'noclerk@id.example', 'No Clerk', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [USER_MAPPED_1, SUB_1, USER_MAPPED_2, SUB_2, USER_NO_CLERK],
  );
}

interface LinkOpts {
  provider?: string;
  issuer?: string;
  subject?: string;
  userId?: string;
  email?: string | null;
  status?: string;
  disabledAt?: string | null;
}

function insertLink(pgEnv: PgTestEnv, opts: LinkOpts = {}): Promise<unknown> {
  return pgEnv.admin.query(
    `INSERT INTO external_identity_links
       (provider_key, issuer, subject, user_id, email, status, disabled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      opts.provider ?? "clerk",
      opts.issuer ?? CLERK_ISSUER,
      opts.subject ?? `sub_${randomUUID()}`,
      opts.userId ?? USER_MAPPED_1,
      opts.email === undefined ? "x@id.example" : opts.email,
      opts.status ?? "active",
      opts.disabledAt === undefined ? null : opts.disabledAt,
    ],
  );
}

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyPreMigrations(env);
    await seedUsers(env);
  } catch (err: unknown) {
    dockerSkipReason = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[0025-external-identity-links.spec] Docker NOT AVAILABLE — skipping. Reason: ${dockerSkipReason}\n`);
      return;
    }
    throw new Error(`Container start failed: ${dockerSkipReason}`);
  }
  upSql = readFileSync(UP_PATH, "utf8");
  downSql = readFileSync(DOWN_PATH, "utf8");
  await env.admin.query(upSql);
  await ensureAppRole(env);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function guard(): PgTestEnv {
  if (!env) throw new Error(`Docker unavailable: ${dockerSkipReason}`);
  return env;
}

const skip = () => dockerSkipReason && process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1";

describe("0025 — files exist", () => {
  it("up + down migration files are present", () => {
    expect(existsSync(UP_PATH)).toBe(true);
    expect(existsSync(DOWN_PATH)).toBe(true);
  });
});

describe("0025 — external_identity_links shape (T1)", () => {
  it("carries the 028 §16 fields", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [TBL],
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const f of [
      "provider_key", "issuer", "subject", "user_id", "email",
      "status", "linked_at", "last_verified_at", "disabled_at",
    ]) {
      expect(names).toContain(f);
    }
  });

  it("is TENANT-AGNOSTIC — NO RLS (mirrors users, NOT devices/0024)", async () => {
    if (skip()) return;
    const t = await guard().admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [TBL],
    );
    // Deliberately false: a provider subject is a global identity, the resolver
    // reads this pre-tenant-context. A FORCE-RLS predicate would fail-close
    // every operator. (Same posture as the users table.)
    expect(t.rows[0]?.relrowsecurity).toBe(false);
    expect(t.rows[0]?.relforcerowsecurity).toBe(false);
    const pol = await guard().admin.query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies WHERE tablename = $1`,
      [TBL],
    );
    expect(pol.rows).toHaveLength(0);
  });

  it("has NO tenant_id and NO money column", async () => {
    if (skip()) return;
    const cols = await guard().admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
      [TBL],
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const forbidden of [
      "tenant_id", "amount", "total", "unit_price", "price", "cost", "money",
      "token", "secret", "password",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });
});

describe("0025 — constraints (T1/T2)", () => {
  beforeEach(async () => {
    if (skip()) return;
    await guard().admin.query(`DELETE FROM external_identity_links`);
  });

  it("(provider_key, issuer, subject) UNIQUE — duplicate rejected (23505)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertLink(e, { subject: "dupe", userId: USER_MAPPED_1 })).resolves.toBeDefined();
    await expect(
      insertLink(e, { subject: "dupe", userId: USER_MAPPED_2, status: "disabled", disabledAt: "2026-01-01" }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("single ACTIVE link per user_id — 2nd active rejected (23505)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertLink(e, { subject: "a1", userId: USER_MAPPED_1 })).resolves.toBeDefined();
    await expect(
      insertLink(e, { subject: "a2", userId: USER_MAPPED_1 }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("a DISABLED row does NOT block a fresh active link (future dual-link shape)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertLink(e, { subject: "old", userId: USER_MAPPED_1, status: "disabled", disabledAt: "2026-01-01" }),
    ).resolves.toBeDefined();
    await expect(
      insertLink(e, { subject: "new", userId: USER_MAPPED_1, status: "active" }),
    ).resolves.toBeDefined();
  });

  it("status CHECK — a stray status is rejected (23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertLink(e, { status: "revoked" })).rejects.toMatchObject({ code: "23514" });
  });

  it("non-empty CHECKs on provider_key / issuer / subject (whitespace 23514)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(insertLink(e, { provider: "   " })).rejects.toMatchObject({ code: "23514" });
    await expect(insertLink(e, { issuer: "   " })).rejects.toMatchObject({ code: "23514" });
    await expect(insertLink(e, { subject: "   " })).rejects.toMatchObject({ code: "23514" });
  });

  it("status/disabled_at consistency CHECK (23514)", async () => {
    if (skip()) return;
    const e = guard();
    // active + disabled_at set -> rejected
    await expect(
      insertLink(e, { status: "active", disabledAt: "2026-01-01" }),
    ).rejects.toMatchObject({ code: "23514" });
    // disabled + disabled_at NULL -> rejected
    await expect(
      insertLink(e, { status: "disabled", disabledAt: null }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("user_id FK -> users — a dangling user is rejected (23503)", async () => {
    if (skip()) return;
    const e = guard();
    await expect(
      insertLink(e, { userId: "0e900000-0000-7000-8000-0000000000ff" }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

describe("0025 — backfill (T7) + fail-closed/surfaced", () => {
  it("link count == count of users with a non-null clerk_user_id (none dropped)", async () => {
    if (skip()) return;
    const e = guard();
    // Re-apply UP to restore the backfill rows the constraint tests cleared.
    await e.admin.query(`DELETE FROM external_identity_links`);
    await e.admin.query(upSql); // INSERT…SELECT runs again, idempotent
    const links = await e.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM external_identity_links WHERE provider_key = 'clerk'`,
    );
    const users = await e.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM users WHERE clerk_user_id IS NOT NULL`,
    );
    expect(links.rows[0]?.n).toBe(users.rows[0]?.n);
    // The two seeded mapped users are present; the no-clerk user is not.
    expect(Number(users.rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it("a backfilled user resolves to its link via (provider_key, subject)", async () => {
    if (skip()) return;
    const e = guard();
    const r = await e.admin.query<{ user_id: string; issuer: string; status: string }>(
      `SELECT user_id, issuer, status FROM external_identity_links
        WHERE provider_key = 'clerk' AND subject = $1`,
      [SUB_1],
    );
    expect(r.rows[0]?.user_id).toBe(USER_MAPPED_1);
    expect(r.rows[0]?.issuer).toBe(CLERK_ISSUER);
    expect(r.rows[0]?.status).toBe("active");
  });

  it("backfill INSERT is idempotent — a re-run adds nothing (ON CONFLICT DO NOTHING)", async () => {
    if (skip()) return;
    const e = guard();
    const before = await e.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM external_identity_links`,
    );
    await e.admin.query(upSql); // re-run the whole UP, including the backfill
    const after = await e.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM external_identity_links`,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

describe("0025 — users.clerk_user_id is a v1 BRIDGE column (T8/N-7, demote NOT drop)", () => {
  it("users.clerk_user_id column still exists", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'clerk_user_id'`,
    );
    expect(r.rows[0]?.n).toBe("1");
  });

  it("users_clerk_user_id_uidx partial UNIQUE index still exists", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_indexes
        WHERE tablename = 'users' AND indexname = 'users_clerk_user_id_uidx'`,
    );
    expect(r.rows[0]?.n).toBe("1");
  });

  it("users_clerk_user_id_format CHECK still exists", async () => {
    if (skip()) return;
    const r = await guard().admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_constraint
        WHERE conname = 'users_clerk_user_id_format'`,
    );
    expect(r.rows[0]?.n).toBe("1");
  });
});

describe("0025 — down/up round-trip", () => {
  it("DOWN drops the table; UP re-creates it (and re-backfills)", async () => {
    if (skip()) return;
    const e = guard();
    await e.admin.query(downSql);
    const afterDown = await e.admin.query(`SELECT to_regclass($1) AS reg`, [TBL]);
    expect(afterDown.rows[0]?.reg).toBeNull();
    // clerk_user_id survives the DOWN (UP never touched it).
    const col = await e.admin.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM information_schema.columns
        WHERE table_name = 'users' AND column_name = 'clerk_user_id'`,
    );
    expect(col.rows[0]?.n).toBe("1");

    await e.admin.query(upSql);
    const afterUp = await e.admin.query<{ reg: string }>(
      `SELECT to_regclass($1)::text AS reg`,
      [TBL],
    );
    expect(afterUp.rows[0]?.reg).toBe(TBL);
    await ensureAppRole(e);
  });
});
