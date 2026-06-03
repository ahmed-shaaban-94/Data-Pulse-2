/**
 * provenance-dedup.spec.ts — 009-US4 (T052, RED).
 *
 * FR-031/033 (US4 backfill idempotency): the off-request, worker-internal
 * backfill entry writes a sale-linked outbound carrying the provenance dedup
 * pair `(source_system, external_id)`. Re-invoking it with the SAME provenance
 * MUST be idempotent — exactly one movement is appended, on-hand is applied
 * once, and the second call returns the already-persisted movement WITHOUT a
 * second side-effect (the partial-unique `uq_stock_movements_tenant_source_external`
 * is the dedup primitive — R4, migration 0014).
 *
 * This is the SERVICE-LAYER half of US4 (the backfill is off-request — there is
 * no HTTP route; the public createStockMovement DTO stays `.strict()` +
 * provenance-free, FR-052). It exercises the worker-internal entry directly on
 * `harness.service`, the InventoryService instance the harness exposes. The
 * worker PROCESSOR that orchestrates this entry over captured 008 rows is T064
 * (apps/worker, Docker harness).
 *
 * RED rationale (execution-map F-05): this method does NOT exist on
 * InventoryService today. US2 added only the strict, provenance-free
 * createStockMovement; no caller writes the `(source_system, external_id)` pair.
 * So this spec fails to compile / run until the GREEN entry lands. Docker-gated.
 */
import {
  startSaleLinkedHarness,
  stopSaleLinkedHarness,
  resetHarness,
  PRODUCT_A_ACTIVE,
  SALE_A_X,
  LINE_A_X_1,
  STORE_A_X,
  TENANT_A,
  ACTOR_A,
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

/** A worker-internal backfill input referencing a captured 008 sale (R8). */
function backfillInput(externalId: string): {
  tenantId: string;
  storeId: string;
  userId: string;
  sourceSystem: string;
  externalId: string;
  movementType: 'outbound';
  quantity: string;
  stockingUnit: string;
  tenantProductRef: string;
  saleId: string;
  saleLineId: string;
  correlationId: string;
} {
  return {
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    userId: ACTOR_A,
    sourceSystem: 'pos-backfill',
    externalId,
    movementType: 'outbound',
    quantity: '-2.0000',
    stockingUnit: 'ea',
    tenantProductRef: PRODUCT_A_ACTIVE,
    saleId: SALE_A_X,
    saleLineId: LINE_A_X_1,
    correlationId: 'corr-us4-t052',
  };
}

describe('T052 — backfill provenance dedup is idempotent (FR-031/033)', () => {
  it('appends one movement, applies on-hand once, and re-run returns the same movement with no second side-effect', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const externalId = 'sale-line-T052-001';
    const before = await onHandQty();

    // First backfill of this captured sale line.
    const first = await h.harness.service.backfillSaleLinkedOutbound(
      backfillInput(externalId),
    );
    expect(first.movementType).toBe('outbound');
    expect(first.saleId).toBe(SALE_A_X);
    expect(first.saleLineId).toBe(LINE_A_X_1);

    const afterFirst = await onHandQty();
    expect(afterFirst - before).toBe(-2);

    // Re-run with the SAME provenance pair (a redelivered backfill job).
    const second = await h.harness.service.backfillSaleLinkedOutbound(
      backfillInput(externalId),
    );

    // Dedup: SAME movement returned, NOT a new row.
    expect(second.id).toBe(first.id);

    // On-hand is unchanged by the re-run — the side-effect applied exactly once.
    const afterSecond = await onHandQty();
    expect(afterSecond).toBe(afterFirst);

    // The ledger holds exactly one movement for this provenance pair.
    const list = await h.harness.service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const matching = list.items.filter((m) => m.id === first.id);
    expect(matching).toHaveLength(1);
  });

  it('treats a distinct externalId as a separate movement (dedup is per provenance pair, not global)', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const before = await onHandQty();

    const a = await h.harness.service.backfillSaleLinkedOutbound(
      backfillInput('sale-line-T052-002'),
    );
    const b = await h.harness.service.backfillSaleLinkedOutbound(
      backfillInput('sale-line-T052-003'),
    );

    expect(b.id).not.toBe(a.id);

    // Two distinct outbounds → on-hand applied twice.
    const after = await onHandQty();
    expect(after - before).toBe(-4);
  });
});
