/**
 * divergent-body.spec.ts — 009-US3 (T051, RED).
 *
 * FR-030: re-using the SAME `Idempotency-Key` with a DIFFERENT body is a
 * deterministic conflict (409) with NO side-effect — the second (divergent)
 * request must not append a movement nor move on-hand. Served by the existing
 * IdempotencyInterceptor's body-fingerprint check (no new primitive). HTTP-layer.
 *
 * RED until 009-US3 wires `@Idempotent("required")` onto the route. Docker-gated.
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

describe('T051 — manual movement divergent body under the same Idempotency-Key', () => {
  it('rejects a different body under the same key with 409 and applies no side-effect', async () => {
    if (h.dockerSkipped || !h.harness) return;
    const key = idempKey('us3diverge');

    const first = await h.harness
      .http()
      .post(movementsPath())
      .set('Idempotency-Key', key)
      .send(movementBody({ movementType: 'inbound', quantity: '4.0000' }));
    expect(first.status).toBe(201);

    const afterFirst = await onHandQty();

    // Same key, DIFFERENT body (different quantity) → deterministic conflict.
    const divergent = await h.harness
      .http()
      .post(movementsPath())
      .set('Idempotency-Key', key)
      .send(movementBody({ movementType: 'inbound', quantity: '9.0000' }));

    expect(divergent.status).toBe(409);

    // No side-effect: on-hand unchanged by the rejected divergent request.
    const afterDivergent = await onHandQty();
    expect(afterDivergent).toBe(afterFirst);
  });
});
