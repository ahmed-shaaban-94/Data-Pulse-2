/**
 * `runWithTenantContext` — DB session middleware.
 *
 * Acquires a dedicated `PoolClient` from the supplied `pg.Pool`, opens a
 * transaction, sets the two GUCs that PostgreSQL RLS policies read
 * (`app.current_tenant`, `app.is_platform_admin`), runs the caller's work
 * function with the client, and commits / rolls back / releases cleanly.
 *
 * Why `set_config(name, value, true)` and not `SET LOCAL <name> = $1`:
 *   `SET LOCAL` is a PostgreSQL parser-level statement that does NOT accept
 *   parameter placeholders. `set_config(name, value, true)` is the
 *   parameterised equivalent — `is_local := true` makes the value scope to
 *   the current transaction, identical to `SET LOCAL`.
 *
 * Why a transaction is mandatory:
 *   `SET LOCAL` only persists for the duration of the surrounding
 *   transaction. Without `BEGIN`/`COMMIT`, a pooled connection would leak
 *   the GUC to whatever request next acquires it — a Constitution III
 *   violation. The tests assert that the GUC is unset after the callback
 *   returns and the connection is back in the pool.
 */
import type { Pool, PoolClient } from "pg";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TenantContext {
  /**
   * Active tenant UUID. Pass `null` for platform-admin operations that
   * don't have a tenant context (the policy's platform-admin OR-branch
   * applies in that case).
   */
  tenantId: string | null;
  /**
   * Whether the caller is a platform admin. Sets `app.is_platform_admin`
   * to the literal string `'true'` or `'false'`.
   */
  isPlatformAdmin: boolean;
}

function validateContext(ctx: TenantContext): void {
  if (ctx.tenantId !== null) {
    if (typeof ctx.tenantId !== "string" || !UUID_RE.test(ctx.tenantId)) {
      throw new Error(
        "runWithTenantContext: tenantId must be a UUID string or null",
      );
    }
  }
  if (typeof ctx.isPlatformAdmin !== "boolean") {
    throw new Error(
      "runWithTenantContext: isPlatformAdmin must be a boolean",
    );
  }
}

/**
 * Runs `work(client)` inside a transaction with the tenant-context GUCs set.
 *
 * On success: COMMIT. On error: ROLLBACK and re-throw. Either way: release
 * the client back to the pool.
 *
 * The caller must NOT issue `BEGIN`/`COMMIT`/`ROLLBACK` from inside `work`.
 * Use `SAVEPOINT` if nested rollback is needed.
 */
export async function runWithTenantContext<T>(
  pool: Pool,
  ctx: TenantContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  validateContext(ctx);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      // Empty string for tenantId === null — current_setting('app.current_tenant', true)::uuid
      // will fail-cast on '', and the policy short-circuits via the
      // is_platform_admin OR-branch.
      await client.query(
        "SELECT set_config('app.current_tenant', $1, true)",
        [ctx.tenantId ?? ""],
      );
      await client.query(
        "SELECT set_config('app.is_platform_admin', $1, true)",
        [ctx.isPlatformAdmin ? "true" : "false"],
      );
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Swallow — the original error is what matters.
      }
      throw err;
    }
  } finally {
    client.release();
  }
}

/**
 * Read both GUCs in their string form. Returns `null` for either field
 * when the GUC is unset on the connection (i.e., outside any
 * `runWithTenantContext` call).
 *
 * Useful for tests that prove `SET LOCAL` did not leak across pool
 * acquisitions.
 */
export async function readTenantContext(
  client: PoolClient,
): Promise<{ currentTenant: string | null; isPlatformAdmin: string | null }> {
  const r = await client.query<{
    current_tenant: string | null;
    is_platform_admin: string | null;
  }>(
    `SELECT
       NULLIF(current_setting('app.current_tenant', true), '') AS current_tenant,
       NULLIF(current_setting('app.is_platform_admin', true), '') AS is_platform_admin`,
  );
  return {
    currentTenant: r.rows[0]?.current_tenant ?? null,
    isPlatformAdmin: r.rows[0]?.is_platform_admin ?? null,
  };
}
