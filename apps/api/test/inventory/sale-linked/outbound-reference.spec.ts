/**
 * outbound-reference.spec.ts — 009-US4 (T060, RED).
 *
 * FR-032 (US4 scenarios 1/3): a sale-linked outbound referencing a captured
 * 008 `sale_id`/`sale_line_id` is appended with the provenance ref recorded,
 * on-hand decreases, and the ref is visible on the movement list. Driven over
 * the HTTP createStockMovement route (the reference path is the public API
 * surface; the off-request backfill path is T064/worker).
 *
 * DECOUPLING: the referenced 008 sale is in the CAPTURED state (processed_at
 * NULL) — this flow reads it directly, no event subscription (R8). Docker-gated.
 */
import {
  startSaleLinkedHarness,
  stopSaleLinkedHarness,
  resetHarness,
  idempKey,
  movementsPath,
  saleLinkedOutboundBody,
  PRODUCT_A_ACTIVE,
  SALE_A_X,
  LINE_A_X_1,
  STORE_A_X,
  TENANT_A,
  type HarnessHandle,
} from './__sale-linked-harness';

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startSaleLinkedHarness());
}, 180_000);
afterAll(async () => {
  await stopSaleLinkedHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));

async function onHandQty(): Promise<number> {
  const r = await h.harness!.service.getOnHand({
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    productId: PRODUCT_A_ACTIVE,
  });
  return Number(r.quantity);
}

describe('T060 — sale-linked outbound references a captured 008 sale (FR-032)', () => {
  it('records the provenance ref, decrements on-hand, and surfaces the ref on the movement list', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const before = await onHandQty();

    const res = await h.harness
      .http()
      .post(movementsPath())
      .set('Idempotency-Key', idempKey('us4saleref'))
      .send(saleLinkedOutboundBody({ quantity: '-2.0000' }));

    expect(res.status).toBe(201);
    // Provenance recorded on the movement.
    expect(res.body.saleId).toBe(SALE_A_X);
    expect(res.body.saleLineId).toBe(LINE_A_X_1);
    expect(res.body.movementType).toBe('outbound');

    // On-hand decreased by the outbound quantity.
    const after = await onHandQty();
    expect(after - before).toBe(-2);

    // The provenance ref is visible on the movement list for the product.
    const list = await h.harness
      .http()
      .get(`${movementsPath()}?productId=${PRODUCT_A_ACTIVE}`)
      .send();
    expect(list.status).toBe(200);
    const found = (list.body.items as Array<{ id: string; saleId: string | null }>).find(
      (m) => m.id === res.body.id,
    );
    expect(found).toBeDefined();
    expect(found?.saleId).toBe(SALE_A_X);
  });
});
