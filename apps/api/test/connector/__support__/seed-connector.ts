/**
 * apps/api/test/connector/__support__/seed-connector.ts
 *
 * Slice 018-ISOLATION-HARNESS (T030) — connector_registration test fixtures.
 *
 * Seeds the 018 connector boundary tables via the `admin` (RLS-bypassing) pool:
 *   - a tenant-A connector_registration (the in-scope target);
 *   - a tenant-B connector_registration (the cross-tenant target the sweep
 *     proves A cannot read);
 *   - a synthetic LINKED connector credential on auth_tokens for tenant A
 *     (scope='connector', connector_registration_id set) — the US1/US4 fixtures
 *     build on this; the sweep only needs the registration rows.
 *
 * connector_registration is TENANT-only (no store axis), so this sets only
 * `app.current_tenant` context implicitly via the admin pool's direct INSERTs.
 *
 * IMPORTANT (execution-map stop): this file MUST NOT modify the 003-owned
 * `isolation-harness.ts`. It imports its IDs and seeds only NEW rows via the
 * `admin` pool. `.ts` (not `.spec.ts`) so Jest does not collect it as a test.
 *
 * IDs use the `…0c018…` mnemonic shape (hex a-f only) to stay unique against the
 * catalog / 008 / 013 / 014 / 015 / 017 corpora.
 */
import {
  ACTOR_A,
  ACTOR_B,
  TENANT_A,
  TENANT_B,
} from "../../catalog/__support__/isolation-harness";

export interface SeedableEnv {
  admin: {
    query: (text: string, params?: unknown[]) => Promise<unknown>;
  };
}

// ----------------------------------------------------------------------------
// 018-specific fixture IDs
// ----------------------------------------------------------------------------

/** Tenant A — an active connector registration (the in-scope target). */
export const REGISTRATION_A = "0c000000-0000-7000-8000-00000c018a01";
/** Tenant B — a connector registration (the cross-tenant target). */
export const REGISTRATION_B = "0c000000-0000-7000-8000-00000c018b01";
/** Tenant A — a synthetic linked connector credential (auth_tokens). */
export const CREDENTIAL_A = "0c000000-0000-7000-8000-00000c018a02";

export const CONNECTOR_FIXTURE_IDS = {
  tenantA: TENANT_A,
  tenantB: TENANT_B,
  registrationA: REGISTRATION_A,
  registrationB: REGISTRATION_B,
  credentialA: CREDENTIAL_A,
} as const;

const TOKEN_HASH_A = Buffer.from("c".repeat(64), "hex");

/**
 * Seed the 018 connector fixtures via the admin pool. Idempotent (ON CONFLICT
 * DO NOTHING). Assumes the shared catalog isolation harness (tenants + users)
 * has already been seeded, or seeds the minimal tenant/user rows itself.
 */
export async function seedConnectorFixture(env: SeedableEnv): Promise<void> {
  const a = env.admin;

  // Minimal tenant + actor rows (idempotent — may already exist from a shared harness).
  await a.query(
    `INSERT INTO tenants (id, slug, name, default_currency_code)
     VALUES ($1, 'cxa', 'CXA', 'USD'), ($2, 'cxb', 'CXB', 'USD')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B],
  );
  await a.query(
    `INSERT INTO users (id, email, password_hash)
     VALUES ($1, 'cxa@fixture.invalid', NULL), ($2, 'cxb@fixture.invalid', NULL)
     ON CONFLICT (id) DO NOTHING`,
    [ACTOR_A, ACTOR_B],
  );

  // Tenant-A registration (active) + tenant-B registration (cross-tenant target).
  await a.query(
    `INSERT INTO connector_registration
       (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
     VALUES ($1, $2, 'Conn A', 'erp-a.example', 'pilot', $3)
     ON CONFLICT (id) DO NOTHING`,
    [REGISTRATION_A, TENANT_A, ACTOR_A],
  );
  await a.query(
    `INSERT INTO connector_registration
       (id, tenant_id, display_name, erpnext_site_ref, environment, created_by)
     VALUES ($1, $2, 'Conn B', 'erp-b.example', 'pilot', $3)
     ON CONFLICT (id) DO NOTHING`,
    [REGISTRATION_B, TENANT_B, ACTOR_B],
  );

  // A synthetic LINKED connector credential for tenant A (US1/US4 build on this).
  await a.query(
    `INSERT INTO auth_tokens
       (id, token_hash, tenant_id, user_id, scope, expires_at, connector_registration_id)
     VALUES ($1, $2, $3, $4, 'connector', now() + interval '90 days', $5)
     ON CONFLICT (id) DO NOTHING`,
    [CREDENTIAL_A, TOKEN_HASH_A, TENANT_A, ACTOR_A, REGISTRATION_A],
  );
}
