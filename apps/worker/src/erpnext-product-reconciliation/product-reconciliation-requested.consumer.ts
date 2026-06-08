/**
 * 021-US3 — `erpnext.product_reconciliation.requested` outbox consumer.
 *
 * Reads an `erpnext.product_reconciliation.requested` outbox event (emitted
 * in-transaction by the api-side `triggerRun` when an on-demand product-master
 * reconciliation run is created — an `erpnext_product_reconciliation_run` row with
 * `status='running'`) and invokes `ProductReconciliationRunProcessor.process(...)`,
 * which advances the run `running → completed` with one classified result per
 * compared line (021 vocabulary) and records `erpnext_view_status`. The 013
 * mapping, the 003 catalog, and the 008 sale facts are NEVER mutated.
 *
 * DEVIATION from SaleCaptured/AuditEventCreated (which bridge to a BullMQ queue):
 * this consumer does the run DB work DIRECTLY via the processor — the exact 015
 * `PostingRequestedConsumer` / 017 `ReconciliationRequestedConsumer` precedent.
 * The outbox layer already gives at-least-once + retry-budget + dead-letter.
 *
 * Stub-tolerant item-view (R3): the connector ERPNext-item view is NOT live (the
 * future [GATED] `021-ITEM-VIEW-CONTRACT`). v1 wires `EMPTY_ERPNEXT_ITEM_VIEW`, so
 * a run reports only DP2-side classes and marks the view unavailable — never a
 * failure, never a fabricated `unmapped_erpnext_item`. This consumer makes the
 * DP2-INTERNAL run live; it does NOT make the cross-system connector leg live.
 *
 * Idempotency (at-least-once): the processor's terminal write is guarded
 * (`UPDATE … WHERE status='running'`); a redelivery is an idempotent no-op
 * (`status:'skipped'`). Payload: IDs + provenance only (run_id) — NO money / PII.
 * The ENVELOPE tenant_id is authoritative (a tampered payload tenant must not
 * redirect the run).
 */
import { z } from "zod";
import { type OutboxConsumer, type OutboxEventEnvelope } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import {
  EMPTY_ERPNEXT_ITEM_VIEW,
  ProductReconciliationRunProcessor,
} from "./product-reconciliation-run.processor";
import { type ErpnextItemViewSource } from "./erpnext-item-view.port";

const ProductReconciliationRequestedPayloadSchema = z.object({
  run_id: z.string().uuid(),
});

export type ProductReconciliationRequestedPayload = z.infer<
  typeof ProductReconciliationRequestedPayloadSchema
>;

export const PRODUCT_RECONCILIATION_REQUESTED_CONSUMER_ID =
  "worker.erpnext.product_reconciliation.requested";

export class ProductReconciliationRequestedConsumer
  implements OutboxConsumer<ProductReconciliationRequestedPayload>
{
  readonly consumerId = PRODUCT_RECONCILIATION_REQUESTED_CONSUMER_ID;
  readonly eventType = "erpnext.product_reconciliation.requested";

  private readonly processor: ProductReconciliationRunProcessor;

  constructor(
    private readonly pool: Pool,
    view: ErpnextItemViewSource = EMPTY_ERPNEXT_ITEM_VIEW,
  ) {
    this.processor = new ProductReconciliationRunProcessor(pool, view);
  }

  async handle(
    event: OutboxEventEnvelope<ProductReconciliationRequestedPayload>,
  ): Promise<void> {
    const parsed = ProductReconciliationRequestedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first
        ? `${first.path.join(".") || "<root>"}: ${first.message}`
        : "validation failed";
      throw new Error(
        `ProductReconciliationRequestedConsumer: malformed payload — ${detail}`,
      );
    }
    const { run_id } = parsed.data;
    const tenantId = event.tenant_id;
    await this.processor.process({ runId: run_id, tenantId });
  }
}
