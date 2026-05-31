/**
 * append-only.spec.ts — 009-US2-MANUAL (T042, RED).
 *
 * FR-001/012: the ledger is append-only. An adjustment is a NEW movement layered
 * on top of history — it never mutates a prior movement. The service exposes NO
 * update/delete path for a historical movement, and 0014 gives stock_movements
 * FOR SELECT + FOR INSERT policies ONLY (no UPDATE/DELETE policy) — so under
 * FORCE RLS a raw UPDATE/DELETE matches ZERO rows (it does not raise; the
 * historical row is left untouched). The assertions below prove that
 * enforcement-agnostically (0 rows affected + row unchanged via the admin pool).
 *
 * Layer: service + DB against the RLS-active `env.app` pool. Docker-gated.
 * RED until T044 (the create path the "new movement" assertions depend on).
 */
import 'reflect-metadata';

import { type PoolClient, Pool } from 'pg';

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from '../../_helpers/postgres-container';
import {
  seedCatalogIsolationFixture,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
  ACTOR_A,
} from '../../catalog/__support__/isolation-harness';
import { seedInventoryFixture, MOVE_A_X } from '../__support__/seed-inventory';
import { InventoryService } from '../../../src/inventory/inventory.service';

let env: PgTestEnv | null = null;
let dockerSkipped = false;
let service: InventoryService;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedInventoryFixture(env);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      dockerSkipped = true;
      // eslint-disable-next-line no-console
      console.warn(`\n[append-only] Docker NOT AVAILABLE: ${msg}\n`);
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
  service = new InventoryService(env.app as unknown as Pool);
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

function maybeSkip(): boolean {
  if (dockerSkipped) {
    // eslint-disable-next-line no-console
    console.warn('[append-only] skipping — Docker unavailable');
    return true;
  }
  return false;
}

async function withTenantClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await env!.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
    const result = await work(client);
    await client.query('ROLLBACK');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

const principal = { tenantId: TENANT_A, storeId: STORE_A_X, userId: ACTOR_A };

describe('append-only ledger (FR-001/012)', () => {
  it('an adjustment is a NEW movement; the prior movement count strictly increases', async () => {
    if (maybeSkip()) return;
    const countBefore = await withTenantClient(async (client) => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM stock_movements
          WHERE store_id = $1 AND tenant_product_ref = $2`,
        [STORE_A_X, PRODUCT_A_ACTIVE],
      );
      return Number(r.rows[0]?.count ?? '0');
    });
    await service.createStockMovement({
      ...principal,
      movementType: 'adjustment',
      quantity: '1.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
      reason: 'append-only proof',
    });
    const countAfter = await withTenantClient(async (client) => {
      const r = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM stock_movements
          WHERE store_id = $1 AND tenant_product_ref = $2`,
        [STORE_A_X, PRODUCT_A_ACTIVE],
      );
      return Number(r.rows[0]?.count ?? '0');
    });
    expect(countAfter).toBe(countBefore + 1); // appended, not mutated
  });

  it('the service exposes NO update or delete method for a movement', () => {
    if (maybeSkip()) return;
    expect((service as unknown as Record<string, unknown>)['updateStockMovement']).toBeUndefined();
    expect((service as unknown as Record<string, unknown>)['deleteStockMovement']).toBeUndefined();
  });

  // Enforcement model (0014): stock_movements has FOR SELECT + FOR INSERT
  // policies ONLY — no UPDATE/DELETE policy. Under FORCE RLS, an UPDATE/DELETE
  // with no applicable permissive policy is treated as `USING (false)`: it
  // affects ZERO rows and does NOT raise. (Distinct from `audit_events`, whose
  // single no-FOR-clause policy DOES admit a same-tenant UPDATE.) So the
  // append-only proof is enforcement-AGNOSTIC: attempt the mutation under the
  // app role, then verify via the RLS-bypassing admin pool that the historical
  // row is UNCHANGED / still present. This passes whether enforcement is by
  // policy-absence (current) or by a future REVOKE of UPDATE/DELETE grants.

  it('a raw UPDATE on a historical movement under the app role changes nothing (no UPDATE policy)', async () => {
    if (maybeSkip()) return;
    // Read the true (pre-attempt) quantity via the admin pool (RLS-bypassing).
    const before = await env!.admin.query<{ quantity: string }>(
      `SELECT quantity FROM stock_movements WHERE id = $1`,
      [MOVE_A_X],
    );
    const original = before.rows[0]?.quantity;
    expect(original).toBeDefined();

    // Attempt the mutation under the RLS-active app role. It does not raise; it
    // matches zero rows (no FOR UPDATE policy → USING (false)).
    const affected = await withTenantClient(async (client) => {
      const r = await client.query(`UPDATE stock_movements SET quantity = 999.0000 WHERE id = $1`, [
        MOVE_A_X,
      ]);
      return r.rowCount ?? 0;
    });
    expect(affected).toBe(0); // append-only: the UPDATE touched nothing

    // The historical quantity is unchanged.
    const after = await env!.admin.query<{ quantity: string }>(
      `SELECT quantity FROM stock_movements WHERE id = $1`,
      [MOVE_A_X],
    );
    expect(after.rows[0]?.quantity).toBe(original);
  });

  it('a raw DELETE on a historical movement under the app role removes nothing (no DELETE policy)', async () => {
    if (maybeSkip()) return;
    const affected = await withTenantClient(async (client) => {
      const r = await client.query(`DELETE FROM stock_movements WHERE id = $1`, [MOVE_A_X]);
      return r.rowCount ?? 0;
    });
    expect(affected).toBe(0); // append-only: the DELETE removed nothing

    // The row is still present (verified via the RLS-bypassing admin pool).
    const after = await env!.admin.query<{ id: string }>(
      `SELECT id FROM stock_movements WHERE id = $1`,
      [MOVE_A_X],
    );
    expect(after.rows).toHaveLength(1);
  });
});
