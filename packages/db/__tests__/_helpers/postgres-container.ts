/**
 * Shared Testcontainers helper.
 *
 *   - Boots `postgres:16-alpine` via `@testcontainers/postgresql`
 *   - Exposes an `admin` pool (DB superuser) for setup, metadata queries, and
 *     migration apply/rollback
 *   - Exposes an `app` pool connected as a non-superuser role with the
 *     privileges a real backend would have. This is the role the RLS
 *     functional smoke test uses, because the superuser bypasses RLS even
 *     when `FORCE ROW LEVEL SECURITY` is set.
 *
 * The migration files live in `packages/db/drizzle/`. We read them from
 * disk so the test exercises the SAME bytes the production runner ships.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";

const DRIZZLE_DIR = resolve(__dirname, "..", "..", "drizzle");

export const UP_SQL_PATH = resolve(DRIZZLE_DIR, "0000_initial.sql");
export const DOWN_SQL_PATH = resolve(DRIZZLE_DIR, "0000_initial.down.sql");

export const APP_ROLE_NAME = "app_test";
export const APP_ROLE_PASSWORD = "app_test";

export interface PgTestEnv {
  container: StartedPostgreSqlContainer;
  /** Pool connected as the database superuser (Testcontainers default). */
  admin: Pool;
  /** Pool connected as the non-superuser `app_test` role. */
  app: Pool;
  upSql: string;
  downSql: string;
  /** Connection URI for the superuser (suitable for child-process tests). */
  adminUri: string;
}

export async function startPgEnv(): Promise<PgTestEnv> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("test")
    .withUsername("postgres")
    .withPassword("postgres")
    .start();

  const adminUri = container.getConnectionUri();
  const admin = new Pool({ connectionString: adminUri });

  // App role is created lazily by `createAppRole` after the migration runs,
  // because GRANT ON ALL TABLES needs the tables to exist first.
  const upSql = readFileSync(UP_SQL_PATH, "utf8");
  const downSql = readFileSync(DOWN_SQL_PATH, "utf8");

  // Build app pool URI now (may be unused if the test never calls it).
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const appUri = `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${host}:${port}/test`;
  const app = new Pool({ connectionString: appUri });

  return { container, admin, app, upSql, downSql, adminUri };
}

/**
 * Apply the UP migration via the admin pool, then create the non-superuser
 * `app_test` role and grant it the privileges a real backend would have.
 *
 * Idempotent: if the migration is already applied (e.g., the test wants to
 * re-apply after a rollback), this throws on the second CREATE TABLE — the
 * caller is expected to wrap UP/DOWN cycles itself.
 */
export async function applyUpAndCreateAppRole(env: PgTestEnv): Promise<void> {
  await env.admin.query(env.upSql);
  await ensureAppRole(env);
}

/**
 * Create the app role and grant table-level privileges. Safe to call multiple
 * times — uses IF NOT EXISTS / re-grants idempotently.
 */
export async function ensureAppRole(env: PgTestEnv): Promise<void> {
  await env.admin.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE_NAME}') THEN
        CREATE ROLE ${APP_ROLE_NAME} LOGIN PASSWORD '${APP_ROLE_PASSWORD}';
      END IF;
    END
    $$;
  `);
  await env.admin.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE_NAME}`);
  await env.admin.query(`
    GRANT SELECT, INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public TO ${APP_ROLE_NAME}
  `);
  await env.admin.query(`
    GRANT USAGE, SELECT
    ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE_NAME}
  `);
}

export async function stopPgEnv(env: PgTestEnv): Promise<void> {
  await env.app.end().catch(() => undefined);
  await env.admin.end().catch(() => undefined);
  await env.container.stop().catch(() => undefined);
}
