/**
 * Testcontainers helper for apps/api repo tests.
 *
 *   - Boots `postgres:16-alpine`
 *   - Applies the foundation migration from
 *     `packages/db/drizzle/0000_initial.sql` (the bytes the production
 *     runner ships)
 *   - Exposes an `admin` pool (DB superuser) for setup + RLS-bypassing
 *     metadata writes
 *   - Exposes an `app` pool connected as a non-superuser `app_test` role
 *     so tests that exercise RLS (e.g., AuthTokenRepository tenant
 *     isolation) hit the policies for real.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Pool } from "pg";

const DRIZZLE_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "drizzle",
);

export const UP_SQL_PATH = resolve(DRIZZLE_DIR, "0000_initial.sql");
export const APP_ROLE_NAME = "app_test";
export const APP_ROLE_PASSWORD = "app_test";

export interface PgTestEnv {
  container: StartedPostgreSqlContainer;
  /** Pool connected as the database superuser (Testcontainers default). */
  admin: Pool;
  /** Pool connected as the non-superuser `app_test` role. */
  app: Pool;
  upSql: string;
  /** Connection URI for the superuser. */
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

  const upSql = readFileSync(UP_SQL_PATH, "utf8");

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const appUri = `postgres://${APP_ROLE_NAME}:${APP_ROLE_PASSWORD}@${host}:${port}/test`;
  const app = new Pool({ connectionString: appUri });

  return { container, admin, app, upSql, adminUri };
}

/**
 * Apply UP migration via the admin pool, then create the non-superuser
 * `app_test` role and grant it the privileges a real backend would have.
 */
export async function applyUpAndCreateAppRole(env: PgTestEnv): Promise<void> {
  await env.admin.query(env.upSql);
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
