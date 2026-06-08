/**
 * apps/api/test/connector-health/__support__/seed-connector-health.ts
 *
 * Slice 020-SETUP (T002) — connector_health test fixtures. Seeds, via the
 * `admin` (RLS-bypassing) pool, two tenants each with >= 1 connector_registration
 * and a controllable `last_seen_at`:
 *
 *   Tenant A:
 *     - REG_A_HEALTHY  — a registration WITH a recent health row (last_seen_at
 *                        controllable; default "now" -> healthy);
 *     - REG_A_NEVER    — a registration with NO health row (-> never_seen);
 *     - REG_A_DISABLED — a disabled registration with a recent health row
 *                        (disabled wins -> never healthy);
 *   Tenant B:
 *     - REG_B          — a registration (the cross-tenant target the sweep proves
 *                        A cannot read).
 *
 * Does NOT modify any shared isolation-harness file (imports its IDs only).
 * `.ts` (not `.spec.ts`) so Jest does not collect it as a test.
 */
import {
  ACTOR_A,
  ACTOR_B,
  TENANT_A,
  TENANT_B,
} from "../../catalog/__support__/isolation-harness";

export interface SeedableEnv {
  admin: { query: (text: string, params?: unknown[]) => Promise<unknown> };
}

// 020-specific fixture IDs (…0c020… mnemonic, hex a-f only).
export const REG_A_HEALTHY = "0c200000-0000-7000-8000-00000c020a01";
export const REG_A_NEVER = "0c200000-0000-7000-8000-00000c020a02";
export const REG_A_DISABLED = "0c200000-0000-7000-8000-00000c020a03";
export const REG_B = "0c200000-0000-7000-8000-00000c020b01";

export const HEALTH_FIXTURE_IDS = {
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  actorA: ACTOR_A,
  actorB: ACTOR_B,
  regAHealthy: REG_A_HEALTHY,
  regANever: REG_A_NEVER,
  regADisabled: REG_A_DISABLED,
  regB: REG_B,
} as const;

const HEALTH_A_HEALTHY = "0c200000-0000-7000-8000-00000c020a91";
const HEALTH_A_DISABLED = "0c200000-0000-7000-8000-00000c020a93";

/**
 * Seed the 020 fixtures via the admin pool. Idempotent (ON CONFLICT DO NOTHING).
 * `last_seen_at` on the healthy + disabled rows is set to now() so the healthy
 * one derives `healthy`; tests can re-stamp it to control the verdict.
 */
export async function seedConnectorHealthFixture(env: SeedableEnv): Promise<void> {
  const a = env.admin;

  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code)
     VALUES ($1, 'cha', 'CHA', 'USD'), ($2, 'chb', 'CHB', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO users (id, email, password_hash)
     VALUES ($1, 'cha@fixture.invalid', NULL), ($2, 'chb@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );

  // Registrations: A healthy, A never-seen, A disabled, B cross-tenant.
  await a.query(
    `INSERT INTO connector_registration
       (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
     VALUES
       ($1, $5, 'A Healthy', 'erp-a-healthy.ch', 'pilot', $7),
       ($2, $5, 'A Never',   'erp-a-never.ch',   'pilot', $7),
       ($4, $5, 'A Disabled','erp-a-disabled.ch','pilot', $7),
       ($3, $6, 'B Conn',    'erp-b.ch',         'pilot', $8)
     ON CONFLICT (id) DO NOTHING`,
    [REG_A_HEALTHY, REG_A_NEVER, REG_B, REG_A_DISABLED, TENANT_A, TENANT_B, ACTOR_A, ACTOR_B],
  );
  // Disable REG_A_DISABLED.
  await a.query(
    `UPDATE connector_registration SET disabled_at = now(), disabled_by = $2
      WHERE id = $1 AND disabled_at IS NULL`,
    [REG_A_DISABLED, ACTOR_A],
  );

  // Health rows: REG_A_HEALTHY seen now; REG_A_DISABLED also has a (recent) row
  // so we can prove disabled wins over an otherwise-healthy window. REG_A_NEVER
  // and REG_B intentionally have NO health row.
  await a.query(
    `INSERT INTO connector_health
       (id, tenant_id, connector_registration_id, last_seen_at,
        connector_version, backlog_indicator, erpnext_reachable, reported_fields_at)
     VALUES
       ($1, $5, $3, now(), '1.2.3', 0, true, now()),
       ($2, $5, $4, now(), '0.9.0', 7, false, now())
     ON CONFLICT (connector_registration_id) DO NOTHING`,
    [HEALTH_A_HEALTHY, HEALTH_A_DISABLED, REG_A_HEALTHY, REG_A_DISABLED, TENANT_A],
  );
}
