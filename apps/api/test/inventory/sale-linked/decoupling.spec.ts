/**
 * decoupling.spec.ts — 009-US4 (T061 / T062 / T063, service-layer half).
 *
 * The three remaining SERVICE-LAYER proofs of the sale-linked backfill, run
 * against `harness.service.backfillSaleLinkedOutbound` (off-request; the worker
 * PROCESSOR that drives it over captured rows is T064/worker harness):
 *
 *   T061 — DECOUPLING (FR-032/060, SC-002, R8): the backfill consumes a CAPTURED
 *          008 sale (processed_at IS NULL) and succeeds with the 008 live loop
 *          UNWIRED. The flow never reads/waits on processed_at and never mutates
 *          the sale fact — sale ids are recorded by value as provenance only.
 *   T062 — RE-RUN IDEMPOTENT (FR-033): re-running the SAME backfill batch (every
 *          line redelivered) appends no duplicate movement and leaves on-hand
 *          unchanged — the provenance partial-unique absorbs the replay.
 *   T063 — AD-HOC NULL-PRODUCT (FR-023, R5): a backfill with a null
 *          tenant_product_ref is appended (provenance only) but is NEVER
 *          auto-created as a product and rolls up to NO product's on-hand.
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
  LINE_A_X_2,
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

async function onHandQty(productId: string): Promise<number> {
  const r = await h.harness!.service.getOnHand({
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    productId,
  });
  return Number(r.quantity);
}

/** One backfilled outbound per captured sale line. */
function lineBackfill(saleLineId: string, externalId: string) {
  return {
    tenantId: TENANT_A,
    storeId: STORE_A_X,
    userId: ACTOR_A,
    sourceSystem: 'pos-backfill',
    externalId,
    movementType: 'outbound' as const,
    quantity: '-1.0000',
    stockingUnit: 'ea',
    tenantProductRef: PRODUCT_A_ACTIVE,
    saleId: SALE_A_X,
    saleLineId,
    correlationId: 'corr-us4-decoupling',
  };
}

describe('T061 — backfill is decoupled from the 008 live loop (FR-032/060, R8)', () => {
  it('consumes a CAPTURED sale (processed_at NULL) and never touches the sale fact', async () => {
    if (h.dockerSkipped || !h.harness) return;

    // Precondition: the seeded 008 sale is in the CAPTURED state — the live loop
    // is unwired, so processed_at is NULL. The backfill depends on nothing else.
    const captured = await h.harness.env.admin.query<{ processed_at: Date | null }>(
      `SELECT processed_at FROM sales WHERE id = $1`,
      [SALE_A_X],
    );
    expect(captured.rows[0]?.processed_at).toBeNull();

    const saleBefore = await h.harness.env.admin.query<{ pos_total: string; processed_at: Date | null }>(
      `SELECT pos_total, processed_at FROM sales WHERE id = $1`,
      [SALE_A_X],
    );

    const before = await onHandQty(PRODUCT_A_ACTIVE);
    const mv = await h.harness.service.backfillSaleLinkedOutbound(
      lineBackfill(LINE_A_X_1, 'decouple-line-1'),
    );
    expect(mv.saleId).toBe(SALE_A_X);

    // On-hand decremented — the flow worked with the live loop UNWIRED.
    expect((await onHandQty(PRODUCT_A_ACTIVE)) - before).toBe(-1);

    // The 008 sale fact is untouched: processed_at still NULL, pos_total unchanged
    // (read-only provenance; the backfill never mutates the sale).
    const saleAfter = await h.harness.env.admin.query<{ pos_total: string; processed_at: Date | null }>(
      `SELECT pos_total, processed_at FROM sales WHERE id = $1`,
      [SALE_A_X],
    );
    expect(saleAfter.rows[0]?.processed_at).toBeNull();
    expect(saleAfter.rows[0]?.pos_total).toBe(saleBefore.rows[0]?.pos_total);
  });
});

describe('T062 — re-running the backfill batch is idempotent (FR-033)', () => {
  it('appends no duplicate and leaves on-hand unchanged when every line is redelivered', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const batch = [
      lineBackfill(LINE_A_X_1, 'rerun-line-1'),
      lineBackfill(LINE_A_X_2, 'rerun-line-2'),
    ];

    const before = await onHandQty(PRODUCT_A_ACTIVE);

    // First pass: two distinct lines → two movements.
    const firstPass = [];
    for (const job of batch) {
      firstPass.push(await h.harness.service.backfillSaleLinkedOutbound(job));
    }
    const afterFirst = await onHandQty(PRODUCT_A_ACTIVE);
    expect(afterFirst - before).toBe(-2);

    // Second pass: the WHOLE batch redelivered → same movements, no new rows.
    const secondPass = [];
    for (const job of batch) {
      secondPass.push(await h.harness.service.backfillSaleLinkedOutbound(job));
    }
    expect(secondPass.map((m) => m.id).sort()).toEqual(firstPass.map((m) => m.id).sort());

    // On-hand unchanged by the replay — applied exactly once per line.
    expect(await onHandQty(PRODUCT_A_ACTIVE)).toBe(afterFirst);
  });
});

describe('T063 — ad-hoc null-product backfill never auto-creates a product (FR-023, R5)', () => {
  it('appends a provenance-only movement that rolls up to no product on-hand', async () => {
    if (h.dockerSkipped || !h.harness) return;

    const productBefore = await onHandQty(PRODUCT_A_ACTIVE);

    // Count tenant_products before — the backfill must NOT add one.
    const tpBefore = await h.harness.env.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_products WHERE tenant_id = $1`,
      [TENANT_A],
    );

    const mv = await h.harness.service.backfillSaleLinkedOutbound({
      tenantId: TENANT_A,
      storeId: STORE_A_X,
      userId: ACTOR_A,
      sourceSystem: 'pos-backfill',
      externalId: 'adhoc-no-product-1',
      movementType: 'outbound',
      quantity: '-3.0000',
      stockingUnit: 'ea',
      tenantProductRef: null, // unresolved reference — provenance only (R5)
      saleId: SALE_A_X,
      saleLineId: LINE_A_X_1,
      correlationId: 'corr-us4-adhoc',
    });

    // The movement persists with a NULL product ref.
    expect(mv.tenantProductRef).toBeNull();

    // No product was auto-created (FR-023).
    const tpAfter = await h.harness.env.admin.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_products WHERE tenant_id = $1`,
      [TENANT_A],
    );
    expect(tpAfter.rows[0]?.n).toBe(tpBefore.rows[0]?.n);

    // The ad-hoc outbound rolls up to NO product's on-hand — PRODUCT_A_ACTIVE is
    // unaffected (the null-product movement is not attributed to any product).
    expect(await onHandQty(PRODUCT_A_ACTIVE)).toBe(productBefore);
  });
});
