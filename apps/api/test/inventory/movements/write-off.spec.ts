/**
 * write-off.spec.ts — 009-US2-MANUAL (T041, RED).
 *
 * FR-002 (write-off clause): a write-off (damaged / expired / shrinkage) is
 * recorded as a REASON-CODED `outbound` — NOT a new `movement_type` enum
 * member. The set of movement types stays {inbound, outbound, adjustment,
 * transfer, count_correction}; "write-off" is a semantic of the `reason` on an
 * outbound, so on-hand decreases like any outbound and the reason makes it
 * distinguishable on the movement list.
 *
 * Layer: service + DB against the RLS-active `env.app` pool. Docker-gated.
 * RED until T044.
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
      console.warn(`\n[write-off] Docker NOT AVAILABLE: ${msg}\n`);
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
    console.warn('[write-off] skipping — Docker unavailable');
    return true;
  }
  return false;
}

const principal = { tenantId: TENANT_A, storeId: STORE_A_X, userId: ACTOR_A };

describe('createStockMovement — write-off is a reason-coded outbound (FR-002)', () => {
  it('a damaged-stock write-off records an OUTBOUND distinguished by reason, not a new type', async () => {
    if (maybeSkip()) return;
    const before = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'outbound',
      quantity: '-2.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
      reason: 'write-off:damaged',
    });
    // The type stays "outbound"; the reason carries the write-off semantic.
    expect(m.movementType).toBe('outbound');
    expect(m.reason).toBe('write-off:damaged');
    const after = await service.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    expect(Number(after.quantity) - Number(before.quantity)).toBe(-2);
  });

  it("'write-off' is NOT an accepted movementType (no enum member)", async () => {
    if (maybeSkip()) return;
    await expect(
      service.createStockMovement({
        ...principal,
        // @ts-expect-error — write-off is not a movementType; this must be rejected
        movementType: 'write-off',
        quantity: '-2.0000',
        stockingUnit: 'ea',
        tenantProductRef: PRODUCT_A_ACTIVE,
        reason: 'damaged',
      }),
    ).rejects.toBeDefined();
  });

  it('the write-off outbound is visible on the movement list with its reason', async () => {
    if (maybeSkip()) return;
    const m = await service.createStockMovement({
      ...principal,
      movementType: 'outbound',
      quantity: '-1.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
      reason: 'write-off:expired',
    });
    const list = await service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const found = list.items.find((x) => x.id === m.id);
    expect(found?.reason).toBe('write-off:expired');
    expect(found?.movementType).toBe('outbound');
  });
});
