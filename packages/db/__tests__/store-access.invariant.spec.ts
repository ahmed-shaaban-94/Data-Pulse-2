/**
 * T175 — Invariant I-3: StoreAccess.tenant matches Membership.tenant (DB layer).
 *
 * Proves the composite FK constraints in 0000_initial.sql enforce I-3 at the
 * database level, independent of any application-layer checks:
 *
 *   store_access_membership_fk:
 *     (tenant_id, membership_id) → memberships (tenant_id, id)  ON DELETE CASCADE
 *
 *   store_access_store_fk:
 *     (tenant_id, store_id) → stores (tenant_id, id)            ON DELETE RESTRICT
 *
 * Scenarios:
 *   1. Happy path — tenant_id / membership_id / store_id all consistent → INSERT succeeds.
 *   2. Membership-tenant mismatch — tenant_id matches store but NOT membership → rejected.
 *   3. Store-tenant mismatch     — tenant_id matches membership but NOT store → rejected.
 *   4. Both mismatched           — tenant_id belongs to neither              → rejected.
 *   5. Cascade delete            — deleting the membership removes store_access rows.
 *   6. Restrict on store delete  — deleting a store with store_access rows is rejected.
 *
 * UUID prefix "5" — no collision with packages/db/__tests__/ fixtures.
 * apps/api tests each boot their own container so cross-prefix duplication is harmless,
 * but "5" is visually distinct from the "0a"/"0b"/"01" style used in migration.spec.ts.
 */

import {
  applyUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "./_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Fixture IDs — prefix "5"
// ---------------------------------------------------------------------------

const TENANT_A  = "51000000-1000-4000-8000-000000000001";
const TENANT_B  = "52000000-2000-4000-8000-000000000002";
const USER_A    = "53000000-3000-4000-8000-000000000003";
const USER_B    = "54000000-4000-4000-8000-000000000004";
const ROLE_A    = "55000000-5000-4000-8000-000000000005";
const ROLE_B    = "56000000-6000-4000-8000-000000000006";
const STORE_A   = "57000000-7000-4000-8000-000000000007"; // belongs to TENANT_A
const STORE_B   = "58000000-8000-4000-8000-000000000008"; // belongs to TENANT_B
const MEM_A     = "59000000-9000-4000-8000-000000000009"; // tenant=TENANT_A, store_access_kind='specific'
const MEM_B     = "5a000000-a000-4000-8000-00000000000a"; // tenant=TENANT_B, store_access_kind='specific'

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

let env: PgTestEnv | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyUpAndCreateAppRole(env);
    await seedBase();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[store-access.invariant.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[store-access.invariant.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

/**
 * Seed the minimal rows needed for all six scenarios.
 * All seeding runs as the superuser so RLS does not interfere.
 */
async function seedBase(): Promise<void> {
  const pg = env!.admin;

  await pg.query(
    `INSERT INTO tenants (id, slug, name) VALUES
       ($1, 'inv-tenant-a', 'Invariant Tenant A'),
       ($2, 'inv-tenant-b', 'Invariant Tenant B')`,
    [TENANT_A, TENANT_B],
  );

  await pg.query(
    `INSERT INTO users (id, email, password_hash) VALUES
       ($1, 'user-a@inv.test', 'x'),
       ($2, 'user-b@inv.test', 'x')`,
    [USER_A, USER_B],
  );

  await pg.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1, $2, 'member', 'Member A'),
       ($3, $4, 'member', 'Member B')`,
    [ROLE_A, TENANT_A, ROLE_B, TENANT_B],
  );

  await pg.query(
    `INSERT INTO stores (id, tenant_id, code, name) VALUES
       ($1, $2, 'store-a', 'Store A'),
       ($3, $4, 'store-b', 'Store B')`,
    [STORE_A, TENANT_A, STORE_B, TENANT_B],
  );

  await pg.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind) VALUES
       ($1, $2, $3, $4, 'specific'),
       ($5, $6, $7, $8, 'specific')`,
    [MEM_A, TENANT_A, USER_A, ROLE_A, MEM_B, TENANT_B, USER_B, ROLE_B],
  );
}

// ---------------------------------------------------------------------------
// Helper: attempt a store_access INSERT and return the Postgres error code,
// or null on success. Each call runs inside its own BEGIN/ROLLBACK so it
// never permanently pollutes the shared fixture state.
// ---------------------------------------------------------------------------
async function tryInsertStoreAccess(
  tenantId: string,
  membershipId: string,
  storeId: string,
): Promise<string | null> {
  const client = await env!.admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO store_access (membership_id, store_id, tenant_id)
       VALUES ($1, $2, $3)`,
      [membershipId, storeId, tenantId],
    );
    await client.query("ROLLBACK");
    return null; // success
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    const e = err as { code?: string };
    return e.code ?? "UNKNOWN";
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — Happy path
// ---------------------------------------------------------------------------

describe("store_access invariant I-3 — happy path", () => {
  it("inserts successfully when tenant_id, membership_id, and store_id are consistent", async () => {
    if (maybeSkip()) return;
    const code = await tryInsertStoreAccess(TENANT_A, MEM_A, STORE_A);
    expect(code).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — Membership-tenant mismatch
// tenant_id = TENANT_B, membership belongs to TENANT_A
// → store_access_membership_fk cannot find (TENANT_B, MEM_A) in memberships
// ---------------------------------------------------------------------------

describe("store_access invariant I-3 — membership-tenant mismatch", () => {
  it("rejects INSERT when tenant_id does not match the membership's tenant (FK 23503)", async () => {
    if (maybeSkip()) return;
    // tenant_id=TENANT_B, but MEM_A belongs to TENANT_A and STORE_B belongs to TENANT_B.
    // The composite FK (tenant_id, membership_id) → memberships(tenant_id, id) fails
    // because (TENANT_B, MEM_A) does not exist in memberships.
    const code = await tryInsertStoreAccess(TENANT_B, MEM_A, STORE_B);
    expect(code).toBe("23503");
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — Store-tenant mismatch
// tenant_id = TENANT_A, store belongs to TENANT_B
// → store_access_store_fk cannot find (TENANT_A, STORE_B) in stores
// ---------------------------------------------------------------------------

describe("store_access invariant I-3 — store-tenant mismatch", () => {
  it("rejects INSERT when tenant_id does not match the store's tenant (FK 23503)", async () => {
    if (maybeSkip()) return;
    // tenant_id=TENANT_A, MEM_A belongs to TENANT_A (membership FK passes),
    // but STORE_B belongs to TENANT_B, so (TENANT_A, STORE_B) is not in stores.
    const code = await tryInsertStoreAccess(TENANT_A, MEM_A, STORE_B);
    expect(code).toBe("23503");
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Both mismatched
// tenant_id belongs to neither membership nor store
// ---------------------------------------------------------------------------

describe("store_access invariant I-3 — both mismatched", () => {
  it("rejects INSERT when tenant_id matches neither the membership nor the store (FK 23503)", async () => {
    if (maybeSkip()) return;
    // tenant_id=TENANT_B, MEM_A ∈ TENANT_A, STORE_A ∈ TENANT_A.
    // Neither composite FK can be satisfied.
    const code = await tryInsertStoreAccess(TENANT_B, MEM_A, STORE_A);
    expect(code).toBe("23503");
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Cascade delete
// Deleting the parent membership must cascade-delete its store_access rows.
// ---------------------------------------------------------------------------

describe("store_access invariant I-3 — cascade delete on membership", () => {
  it("deletes store_access rows when the parent membership is deleted", async () => {
    if (maybeSkip()) return;

    // Use a dedicated membership + store_access row so deleting it doesn't
    // affect the shared MEM_A fixture used by other scenarios.
    const MEM_CASCADE = "5b000000-b000-4000-8000-00000000000b";
    const pg = env!.admin;

    await pg.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'specific')`,
      [MEM_CASCADE, TENANT_A, USER_A, ROLE_A],
    );
    await pg.query(
      `INSERT INTO store_access (membership_id, store_id, tenant_id)
       VALUES ($1, $2, $3)`,
      [MEM_CASCADE, STORE_A, TENANT_A],
    );

    // Confirm the row exists before the cascade.
    const before = await pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM store_access WHERE membership_id = $1`,
      [MEM_CASCADE],
    );
    expect(before.rows[0]?.count).toBe("1");

    // Delete the membership — should cascade.
    await pg.query(`DELETE FROM memberships WHERE id = $1`, [MEM_CASCADE]);

    const after = await pg.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM store_access WHERE membership_id = $1`,
      [MEM_CASCADE],
    );
    expect(after.rows[0]?.count).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Scenario 6 — Restrict on store delete
