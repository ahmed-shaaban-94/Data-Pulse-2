/**
 * inbound-outbound-adjust.spec.ts — 009-US2-MANUAL (T040, RED).
 *
 * FR-010/011/012/013 + SC-007: a manual inbound (+), outbound (−), and
 * adjustment (signed, mandatory reason) are each APPENDED as movements; the
 * derived on-hand reflects each; and each successful create writes one audit
 * event in the SAME transaction (audit and state cannot diverge — the catalog
 * write idiom).
 *
 * Layer: service + DB against the RLS-active `env.app` pool. Docker-gated.
 * RED until T044 implements `createStockMovement`.
 */
import 'reflect-metadata';

import { Pool } from 'pg';

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
import { seedInventoryFixture } from '../__support__/seed-inventory';
import { CrossUnitError, InventoryService } from '../../../src/inventory/inventory.service';

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
      console.warn(`\n[inbound-outbound-adjust] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn('[inbound-outbound-adjust] skipping — Docker unavailable');
    return true;
  }
  return false;
}

/** Count audit_events for a target id under tenant A's GUC. */
async function auditCountForTarget(targetId: string): Promise<number> {
  const client = await env!.app.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
    const r = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_events WHERE target_id = $1`,
      [targetId],
    );
    await client.query('ROLLBACK');
    return Number(r.rows[0]?.count ?? '0');
  } finally {
    client.release();
  }
}

const principal = { tenantId: TENANT_A, storeId: STORE_A_X, userId: ACTOR_A };

describe('createStockMovement — inbound/outbound/adjustment appended + on-hand reflects (FR-010..013)', () => {
  it('an inbound (+) is appended and on-hand increases by the quantity', async () => {
    if (maybeSkip()) return;
    const before = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'inbound',
      quantity: '4.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });
    expect(m.movementType).toBe('inbound');
    expect(Number(m.quantity)).toBe(4);
    const after = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    expect(Number(after.quantity) - Number(before.quantity)).toBe(4);
  });

  it('an outbound (−) is appended and on-hand decreases', async () => {
    if (maybeSkip()) return;
    const before = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'outbound',
      quantity: '-1.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });
    expect(Number(m.quantity)).toBe(-1);
    const after = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    expect(Number(after.quantity) - Number(before.quantity)).toBe(-1);
  });

  it('an adjustment (signed) with a reason is appended; reason persists', async () => {
    if (maybeSkip()) return;
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'adjustment',
      quantity: '2.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
      reason: 'cycle-count true-up',
    });
    expect(m.movementType).toBe('adjustment');
    expect(m.reason).toBe('cycle-count true-up');
  });

  it('an adjustment WITHOUT a reason is rejected (mandatory reason, FR-012)', async () => {
    if (maybeSkip()) return;
    await expect(
      service.createStockMovement({
        ...principal,
        movementType: 'adjustment',
        quantity: '2.0000',
        stockingUnit: 'ea',
        tenantProductRef: PRODUCT_A_ACTIVE,
      }),
    ).rejects.toThrow(/adjustment requires a reason/i);
  });

  it('each successful create writes exactly one audit event for the movement (SC-007)', async () => {
    if (maybeSkip()) return;
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'inbound',
      quantity: '3.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });
    expect(await auditCountForTarget(m.id)).toBe(1);
  });
});

// Exercises the REAL service branches (cross-unit SQL + sign rules). The
// controller-layer cross-unit test (`cross-unit-reject.spec.ts`) uses a fake
// service, so the actual `assertUnitMatchesEstablished` SQL path and the
// sign-rejection guards only run HERE, against Postgres.
describe('createStockMovement — validation guards exercise the real service (FR-022)', () => {
  it('a cross-unit movement on an EA-established product → CrossUnitError', async () => {
    if (maybeSkip()) return;
    // PRODUCT_A_ACTIVE at STORE_A_X is established in 'ea' (seed fixture).
    await expect(
      service.createStockMovement({
        ...principal,
        movementType: 'inbound',
        quantity: '1.0000',
        stockingUnit: 'case', // ≠ established 'ea'
        tenantProductRef: PRODUCT_A_ACTIVE,
      }),
    ).rejects.toBeInstanceOf(CrossUnitError);
  });

  it('an inbound with a negative quantity is rejected (sign rule)', async () => {
    if (maybeSkip()) return;
    await expect(
      service.createStockMovement({
        ...principal,
        movementType: 'inbound',
        quantity: '-1.0000',
        stockingUnit: 'ea',
        tenantProductRef: PRODUCT_A_ACTIVE,
      }),
    ).rejects.toThrow(/inbound quantity must be positive/i);
  });

  it('an outbound with a positive quantity is rejected (sign rule)', async () => {
    if (maybeSkip()) return;
    await expect(
      service.createStockMovement({
        ...principal,
        movementType: 'outbound',
        quantity: '1.0000',
        stockingUnit: 'ea',
        tenantProductRef: PRODUCT_A_ACTIVE,
      }),
    ).rejects.toThrow(/outbound quantity must be negative/i);
  });

  it('a zero quantity is rejected (non-zero rule)', async () => {
    if (maybeSkip()) return;
    await expect(
      service.createStockMovement({
        ...principal,
        movementType: 'adjustment',
        quantity: '0.0000',
        stockingUnit: 'ea',
        tenantProductRef: PRODUCT_A_ACTIVE,
        reason: 'noop',
      }),
    ).rejects.toThrow(/non-zero/i);
  });

  it('a first movement for a NEW ad-hoc null-product needs no established-unit match', async () => {
    if (maybeSkip()) return;
    // ad-hoc (null product) → cross-unit check is skipped; any unit accepted.
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'adjustment',
      quantity: '1.0000',
      stockingUnit: 'box',
      tenantProductRef: null,
      reason: 'ad-hoc, novel unit',
    });
    expect(m.tenantProductRef).toBeNull();
    expect(m.stockingUnit).toBe('box');
  });
});
