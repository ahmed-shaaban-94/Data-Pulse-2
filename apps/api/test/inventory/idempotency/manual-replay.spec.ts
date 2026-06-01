/**
 * manual-replay.spec.ts — 009-US3 (T050, RED).
 *
 * FR-030 + SC-003: a manual createStockMovement retried with the SAME
 * `Idempotency-Key` and the SAME body returns the SAME movement N times —
 * exactly one row is appended and on-hand is applied once. The replay is served
 * by the existing IdempotencyInterceptor (no new primitive); this spec drives
 * the HTTP layer (the interceptor reads the header off the request).
 *
 * RED until 009-US3 wires `@Idempotent("required")` onto the createStockMovement
 * route + imports IdempotencyModule (so the interceptor's metadata is honored).
 * Docker-gated.
 */
import {
  startMovementHarness,
  stopMovementHarness,
  resetHarness,
  idempKey,
  movementsPath,
  movementBody,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
  type HarnessHandle,
} from './__movement-harness';
import { InventoryService } from '../../../src/inventory/inventory.service';

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startMovementHarness());
}, 180_000);
afterAll(async () => {
  await stopMovementHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));

async function onHandQty(): Promise<number> {
  const svc = new InventoryService(h.harness!.env.app as never);
  const r = await svc.getOnHand({
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    productId: PRODUCT_A_ACTIVE,
  });
  return Number(r.quantity);
}

describe('T050 — manual movement replay (same Idempotency-Key + same body)', () => {
  it('returns the same movement and applies on-hand exactly once across N retries', async () => {
    if (h.dockerSkipped || !h.harness) return;
    const key = idempKey('us3replay');
    const body = movementBody({ movementType: 'inbound', quantity: '4.0000' });

    const before = await onHandQty();

    const first = await h.harness
      .http()
      .post(movementsPath())
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.status).toBe(201);
    const firstId = first.body.id as string;

    // Two more identical retries with the SAME key + body.
    const second = await h.harness
      .http()
      .post(movementsPath())
      .set('Idempotency-Key', key)
      .send(body);
    const third = await h.harness
      .http()
      .post(movementsPath())
      .set('Idempotency-Key', key)
      .send(body);

    // Same movement returned each time (replayed, not re-created).
    expect(second.body.id).toBe(firstId);
    expect(third.body.id).toBe(firstId);

    // On-hand moved by the quantity exactly ONCE (not 3×).
    const after = await onHandQty();
    expect(after - before).toBe(4);
  });
});
