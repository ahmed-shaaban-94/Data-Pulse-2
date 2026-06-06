/**
 * 017-RECON-WIRING — `erpnext.reconciliation.requested` outbox consumer.
 *
 * Reads an `erpnext.reconciliation.requested` outbox event (emitted in-transaction
 * by the api-side `triggerRun` when an on-demand stock reconciliation run is
 * created — an `erpnext_reconciliation_run` row with `status='running'`) and
 * invokes `ReconciliationRunProcessor.process(...)`, which advances the run
 * `running → completed` with one classified `erpnext_reconciliation_result` per
 * compared item (014 vocabulary). The DP2 009 ledger + the 008 sale fact are NEVER
 * mutated (read + report only).
 *
 * DEVIATION from SaleCaptured/AuditEventCreated (which bridge to a BullMQ queue):
 * this consumer does the run DB work DIRECTLY via the processor — the exact 015
 * `PostingRequestedConsumer` precedent. There is no pre-existing downstream
 * processor to hand off to, and the outbox layer already gives at-least-once +
 * retry-budget + dead-letter; a second BullMQ hop would be redundant retry, not
 * added safety. The consumer takes a `Pool`; the processor establishes its own
 * tenant context via `runWithTenantContext`.
 *
 * Stub-tolerant Bin read (R3): the connector ERPNext-Bin view is NOT live (the
 * future [GATED] `017-STOCK-VIEW-CONTRACT`). v1 wires `EMPTY_BIN_VIEW`, so a run
 * over a tenant with DP2 on-hand classes every confirmed item as `dp2_only` (the
 * connector hasn't reported) — correct, observable, and a real advance from
 * `running`. This consumer makes the DP2-INTERNAL run live; it does NOT make the
 * cross-system connector→ERPNext leg live.
 *
 * Idempotency (at-least-once): if the drainer crashes after the processor's
 * terminal `UPDATE … WHERE status='running'` but before marking the event
 * delivered, `handle()` re-runs. The processor's guarded write is then a 0-row
 * no-op (`status:'skipped'`) and the result inserts are skipped — never a
 * throw-then-dead-letter loop, no duplicate results.
 *
 * Payload shape: IDs + provenance only (run_id / store_id) — NO money / PII. The
 * ENVELOPE tenant_id is authoritative (a tampered payload tenant must not redirect
 * the run).
 */
import { z } from "zod";
import { type OutboxConsumer, type OutboxEventEnvelope } from "@data-pulse-2/shared";
import type { Pool } from "pg";

import {
  EMPTY_BIN_VIEW,
  ReconciliationRunProcessor,
  type ErpnextBinView,
} from "./reconciliation-run.processor";

// ---------------------------------------------------------------------------
// Payload schema — IDs + provenance only (no PII / money)
// ---------------------------------------------------------------------------

const ReconciliationRequestedPayloadSchema = z.object({
  run_id: z.string().uuid(),
  store_id: z.string().uuid(),
});

export type ReconciliationRequestedPayload = z.infer<
  typeof ReconciliationRequestedPayloadSchema
>;

export const RECONCILIATION_REQUESTED_CONSUMER_ID =
  "worker.erpnext.reconciliation.requested";

export class ReconciliationRequestedConsumer
  implements OutboxConsumer<ReconciliationRequestedPayload>
{
  readonly consumerId = RECONCILIATION_REQUESTED_CONSUMER_ID;
  readonly eventType = "erpnext.reconciliation.requested";

  private readonly processor: ReconciliationRunProcessor;

  constructor(
    private readonly pool: Pool,
    bin: ErpnextBinView = EMPTY_BIN_VIEW,
  ) {
    this.processor = new ReconciliationRunProcessor(pool, bin);
  }

  async handle(
    event: OutboxEventEnvelope<ReconciliationRequestedPayload>,
  ): Promise<void> {
    const parsed = ReconciliationRequestedPayloadSchema.safeParse(event.payload);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const detail = first
        ? `${first.path.join(".") || "<root>"}: ${first.message}`
        : "validation failed";
      throw new Error(
        `ReconciliationRequestedConsumer: malformed payload — ${detail}`,
      );
    }
    const { run_id } = parsed.data;
    // The ENVELOPE tenant is authoritative (not the payload).
    const tenantId = event.tenant_id;

    // The processor's terminal write is guarded (UPDATE … WHERE status='running'),
    // so an at-least-once redelivery is an idempotent no-op (status:'skipped').
    await this.processor.process({ runId: run_id, tenantId });
  }
}