// Deleting a store that still has store_access rows must be rejected.
// ---------------------------------------------------------------------------

describe("store_access invariant I-3 — restrict on store delete", () => {
  it("rejects DELETE on a store that still has store_access rows (FK 23503)", async () => {
    if (maybeSkip()) return;

    // Use a dedicated store so this scenario is independent of other scenarios.
    const STORE_RESTRICT = "5c000000-c000-4000-8000-00000000000c";
    const MEM_RESTRICT   = "5d000000-d000-4000-8000-00000000000d";
    const pg = env!.admin;

    await pg.query(
      `INSERT INTO stores (id, tenant_id, code, name) VALUES ($1, $2, 'store-r', 'Store Restrict')`,
      [STORE_RESTRICT, TENANT_A],
    );
    await pg.query(
      `INSERT INTO memberships (id, tenant_id, user_id, role_id, store_access_kind)
       VALUES ($1, $2, $3, $4, 'specific')`,
      [MEM_RESTRICT, TENANT_A, USER_A, ROLE_A],
    );
    await pg.query(
      `INSERT INTO store_access (membership_id, store_id, tenant_id)
       VALUES ($1, $2, $3)`,
      [MEM_RESTRICT, STORE_RESTRICT, TENANT_A],
    );

    // Attempt to delete the store — should be rejected.
    let errorCode: string | null = null;
    try {
      await pg.query(`DELETE FROM stores WHERE id = $1`, [STORE_RESTRICT]);
    } catch (err: unknown) {
      errorCode = (err as { code?: string }).code ?? "UNKNOWN";
    }
    expect(errorCode).toBe("23503");

    // Cleanup: delete the store_access row first, then the membership and store.
    await pg.query(
      `DELETE FROM store_access WHERE membership_id = $1 AND store_id = $2`,
      [MEM_RESTRICT, STORE_RESTRICT],
    );
    await pg.query(`DELETE FROM memberships WHERE id = $1`, [MEM_RESTRICT]);
    await pg.query(`DELETE FROM stores WHERE id = $1`, [STORE_RESTRICT]);
  });
});
