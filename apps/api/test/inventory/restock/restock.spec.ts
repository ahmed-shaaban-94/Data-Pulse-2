/**
 * restock.spec.ts — 009-RESTOCK (T090/T091, RED).
 *
 * Void/refund/return → restock = a manual/backfill INBOUND movement that
 * references the originating 008 void/refund terminal event as provenance,
 * deduped idempotently on (source_system, external_id) per FR-031 (FR-025/R6).
 * The INBOUND mirror of US4's sale-linked outbound — same provenance-dedup
 * machinery, opposite sign.
 *
 *   T090 — restock inbound: appends an inbound referencing a void terminal
 *           event, on-hand increases, provenance recorded.
 *   T091 — idempotent on the provenance pair: a redelivered restock appends no
 *           second movement and re-applies no on-hand (FR-031); a distinct
 *           externalId is a separate restock.
 *
 * Automatic restock-on-void is explicitly DEFERRED (FR-025/FR-060) — there is
 * NO auto route; this is the manual/backfill entry only. Docker-gated.
 */
import {
  startRestockHarness,
  stopRestockHarness,
  resetHarness,
  onHand,
  restockInput,
  PRODUCT_A_ACTIVE,
  STORE_A_X,
  TENANT_A,
  VOID_A_X,
  type HarnessHandle,
} from './__restock-harness';

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startRestockHarness());
}, 180_000);
afterAll(async () => {
  await stopRestockHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));

describe('T090 — restock inbound references an 008 void terminal event (FR-025)', () => {
  it('appends an inbound, increases on-hand, and records the terminal-event provenance', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const before = await onHand(h.harness);

    const mv = await h.harness.service.backfillRestockInbound(
      restockInput('void-line-T090-001') as never,
    );
    expect(mv.movementType).toBe('inbound');
    expect(mv.terminalEventRef).toBe(VOID_A_X);
    expect(Number(mv.quantity)).toBe(2);

    // On-hand increased by the restocked quantity.
    expect((await onHand(h.harness)) - before).toBe(2);

    // The terminal-event provenance is visible on the movement list.
    const list = await h.harness.service.listStockMovements({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      productId: PRODUCT_A_ACTIVE,
    });
    const found = list.items.find((m) => m.id === mv.id);
    expect(found?.terminalEventRef).toBe(VOID_A_X);
  });
});

describe('T091 — restock is idempotent on the provenance pair (FR-031)', () => {
  it('re-running the same restock appends nothing and leaves on-hand unchanged', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const externalId = 'void-line-T091-001';
    const before = await onHand(h.harness);

    const first = await h.harness.service.backfillRestockInbound(
      restockInput(externalId) as never,
    );
    const afterFirst = await onHand(h.harness);
    expect(afterFirst - before).toBe(2);

    const second = await h.harness.service.backfillRestockInbound(
      restockInput(externalId) as never,
    );
    // Dedup: same movement returned, no new row, on-hand unchanged.
    expect(second.id).toBe(first.id);
    expect(await onHand(h.harness)).toBe(afterFirst);
  });

  it('treats a distinct externalId as a separate restock', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const before = await onHand(h.harness);
    const a = await h.harness.service.backfillRestockInbound(
      restockInput('void-line-T091-002') as never,
    );
    const b = await h.harness.service.backfillRestockInbound(
      restockInput('void-line-T091-003') as never,
    );
    expect(b.id).not.toBe(a.id);
    // Two distinct inbounds → on-hand +4.
    expect((await onHand(h.harness)) - before).toBe(4);
  });

  it('rejects a non-positive (outbound-signed) restock quantity', async () => {
    if (h.dockerSkipped || !h.harness) return;

    await expect(
      h.harness.service.backfillRestockInbound(
        restockInput('void-line-T091-neg', { quantity: '-2.0000' }) as never,
      ),
    ).rejects.toThrow();
  });
});
