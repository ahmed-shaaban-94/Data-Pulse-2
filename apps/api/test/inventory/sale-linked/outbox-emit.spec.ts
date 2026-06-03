/**
 * outbox-emit.spec.ts — 009 follow-up (issue #465 part B) — movement outbox emit.
 *
 * Proves the `inventory.movement.created` outbox event is written
 * IN-TRANSACTION with the movement append, and — the load-bearing assertion —
 * that a redelivered backfill (same sourceSystem+externalId) leaves EXACTLY ONE
 * such event, not two (the dedup early-return must skip the emit, or FR-033
 * idempotency is broken at the event layer). Outbox rows are read via the admin
 * pool (RLS-bypass), the same way the backfill spec counts movements.
 *
 * Docker-gated (Testcontainers via the shared sale-linked harness).
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

const EVENT_TYPE = 'inventory.movement.created';

const h: HarnessHandle = { harness: null, dockerSkipped: false };

beforeAll(async () => {
  Object.assign(h, await startSaleLinkedHarness());
}, 180_000);
afterAll(async () => {
  await stopSaleLinkedHarness(h);
}, 60_000);
beforeEach(() => resetHarness(h));

/** Count inventory.movement.created outbox rows referencing a given movement id. */
async function outboxRowsForMovement(movementId: string): Promise<number> {
  const r = await h.harness!.env.admin.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM outbox_events
      WHERE event_type = $1 AND payload->'movementIds' ? $2`,
    [EVENT_TYPE, movementId],
  );
  return Number(r.rows[0]!.n);
}

function backfillInput(externalId: string) {
  return {
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    userId: ACTOR_A,
    sourceSystem: 'pos-backfill',
    externalId,
    movementType: 'outbound' as const,
    quantity: '-2.0000',
    stockingUnit: 'ea',
    tenantProductRef: PRODUCT_A_ACTIVE,
    saleId: SALE_A_X,
    saleLineId: LINE_A_X_1,
    correlationId: 'corr-465b',
  };
}

describe('issue #465 B — inventory.movement.created emitted in-transaction', () => {
  it('a manual create emits exactly one event, atomic with the movement', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const mv = await h.harness.service.createStockMovement({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      userId: ACTOR_A,
      movementType: 'inbound',
      quantity: '3.0000',
      stockingUnit: 'ea',
      tenantProductRef: PRODUCT_A_ACTIVE,
    });

    expect(await outboxRowsForMovement(mv.id)).toBe(1);

    // The event row is pending + carries the new type + no money/PII payload.
    const row = await h.harness.env.admin.query<{
      event_type: string;
      delivery_state: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, delivery_state, payload FROM outbox_events
        WHERE event_type = $1 AND payload->'movementIds' ? $2`,
      [EVENT_TYPE, mv.id],
    );
    expect(row.rows[0]?.delivery_state).toBe('pending');
    expect(row.rows[0]?.payload).not.toHaveProperty('quantity');
    expect(row.rows[0]?.payload['movementType']).toBe('inbound');
  });

  it('a redelivered backfill leaves EXACTLY ONE event — the dedup skips the emit (FR-033)', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const externalId = 'sale-line-465b-001';

    const first = await h.harness.service.backfillSaleLinkedOutbound(
      backfillInput(externalId) as never,
    );
    expect(await outboxRowsForMovement(first.id)).toBe(1);

    // Re-run with the SAME provenance pair — dedups to the same movement, and
    // MUST NOT emit a second event.
    const second = await h.harness.service.backfillSaleLinkedOutbound(
      backfillInput(externalId) as never,
    );
    expect(second.id).toBe(first.id);
    expect(await outboxRowsForMovement(first.id)).toBe(1); // still one, not two
  });
});
