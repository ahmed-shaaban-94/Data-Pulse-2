/**
 * negative-balance.spec.ts — 009-SIGNAL-NEGBAL (T045).
 *
 * The allow-and-flag negative-stock policy (FR-024 / plan §3.3): an outbound
 * that drives a (tenant, store, product) on-hand below zero is NEVER rejected —
 * the movement is appended, on-hand may go negative, the on-hand projection
 * carries `negativeBalance: true`, AND the NEW `inventory_negative_balance_total`
 * counter increments. A non-negative outbound does NOT increment it.
 *
 * The counter is observed by mocking the emission helper (the OTel instrument is
 * no-op without a registered MetricReader — the established api.metrics test
 * idiom). The on-hand flag is asserted against the real Docker DB. Docker-gated.
 */
import 'reflect-metadata';

// Mock the emission helper BEFORE the service imports it (jest hoists this).
jest.mock('../../../src/observability/metrics/api.metrics', () => {
  const actual = jest.requireActual('../../../src/observability/metrics/api.metrics');
  return { ...actual, recordInventoryNegativeBalance: jest.fn() };
});

import type { Pool } from 'pg';

import {
  applyAllUpAndCreateAppRole,
  startPgEnv,
  stopPgEnv,
  type PgTestEnv,
} from '../../_helpers/postgres-container';
import {
  seedCatalogIsolationFixture,
  ACTOR_A,
  PRODUCT_A_ACTIVE,
  PRODUCT_A_RETIRED,
  STORE_A_X,
  TENANT_A,
} from '../../catalog/__support__/isolation-harness';
import { seedInventoryFixture } from '../__support__/seed-inventory';

import { recordInventoryNegativeBalance } from '../../../src/observability/metrics/api.metrics';
import { InventoryService } from '../../../src/inventory/inventory.service';

const recordNegBal = recordInventoryNegativeBalance as jest.MockedFunction<
  typeof recordInventoryNegativeBalance
>;

let env: PgTestEnv | null = null;
let service: InventoryService | null = null;
let dockerSkipped = false;

beforeAll(async () => {
  try {
    env = await startPgEnv();
    await applyAllUpAndCreateAppRole(env);
    await seedCatalogIsolationFixture(env);
    await seedInventoryFixture(env);
    service = new InventoryService(env.app as unknown as Pool);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (process.env['MIGRATION_TEST_ALLOW_SKIP'] === '1') {
      console.warn(`\n[inventory/signal/negative-balance] Docker NOT AVAILABLE: ${msg}\n`);
      dockerSkipped = true;
      return;
    }
    throw new Error(`Container start failed: ${msg}`);
  }
}, 180_000);

afterAll(async () => {
  if (env) await stopPgEnv(env);
}, 60_000);

beforeEach(() => recordNegBal.mockClear());

function maybeSkip(): boolean {
  return dockerSkipped || !env || !service;
}

describe('T045 — negative-balance allow-and-flag signal (FR-024)', () => {
  it('flags negativeBalance on the on-hand projection and increments the counter when an outbound drives on-hand below zero', async () => {
    if (maybeSkip()) return;

    // PRODUCT_A_RETIRED at A.X has no seeded movements → on-hand 0. Establish a
    // small inbound, then an outbound that exceeds it → on-hand negative.
    await service!.createStockMovement({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      userId: ACTOR_A,
      movementType: 'inbound',
      quantity: '2.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_RETIRED,
    });
    recordNegBal.mockClear(); // ignore any emission from setup

    const mv = await service!.createStockMovement({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      userId: ACTOR_A,
      movementType: 'outbound',
      quantity: '-5.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_RETIRED,
    });
    // The movement is recorded (never rejected) ...
    expect(mv.movementType).toBe('outbound');

    // ... on-hand is negative and flagged ...
    const onHand = await service!.getOnHand({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_RETIRED,
    });
    expect(Number(onHand.quantity)).toBe(-3);
    expect(onHand.negativeBalance).toBe(true);

    // ... and the negative-balance counter incremented exactly once.
    expect(recordNegBal).toHaveBeenCalledTimes(1);
  });

  it('does NOT increment the counter when an outbound leaves on-hand non-negative', async () => {
    if (maybeSkip()) return;

    // PRODUCT_A_ACTIVE at A.X has seeded inbound on-hand (positive). A small
    // outbound that stays non-negative must NOT flag.
    const before = Number(
      (
        await service!.getOnHand({
          tenantId: TENANT_A,
          storeId: STORE_A_X,
          productId: PRODUCT_A_ACTIVE,
        })
      ).quantity,
    );
    expect(before).toBeGreaterThan(0); // precondition: positive seeded on-hand

    await service!.createStockMovement({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      userId: ACTOR_A,
      movementType: 'outbound',
      quantity: '-1.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });

    expect(recordNegBal).not.toHaveBeenCalled();
  });
});
