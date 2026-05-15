/**
 * T311 — DB-layer audit-retention privilege invariant.
 *
 * Verifies that the column-scoped UPDATE grant introduced in migration 0005
 * enforces the immutability boundary described in audit-retention-decision.md §8:
 *
 *   - The API/app role (app_test) cannot UPDATE audit_events.retention_marked_at.
 *   - The retention worker role can UPDATE audit_events.retention_marked_at.
 *   - The retention worker role cannot UPDATE any audit fact column
 *     (action, metadata, occurred_at, tenant_id, store_id).
 *   - The API/app role cannot DELETE audit_events rows.
 *   - The retention worker role cannot DELETE audit_events rows.
 *
 * All privilege checks are performed by connecting as the target role (never
 * the superuser admin pool), so they reflect real Postgres enforcement, not
 * superuser bypass.
 *
 * Soft-skips when MIGRATION_TEST_ALLOW_SKIP=1 and Docker is unavailable,
 * matching the pattern used across packages/db/__tests__/.
 */
import { Pool } from "pg";
import {
  applyAllUpAndCreateAppRole,
  createRetentionWorkerPool,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from "./_helpers/postgres-container";

// ---------------------------------------------------------------------------
// Fixture IDs — prefix "05" (migration 0005); no collision with other specs
// ---------------------------------------------------------------------------

const TENANT_ID = "05000000-0000-7000-8000-000000000001";
const AUDIT_ROW_ID = "05000000-0000-7000-8000-000000000a01";

let env: PgTestEnv | null = null;
let retentionPool: Pool | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    // Apply all migrations (0000–0005) so that audit_retention_worker role
    // and the column-scoped GRANT from 0005 exist before we run tests.
    await applyAllUpAndCreateAppRole(env);

    // Promote audit_retention_worker to LOGIN for the test session.
    retentionPool = await createRetentionWorkerPool(env);

    // Seed a tenant and one audit_events row as superuser so privilege tests
    // have a concrete target.  The seed bypasses RLS — that is intentional;
    // setup always uses the admin pool.
    await env.admin.query(
      `INSERT INTO tenants (id, slug, name) VALUES ($1, 'inv-tenant', 'Invariant Test Tenant')`,
      [TENANT_ID],
    );
    await env.admin.query(
      `INSERT INTO audit_events
         (id, tenant_id, action, metadata, occurred_at)
       VALUES
         ($1, $2, 'test.invariant.seed', '{}', now() - interval '400 days')`,
      [AUDIT_ROW_ID, TENANT_ID],
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env["MIGRATION_TEST_ALLOW_SKIP"] === "1") {
      // eslint-disable-next-line no-console
      console.warn(`\n[audit-retention.invariant.spec] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (retentionPool) await retentionPool.end().catch(() => undefined);
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn("[audit-retention.invariant.spec] skipping (Docker unavailable)");
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function expectPermissionDenied(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await expect(pool.query(sql, params)).rejects.toMatchObject({
    code: "42501", // permission_denied
  });
}

// ---------------------------------------------------------------------------
// App/API role — must NOT be able to UPDATE retention_marked_at
// ---------------------------------------------------------------------------

describe("app_test role — UPDATE restrictions on audit_events", () => {
  it("cannot UPDATE retention_marked_at (I-APP-1)", async () => {
    if (maybeSkip()) return;

    await expectPermissionDenied(
      env!.app,
      `UPDATE audit_events SET retention_marked_at = now() WHERE id = $1`,
      [AUDIT_ROW_ID],
    );
  });
});

// ---------------------------------------------------------------------------
// Retention worker role — CAN update retention_marked_at, cannot update facts
// ---------------------------------------------------------------------------

describe("audit_retention_worker role — column-scoped UPDATE", () => {
  it("can UPDATE retention_marked_at (I-WORKER-1 positive control)", async () => {
    if (maybeSkip()) return;

    // The worker connects without RLS context (no SET LOCAL app.current_tenant).
    // Migration 0005 grants SELECT + UPDATE(retention_marked_at); the SELECT
    // is needed for the CTE predicate. Without tenant context, tenant-scoped
    // RLS returns 0 rows — this is expected (the production sweep runs as a
    // privileged platform role that bypasses RLS; here we only verify column
    // privilege, not RLS bypass).  So we check that the query succeeds (no
    // permission error) even if 0 rows are updated.
    await expect(
      retentionPool!.query(
        `UPDATE audit_events SET retention_marked_at = now() WHERE id = $1`,
        [AUDIT_ROW_ID],
      ),
    ).resolves.toBeDefined();
  });

  it("cannot UPDATE action (I-WORKER-2)", async () => {
    if (maybeSkip()) return;

    await expectPermissionDenied(
      retentionPool!,
      `UPDATE audit_events SET action = 'tampered' WHERE id = $1`,
      [AUDIT_ROW_ID],
    );
  });

  it("cannot UPDATE metadata (I-WORKER-3)", async () => {
    if (maybeSkip()) return;

    await expectPermissionDenied(
      retentionPool!,
      `UPDATE audit_events SET metadata = '{}' WHERE id = $1`,
      [AUDIT_ROW_ID],
    );
  });

  it("cannot UPDATE occurred_at (I-WORKER-4)", async () => {
    if (maybeSkip()) return;

    await expectPermissionDenied(
      retentionPool!,
      `UPDATE audit_events SET occurred_at = now() WHERE id = $1`,
      [AUDIT_ROW_ID],
    );
  });

  it("cannot UPDATE tenant_id (I-WORKER-5)", async () => {
    if (maybeSkip()) return;

    await expectPermissionDenied(
      retentionPool!,
      `UPDATE audit_events SET tenant_id = $2 WHERE id = $1`,
      [AUDIT_ROW_ID, TENANT_ID],
    );
  });

  it("cannot UPDATE store_id (I-WORKER-6)", async () => {
    if (maybeSkip()) return;

    await expectPermissionDenied(
      retentionPool!,
      `UPDATE audit_events SET store_id = null WHERE id = $1`,
      [AUDIT_ROW_ID],
    );
  });
});

// ---------------------------------------------------------------------------
// DELETE — no role may delete audit_events rows
// ---------------------------------------------------------------------------

describe("DELETE prohibition on audit_events", () => {
  it("app_test role cannot DELETE audit_events rows (I-DEL-1)", async () => {
    if (maybeSkip()) return;

    await expectPermissionDenied(
      env!.app,
      `DELETE FROM audit_events WHERE id = $1`,
      [AUDIT_ROW_ID],
    );
  });

  it("audit_retention_worker role cannot DELETE audit_events rows (I-DEL-2)", async () => {
    if (maybeSkip()) return;

    await expectPermissionDenied(
      retentionPool!,
      `DELETE FROM audit_events WHERE id = $1`,
      [AUDIT_ROW_ID],
    );
  });
});
